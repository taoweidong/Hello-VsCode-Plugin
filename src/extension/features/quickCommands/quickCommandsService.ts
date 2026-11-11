import { randomUUID } from 'node:crypto'
import * as vscode from 'vscode'
import { CONFIG, STORAGE } from '../../constants'
import {
  JsonEnvelopeFileStore,
  type EnvelopeParseResult,
} from '../../services/stores/jsonEnvelopeStore'
import { QueuedStoreMutations } from '../../services/stores/queuedFileStore'
import { writeJsonAtomic } from '../../services/stores/atomicWrite'
import { reasonOf } from '../../services/errors'

/**
 * 快捷命令（v3.5，16 方案）：终端命令收藏 + 别名 + 显式分组 + 单击在终端执行。
 *
 * - 存储契约与收藏夹同口径：信封 { schemaVersion, groups, commands } + 原子写，
 *   损坏复制 .bak 后按空数据继续；无工作区回退 globalState（双实现）；
 * - 分组为薄实体（名称 + 数组序），命令必属某组（null = 未分组），
 *   分组删除时组内命令回落未分组；
 * - 命令原样存取仅 trim 首尾空白（16 方案 A3）；去重按 trim 后全文精确匹配；
 * - 上限：命令 200 / 分组 50，超出拒绝新增（读取侧裁剪保留前 N 条）。
 */

/** 分组：薄实体，仅名称 + 数组序（顺序即展示顺序）。 */
export interface QuickCommandGroup {
  id: string
  /** 分组名，同一存储内唯一（trim 后比较，大小写敏感） */
  name: string
  /** ISO 时间 */
  createdAt: string
}

/** 快捷命令条目。 */
export interface QuickCommandItem {
  id: string
  /** 别名（展示名，可重命名；默认取命令首词） */
  name: string
  /** 命令文本，原样存取（仅 trim 首尾空白） */
  command: string
  /** 所属分组 id；null = 未分组 */
  groupId: string | null
  /** ISO 时间 */
  addedAt: string
  /** 最近一次执行时间（执行时回写） */
  lastUsedAt?: string
  /** 累计执行次数（执行时回写） */
  useCount?: number
}

/** 持久化数据形态（与信封一一对应）。 */
export interface QuickCommandsData {
  groups: QuickCommandGroup[]
  commands: QuickCommandItem[]
}

/** 当前存储格式版本（信封 { schemaVersion, groups, commands }）。 */
export const QUICK_COMMANDS_SCHEMA_VERSION = 1
/** 快捷命令上限：超出拒绝新增（读取侧保留前 N 条）。 */
export const MAX_QUICK_COMMANDS = 200
/** 分组上限：超出拒绝新增（读取侧保留前 N 个）。 */
export const MAX_QUICK_COMMAND_GROUPS = 50
/** 快捷命令数据文件（相对工作区根；单一来源 STORAGE.quickCommandsFileName，导出别名供测试）。 */
export const QUICK_COMMANDS_FILE_NAME = STORAGE.quickCommandsFileName
/** 无工作区时 globalState 的存储键（同上）。 */
export const QUICK_COMMANDS_MEMENTO_KEY = STORAGE.quickCommandsMementoKey

/** 默认别名：trim 后首个空白分段，截 20 字符。 */
export function defaultAlias(command: string): string {
  const firstWord = command.trim().split(/\s+/)[0] ?? ''
  return firstWord.slice(0, 20)
}

/** 归一化守卫：信封形态校验 + 逐条校验 + 悬空分组回落 + 重名去首 + 双上限裁剪。 */
export function normalizeQuickCommandData(
  raw: unknown,
  onWarning?: (message: string) => void
): QuickCommandsData {
  if (
    typeof raw !== 'object' ||
    raw === null ||
    Array.isArray(raw) ||
    (!Array.isArray((raw as { groups?: unknown }).groups) &&
      !Array.isArray((raw as { commands?: unknown }).commands))
  ) {
    onWarning?.('快捷命令数据不是合法的信封对象，已按空数据处理。')
    return { groups: [], commands: [] }
  }
  const envelope = raw as { schemaVersion?: unknown; groups?: unknown; commands?: unknown }
  if (
    envelope.schemaVersion !== undefined &&
    envelope.schemaVersion !== QUICK_COMMANDS_SCHEMA_VERSION
  ) {
    onWarning?.(
      `快捷命令数据 schemaVersion=${String(envelope.schemaVersion)} 与当前版本 ${QUICK_COMMANDS_SCHEMA_VERSION} 不一致，已尽力读取。`
    )
  }
  const groups = normalizeGroupList(envelope.groups, onWarning)
  const commands = normalizeCommandList(envelope.commands, groups, onWarning)
  return { groups, commands }
}

