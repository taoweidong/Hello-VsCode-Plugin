import { randomUUID } from 'node:crypto'
import * as path from 'path'
import * as vscode from 'vscode'
import { STORAGE } from '../../constants'
import { writeJsonAtomic } from '../../services/stores/atomicWrite'
import { QueuedStoreMutations } from '../../services/stores/queuedFileStore'

/**
 * 代码书签（v3.6，14 方案）：行级书签 + `Ctrl+Alt+K` 打/取消 + 树视图 / QuickPick /
 * 上一个-下一个循环三种跳转方式（命令壳与树视图见 bookmarksCommands / bookmarksTreeProvider）。
 *
 * - 简单版口径（需求方确认）：只存行号，不做 gutter 装饰与编辑追踪——文件编辑导致
 *   行号漂移即跳错行，由用户自行重打；text 为打点时行文本快照，仅展示用，可能过期；
 * - 存储契约与收藏夹完全同口径：信封 { schemaVersion, items } + 原子写，损坏复制
 *   .bak 后按空数据继续（绝无备份不覆盖），顶层旧数组宽容读取；上限 500 条，
 *   新书签插头部，超出丢最旧；
 * - 数据落点（15 方案口径）：有工作区 → `.vscode/bookmarks.json`；无工作区 →
 *   globalStorage 目录下明文 JSON（手动拷贝即备份迁移）；
 * - 路径：工作区内存 POSIX 相对路径（仓库可迁移），工作区外存绝对 fsPath（同收藏夹）。
 */

/** 书签条目（path 为存储形态；line 为 0-based，展示统一 +1）。 */
export interface BookmarkItem {
  id: string
  /** 工作区内 = POSIX 相对路径；工作区外 = 绝对 fsPath（与收藏夹同口径） */
  path: string
  /** 0-based 行号（VSCode API 口径；展示统一 +1） */
  line: number
  /** 打点行文本快照（trim、截断 100 字符、空行存占位符；仅展示用，可能过期） */
  text: string
  /** ISO 时间 */
  addedAt: string
}

/** 当前存储格式版本（信封 { schemaVersion, items }）。 */
export const BOOKMARKS_SCHEMA_VERSION = 1
/** 书签上限：超出丢最旧（新书签插头部）。 */
export const MAX_BOOKMARKS = 500
/** 行文本快照截断长度。 */
export const BOOKMARK_TEXT_MAX_LENGTH = 100
/** 空行文本快照的展示占位符。 */
export const EMPTY_LINE_TEXT = '(空行)'

/** 相对路径转 POSIX 分隔（存储形态统一，跨平台可迁移；循环排序键也用它）。 */
export function toPosix(value: string): string {
  return value.split('\\').join('/')
}

/** 归一化守卫：缺 path / line 非整数或 <0 逐条丢弃并警告；上限裁剪保留头部（新插头部语义）。 */
export function normalizeBookmarkList(
  raw: unknown,
  onWarning?: (message: string) => void
): BookmarkItem[] {
  if (!Array.isArray(raw)) {
    onWarning?.('书签数据不是数组，已按空数据处理。')
    return []
  }
  const items: BookmarkItem[] = []
  let dropped = 0
  for (const entry of raw) {
    const item = normalizeBookmarkItem(entry)
    if (item) {
      items.push(item)
    } else {
      dropped += 1
    }
  }
  if (dropped > 0) {
    onWarning?.(`书签数据中 ${dropped} 条记录缺少合法 path/line，已丢弃。`)
  }
  if (items.length > MAX_BOOKMARKS) {
    onWarning?.(
      `书签数量 ${items.length} 超上限 ${MAX_BOOKMARKS}，已保留最新 ${MAX_BOOKMARKS} 条。`
    )
    items.length = MAX_BOOKMARKS
  }
  return items
}

