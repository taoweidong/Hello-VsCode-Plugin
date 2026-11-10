/**
 * `vscode` 模块的单元测试桩（NFR-07 / docs/需求与优化方案/03 §6.1）。
 *
 * 由 vitest.config.ts 的 resolve.alias 将 `import * as vscode from 'vscode'`
 * 重定向到本文件——被测源码零改动即可在无 VSCode 宿主的环境下运行。
 *
 * 设计原则：
 * - 只覆盖 src/ 实际使用到的 API 面；缺什么由用例作者按需补充（勿删已有导出）；
 * - 副作用可观测、可重置：统一经 `__resetStubs()` / `__stubs` 访问与清理；
 * - `workspace.fs` 基于真实 Node fs（测试用临时目录），错误映射为 FileSystemError
 *   并携带 VSCode 语义的 code（'FileNotFound' 等）。
 */
import * as nodeFs from 'node:fs'
import * as nodeFsPromises from 'node:fs/promises'
import * as nodePath from 'node:path'

/* ---------------- 基础类型与枚举 ---------------- */

export enum FileType {
  Unknown = 0,
  File = 1,
  Directory = 2,
  SymbolicLink = 64,
}

export enum ConfigurationTarget {
  Global = 1,
  Workspace = 2,
  WorkspaceFolder = 3,
}

export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2,
}

export const QuickPickItemKind = { Separator: -1, Default: 0 } as const

export const ProgressLocation = {
  SourceControl: 1,
  Window: 10,
  Notification: 15,
} as const

/** 与真实 vscode.ViewColumn 对齐的最小枚举（createWebviewPanel 的 showOptions 用）。 */
export enum ViewColumn {
  Active = 1,
  Beside = 2,
  One = 1,
  Two = 2,
  Three = 3,
}

/** 任务作用域枚举（任务管理器 v2.3：区分工作区文件夹 scope 与 Workspace 全局） */
export enum TaskScope {
  Global = 1,
  Workspace = 2,
  WorkspaceFolder = 3,
}

/** 任务分组常量（与真实 vscode.TaskGroup 一致：同 id 实例在真实宿主中是单例） */
export const TaskGroup = {
  Build: { id: 'build', value: 'build' },
  Clean: { id: 'clean', value: 'clean' },
  Rebuild: { id: 'rebuild', value: 'rebuild' },
  Test: { id: 'test', value: 'test' },
} as const

/** 编辑器滚动方式常量（定位到 tasks.json 行用） */
export const TextEditorRevealType = {
  Default: 0,
  InCenter: 1,
  InCenterIfOutsideViewport: 2,
  AtTop: 3,
} as const

/* ---------------- 可释放 / 事件 ---------------- */

export class Disposable {
  constructor(private readonly callback: () => void) {}
  dispose(): void {
    this.callback()
  }
}

export class EventEmitter<T> {
  private listeners = new Set<(e: T) => unknown>()
  private disposed = false

  /**
   * 订阅事件（对齐真实 vscode.Event 语义：传入监听器、返回可退订 Disposable）。
   * 注意：早期版本误将本属性实现为「触发函数」，导致 .event(listener) 变成触发而非订阅，
   * 现已修正——触发一律走 fire()/各桩的 __fire* 入口。
   */
  get event(): (listener: (e: T) => unknown) => Disposable {
    return (listener: (e: T) => unknown) => {
      this.listeners.add(listener)
      return new Disposable(() => this.listeners.delete(listener))
    }
  }

  fire(data: T): void {
    if (this.disposed) {
      return // 已释放的事件源不再分发（对齐真实语义）
    }
    for (const listener of [...this.listeners]) {
      listener(data)
    }
  }

  dispose(): void {
    this.disposed = true
    this.listeners.clear()
  }
}

/* ---------------- URI / 文件系统 ---------------- */

function toPosix(p: string): string {
  return p.split('\\').join('/')
}

export class Uri {
  readonly scheme: string
  readonly fsPath: string
  readonly path: string
  readonly authority: string
  readonly query: string
  readonly fragment: string

  constructor(parts: { scheme: string; fsPath: string; query?: string; fragment?: string }) {
    this.scheme = parts.scheme
    this.fsPath = parts.fsPath
    this.path = toPosix(parts.fsPath)
    this.query = parts.query ?? ''
    this.fragment = parts.fragment ?? ''
    this.authority = ''
  }

  static file(path: string): Uri {
    return new Uri({ scheme: 'file', fsPath: nodePath.normalize(path) })
  }