/** 分组守卫：缺合法 name 丢弃、重名保留首个、上限裁剪。 */
function normalizeGroupList(
  raw: unknown,
  onWarning?: (message: string) => void
): QuickCommandGroup[] {
  const entries = Array.isArray(raw) ? raw : []
  const groups: QuickCommandGroup[] = []
  const seen = new Set<string>()
  let dropped = 0
  let duplicated = 0
  for (const entry of entries) {
    const record =
      typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>) : undefined
    const name = typeof record?.name === 'string' ? record.name.trim() : ''
    if (!record || name.length === 0) {
      dropped += 1
      continue
    }
    if (seen.has(name)) {
      duplicated += 1
      continue
    }
    seen.add(name)
    groups.push({
      id: typeof record.id === 'string' && record.id.length > 0 ? record.id : randomUUID(),
      name,
      createdAt: typeof record.createdAt === 'string' ? record.createdAt : new Date().toISOString(),
    })
  }
  if (dropped > 0) {
    onWarning?.(`快捷命令分组数据中 ${dropped} 条记录缺少合法 name，已丢弃。`)
  }
  if (duplicated > 0) {
    onWarning?.(`快捷命令分组数据中 ${duplicated} 个重名分组（重名保留首个），已去重。`)
  }
  if (groups.length > MAX_QUICK_COMMAND_GROUPS) {
    onWarning?.(
      `快捷命令分组数量 ${groups.length} 超上限 ${MAX_QUICK_COMMAND_GROUPS}，已保留前 ${MAX_QUICK_COMMAND_GROUPS} 个。`
    )
    groups.length = MAX_QUICK_COMMAND_GROUPS
  }
  return groups
}

/** 命令守卫：缺合法 command 丢弃、悬空 groupId 回落未分组（汇总警告）、上限裁剪。 */
function normalizeCommandList(
  raw: unknown,
  groups: QuickCommandGroup[],
  onWarning?: (message: string) => void
): QuickCommandItem[] {
  const entries = Array.isArray(raw) ? raw : []
  const groupIds = new Set(groups.map((group) => group.id))
  const items: QuickCommandItem[] = []
  let dropped = 0
  let dangling = 0
  for (const entry of entries) {
    const record =
      typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>) : undefined
    const command = typeof record?.command === 'string' ? record.command.trim() : ''
    if (!record || command.length === 0) {
      dropped += 1
      continue
    }
    let groupId: string | null = null
    if (typeof record.groupId === 'string' && record.groupId.length > 0) {
      if (groupIds.has(record.groupId)) {
        groupId = record.groupId
      } else {
        dangling += 1
      }
    }
    items.push({
      id: typeof record.id === 'string' && record.id.length > 0 ? record.id : randomUUID(),
      name:
        typeof record.name === 'string' && record.name.trim().length > 0
          ? record.name.trim()
          : defaultAlias(command),
      command,
      groupId,
      addedAt: typeof record.addedAt === 'string' ? record.addedAt : new Date().toISOString(),
      lastUsedAt: typeof record.lastUsedAt === 'string' ? record.lastUsedAt : undefined,
      useCount:
        typeof record.useCount === 'number' &&
        Number.isInteger(record.useCount) &&
        record.useCount >= 0
          ? record.useCount
          : undefined,
    })
  }
  if (dropped > 0) {
    onWarning?.(`快捷命令数据中 ${dropped} 条记录缺少合法 command，已丢弃。`)
  }
  if (dangling > 0) {
    onWarning?.(`快捷命令数据中 ${dangling} 条记录的分组引用不存在，已回落未分组。`)
  }
  if (items.length > MAX_QUICK_COMMANDS) {
    onWarning?.(
      `快捷命令数量 ${items.length} 超上限 ${MAX_QUICK_COMMANDS}，已保留前 ${MAX_QUICK_COMMANDS} 条。`
    )
    items.length = MAX_QUICK_COMMANDS
  }
  return items
}

