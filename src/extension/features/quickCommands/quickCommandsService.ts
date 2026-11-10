import { randomUUID } from 'node:crypto'
import * as path from 'path'
import * as vscode from 'vscode'
import { writeJsonAtomic } from '../../services/stores/atomicWrite'

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
/**
 * 快捷命令数据文件（相对工作区根；v3.5，16 方案）。
 * T8（constants 收敛）前暂居本文件，收敛后改引 STORAGE.quickCommandsFileName。
 */
export const QUICK_COMMANDS_FILE_NAME = '.vscode/quick-commands.json'
/** 无工作区时 globalState 的存储键（同上，T8 收敛进 constants）。 */
export const QUICK_COMMANDS_MEMENTO_KEY = 'extStarter.quickCommands'

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
    const record = typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>) : undefined
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
    const record = typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>) : undefined
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
      useCount: typeof record.useCount === 'number' && Number.isInteger(record.useCount) && record.useCount >= 0
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

/** 快捷命令数据源抽象（双实现：工作区文件 + Memento）。 */
export interface IQuickCommandsStore {
  load(): Promise<QuickCommandsData>
  save(data: QuickCommandsData): Promise<void>
}

/** 默认数据源：工作区 `.vscode/quick-commands.json`（损坏契约与收藏夹一致）。 */
export class JsonQuickCommandsStore implements IQuickCommandsStore {
  constructor(
    public readonly fileUri: vscode.Uri,
    private readonly options: { onWarning?: (message: string) => void } = {}
  ) {}

  async load(): Promise<QuickCommandsData> {
    let text: string
    try {
      const raw = await vscode.workspace.fs.readFile(this.fileUri)
      text = Buffer.from(raw).toString('utf8')
    } catch (err) {
      if (err instanceof vscode.FileSystemError && err.code === 'FileNotFound') {
        return { groups: [], commands: [] } // 首次使用：视为空数据
      }
      this.options.onWarning?.(
        `读取快捷命令数据失败（${this.fileUri.fsPath}）：${err instanceof Error ? err.message : String(err)}`
      )
      throw err
    }
    if (text.charCodeAt(0) === 0xfeff) {
      text = text.slice(1)
    }
    let data: unknown
    try {
      data = JSON.parse(text)
    } catch (err) {
      return this.recoverFromCorruption(err instanceof Error ? err.message : String(err))
    }
    if (
      typeof data === 'object' &&
      data !== null &&
      (Array.isArray((data as { groups?: unknown }).groups) ||
        Array.isArray((data as { commands?: unknown }).commands))
    ) {
      return normalizeQuickCommandData(data, this.options.onWarning)
    }
    return this.recoverFromCorruption('根节点不是含 groups/commands 数组的信封对象')
  }

  async save(data: QuickCommandsData): Promise<void> {
    await writeJsonAtomic(this.fileUri, {
      schemaVersion: QUICK_COMMANDS_SCHEMA_VERSION,
      groups: data.groups,
      commands: data.commands,
    })
  }

  /** 损坏恢复：复制备份（原文件不动）→ 警告上报 → 按空数据继续；备份失败抛错。 */
  private async recoverFromCorruption(reason: string): Promise<QuickCommandsData> {
    const dirUri = vscode.Uri.joinPath(this.fileUri, '..')
    const backupUri = vscode.Uri.joinPath(
      dirUri,
      `${path.basename(this.fileUri.fsPath)}.corrupt-${Date.now()}-${randomUUID().slice(0, 8)}.bak`
    )
    try {
      await vscode.workspace.fs.copy(this.fileUri, backupUri)
    } catch (err) {
      throw new Error(
        `快捷命令数据文件损坏且备份失败：无法将 ${this.fileUri.fsPath} 复制为 ${backupUri.fsPath}` +
          `（${err instanceof Error ? err.message : String(err)}）。原文件保留在原位，请手动处理。`,
        { cause: err }
      )
    }
    this.options.onWarning?.(
      `快捷命令数据文件损坏（${reason}）。原文件保留在原位，已复制备份到 ${path.basename(backupUri.fsPath)}，本次按空数据继续。`
    )
    return { groups: [], commands: [] }
  }
}

/** 备用数据源：无工作区时经 globalState 持久化。 */
export class MementoQuickCommandsStore implements IQuickCommandsStore {
  constructor(
    private readonly memento: vscode.Memento,
    private readonly key: string,
    private readonly options: { onWarning?: (message: string) => void } = {}
  ) {}

  async load(): Promise<QuickCommandsData> {
    return normalizeQuickCommandData(
      this.memento.get<unknown>(this.key, { groups: [], commands: [] }),
      this.options.onWarning
    )
  }

  async save(data: QuickCommandsData): Promise<void> {
    await this.memento.update(this.key, data)
  }
}

/** 装配：有工作区 → 工作区文件；无工作区 → globalState。 */
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
  return new MementoQuickCommandsStore(context.globalState, QUICK_COMMANDS_MEMENTO_KEY, options)
}