  static parse(value: string): Uri {
    return Uri.file(value.replace(/^file:\/\//, ''))
  }

  static joinPath(base: Uri, ...pathSegments: string[]): Uri {
    return new Uri({
      scheme: base.scheme,
      fsPath: nodePath.normalize(nodePath.join(base.fsPath, ...pathSegments)),
    })
  }

  with(change: { query?: string; fragment?: string }): Uri {
    return new Uri({
      scheme: this.scheme,
      fsPath: this.fsPath,
      query: change.query ?? this.query,
      fragment: change.fragment ?? this.fragment,
    })
  }

  toString(): string {
    return `${this.scheme}://${toPosix(this.fsPath)}${this.query ? `?${this.query}` : ''}`
  }
}

export class FileSystemError extends Error {
  readonly code: string
  constructor(message: string, code = 'Unknown') {
    super(message)
    this.name = 'FileSystemError'
    this.code = code
  }
  static FileNotFound(uri: Uri): FileSystemError {
    return new FileSystemError(uri.fsPath, 'FileNotFound')
  }
}

function toFileType(stat: nodeFs.Stats): FileType {
  if (stat.isFile()) return FileType.File
  if (stat.isDirectory()) return FileType.Directory
  if (stat.isSymbolicLink()) return FileType.SymbolicLink
  return FileType.Unknown
}

function mapFsError(err: unknown, uri: Uri): unknown {
  if (err instanceof FileSystemError) return err
  const code = (err as NodeJS.ErrnoException)?.code
  if (code === 'ENOENT') return FileSystemError.FileNotFound(uri)
  if (code === 'EACCES' || code === 'EPERM') return new FileSystemError(uri.fsPath, 'NoPermissions')
  if (code === 'EISDIR') return new FileSystemError(uri.fsPath, 'FileIsADirectory')
  if (code === 'ENOTDIR') return new FileSystemError(uri.fsPath, 'FileNotADirectory')
  return err
}

/* ---------------- 配置存储 ---------------- */

interface ConfigurationLike {
  get<T>(section: string, defaultValue?: T): T
  update(section: string, value: unknown, target?: ConfigurationTarget): Promise<void>
  has(section: string): boolean
  inspect(section: string): unknown
}

/**
 * 配置存储：section → key → value，分「用户（全局）」与「工作区」两层，
 * 模拟 VSCode 的合并语义：get 工作区优先；inspect 同时报告两个作用域。
 */
const configStore = new Map<string, Map<string, unknown>>()
const workspaceConfigStore = new Map<string, Map<string, unknown>>()

function storeFor(target?: ConfigurationTarget): Map<string, Map<string, unknown>> {
  return target === ConfigurationTarget.Workspace ? workspaceConfigStore : configStore
}

function makeConfiguration(section: string): ConfigurationLike {
  return {
    get<T>(key: string, defaultValue?: T): T {
      const value =
        workspaceConfigStore.get(section)?.get(key) ?? configStore.get(section)?.get(key)
      return (value === undefined ? defaultValue : value) as T
    },
    async update(key: string, value: unknown, target?: ConfigurationTarget): Promise<void> {
      __record('configUpdate', { section, key, value })
      const store = storeFor(target)
      if (!store.has(section)) {
        store.set(section, new Map())
      }
      store.get(section)!.set(key, value)
      fireConfigChange(`${section}.${key}`)
    },
    has(key: string): boolean {
      return (
        workspaceConfigStore.get(section)?.has(key) ?? configStore.get(section)?.has(key) ?? false
      )
    },
    inspect(key: string): unknown {
      return {
        key: `${section}.${key}`,
        globalValue: configStore.get(section)?.get(key),
        workspaceValue: workspaceConfigStore.get(section)?.get(key),
      }
    },
  }
}

const configChangeListeners = new Set<
  (event: { affectsConfiguration(section: string): boolean }) => unknown
>()

function fireConfigChange(fullKey: string): void {
  const event = {
    affectsConfiguration(section: string): boolean {
      return fullKey === section || fullKey.startsWith(`${section}.`)
    },
  }
  for (const listener of [...configChangeListeners]) {
    listener(event)
  }
}

/** 测试入口：模拟某个配置键发生变化（fullKey 形如 'extStarter.storagePath'）。 */
export function __fireConfigurationChange(fullKey: string): void {
  fireConfigChange(fullKey)
}

/* ---------------- 工作区文件夹变化 / 信任授予监听 ---------------- */

const workspaceFoldersListeners = new Set<() => unknown>()

/** 测试入口：模拟工作区文件夹集合变化（增删文件夹 / 首次打开）。 */
export function __fireWorkspaceFoldersChanged(): void {
  for (const listener of [...workspaceFoldersListeners]) {
    listener()
  }
}

const trustListeners = new Set<() => unknown>()

/** 测试入口：模拟工作区信任授予（受限模式 → 正常）。 */
export function __fireWorkspaceTrustGranted(): void {
  for (const listener of [...trustListeners]) {
    listener()
  }
}

/* ---------------- 录制器 ---------------- */

type Recorded = { kind: string; args: unknown[] }

const recorded: Recorded[] = []
function __record(kind: string, payload?: unknown): void {
  recorded.push({ kind, args: payload === undefined ? [] : [payload] })
}

/** 对话框 / QuickPick / InputBox 的排队应答（shift 取用；空则返回 undefined）。 */
const dialogQueue: unknown[] = []

/**
 * 活动编辑器桩的最小结构面（draftCommands / copyCommands 只消费这三处：
 * document.getText(selection)、document.fileName、document.uri）。测试直接构造。
 */
export interface ActiveTextEditorStub {
  document: {
    uri: Uri
    fileName: string
    getText(selection?: unknown): string
  }
  selection: unknown
}

export interface StubState {
  recorded: Recorded[]
  dialogQueue: unknown[]
  outputLines: string[]
  registeredCommands: Map<string, (...args: unknown[]) => unknown>
  /** 已注册的 Webview 面板序列化器（viewType → serializer），供窗口重载恢复用例驱动。 */
  registeredSerializers: Map<
    string,
    { deserializeWebviewPanel(panel: unknown, state: unknown): Promise<void> }
  >
  clipboard: string
  workspaceFolders: { uri: Uri; name: string; index: number }[] | undefined
  isTrusted: boolean
  /** fetchTasks 返回的工作区任务（任务管理器 v2.3） */
  workspaceTasks: Task[]
  /** 当前活动的任务执行列表（tasks.taskExecutions 的 getter 读这里） */
  taskExecutions: FakeTaskExecution[]
  /** 假文本文档内容（uri.toString() → 文件全文），openTextDocument 读取 */
  documents: Map<string, string>
  /** 可注入的 fetchTasks / executeTask 抛错 */
  fetchTasksError: unknown
  executeTaskError: unknown
  /** 可注入的活动编辑器（draftCommands / copyCommands 成功路径用；undefined = 无编辑器） */
  activeTextEditor:
    | ActiveTextEditorStub
    | undefined /** 已创建的 FileSystemWatcher 桩（供测试用 __fireChange 等驱动） */
  fileWatchers: {
    onDidChange: (cb: () => unknown) => Disposable
    onDidCreate: (cb: () => unknown) => Disposable
    onDidDelete: (cb: () => unknown) => Disposable
    __fireChange: () => void
    __fireCreate: () => void
    __fireDelete: () => void
    dispose: () => void
  }[]
  /** 已创建的终端桩（快捷命令 v3.5；createTerminal 按序追加） */
  terminals: Terminal[]
  /** 可注入的活动终端（captureTerminalSelection / execute 用；undefined = 无） */
  activeTerminal: Terminal | undefined
}

export const __stubs: StubState = {
  recorded,
  dialogQueue,
  outputLines: [],
  registeredCommands: new Map(),
  registeredSerializers: new Map(),
  clipboard: '',
  workspaceFolders: undefined,
  isTrusted: true,
  workspaceTasks: [],
  taskExecutions: [],
  documents: new Map(),
  fetchTasksError: undefined,
  executeTaskError: undefined,
  activeTextEditor: undefined,
  fileWatchers: [],
  terminals: [],
  activeTerminal: undefined,
}

/** 每个用例 setup 时调用：清空全部副作用。 */
export function __resetStubs(options?: { keepWorkspaceFolders?: boolean }): void {
  recorded.length = 0
  dialogQueue.length = 0
  __stubs.outputLines.length = 0
  __stubs.registeredCommands.clear()
  __stubs.registeredSerializers.clear()
  __stubs.clipboard = ''
  configStore.clear()
  workspaceConfigStore.clear()
  configChangeListeners.clear()
  workspaceFoldersListeners.clear()
  trustListeners.clear()
  if (!options?.keepWorkspaceFolders) {
    __stubs.workspaceFolders = undefined
  }
  __stubs.isTrusted = true
  __stubs.workspaceTasks = []
  __stubs.taskExecutions = []
  __stubs.documents.clear()
  __stubs.fetchTasksError = undefined
  __stubs.executeTaskError = undefined
  __stubs.activeTextEditor = undefined
  __stubs.fileWatchers = []
  __stubs.terminals = []
  __stubs.activeTerminal = undefined
  taskStartEmitter = new EventEmitter<FakeTaskExecution>()
  taskEndEmitter = new EventEmitter<FakeTaskExecution>()
}

/** 写入配置（等价于用户设置）。 */
export function __setConfig(section: string, key: string, value: unknown): void {
  if (!configStore.has(section)) {
    configStore.set(section, new Map())
  }
  configStore.get(section)!.set(key, value)
}

/* ---------------- window ---------------- */

/** 终端桩：形状对齐真实 vscode.Terminal 的快捷命令消费面（name/exitStatus/show/sendText）。 */
export class Terminal {
  exitStatus: { reason: string } | undefined = undefined
  constructor(
    readonly name: string,
    readonly creationOptions?: { name?: string; cwd?: string | Uri }
  ) {}
  show(preserveFocus?: boolean): void {
    __record('terminalShow', { name: this.name, preserveFocus })
  }
  sendText(text: string, shouldExecute?: boolean): void {
    __record('terminalSendText', { name: this.name, text, shouldExecute })
  }
  dispose(): void {
    __record('terminalDispose', this.name)
  }
}

function nextDialogAnswer(): unknown {
  return dialogQueue.length ? dialogQueue.shift() : undefined
}

function createOutputChannelStub(name: string) {
  return {
    name,
    appendLine(line: string): void {
      __stubs.outputLines.push(line)
    },
    append(value: string): void {
      __stubs.outputLines.push(value)
    },
    replace(value: string): void {
      __stubs.outputLines.push(value)
    },
    clear(): void {},
    show(): void {
      __record('outputShow', name)
    },
    hide(): void {},
    dispose(): void {},
  }
}

export const window = {
  createOutputChannel: (name: string) => createOutputChannelStub(name),
  /**
   * 终端桩（快捷命令 v3.5）：创建即录制并入 __stubs.terminals；
   * sendText / show 录制，exitStatus 公开可变（测试手动置值模拟用户关闭终端）。
   */
  createTerminal: (options?: { name?: string; cwd?: string | Uri }) => {
    __record('createTerminal', options)
    const terminal = new Terminal(options?.name ?? 'stub-terminal')
    __stubs.terminals.push(terminal)
    return terminal
  },
  /** 活动终端（测试经 __stubs.activeTerminal 注入；undefined = 无）。 */
  get activeTerminal(): Terminal | undefined {
    return __stubs.activeTerminal
  },
  /** 活动编辑器（测试经 __stubs.activeTextEditor 注入；真实形态见 ActiveTextEditorStub）。 */
  get activeTextEditor(): ActiveTextEditorStub | undefined {
    return __stubs.activeTextEditor
  },
  showInformationMessage: (message: string, ...items: unknown[]) => {
    __record('showInformationMessage', { message, items })
    return Promise.resolve(nextDialogAnswer())
  },
  showWarningMessage: (message: string, ...items: unknown[]) => {
    __record('showWarningMessage', { message, items })
    return Promise.resolve(nextDialogAnswer())
  },
  showErrorMessage: (message: string, ...items: unknown[]) => {
    __record('showErrorMessage', { message, items })
    return Promise.resolve(nextDialogAnswer())
  },
  showQuickPick: (items: unknown, options?: unknown) => {
    __record('showQuickPick', { items, options })
    return Promise.resolve(nextDialogAnswer())
  },
  showInputBox: (options?: unknown) => {
    __record('showInputBox', options)
    return Promise.resolve(nextDialogAnswer())
  },
  showTextDocument: (uriOrDocument: unknown, options?: unknown) => {
    __record('showTextDocument', { uriOrDocument, options })
    const uri = (uriOrDocument as { uri?: Uri } | undefined)?.uri
    return Promise.resolve({
      document: uriOrDocument,
      uri,
      revealRange: (range: unknown, revealType?: unknown) => {
        __record('revealRange', { range, revealType })
      },
    })
  },
  createTreeView: (viewId: string, options?: unknown) => {
    __record('createTreeView', { viewId, options })
    return {
      viewId,
      message: undefined,
      badge: undefined,
      reveal: () => Promise.resolve(),
      dispose: () => {},
    }
  },
  createWebviewPanel: (
    viewType: string,
    title: string,
    showOptions: unknown,
    options?: unknown
  ) => {
    __record('createWebviewPanel', { viewType, title, showOptions, options })
    return createWebviewPanelStub(viewType, title)
  },
  /** 面板序列化器注册（录制 + 可经 __stubs.registeredSerializers 驱动恢复）。 */
  registerWebviewPanelSerializer: (
    viewType: string,
    serializer: { deserializeWebviewPanel(panel: unknown, state: unknown): Promise<void> }
  ): Disposable => {
    __record('registerWebviewPanelSerializer', viewType)
    __stubs.registeredSerializers.set(viewType, serializer)
    return new Disposable(() => __stubs.registeredSerializers.delete(viewType))
  },
  /** 文件夹 / 文件选择框：应答经 dialogQueue 队列（数组元素为 Uri[]，取消为 undefined）。 */
  showOpenDialog: (options?: unknown) => {
    __record('showOpenDialog', options)
    return Promise.resolve(nextDialogAnswer() as Uri[] | undefined)
  },
  withProgress: async <T>(
    options: unknown,
    task: (
      progress: { report(value: { message?: string; increment?: number }): void },
      token: {
        isCancellationRequested: boolean
        onCancellationRequested(cb: () => void): Disposable
      }
    ) => Promise<T>
  ): Promise<T> => {
    __record('withProgress', options)
    return task(
      { report: (value) => __record('progressReport', value) },
      {
        isCancellationRequested: false,
        onCancellationRequested: () => new Disposable(() => {}),
      }
    )
  },
}

/** 测试用 Webview 面板桩：postMessage 可经 webview.__emit 直接触发页面消息回调。 */
export function createWebviewPanelStub(viewType: string, title: string) {
  const messageListeners = new Set<(message: unknown) => unknown>()
  const panel = {
    viewType,
    title,
    visible: true,
    active: true,
    webview: {
      html: '',
      cspSource: 'vscode-webview://stub-csp-source',
      options: {} as Record<string, unknown>,
      postMessage: async (message: unknown): Promise<boolean> => {
        __record('webviewPostMessage', message)
        return true
      },
      asWebviewUri: (uri: Uri): Uri => uri,
      onDidReceiveMessage: (listener: (message: unknown) => unknown): Disposable => {
        messageListeners.add(listener)
        return new Disposable(() => messageListeners.delete(listener))
      },
      /** 测试入口：模拟页面发来的消息。 */
      __emit: (message: unknown): void => {
        for (const listener of [...messageListeners]) {
          void listener(message)
        }
      },
    },
    onDidDispose: (cb: () => unknown): Disposable => new Disposable(() => void cb()),
    onDidChangeViewState: (cb: () => unknown): Disposable => new Disposable(() => void cb()),
    reveal: (): void => {
      __record('panelReveal', viewType)
    },
    dispose: (): void => {
      __record('panelDispose', viewType)
    },
  }
  return panel
}

/* ---------------- workspace ---------------- */

async function fsCall<T>(uri: Uri, op: () => Promise<T>): Promise<T> {
  try {
    return await op()
  } catch (err) {
    throw mapFsError(err, uri)
  }
}

export const workspace = {
  name: 'stub-workspace',
  workspaceFolders: undefined as { uri: Uri; name: string; index: number }[] | undefined,
  isTrusted: true,
  getConfiguration: (section?: string): ConfigurationLike => makeConfiguration(section ?? ''),
  fs: {
    readFile: (uri: Uri): Promise<Uint8Array> =>
      fsCall(uri, async () => new Uint8Array(await nodeFsPromises.readFile(uri.fsPath))),
    writeFile: (uri: Uri, content: Uint8Array): Promise<void> =>
      fsCall(uri, () => nodeFsPromises.writeFile(uri.fsPath, content)),
    stat: (uri: Uri): Promise<{ type: FileType; ctime: number; mtime: number; size: number }> =>
      fsCall(uri, async () => {
        const s = await nodeFsPromises.stat(uri.fsPath)
        return { type: toFileType(s), ctime: s.ctimeMs, mtime: s.mtimeMs, size: s.size }
      }),
    createDirectory: (uri: Uri): Promise<void> =>
      fsCall(uri, async () => {
        await nodeFsPromises.mkdir(uri.fsPath, { recursive: true })
      }),
    readDirectory: (uri: Uri): Promise<[string, FileType][]> =>
      fsCall(uri, async () => {
        const entries = await nodeFsPromises.readdir(uri.fsPath, { withFileTypes: true })
        return entries.map(
          (e) =>
            [e.name, e.isDirectory() ? FileType.Directory : FileType.File] as [string, FileType]
        )
      }),
    rename: (source: Uri, target: Uri, _options?: { overwrite?: boolean }): Promise<void> =>
      // node 的 rename 在两个平台上都覆盖已存在目标，与 overwrite:true 语义一致
      fsCall(source, () => nodeFsPromises.rename(source.fsPath, target.fsPath)),
    copy: (source: Uri, target: Uri, options?: { overwrite?: boolean }): Promise<void> =>
      fsCall(source, () =>
        nodeFsPromises.copyFile(
          source.fsPath,
          target.fsPath,
          options?.overwrite ? 0 : nodeFs.constants.COPYFILE_EXCL
        )
      ),
    delete: (uri: Uri, options?: { recursive?: boolean; useTrash?: boolean }): Promise<void> =>
      fsCall(uri, () => nodeFsPromises.rm(uri.fsPath, { recursive: options?.recursive ?? false })),
  },
  createFileSystemWatcher: (globPattern: unknown) => {
    __record('createFileSystemWatcher', globPattern)
    const change = new EventEmitter<void>()
    const create = new EventEmitter<void>()
    const del = new EventEmitter<void>()
    const watcher = {
      onDidChange: (cb: () => unknown) => change.event(cb),
      onDidCreate: (cb: () => unknown) => create.event(cb),
      onDidDelete: (cb: () => unknown) => del.event(cb),
      __fireChange: () => change.fire(),
      __fireCreate: () => create.fire(),
      __fireDelete: () => del.fire(),
      dispose: () => {
        change.dispose()
        create.dispose()
        del.dispose()
      },
    }
    __stubs.fileWatchers.push(watcher)
    return watcher
  },
  onDidChangeConfiguration: (
    listener: (event: { affectsConfiguration(section: string): boolean }) => unknown
  ): Disposable => {
    configChangeListeners.add(listener)
    return new Disposable(() => configChangeListeners.delete(listener))
  },
  onDidChangeWorkspaceFolders: (listener: () => unknown): Disposable => {
    __record('onDidChangeWorkspaceFolders')
    workspaceFoldersListeners.add(listener)
    return new Disposable(() => workspaceFoldersListeners.delete(listener))
  },
  asRelativePath: (pathOrUri: unknown): string => String(pathOrUri),
  /** 按路径前缀匹配所属工作区文件夹（多根取最深匹配；v3.4 收藏夹服务用） */
  getWorkspaceFolder: (uri: Uri): { uri: Uri; name: string; index: number } | undefined =>
    workspace.workspaceFolders
      ?.filter((folder) => {
        const root = folder.uri.fsPath
        const prefix = root.endsWith(nodePath.sep) ? root : root + nodePath.sep
        return uri.fsPath === root || uri.fsPath.startsWith(prefix)
      })
      .sort((a, b) => b.uri.fsPath.length - a.uri.fsPath.length)[0],
  findFiles: async (): Promise<Uri[]> => [],
  /** 假文本文档：内容经 __setDocument 注入；未注入的 uri 视为文件不存在（FileNotFound） */
  openTextDocument: async (target: Uri | string): Promise<unknown> => {
    const uri = typeof target === 'string' ? Uri.parse(target) : target
    __record('openTextDocument', uri.toString())
    const content = __stubs.documents.get(uri.toString())
    if (content === undefined) {
      throw FileSystemError.FileNotFound(uri)
    }
    return createFakeTextDocument(uri, content)
  },
  onDidGrantWorkspaceTrust: (listener: () => unknown): Disposable => {
    __record('onDidGrantWorkspaceTrust')
    trustListeners.add(listener)
    return new Disposable(() => trustListeners.delete(listener))
  },
}

/** 假 TextDocument：getText / positionAt / offsetAt 按 content 计算（定位断言用）。 */
export function createFakeTextDocument(uri: Uri, content: string) {
  const lines = content.split('\n')
  return {
    uri,
    fileName: uri.fsPath,
    languageId: 'jsonc',
    getText: (): string => content,
    positionAt(offset: number): Position {
      const clamped = Math.max(0, Math.min(offset, content.length))
      const before = content.slice(0, clamped).split('\n')
      return new Position(before.length - 1, before[before.length - 1].length)
    },
    offsetAt(position: Position): number {
      let offset = 0
      for (let line = 0; line < position.line && line < lines.length; line += 1) {
        offset += lines[line].length + 1
      }
      return offset + position.character
    },
  }
}

/** 测试入口：注入一个假文本文档的内容（openTextDocument 按 uri.toString() 匹配）。 */
export function __setDocument(uri: Uri, content: string): void {
  __stubs.documents.set(uri.toString(), content)
}

/* ---------------- commands / env / 其余 UI 值类型 ---------------- */

export const commands = {
  registerCommand: (command: string, callback: (...args: unknown[]) => unknown): Disposable => {
    __stubs.registeredCommands.set(command, callback)
    return new Disposable(() => __stubs.registeredCommands.delete(command))
  },
  executeCommand: async (command: string, ...args: unknown[]): Promise<unknown> => {
    __record('executeCommand', { command, args })
    const handler = __stubs.registeredCommands.get(command)
    if (!handler) {
      throw new Error(`命令未注册（stub）：${command}`)
    }
    return handler(...args)
  },
  getCommands: async (): Promise<string[]> => [...__stubs.registeredCommands.keys()],
}

export const env = {
  appName: 'stub',
  clipboard: {
    writeText: async (value: string): Promise<void> => {
      __stubs.clipboard = value
    },
    readText: async (): Promise<string> => __stubs.clipboard,
  },
  uiKind: 1,
  language: 'zh-cn',
}

/** 宿主版本号（environmentTask 的 VSCode 条目渲染用；占位值避免 "stub undefined"）。 */
export const version = '1.85.0-stub'

/* ---------------- tasks（任务管理器 v2.3）---------------- */

/** 工作区文件夹形状（与 __stubs.workspaceFolders 元素一致） */
export interface WorkspaceFolderLike {
  uri: Uri
  name: string
  index: number
}

/**
 * Task 桩：构造签名与真实 API 一致
 * `(definition, scope, name, source, execution?, problemMatchers?)`。
 * 关键红线：executeTask 只应收到「fetchTasks 返回的对象」（带身份字段），
 * 测试据此可断言没有重建执行对象。
 */
export class Task {
  readonly definition: Record<string, unknown>
  scope: WorkspaceFolderLike | TaskScope
  readonly name: string
  readonly source: string
  execution?: ShellExecution | ProcessExecution
  problemMatchers: string[]
  group?: unknown
  detail?: string
  isBackground = false
  presentationOptions: Record<string, unknown> = {}
  runOptions: Record<string, unknown> = {}

  constructor(
    definition: Record<string, unknown>,
    scope: WorkspaceFolderLike | TaskScope,
    name: string,
    source: string,
    execution?: ShellExecution | ProcessExecution,
    problemMatchers?: string | string[]
  ) {
    this.definition = definition
    this.scope = scope
    this.name = name
    this.source = source
    this.execution = execution
    this.problemMatchers = Array.isArray(problemMatchers)
      ? problemMatchers
      : problemMatchers
        ? [problemMatchers]
        : []
  }
}

/** ShellExecution 桩：两套构造 `(commandLine, options?)` 与 `(command, args, options?)` */
export class ShellExecution {
  commandLine?: string
  command?: string | { value: string }
  args?: (string | { value: string })[]
  options?: { cwd?: string | Uri; env?: Record<string, string>; shell?: unknown }

  constructor(
    commandOrCommandLine: string | { value: string },
    argsOrOptions?: (string | { value: string })[] | { cwd?: string | Uri },
    options?: { cwd?: string | Uri }
  ) {
    if (Array.isArray(argsOrOptions)) {
      this.command = commandOrCommandLine
      this.args = argsOrOptions
      this.options = options
    } else {
      this.commandLine = commandOrCommandLine as string
      this.options = argsOrOptions
    }
  }
}

/** ProcessExecution 桩：两套构造 `(process, options?)` 与 `(process, args, options?)` */
export class ProcessExecution {
  process: string
  args: string[]
  options?: { cwd?: string | Uri; env?: Record<string, string> }

  constructor(
    process: string,
    argsOrOptions?: string[] | { cwd?: string | Uri },
    options?: { cwd?: string | Uri }
  ) {
    this.process = process
    if (Array.isArray(argsOrOptions)) {
      this.args = argsOrOptions
      this.options = options
    } else {
      this.args = []
      this.options = argsOrOptions
    }
  }
}

/** FakeTaskExecution：taskExecutions 的元素；terminate 可被测试覆写以模拟抛错 */
export class FakeTaskExecution {
  terminate: () => void = () => __record('taskTerminate', this.task.name)
  constructor(readonly task: Task) {}
}

let taskStartEmitter = new EventEmitter<FakeTaskExecution>()
let taskEndEmitter = new EventEmitter<FakeTaskExecution>()

export const tasks = {
  fetchTasks: async (): Promise<Task[]> => {
    __record('fetchTasks')
    if (__stubs.fetchTasksError !== undefined) {
      throw __stubs.fetchTasksError
    }
    return __stubs.workspaceTasks
  },
  /** 记录被提交的 Task 对象（可断言「原始 fetchTasks 对象」红线）；成功时加入 taskExecutions */
  executeTask: async (task: Task): Promise<FakeTaskExecution> => {
    __record('executeTask', task)
    if (__stubs.executeTaskError !== undefined) {
      throw __stubs.executeTaskError
    }
    const execution = new FakeTaskExecution(task)
    __stubs.taskExecutions.push(execution)
    return execution
  },
  get taskExecutions(): readonly FakeTaskExecution[] {
    return __stubs.taskExecutions
  },
  onDidStartTask: (listener: (e: FakeTaskExecution) => unknown): Disposable =>
    taskStartEmitter.event(listener),
  onDidEndTask: (listener: (e: FakeTaskExecution) => unknown): Disposable =>
    taskEndEmitter.event(listener),
}

/** 测试入口：注入 fetchTasks 结果（工作区 .vscode/tasks.json 任务）。 */
export function __setWorkspaceTasks(list: Task[]): void {
  __stubs.workspaceTasks = list
}

/** 测试入口：替换当前活动执行列表。 */
export function __setTaskExecutions(list: FakeTaskExecution[]): void {
  __stubs.taskExecutions = list
}

/** 测试入口：触发开始事件（去抖后应只发一次变更）。 */
export function __fireTaskStart(execution: FakeTaskExecution): void {
  taskStartEmitter.fire(execution)
}

/** 测试入口：触发结束事件。 */
export function __fireTaskEnd(execution: FakeTaskExecution): void {
  taskEndEmitter.fire(execution)
}

export class ThemeIcon {
  readonly id: string
  constructor(id: string) {
    this.id = id
  }
}

export class ThemeColor {
  constructor(readonly id: string) {}
}

/* ---------------- 位置 / 范围（定位 tasks.json 行的断言用） ---------------- */

export class Position {
  constructor(
    readonly line: number,
    readonly character: number
  ) {}
  isBefore(other: Position): boolean {
    return this.line < other.line || (this.line === other.line && this.character < other.character)
  }
  isBeforeOrEqual(other: Position): boolean {
    return this.isBefore(other) || this.isEqual(other)
  }
  isAfter(other: Position): boolean {
    return other.isBefore(this)
  }
  isAfterOrEqual(other: Position): boolean {
    return other.isBeforeOrEqual(this)
  }
  isEqual(other: Position): boolean {
    return this.line === other.line && this.character === other.character
  }
  compareTo(other: Position): number {
    if (this.isBefore(other)) return -1
    if (this.isAfter(other)) return 1
    return 0
  }
  translate(lineDelta = 0, characterDelta = 0): Position {
    return new Position(this.line + lineDelta, this.character + characterDelta)
  }
  with(line?: number, character?: number): Position {
    return new Position(line ?? this.line, character ?? this.character)
  }
}

export class Range {
  readonly start: Position
  readonly end: Position
  constructor(start: Position, end: Position)
  constructor(startLine: number, startChar: number, endLine: number, endChar: number)
  constructor(
    startOrLine: Position | number,
    startCharOrEnd?: Position | number,
    endLine?: number,
    endChar?: number
  ) {
    const start =
      typeof startOrLine === 'number'
        ? new Position(startOrLine, startCharOrEnd as number)
        : startOrLine
    const end =
      typeof startOrLine === 'number'
        ? new Position(endLine ?? startOrLine, endChar ?? (startCharOrEnd as number))
        : (startCharOrEnd as Position)
    // 与真实 vscode.Range 一致：start ≤ end 归一化
    if (start.isBefore(end)) {
      this.start = start
      this.end = end
    } else {
      this.start = end
      this.end = start
    }
  }
  get isEmpty(): boolean {
    return this.start.isEqual(this.end)
  }
  get isSingleLine(): boolean {
    return this.start.line === this.end.line
  }
  contains(positionOrRange: Position | Range): boolean {
    const position = positionOrRange instanceof Position ? positionOrRange : positionOrRange.start
    return position.isAfterOrEqual(this.start) && position.isBeforeOrEqual(this.end)
  }
  union(other: Range): Range {
    const start = this.start.isBefore(other.start) ? this.start : other.start
    const end = this.end.isAfter(other.end) ? this.end : other.end
    return new Range(start, end)
  }
  with(start?: Position, end?: Position): Range {
    return new Range(start ?? this.start, end ?? this.end)
  }
}

export class Selection extends Range {
  readonly anchor: Position
  readonly active: Position
  constructor(anchor: Position, active: Position) {
    super(anchor, active)
    this.anchor = anchor
    this.active = active
  }
  get isReversed(): boolean {
    return this.active.isBefore(this.anchor)
  }
}

export class TreeItem {
  label?: string | { label: string }
  id?: string
  description?: string | boolean
  tooltip?: string | unknown
  iconPath?: unknown
  resourceUri?: unknown
  contextValue?: string
  command?: { command: string; title: string; arguments?: unknown[] }
  collapsibleState?: TreeItemCollapsibleState
  accessibilityInformation?: { label: string; role?: string }
  constructor(label?: string | { label: string }, collapsibleState?: TreeItemCollapsibleState) {
    this.label = label
    this.collapsibleState = collapsibleState
  }
}

export class MarkdownString {
  value = ''
  supportThemeIcons = false
  supportHtml = false
  isTrusted: unknown = undefined
  constructor(initial?: string) {
    if (initial !== undefined) {
      this.value = initial
    }
  }
  appendMarkdown(value: string): this {
    this.value += value
    return this
  }
  appendText(value: string): this {
    this.value += value
    return this
  }
  appendCodeblock(code: string, language = ''): this {
    this.value += `\`\`\`${language}\n${code}\n\`\`\``
    return this
  }
}

export class RelativePattern {
  base: unknown
  pattern: string
  constructor(base: unknown, pattern: string) {
    this.base = base
    this.pattern = pattern
  }
}

/** Memento / ExtensionContext 由测试自行构造，此处仅提供便捷实现。 */
export function createMementoStub(initial: Record<string, unknown> = {}) {
  const backing = new Map<string, unknown>(Object.entries(initial))
  return {
    get: <T>(key: string, defaultValue?: T): T =>
      backing.has(key) ? (backing.get(key) as T) : (defaultValue as T),
    update: async (key: string, value: unknown): Promise<void> => {
      backing.set(key, value)
    },
    keys: (): string[] => [...backing.keys()],
    setKeysForSync: (): void => {},
    __backing: backing,
  }
}

export function createExtensionContextStub() {
  return {
    subscriptions: [] as Disposable[],
    globalState: createMementoStub(),
    workspaceState: createMementoStub(),
    extensionUri: Uri.file(process.cwd()),
    extensionPath: process.cwd(),
    globalStorageUri: Uri.file(nodePath.join(process.cwd(), '.stub-global-storage')),
    globalStoragePath: nodePath.join(process.cwd(), '.stub-global-storage'),
    storageUri: Uri.file(nodePath.join(process.cwd(), '.stub-storage')),
    storagePath: nodePath.join(process.cwd(), '.stub-storage'),
    logUri: Uri.file(nodePath.join(process.cwd(), '.stub-log')),
    logPath: nodePath.join(process.cwd(), '.stub-log'),
    asAbsolutePath: (p: string): string => nodePath.join(process.cwd(), p),
    environmentVariableCollection: {},
    extensionMode: 1,
    secrets: {},
    languageModelAccessInformation: {},
  }
}

/* 让 workspace.workspaceFolders / isTrusted 与 __stubs 联动（保持引用一致） */
Object.defineProperty(workspace, 'workspaceFolders', {
  get: () => __stubs.workspaceFolders,
  set: (value) => {
    __stubs.workspaceFolders = value
  },
})
Object.defineProperty(workspace, 'isTrusted', {
  get: () => __stubs.isTrusted,
  set: (value) => {
    __stubs.isTrusted = value
  },
})