/** 快捷命令数据源抽象（双实现：工作区文件 + globalStorage 明文文件，17 方案阶段 4）。 */
export interface IQuickCommandsStore {
  load(): Promise<QuickCommandsData>
  save(data: QuickCommandsData): Promise<void>
  /** 数据文件落点（「打开数据文件」命令依赖；对齐收藏夹 / 书签口径）。 */
  dataFileUri(): vscode.Uri
}

/**
 * 快捷命令数据内容解析（17 方案阶段 2 收敛到共享信封存储）。
 * 顶层**不做**裸数组宽容读取：本信封是 groups + commands 双集合，裸数组语义
 * 存在歧义（按 commands 解释可能静默丢掉手写的 groups）——判损坏并复制备份
 * 更安全（原文件可从备份恢复）；单一集合的 favorites 才有明确的宽容读取口径。
 */
function parseQuickCommandsContent(
  data: unknown,
  warn: (message: string) => void
): EnvelopeParseResult<QuickCommandsData> {
  if (
    typeof data === 'object' &&
    data !== null &&
    (Array.isArray((data as { groups?: unknown }).groups) ||
      Array.isArray((data as { commands?: unknown }).commands))
  ) {
    return { ok: true, value: normalizeQuickCommandData(data, warn) }
  }
  return { ok: false, reason: '根节点不是含 groups/commands 数组的信封对象' }
}

/** 默认数据源：工作区 `.vscode/quick-commands.json`（损坏契约与收藏夹一致）。 */
export class JsonQuickCommandsStore implements IQuickCommandsStore {
  private readonly inner: JsonEnvelopeFileStore<QuickCommandsData>

  constructor(
    public readonly fileUri: vscode.Uri,
    options: { onWarning?: (message: string) => void } = {}
  ) {
    this.inner = new JsonEnvelopeFileStore<QuickCommandsData>(fileUri, {
      label: '快捷命令',
      empty: () => ({ groups: [], commands: [] }),
      parse: parseQuickCommandsContent,
      serialize: (data) => ({
        schemaVersion: QUICK_COMMANDS_SCHEMA_VERSION,
        groups: data.groups,
        commands: data.commands,
      }),
      onWarning: options.onWarning,
    })
  }

  load(): Promise<QuickCommandsData> {
    return this.inner.load()
  }

  async save(data: QuickCommandsData): Promise<void> {
    await this.inner.save(data)
  }

  dataFileUri(): vscode.Uri {
    return this.fileUri
  }
}

/**
 * 备用数据源：无工作区时落到 globalStorage 目录下的明文 JSON（17 方案阶段 4
 * 对齐 15 方案收藏夹先例——所有场景都是可手动拷贝的明文 JSON；旧的 globalState
 * 回退经激活期 migrateQuickCommandsMementoToFile 一次性迁移）。
 */
export class GlobalJsonQuickCommandsStore extends JsonQuickCommandsStore {}

/** 装配：有工作区 → 工作区文件；无工作区 → globalStorage 明文 JSON。 */
export function createQuickCommandsStore(
  context: vscode.ExtensionContext,
  options: { onWarning?: (message: string) => void } = {}
): IQuickCommandsStore {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri
  if (root) {
    return new JsonQuickCommandsStore(
      vscode.Uri.joinPath(root, ...QUICK_COMMANDS_FILE_NAME.split('/')),
      options
    )
  }
  return new GlobalJsonQuickCommandsStore(
    vscode.Uri.joinPath(context.globalStorageUri, STORAGE.quickCommandsGlobalFileName),
    options
  )
}

/**
 * 激活期一次性迁移（17 方案阶段 4，对齐 migrateFavoritesMementoToFile 口径）：
 * 把旧 globalState（`extStarter.quickCommands`）数据搬到 globalStorage 明文 JSON——
 * 与有无工作区无关地无条件执行，消除孤儿窗口；幂等（旧键清除后永不再触发）。
 *
 * 分支：① 无数据 → 静默跳过；② 全局文件已存在 → 旧键直接作废清除（不合并）；
 * ③ 文件不存在 → 归一化写入信封，写成功才清旧键，onMigrated 回调一次；
 * ④ 写失败 → 错误向上抛，旧键保留。
 */
