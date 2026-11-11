import { randomUUID } from 'node:crypto'
import * as path from 'path'
import * as vscode from 'vscode'
import { STORAGE } from '../../constants'
import { writeJsonAtomic } from '../../services/stores/atomicWrite'
import {
  JsonEnvelopeFileStore,
  type EnvelopeParseResult,
} from '../../services/stores/jsonEnvelopeStore'
import { QueuedStoreMutations } from '../../services/stores/queuedFileStore'
import { reasonOf } from '../../services/errors'

/**
 * 收藏夹（v3.4，13 方案；v3.6 存储可迁移增强，15 方案）：文件 / 文件夹路径收藏 + 别名 + 单击跳转。
 *
 * - 存储契约与书签 / 快捷命令同口径：信封 { schemaVersion, items } + 原子写，
 *   损坏复制 .bak 后按空数据继续（绝无备份不覆盖）；顶层旧数组宽容读取；
 * - 数据落点（15 方案：所有场景都是可手动拷贝的明文 JSON）：
 *   有工作区 → `.vscode/favorites.json`；无工作区 → globalStorage 目录下明文 JSON
 *   （GlobalJsonFavoritesStore）；旧 globalState 数据由激活期 migrateFavoritesMementoToFile
 *   一次性迁移（幂等，迁移成功才清旧键）；
 * - 路径：工作区内存 POSIX 相对路径（仓库可迁移），工作区外存绝对 fsPath；
 *   解析时逐工作区文件夹尝试存在性，全未命中回退第一个文件夹；
 * - 去重按解析后的绝对路径；上限 200 条，新收藏插头部，超出丢最旧。
 */

/** 收藏条目（path 为存储形态：相对或绝对，解析见 resolveFavoriteUri）。 */
export interface FavoriteItem {
  id: string
  /** 别名（展示名，可重命名；默认 basename） */
  name: string
  /** 工作区内 = POSIX 相对路径；工作区外 = 绝对 fsPath */
  path: string
  isFolder: boolean
  /** ISO 时间 */
  addedAt: string
}

/** 当前存储格式版本（信封 { schemaVersion, items }）。 */
export const FAVORITES_SCHEMA_VERSION = 1
/** 收藏上限：超出丢最旧（新收藏插头部）。 */
export const MAX_FAVORITES = 200

/** 归一化守卫：逐条校验（缺 path / 非 banana 形态整条丢弃），别名回退 basename，上限裁剪。 */
export function normalizeFavoriteList(
  raw: unknown,
  onWarning?: (message: string) => void
): FavoriteItem[] {
  if (!Array.isArray(raw)) {
    onWarning?.('收藏数据不是数组，已按空数据处理。')
    return []
  }
  const items: FavoriteItem[] = []
  let dropped = 0
  for (const entry of raw) {
    const item = normalizeFavoriteItem(entry)
    if (item) {
      items.push(item)
    } else {
      dropped += 1
    }
  }
  if (dropped > 0) {
    onWarning?.(`收藏数据中 ${dropped} 条记录缺少合法 path，已丢弃。`)
  }
  if (items.length > MAX_FAVORITES) {
    onWarning?.(
      `收藏数量 ${items.length} 超上限 ${MAX_FAVORITES}，已保留最新 ${MAX_FAVORITES} 条。`
    )
    items.length = MAX_FAVORITES
  }
  return items
}

function normalizeFavoriteItem(entry: unknown): FavoriteItem | undefined {
  if (typeof entry !== 'object' || entry === null) {
    return undefined
  }
  const record = entry as Record<string, unknown>
  if (typeof record.path !== 'string' || record.path.trim().length === 0) {
    return undefined
  }
  const fallbackName = path.basename(record.path) || record.path
  return {
    id: typeof record.id === 'string' && record.id.length > 0 ? record.id : randomUUID(),
    name:
      typeof record.name === 'string' && record.name.trim().length > 0 ? record.name : fallbackName,
    path: record.path,
    isFolder: record.isFolder === true,
    addedAt: typeof record.addedAt === 'string' ? record.addedAt : new Date().toISOString(),
  }
}

/** 收藏数据源抽象（双实现：工作区文件 + globalStorage 明文文件）。 */
export interface IFavoritesStore {
  load(): Promise<FavoriteItem[]>
  save(items: FavoriteItem[]): Promise<void>
  /** 数据文件落点（「打开数据文件」命令与备份迁移口径依赖；15 方案）。 */
  dataFileUri(): vscode.Uri
}

