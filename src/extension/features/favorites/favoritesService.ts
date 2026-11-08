import { randomUUID } from 'node:crypto'
import * as path from 'path'
import * as vscode from 'vscode'
import { STORAGE } from '../../constants'
import { writeJsonAtomic } from '../../services/stores/atomicWrite'

/**
 * 收藏夹（v3.4，13 方案）：文件 / 文件夹路径收藏 + 别名 + 单击跳转。
 *
 * - 存储契约与 serial-servers 同口径：信封 { schemaVersion, items } + 原子写，
 *   损坏复制 .bak 后按空数据继续（绝无备份不覆盖）；顶层旧数组宽容读取；
 *   无工作区回退 globalState（双实现）；
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

/** 收藏数据源抽象（双实现：工作区文件 + Memento）。 */
export interface IFavoritesStore {
  load(): Promise<FavoriteItem[]>
  save(items: FavoriteItem[]): Promise<void>
}

/** 默认数据源：工作区 `.vscode/favorites.json`（损坏契约与 serial-servers 一致）。 */
export class JsonFavoritesStore implements IFavoritesStore {
  constructor(
    public readonly fileUri: vscode.Uri,
    private readonly options: { onWarning?: (message: string) => void } = {}
  ) {}

  async load(): Promise<FavoriteItem[]> {
    let text: string
    try {
      const raw = await vscode.workspace.fs.readFile(this.fileUri)
      text = Buffer.from(raw).toString('utf8')
    } catch (err) {
      if (err instanceof vscode.FileSystemError && err.code === 'FileNotFound') {
        return [] // 首次使用：视为空数据
      }
      this.options.onWarning?.(
        `读取收藏数据失败（${this.fileUri.fsPath}）：${err instanceof Error ? err.message : String(err)}`
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
    if (Array.isArray(data)) {
      // 顶层数组（手写常见形态）：宽容读取，下次保存自动迁移为信封
      this.options.onWarning?.(
        '收藏数据文件为顶层数组格式，已兼容读取，下次保存自动迁移为信封格式。'
      )
      return normalizeFavoriteList(data, this.options.onWarning)
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
        this.options.onWarning?.(
          `收藏数据 schemaVersion=${String(envelope.schemaVersion)} 与当前版本 ${FAVORITES_SCHEMA_VERSION} 不一致，已尽力按 items 读取。`
        )
      }
      return normalizeFavoriteList(envelope.items, this.options.onWarning)
    }
    return this.recoverFromCorruption('根节点既不是数组，也不是含 items 数组的对象')
  }

  async save(items: FavoriteItem[]): Promise<void> {
    await writeJsonAtomic(this.fileUri, { schemaVersion: FAVORITES_SCHEMA_VERSION, items })
  }

  /** 损坏恢复：复制备份（原文件不动）→ 警告上报 → 按空数据继续；备份失败抛错。 */
  private async recoverFromCorruption(reason: string): Promise<FavoriteItem[]> {
    const dirUri = vscode.Uri.joinPath(this.fileUri, '..')
    const backupUri = vscode.Uri.joinPath(
      dirUri,
      `${path.basename(this.fileUri.fsPath)}.corrupt-${Date.now()}-${randomUUID().slice(0, 8)}.bak`
    )
    try {
      await vscode.workspace.fs.copy(this.fileUri, backupUri)
    } catch (err) {
      throw new Error(
        `收藏数据文件损坏且备份失败：无法将 ${this.fileUri.fsPath} 复制为 ${backupUri.fsPath}` +
          `（${err instanceof Error ? err.message : String(err)}）。原文件保留在原位，请手动处理。`,
        { cause: err }
      )
    }
    this.options.onWarning?.(
      `收藏数据文件损坏（${reason}）。原文件保留在原位，已复制备份到 ${path.basename(backupUri.fsPath)}，本次按空数据继续。`
    )
    return []
  }
}

/** 备用数据源：无工作区时经 globalState 持久化。 */
export class MementoFavoritesStore implements IFavoritesStore {
  constructor(
    private readonly memento: vscode.Memento,
    private readonly key: string,
    private readonly options: { onWarning?: (message: string) => void } = {}
  ) {}

  async load(): Promise<FavoriteItem[]> {
    return normalizeFavoriteList(this.memento.get<unknown>(this.key, []), this.options.onWarning)
  }

  async save(items: FavoriteItem[]): Promise<void> {
    await this.memento.update(this.key, items)
  }
}

/** 装配：有工作区 → 工作区文件；无工作区 → globalState。 */
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
  return new MementoFavoritesStore(context.globalState, STORAGE.favoritesMementoKey, options)
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

  constructor(
    private readonly store: IFavoritesStore,
    /** 工作区文件夹提供者（可注入，测试友好；默认第一个工作区文件夹）。 */
    private readonly getWorkspaceFolder: () => vscode.WorkspaceFolder | undefined = () =>
      vscode.workspace.workspaceFolders?.[0]
  ) {}

  /** 加载持久化数据（激活时调用；失败保留空列表并记录原因）。 */
  async load(): Promise<void> {
    try {
      this.items = await this.store.load()
      this.loadError = undefined
    } catch (err) {
      this.items = []
      this.loadError = err instanceof Error ? err.message : String(err)
    }
    this._onDidChange.fire()
  }

  list(): FavoriteItem[] {
    return [...this.items]
  }

  /** 批量添加（单选/多选统一入口）；重复路径跳过；别名缺省 basename；保持选择顺序插头部。 */
  async add(uris: readonly vscode.Uri[], alias?: string): Promise<AddFavoritesResult> {
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
  }

  /** 重命名别名（id 不存在返回 false）。 */
  async rename(id: string, name: string): Promise<boolean> {
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
  }

  /** 移除收藏（id 不存在返回 false）。 */
  async remove(id: string): Promise<boolean> {
    const before = this.items.length
    this.items = this.items.filter((entry) => entry.id !== id)
    if (this.items.length === before) {
      return false
    }
    await this.persist()
    return true
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
    return vscode.Uri.joinPath(fallback?.uri ?? vscode.Uri.file(path.sep), ...item.path.split('/'))
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