export async function migrateQuickCommandsMementoToFile(
  context: vscode.ExtensionContext,
  options: {
    onWarning?: (message: string) => void
    onMigrated?: (fileUri: vscode.Uri) => void
  } = {}
): Promise<boolean> {
  const legacy = context.globalState.get<unknown>(QUICK_COMMANDS_MEMENTO_KEY)
  if (legacy === undefined) {
    return false
  }
  const fileUri = vscode.Uri.joinPath(context.globalStorageUri, STORAGE.quickCommandsGlobalFileName)
  let exists = true
  try {
    await vscode.workspace.fs.stat(fileUri)
  } catch (err) {
    if (err instanceof vscode.FileSystemError && err.code === 'FileNotFound') {
      exists = false
    } else {
      throw err
    }
  }
  if (exists) {
    await context.globalState.update(QUICK_COMMANDS_MEMENTO_KEY, undefined)
    return false
  }
  const data = normalizeQuickCommandData(legacy, options.onWarning)
  await writeJsonAtomic(fileUri, {
    schemaVersion: QUICK_COMMANDS_SCHEMA_VERSION,
    groups: data.groups,
    commands: data.commands,
  })
  await context.globalState.update(QUICK_COMMANDS_MEMENTO_KEY, undefined)
  options.onMigrated?.(fileUri)
  return true
}

/** 添加结果（命令壳用于提示与分支渲染）。 */
export type AddCommandStatus =
  | { status: 'added'; item: QuickCommandItem }
  | { status: 'duplicate'; existing: QuickCommandItem }
  | { status: 'cap' }
  | { status: 'invalid' }

/** 修改命令文本结果（'duplicate' = 与其他条目命令文本相同）。 */
export type UpdateTextStatus = 'updated' | 'duplicate' | 'notfound' | 'empty'

/** 新建分组结果（duplicate 返回既有组，壳层可直接复用；invalid = 空白名，P3-01）。 */
export type GroupOp =
  | { status: 'created'; group: QuickCommandGroup }
  | { status: 'duplicate'; existing: QuickCommandGroup }
  | { status: 'cap' }
  | { status: 'invalid' }

/** 分组重命名结果。 */
export type RenameGroupStatus = 'renamed' | 'duplicate' | 'notfound'

/** 专用复用终端名（16 方案 §5：避免每次执行刷屏新建）。 */
export const QUICK_COMMAND_TERMINAL_NAME = 'QuickCommand'

/** 未分组节点的展示标签（groupId=null；此前 6 处字面量，P3-03 收敛）。 */
export const UNGROUPED_LABEL = '未分组'

/** 快捷命令业务服务：命令与树视图的唯一数据入口。 */
export class QuickCommandsService implements vscode.Disposable {
  private groups: QuickCommandGroup[] = []
  private commands: QuickCommandItem[] = []
  /** 首次 load 失败的原因（树视图以 info 节点呈现；成功后清空）。 */
  loadError: string | undefined
  /** 专用复用终端（exitStatus 非 undefined = 已被用户关闭，执行前重建）。 */
  private terminal: vscode.Terminal | undefined

  private readonly _onDidChange = new vscode.EventEmitter<void>()
  readonly onDidChange = this._onDidChange.event

  /**
   * 数据完整性契约（17 方案阶段 1，P1-1）：所有写操作经串行队列
   * 「加载先行 → 写前重读 → 变更 → 落盘」，多窗口 / 激活期慢加载场景
   * 不会用陈旧内存数据整文件覆盖磁盘数据；重读失败中止变更不落盘。
   */
  private readonly mutations = new QueuedStoreMutations(
    () => {
      this.loadPromise ??= this.doLoad()
      return this.loadPromise
    },
    async () => {
      const data = await this.store.load()
      this.groups = data.groups
      this.commands = data.commands
      this.loadError = undefined
    }
  )
  /** 初始加载缓存（幂等；写路径经 mutations.ensureLoaded 复用同一 promise）。 */
  private loadPromise: Promise<void> | undefined