/** 收藏数据内容解析（信封 + 顶层宽容读取，17 方案阶段 2 收敛到共享信封存储）。 */
function parseFavoritesContent(
  data: unknown,
  warn: (message: string) => void
): EnvelopeParseResult<FavoriteItem[]> {
  if (Array.isArray(data)) {
    // 顶层数组（手写常见形态）：宽容读取，下次保存自动迁移为信封
    warn('收藏数据文件为顶层数组格式，已兼容读取，下次保存自动迁移为信封格式。')
    return { ok: true, value: normalizeFavoriteList(data, warn) }
  }
  if (
    typeof data === 'object' &&
    data !== null &&
    Array.isArray((data as { items?: unknown }).items)
  ) {
    const envelope = data as { schemaVersion?: unknown; items: unknown[] }
    if (
      envelope.schemaVersion !== undefined &&
      envelope.schemaVersion !== FAVORITES_SCHEMA_VERSION
    ) {
      warn(
        `收藏数据 schemaVersion=${String(envelope.schemaVersion)} 与当前版本 ${FAVORITES_SCHEMA_VERSION} 不一致，已尽力按 items 读取。`
      )
    }
    return { ok: true, value: normalizeFavoriteList(envelope.items, warn) }
  }
  return { ok: false, reason: '根节点既不是数组，也不是含 items 数组的对象' }
}

/** 默认数据源：工作区 `.vscode/favorites.json`（损坏契约与共享信封存储一致）。 */
export class JsonFavoritesStore implements IFavoritesStore {
  private readonly inner: JsonEnvelopeFileStore<FavoriteItem[]>

  constructor(
    public readonly fileUri: vscode.Uri,
    options: { onWarning?: (message: string) => void } = {}
  ) {
    this.inner = new JsonEnvelopeFileStore<FavoriteItem[]>(fileUri, {
      label: '收藏',
      empty: () => [],
      parse: parseFavoritesContent,
      serialize: (items) => ({ schemaVersion: FAVORITES_SCHEMA_VERSION, items }),
      onWarning: options.onWarning,
    })
  }

  load(): Promise<FavoriteItem[]> {
    return this.inner.load()
  }

  async save(items: FavoriteItem[]): Promise<void> {
    await this.inner.save(items)
  }

  dataFileUri(): vscode.Uri {
    return this.fileUri
  }
}

/**
 * 备用数据源：无工作区时落到 globalStorage 目录下的明文 JSON（v3.6，15 方案——
 * 手动拷贝该文件即可备份/迁移；writeJsonAtomic 自带 createDirectory，无需预建目录）。
 */
export class GlobalJsonFavoritesStore extends JsonFavoritesStore {}

/**
 * 激活期一次性迁移（15 方案 §3）：把旧 globalState（`extStarter.favorites`）数据
 * 搬到 globalStorage 明文 JSON——与当前有无工作区无关地无条件执行，消除
 * 「无工作区攒数据、之后打开工作区无人迁移」的孤儿窗口；对齐既有激活迁移
 * 先例；幂等（旧键清除后永不再触发）。
 *
 * 分支：① 无数据 → 静默跳过；② 全局文件已存在 → 旧键直接作废清除（不合并、
 * 不覆盖，对齐「旧键都清掉」口径）；③ 文件不存在 → 归一化写入
 * 信封，写成功才清旧键，onMigrated 回调一次；④ 写失败 → 错误向上抛，旧键保留。
 *
 * 返回是否有数据真正搬迁（② 分支返回 false）。
 */
export async function migrateFavoritesMementoToFile(
  context: vscode.ExtensionContext,
  options: {
    onWarning?: (message: string) => void
    onMigrated?: (fileUri: vscode.Uri) => void
  } = {}
): Promise<boolean> {
  const legacy = context.globalState.get<unknown>(STORAGE.favoritesMementoKey)
  if (legacy === undefined) {
    return false
  }
  const fileUri = vscode.Uri.joinPath(context.globalStorageUri, STORAGE.favoritesGlobalFileName)
  let exists = true
  try {
    await vscode.workspace.fs.stat(fileUri)
  } catch (err) {
    if (err instanceof vscode.FileSystemError && err.code === 'FileNotFound') {
      exists = false
    } else {
      throw err // stat 因别的原因失败：如实上抛（旧键保留），不做任何写入
    }
  }
  if (exists) {
    await context.globalState.update(STORAGE.favoritesMementoKey, undefined)
    return false
  }
  const items = normalizeFavoriteList(legacy, options.onWarning)
  await writeJsonAtomic(fileUri, { schemaVersion: FAVORITES_SCHEMA_VERSION, items })
  await context.globalState.update(STORAGE.favoritesMementoKey, undefined)
  options.onMigrated?.(fileUri)
  return true
}