function normalizeBookmarkItem(entry: unknown): BookmarkItem | undefined {
  if (typeof entry !== 'object' || entry === null) {
    return undefined
  }
  const record = entry as Record<string, unknown>
  if (typeof record.path !== 'string' || record.path.trim().length === 0) {
    return undefined
  }
  if (typeof record.line !== 'number' || !Number.isInteger(record.line) || record.line < 0) {
    return undefined
  }
  return {
    id: typeof record.id === 'string' && record.id.length > 0 ? record.id : randomUUID(),
    path: record.path,
    line: record.line,
    text: typeof record.text === 'string' ? record.text : '',
    addedAt: typeof record.addedAt === 'string' ? record.addedAt : new Date().toISOString(),
  }
}

/** 书签数据源抽象（双实现：工作区文件 + globalStorage 明文文件）。 */
export interface IBookmarksStore {
  load(): Promise<BookmarkItem[]>
  save(items: BookmarkItem[]): Promise<void>
  /** 数据文件落点（「打开数据文件」命令依赖；15 方案口径）。 */
  dataFileUri(): vscode.Uri
}

/** 默认数据源：工作区 `.vscode/bookmarks.json`（损坏契约与收藏夹一致）。 */
export class JsonBookmarksStore implements IBookmarksStore {
  constructor(
    public readonly fileUri: vscode.Uri,
    private readonly options: { onWarning?: (message: string) => void } = {}
  ) {}

  async load(): Promise<BookmarkItem[]> {
    let text: string
    try {
      const raw = await vscode.workspace.fs.readFile(this.fileUri)
      text = Buffer.from(raw).toString('utf8')
    } catch (err) {
      if (err instanceof vscode.FileSystemError && err.code === 'FileNotFound') {
        return [] // 首次使用：视为空数据
      }
      this.options.onWarning?.(
        `读取书签数据失败（${this.fileUri.fsPath}）：${err instanceof Error ? err.message : String(err)}`
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
        '书签数据文件为顶层数组格式，已兼容读取，下次保存自动迁移为信封格式。'
      )
      return normalizeBookmarkList(data, this.options.onWarning)
    }
    if (
      typeof data === 'object' &&
      data !== null &&
      Array.isArray((data as { items?: unknown }).items)
    ) {
      const envelope = data as { schemaVersion?: unknown; items: unknown[] }
      if (
        envelope.schemaVersion !== undefined &&
        envelope.schemaVersion !== BOOKMARKS_SCHEMA_VERSION
      ) {
        this.options.onWarning?.(
          `书签数据 schemaVersion=${String(envelope.schemaVersion)} 与当前版本 ${BOOKMARKS_SCHEMA_VERSION} 不一致，已尽力按 items 读取。`
        )
      }
      return normalizeBookmarkList(envelope.items, this.options.onWarning)
    }
    return this.recoverFromCorruption('根节点既不是数组，也不是含 items 数组的对象')
  }

  async save(items: BookmarkItem[]): Promise<void> {
    await writeJsonAtomic(this.fileUri, { schemaVersion: BOOKMARKS_SCHEMA_VERSION, items })
  }

  dataFileUri(): vscode.Uri {
    return this.fileUri
  }

  /** 损坏恢复：复制备份（原文件不动）→ 警告上报 → 按空数据继续；备份失败抛错。 */
  private async recoverFromCorruption(reason: string): Promise<BookmarkItem[]> {
    const dirUri = vscode.Uri.joinPath(this.fileUri, '..')
    const backupUri = vscode.Uri.joinPath(
      dirUri,
      `${path.basename(this.fileUri.fsPath)}.corrupt-${Date.now()}-${randomUUID().slice(0, 8)}.bak`
    )
    try {
      await vscode.workspace.fs.copy(this.fileUri, backupUri)
    } catch (err) {
      throw new Error(
        `书签数据文件损坏且备份失败：无法将 ${this.fileUri.fsPath} 复制为 ${backupUri.fsPath}` +
          `（${err instanceof Error ? err.message : String(err)}）。原文件保留在原位，请手动处理。`,
        { cause: err }
      )
    }
    this.options.onWarning?.(
      `书签数据文件损坏（${reason}）。原文件保留在原位，已复制备份到 ${path.basename(backupUri.fsPath)}，本次按空数据继续。`
    )
    return []
  }
}