  constructor(
    private readonly store: IQuickCommandsStore,
    private readonly options: {
      /** 工作区根提供者（可注入，测试友好；默认第一个工作区文件夹）。 */
      getWorkspaceRoot?: () => vscode.Uri | undefined
      /** 是否复用专用终端（可注入；默认读 quickCommandReuseTerminal 配置，缺省 true）。 */
      getReuseTerminal?: () => boolean
    } = {}
  ) {}

  /** 加载持久化数据（激活时调用；失败保留空列表并记录原因；完成后触发变更事件）。 */
  async load(): Promise<void> {
    this.loadPromise = this.doLoad()
    try {
      await this.loadPromise
    } finally {
      this._onDidChange.fire()
    }
  }

  /** 加载实现（不触发事件——变更队列内隐式加载不应多发 onDidChange）。 */
  private async doLoad(): Promise<void> {
    try {
      const data = await this.store.load()
      this.groups = data.groups
      this.commands = data.commands
      this.loadError = undefined
    } catch (err) {
      this.groups = []
      this.commands = []
      this.loadError = reasonOf(err)
    }
  }

  listCommands(): QuickCommandItem[] {
    return [...this.commands]
  }

  /** 数据文件落点（透传当前 store；「打开数据文件」命令依赖）。 */
  dataFileUri(): vscode.Uri {
    return this.store.dataFileUri()
  }

  /** 确保数据文件存在：缺失时写空信封（「打开数据文件」所见即存储格式）。 */
  async ensureDataFile(): Promise<void> {
    try {
      await vscode.workspace.fs.stat(this.store.dataFileUri())
    } catch (err) {
      if (err instanceof vscode.FileSystemError && err.code === 'FileNotFound') {
        await this.store.save({ groups: [], commands: [] })
        return
      }
      throw err
    }
  }

  listGroups(): QuickCommandGroup[] {
    return [...this.groups]
  }

  /** 按 id 查条目。 */
  get(id: string): QuickCommandItem | undefined {
    return this.commands.find((entry) => entry.id === id)
  }

  /** 按 id 查分组。 */
  getGroup(id: string): QuickCommandGroup | undefined {
    return this.groups.find((group) => group.id === id)
  }

  /**
   * 新增快捷命令：command trim 后全文精确去重（重复仅提示不覆盖，16 方案 §3.2）；
   * 新条目插入所在分组顶部（同 groupId 首个条目之前）。
   */
  addCommand(input: {
    command: string
    name?: string
    groupId?: string | null
  }): Promise<AddCommandStatus> {
    return this.mutations.run(async () => {
      const command = input.command.trim()
      const groupId = input.groupId ?? null
      if (command.length === 0 || (groupId !== null && !this.getGroup(groupId))) {
        return { status: 'invalid' }
      }
      const existing = this.commands.find((entry) => entry.command === command)
      if (existing) {
        return { status: 'duplicate', existing }
      }
      if (this.commands.length >= MAX_QUICK_COMMANDS) {
        return { status: 'cap' }
      }
      const item: QuickCommandItem = {
        id: randomUUID(),
        name:
          input.name && input.name.trim().length > 0 ? input.name.trim() : defaultAlias(command),
        command,
        groupId,
        addedAt: new Date().toISOString(),
      }
      const insertAt = this.commands.findIndex((entry) => entry.groupId === groupId)
      if (insertAt >= 0) {
        this.commands.splice(insertAt, 0, item)
      } else {
        this.commands.push(item)
      }
      await this.persist()
      return { status: 'added', item }
    })
  }

  /** 重命名别名（id 不存在或名字空白返回 false）。 */
  renameCommand(id: string, name: string): Promise<boolean> {
    return this.mutations.run(async () => {
      const trimmed = name.trim()
      const item = this.get(id)
      if (!item || trimmed.length === 0) {
        return false
      }
      item.name = trimmed
      await this.persist()
      return true
    })
  }

  /** 修改命令文本：trim 后与其他条目冲突 → 'duplicate'。 */
  updateCommandText(id: string, command: string): Promise<UpdateTextStatus> {
    return this.mutations.run(async () => {
      const trimmed = command.trim()
      if (trimmed.length === 0) {
        return 'empty'
      }
      const item = this.get(id)
      if (!item) {
        return 'notfound'
      }
      if (this.commands.some((entry) => entry.id !== id && entry.command === trimmed)) {
        return 'duplicate'
      }
      item.command = trimmed
      await this.persist()
      return 'updated'
    })
  }