/** 装配：有工作区 → 工作区文件；无工作区 → globalStorage 明文 JSON。 */
export function createFavoritesStore(
  context: vscode.ExtensionContext,
  options: { onWarning?: (message: string) => void } = {}
): IFavoritesStore {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri
  if (root) {
    return new JsonFavoritesStore(
      vscode.Uri.joinPath(root, ...STORAGE.favoritesFileName.split('/')),
      options
    )
  }
  return new GlobalJsonFavoritesStore(
    vscode.Uri.joinPath(context.globalStorageUri, STORAGE.favoritesGlobalFileName),
    options
  )
}

/** 相对路径转 POSIX 分隔（存储形态统一，跨平台可迁移）。 */
function toPosix(value: string): string {
  return value.split('\\').join('/')
}

/** 添加结果（命令壳用于提示与集成断言）。 */
export interface AddFavoritesResult {
  added: number
  skipped: number
}

/** 收藏夹业务服务：命令与树视图的唯一数据入口。 */
export class FavoritesService implements vscode.Disposable {
  private items: FavoriteItem[] = []
  /** 首次 load 失败的原因（树视图以 info 节点呈现；成功后清空）。 */
  loadError: string | undefined

  private readonly _onDidChange = new vscode.EventEmitter<void>()
  readonly onDidChange = this._onDidChange.event

  /**
   * 数据完整性契约（17 方案阶段 1，P1-1）：所有写操作经串行队列
   * 「加载先行 → 写前重读 → 变更 → 落盘」，多窗口 / 激活期慢加载场景
   * 不会用陈旧内存列表整文件覆盖磁盘数据；重读失败中止变更不落盘。
   */
  private readonly mutations = new QueuedStoreMutations(
    () => {
      this.loadPromise ??= this.doLoad()
      return this.loadPromise
    },
    async () => {
      this.items = await this.store.load()
      this.loadError = undefined
    }
  )
  /** 初始加载缓存（幂等；写路径经 mutations.ensureLoaded 复用同一 promise）。 */
  private loadPromise: Promise<void> | undefined