/**
 * 备用数据源：无工作区时落到 globalStorage 目录下的明文 JSON（15 方案口径——
 * 手动拷贝该文件即可备份/迁移；writeJsonAtomic 自带 createDirectory，无需预建目录）。
 */
export class GlobalJsonBookmarksStore extends JsonBookmarksStore {}

/** 装配：有工作区 → 工作区文件；无工作区 → globalStorage 明文 JSON。 */
export function createBookmarksStore(
  context: vscode.ExtensionContext,
  options: { onWarning?: (message: string) => void } = {}
): IBookmarksStore {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri
  if (root) {
    return new JsonBookmarksStore(
      vscode.Uri.joinPath(root, ...STORAGE.bookmarksFileName.split('/')),
      options
    )
  }
  return new GlobalJsonBookmarksStore(
    vscode.Uri.joinPath(context.globalStorageUri, STORAGE.bookmarksGlobalFileName),
    options
  )
}

/** 书签业务服务：命令与树视图的唯一数据入口。 */
export class BookmarksService implements vscode.Disposable {
  private items: BookmarkItem[] = []
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
    private readonly store: IBookmarksStore,
    /** 工作区文件夹提供者（可注入，测试友好；默认第一个工作区文件夹；resolveBookmarkUri 回退用）。 */
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
      this.loadError = err instanceof Error ? err.message : String(err)
    }
  }

  list(): BookmarkItem[] {
    return [...this.items]
  }

  /**
   * 把存储路径解析为可访问 URI（与收藏夹 resolveFavoriteUri 同语义）：
   * 相对路径逐工作区文件夹尝试 fs.stat 存在性，命中即用；全未命中回退第一个
   * 文件夹；绝对路径（含工作区外书签）直接 Uri.file。文件不存在也返回最佳
   * 猜测 URI——由调用方决定错误呈现（jump 时 openTextDocument 如实报错）。
   */
  async resolveBookmarkUri(item: BookmarkItem): Promise<vscode.Uri> {
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

  /**
   * 跳转：解析 URI → 打开文档 → selection 置行首 + reveal 居中（视口外才居中）。
   * 行号越界（文件被改短）钳制到最后一行并如实提示；空文档定位到第 0 行。
   */
  async jump(item: BookmarkItem): Promise<vscode.Uri> {
    const uri = await this.resolveBookmarkUri(item)
    const document = await vscode.workspace.openTextDocument(uri)
    const editor = await vscode.window.showTextDocument(document)
    let line = item.line
    if (document.lineCount > 0 && item.line > document.lineCount - 1) {
      line = document.lineCount - 1
      void vscode.window.showInformationMessage(
        `书签行号越界（L${item.line + 1}），已定位到文件末尾。`
      )
    }
    const position = new vscode.Position(line, 0)
    editor.selection = new vscode.Selection(position, position)
    editor.revealRange(
      new vscode.Range(position, position),
      vscode.TextEditorRevealType.InCenterIfOutsideViewport
    )
    return uri
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

  /** 工作区内 → POSIX 相对路径；否则绝对 fsPath（同步判定，与收藏夹添加口径一致）。 */
  storagePathFor(uri: vscode.Uri): string {
    const folder = vscode.workspace.getWorkspaceFolder(uri)
    return folder ? toPosix(path.relative(folder.uri.fsPath, uri.fsPath)) : uri.fsPath
  }

  /** 行文本快照：trim → 空行占位符 → 超长截断。 */
  snapshotText(text: string): string {
    const trimmed = text.trim()
    if (trimmed.length === 0) {
      return EMPTY_LINE_TEXT
    }
    return trimmed.slice(0, BOOKMARK_TEXT_MAX_LENGTH)
  }

  /**
   * toggle：同文件同 line 已存在 → 移除并返回 removed；否则插头部返回 added
   * （上限裁剪丢最旧）。line 为 0-based。
   */
  toggle(
    uri: vscode.Uri,
    line: number,
    text: string
  ): Promise<{ added?: BookmarkItem; removed?: BookmarkItem }> {
    return this.mutations.run(async () => {
      const key = toPosix(this.storagePathFor(uri))
      const existing = this.items.find((item) => toPosix(item.path) === key && item.line === line)
      if (existing) {
        this.items = this.items.filter((item) => item !== existing)
        await this.persist()
        return { removed: existing }
      }
      const item: BookmarkItem = {
        id: randomUUID(),
        path: this.storagePathFor(uri),
        line,
        text: this.snapshotText(text),
        addedAt: new Date().toISOString(),
      }
      this.items = [item, ...this.items]
      this.trimToCap()
      await this.persist()
      return { added: item }
    })
  }

  /** 移除书签（id 不存在返回 false）。 */
  remove(id: string): Promise<boolean> {
    return this.mutations.run(async () => {
      const before = this.items.length
      this.items = this.items.filter((item) => item.id !== id)
      if (this.items.length === before) {
        return false
      }
      await this.persist()
      return true
    })
  }

  /** 清空全部书签，返回清除条数（空数据不触发持久化）。 */
  clear(): Promise<number> {
    return this.mutations.run(async () => {
      const count = this.items.length
      if (count > 0) {
        this.items = []
        await this.persist()
      }
      return count
    })
  }

  /** 循环导航顺序：按 (toPosix(path), line) 升序的排序副本（空间顺序即导航顺序）。 */
  ordered(): BookmarkItem[] {
    return [...this.items].sort((a, b) => {
      const ap = toPosix(a.path)
      const bp = toPosix(b.path)
      if (ap !== bp) {
        return ap < bp ? -1 : 1
      }
      return a.line - b.line
    })
  }

  /**
   * 循环导航（14 方案 §5 定死口径）：排序键 (toPosix(path), line) 升序；
   * 「当前位置」由 uri+line 按与打书签相同的规则归一化后构造同序比较键
   * （无活动编辑器传 undefined → next 跳第一条 / prev 跳最后一条）；
   * next = 严格晚于当前键的第一条（尾后回绕到首），prev = 严格早于的第一条
   * （首前回绕到尾）；当前文件无书签不是特殊分支，排序键始终可比，回绕自然覆盖。
   * 路径比较用普通字符串序（不用 localeCompare，保证跨环境确定性）。
   */
  next(
    uri: vscode.Uri | undefined,
    line: number | undefined,
    direction: 'next' | 'prev'
  ): BookmarkItem | undefined {
    const items = this.ordered()
    if (items.length === 0) {
      return undefined
    }
    if (uri === undefined || line === undefined) {
      return direction === 'next' ? items[0] : items[items.length - 1]
    }
    const currentPath = toPosix(this.storagePathFor(uri))
    const compare = (item: BookmarkItem): number => {
      const itemPath = toPosix(item.path)
      if (itemPath !== currentPath) {
        return itemPath < currentPath ? -1 : 1
      }
      return item.line - line
    }
    if (direction === 'next') {
      return items.find((item) => compare(item) > 0) ?? items[0]
    }
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index]
      if (item && compare(item) < 0) {
        return item
      }
    }
    return items[items.length - 1]
  }

  dispose(): void {
    this._onDidChange.dispose()
  }

  private trimToCap(): void {
    if (this.items.length > MAX_BOOKMARKS) {
      this.items.length = MAX_BOOKMARKS
    }
  }

  private async persist(): Promise<void> {
    await this.store.save(this.items)
    this._onDidChange.fire()
  }
}