  /** 移除快捷命令（id 不存在返回 false）。 */
  removeCommand(id: string): Promise<boolean> {
    return this.mutations.run(async () => {
      const before = this.commands.length
      this.commands = this.commands.filter((entry) => entry.id !== id)
      if (this.commands.length === before) {
        return false
      }
      await this.persist()
      return true
    })
  }

  /** 移动到分组（groupId=null 回到未分组；分组不存在或条目不存在返回 false）。 */
  moveCommandToGroup(id: string, groupId: string | null): Promise<boolean> {
    return this.mutations.run(async () => {
      const item = this.get(id)
      if (!item || (groupId !== null && !this.getGroup(groupId))) {
        return false
      }
      item.groupId = groupId
      await this.persist()
      return true
    })
  }

  /** 新建分组：trim 后唯一；超出上限返回 cap。 */
  createGroup(name: string): Promise<GroupOp> {
    return this.mutations.run(async () => {
      const trimmed = name.trim()
      if (trimmed.length === 0) {
        return { status: 'invalid' } // 空白名 ≠ 数量上限（P3-01 状态语义纠正）
      }
      const existing = this.groups.find((group) => group.name === trimmed)
      if (existing) {
        return { status: 'duplicate', existing }
      }
      if (this.groups.length >= MAX_QUICK_COMMAND_GROUPS) {
        return { status: 'cap' }
      }
      const group: QuickCommandGroup = {
        id: randomUUID(),
        name: trimmed,
        createdAt: new Date().toISOString(),
      }
      this.groups.push(group)
      await this.persist()
      return { status: 'created', group }
    })
  }

  /** 重命名分组：重名冲突 → 'duplicate'。 */
  renameGroup(id: string, name: string): Promise<RenameGroupStatus> {
    return this.mutations.run(async () => {
      const trimmed = name.trim()
      const group = this.getGroup(id)
      if (!group || trimmed.length === 0) {
        return 'notfound'
      }
      if (this.groups.some((entry) => entry.id !== id && entry.name === trimmed)) {
        return 'duplicate'
      }
      group.name = trimmed
      await this.persist()
      return 'renamed'
    })
  }

  /** 删除分组：组内命令回落未分组（16 方案 §3.3）；id 不存在返回 false。 */
  removeGroup(id: string): Promise<boolean> {
    return this.mutations.run(async () => {
      if (!this.getGroup(id)) {
        return false
      }
      this.groups = this.groups.filter((group) => group.id !== id)
      for (const item of this.commands) {
        if (item.groupId === id) {
          item.groupId = null
        }
      }
      await this.persist()
      return true
    })
  }

  /** 使用记录回写：lastUsedAt = now，useCount + 1（QuickPick MRU 留数据）。 */
  recordExecution(id: string): Promise<void> {
    return this.mutations.run(async () => {
      const item = this.get(id)
      if (!item) {
        return
      }
      item.lastUsedAt = new Date().toISOString()
      item.useCount = (item.useCount ?? 0) + 1
      await this.persist()
    })
  }

  /**
   * 在终端执行快捷命令（16 方案 §5）：复用名为 QuickCommand 的专用终端
   * （被关闭后自动重建）；cwd = 工作区首目录；命令原样 sendText，不做任何改写。
   */
  async execute(item: QuickCommandItem): Promise<void> {
    const reuse = this.options.getReuseTerminal
      ? this.options.getReuseTerminal()
      : vscode.workspace
          .getConfiguration(CONFIG.section)
          .get<boolean>(CONFIG.quickCommandReuseTerminal, true)
    if (!reuse || !this.terminal || this.terminal.exitStatus !== undefined) {
      this.terminal = vscode.window.createTerminal({
        name: QUICK_COMMAND_TERMINAL_NAME,
        cwd: this.options.getWorkspaceRoot
          ? this.options.getWorkspaceRoot()
          : vscode.workspace.workspaceFolders?.[0]?.uri,
      })
    }
    this.terminal.show()
    this.terminal.sendText(item.command, true)
    await this.recordExecution(item.id)
  }

  dispose(): void {
    this._onDidChange.dispose()
  }

  private async persist(): Promise<void> {
    await this.store.save({ groups: this.groups, commands: this.commands })
    this._onDidChange.fire()
  }
}