  constructor(
    private readonly store: IFavoritesStore,
    /** 工作区文件夹提供者（可注入，测试友好；默认第一个工作区文件夹）。 */
    private readonly getWorkspaceFolder: () => vscode.WorkspaceFolder | undefined = () =>
      vscode.workspace.workspaceFolders?.[0]
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
      this.items = await this.store.load()
      this.loadError = undefined
    } catch (err) {
      this.items = []
      this.loadError = reasonOf(err)
    }
  }

  list(): FavoriteItem[] {
    return [...this.items]
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
        await this.store.save([])
        return
      }
      throw err
    }
  }

  /** 批量添加（单选/多选统一入口）；重复路径跳过；别名缺省 basename；保持选择顺序插头部。 */
  add(uris: readonly vscode.Uri[], alias?: string): Promise<AddFavoritesResult> {
    return this.mutations.run(async () => {
      let added = 0
      let skipped = 0
      const fresh: FavoriteItem[] = []
      const seen = new Set<string>()
      for (const uri of uris) {
        const item = await this.buildItem(uri, alias)
        if (!item) {
          skipped += 1
          continue
        }
        const normalized = toPosix(item.path)
        if (seen.has(normalized) || this.findByResolvedPath(item.path)) {
          skipped += 1
          continue
        }
        seen.add(normalized)
        fresh.push(item)
        added += 1
      }
      if (fresh.length > 0) {
        // 新收藏插头部且批量内保持选择顺序（第一批选中项在最前）
        this.items = [...fresh, ...this.items]
        this.trimToCap()
        await this.persist()
      }
      return { added, skipped }
    })
  }

  /** 重命名别名（id 不存在返回 false）。 */
  rename(id: string, name: string): Promise<boolean> {
    return this.mutations.run(async () => {
      const trimmed = name.trim()
      if (trimmed.length === 0) {
        return false
      }
      const item = this.items.find((entry) => entry.id === id)
      if (!item) {
        return false
      }
      item.name = trimmed
      await this.persist()
      return true
    })
  }

  /** 移除收藏（id 不存在返回 false）。 */
  remove(id: string): Promise<boolean> {
    return this.mutations.run(async () => {
      const before = this.items.length
      this.items = this.items.filter((entry) => entry.id !== id)
      if (this.items.length === before) {
        return false
      }
      await this.persist()
      return true
    })
  }

  /** 按 id 查条目。 */
  get(id: string): FavoriteItem | undefined {
    return this.items.find((entry) => entry.id === id)
  }

  /**
   * 把存储路径解析为可访问 URI：相对路径逐工作区文件夹尝试存在性（fs.stat），
   * 全未命中回退第一个文件夹；绝对路径（含工作区外收藏）直接 Uri.file。
   * 文件不存在也返回最佳猜测 URI——由调用方决定错误呈现（如实提示，不静默）。
   */
  async resolveFavoriteUri(item: FavoriteItem): Promise<vscode.Uri> {
    if (path.isAbsolute(item.path)) {
      return vscode.Uri.file(item.path)
    }
    const folders = vscode.workspace.workspaceFolders ?? []
    for (const folder of folders) {
      const candidate = vscode.Uri.joinPath(folder.uri, ...item.path.split('/'))
      try {
        await vscode.workspace.fs.stat(candidate)
        return candidate
      } catch {
        // 换下一个工作区文件夹
      }
    }
    const fallback = folders[0] ?? this.getWorkspaceFolder()
    if (!fallback) {
      // P3-13：无工作区时相对路径无法解析——给出可读错误（不再返回怪异 URI）
      throw new Error(`无法解析收藏路径：未打开工作区且路径不是绝对路径（${item.path}）。`)
    }
    return vscode.Uri.joinPath(fallback.uri, ...item.path.split('/'))
  }

  /** 打开收藏项：文件 → 编辑器；文件夹 → 资源管理器 reveal。返回目标 URI。 */
  async open(item: FavoriteItem): Promise<vscode.Uri> {
    const uri = await this.resolveFavoriteUri(item)
    if (item.isFolder) {
      await vscode.commands.executeCommand('revealInExplorer', uri)
    } else {
      await vscode.commands.executeCommand('vscode.open', uri)
    }
    return uri
  }

  /** 在资源管理器中显示（文件与文件夹同走 reveal）。 */
  async reveal(item: FavoriteItem): Promise<vscode.Uri> {
    const uri = await this.resolveFavoriteUri(item)
    await vscode.commands.executeCommand('revealInExplorer', uri)
    return uri
  }

  /** 解析后的绝对路径（复制路径用）。 */
  async absolutePath(item: FavoriteItem): Promise<string> {
    return (await this.resolveFavoriteUri(item)).fsPath
  }

  /** 单条去重判定：同解析形态路径已存在。 */
  private findByResolvedPath(storagePath: string): boolean {
    const normalized = toPosix(storagePath)
    return this.items.some((entry) => toPosix(entry.path) === normalized)
  }

  dispose(): void {
    this._onDidChange.dispose()
  }

  private trimToCap(): void {
    if (this.items.length > MAX_FAVORITES) {
      this.items.length = MAX_FAVORITES
    }
  }

  private async persist(): Promise<void> {
    await this.store.save(this.items)
    this._onDidChange.fire()
  }

  /** 由 URI 构造收藏条目；stat 失败视为不可访问（返回 undefined 计入 skipped）。 */
  private async buildItem(uri: vscode.Uri, alias?: string): Promise<FavoriteItem | undefined> {
    let isFolder: boolean // catch 分支直接 return，初值无意义（no-useless-assignment）
    try {
      const stat = await vscode.workspace.fs.stat(uri)
      isFolder = (stat.type & vscode.FileType.Directory) !== 0
    } catch {
      return undefined
    }
    const folder = this.containingWorkspaceFolder(uri)
    const storagePath = folder ? toPosix(path.relative(folder.uri.fsPath, uri.fsPath)) : uri.fsPath
    const fallbackName = path.basename(uri.fsPath) || uri.fsPath
    return {
      id: randomUUID(),
      name: alias && alias.trim().length > 0 ? alias.trim() : fallbackName,
      path: storagePath,
      isFolder,
      addedAt: new Date().toISOString(),
    }
  }

  /** URI 所属工作区文件夹（不在任何文件夹内返回 undefined）。 */
  private containingWorkspaceFolder(uri: vscode.Uri): vscode.WorkspaceFolder | undefined {
    return vscode.workspace.getWorkspaceFolder(uri)
  }
}
