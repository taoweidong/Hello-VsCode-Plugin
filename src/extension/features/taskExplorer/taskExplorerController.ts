import * as vscode from 'vscode'
import type { WorkspaceTaskEntry } from './taskSource'
import { isWorkspaceFileTask, taskKey, taskRef } from './taskSource'
import { TaskExplorerTreeProvider, type TaskExplorerNode } from './taskExplorerTreeProvider'
import { TaskStatusTracker } from './taskStatusTracker'
import { TaskUsageStore } from './taskUsageStore'
import { locateTaskLabel } from './tasksJsonLocator'

/**
 * 任务管理器控制器（v2.3，10 方案 §5.1/§8/§9）：组装 source / usage / status /
 * treeProvider，持有 watcher 与信任/工作区监听，承载全部命令编排。
 *
 * 刷新路径（10 方案 §9）：
 * - `refresh()`（标题栏命令）：清空去抖队列并立即重新加载；
 * - watcher / 工作区变化 / 授予信任 → 300ms 去抖重新加载；
 * - 运行开始/结束、收藏、清空最近 → status/usage 事件只 fire，不重新 fetchTasks；
 * - 加载失败保留旧数据，由 provider 置错误 info。
 *
 * 关键红线（10 方案 §5.3）：只执行 `fetchTasks()` 返回的对象，绝不重建
 * `ShellExecution`；最近运行只在「本扩展 run 命令 executeTask 成功之后」记录。
 */

/** watcher 抖动去抖间隔（vscode-taskexplorer 无去抖导致事件风暴的已知问题） */
const WATCHER_DEBOUNCE_MS = 300

function isTaskNode(value: unknown): value is { kind: 'task'; entry: WorkspaceTaskEntry } {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind === 'task' &&
    typeof (value as { entry?: unknown }).entry === 'object'
  )
}

function isFolderLike(value: unknown): value is vscode.WorkspaceFolder {
  return (
    typeof value === 'object' &&
    value !== null &&
    'uri' in value &&
    'name' in value &&
    'index' in value
  )
}

/** 从树节点取所属文件夹（folder / file / task 三类节点） */
function folderFromNode(value: unknown): vscode.WorkspaceFolder | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  const node = value as TaskExplorerNode
  if (node.kind === 'folder' || node.kind === 'file') {
    return node.folder
  }
  if (node.kind === 'task') {
    return node.entry.folder
  }
  return undefined
}

export class TaskExplorerController implements vscode.Disposable {
  readonly usage: TaskUsageStore
  readonly status: TaskStatusTracker
  readonly treeProvider: TaskExplorerTreeProvider

  private readonly watcher: vscode.FileSystemWatcher
  private readonly subscriptions: vscode.Disposable[] = []
  private debounceTimer: ReturnType<typeof setTimeout> | undefined

  constructor(
    workspaceState: vscode.Memento,
    private readonly output: vscode.OutputChannel
  ) {
    this.usage = new TaskUsageStore(workspaceState, output)
    this.status = new TaskStatusTracker(output)
    this.treeProvider = new TaskExplorerTreeProvider(this.usage, this.status, output)

    this.watcher = vscode.workspace.createFileSystemWatcher('**/.vscode/tasks.json')
    const scheduleRefresh = (): void => this.scheduleDebouncedRefresh()
    this.subscriptions.push(
      this.watcher,
      this.watcher.onDidChange(scheduleRefresh),
      this.watcher.onDidCreate(scheduleRefresh),
      this.watcher.onDidDelete(scheduleRefresh),
      vscode.workspace.onDidChangeWorkspaceFolders(() => void this.refresh()),
      vscode.workspace.onDidGrantWorkspaceTrust(() => void this.refresh())
    )
  }

  // ---------- 刷新 ----------

  /** 手动刷新：清空去抖队列并立即重新 fetchTasks */
  refresh(): void {
    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = undefined
    }
    void this.treeProvider.refresh()
  }

  private scheduleDebouncedRefresh(): void {
    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer)
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined
      void this.treeProvider.refresh()
    }, WATCHER_DEBOUNCE_MS)
  }

  // ---------- 命令参数归一化 ----------

  /**
   * 命令参数可能是 TreeItem.command 传入的原始 vscode.Task，也可能是右键菜单
   * 传入的树节点；统一归一化为 entry。原始 Task 先经 isWorkspaceFileTask 校验
   * （拒绝执行非工作区 tasks.json 任务）。
   */
  private resolveEntryArg(arg: unknown): WorkspaceTaskEntry | undefined {
    if (isTaskNode(arg)) {
      return arg.entry
    }
    if (arg instanceof vscode.Task && isWorkspaceFileTask(arg)) {
      return { task: arg, folder: arg.scope, key: taskKey(arg), label: arg.name, ref: taskRef(arg) }
    }
    return undefined
  }

  // ---------- 运行 / 停止 ----------

  async run(arg: unknown): Promise<void> {
    const entry = this.resolveEntryArg(arg)
    if (!entry) {
      void vscode.window.showInformationMessage('请从任务管理器中选择要运行的任务。')
      return
    }
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showWarningMessage('受限模式下不能运行任务，请先信任工作区。')
      return
    }
    try {
      await vscode.tasks.executeTask(entry.task)
      this.usage.recordRun(entry.ref) // executeTask 成功提交后才记入最近运行
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.output.appendLine(`[taskExplorer] 运行失败：${message}`)
      void vscode.window.showErrorMessage(`运行任务失败：${message}`)
    }
  }

  stop(arg: unknown): void {
    const entry = this.resolveEntryArg(arg)
    if (!entry) {
      void vscode.window.showInformationMessage('请从任务管理器中选择要停止的任务。')
      return
    }
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showWarningMessage('受限模式下不能运行任务，请先信任工作区。')
      return
    }
    const terminated = this.status.terminate(entry.key)
    if (terminated === 0) {
      void vscode.window.showInformationMessage(`任务未在运行：${entry.task.name}`)
    }
  }

  // ---------- 定位（只读辅助，失败降级，见 10 方案 §8.4） ----------

  async locate(arg: unknown): Promise<void> {
    const entry = this.resolveEntryArg(arg)
    if (!entry) {
      void vscode.window.showInformationMessage('请从任务管理器中选择要定位的任务。')
      return
    }
    const uri = vscode.Uri.joinPath(entry.folder.uri, '.vscode', 'tasks.json')
    let document: vscode.TextDocument
    try {
      document = await vscode.workspace.openTextDocument(uri)
    } catch {
      void vscode.window.showWarningMessage('未找到 .vscode/tasks.json。')
      return
    }
    const offset = locateTaskLabel(document.getText(), entry.task.name)
    if (offset === undefined) {
      await vscode.window.showTextDocument(document, { preview: false })
      void vscode.window.showWarningMessage('未能定位任务行，已打开 tasks.json 顶部。')
      return
    }
    const position = document.positionAt(offset)
    const range = new vscode.Range(position, position)
    const editor = await vscode.window.showTextDocument(document, {
      preview: false,
      selection: range,
    })
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport)
  }

  // ---------- 打开 tasks.json ----------

  /** 单根直开；多根 QuickPick 选择文件夹；文件不存在给提示（10 方案 §10.1） */
  async openTasksJson(arg?: unknown): Promise<void> {
    const folder =
      folderFromNode(arg) ??
      (isFolderLike(arg) ? arg : undefined) ??
      (arg instanceof vscode.Task && isWorkspaceFileTask(arg) ? arg.scope : undefined)
    if (folder) {
      await this.showTasksJson(folder)
      return
    }
    const folders = vscode.workspace.workspaceFolders ?? []
    if (folders.length === 0) {
      void vscode.window.showInformationMessage('未打开工作区文件夹，无法打开 tasks.json。')
      return
    }
    if (folders.length === 1) {
      await this.showTasksJson(folders[0])
      return
    }
    const pick = await vscode.window.showQuickPick(
      folders.map((item) => ({ label: item.name, description: String(item.uri), folder: item })),
      { placeHolder: '选择要打开 tasks.json 的工作区文件夹' }
    )
    if (pick) {
      await this.showTasksJson(pick.folder)
    }
  }

  private async showTasksJson(folder: vscode.WorkspaceFolder): Promise<void> {
    const uri = vscode.Uri.joinPath(folder.uri, '.vscode', 'tasks.json')
    try {
      const document = await vscode.workspace.openTextDocument(uri)
      await vscode.window.showTextDocument(document, { preview: false })
    } catch {
      void vscode.window.showWarningMessage('未找到 .vscode/tasks.json。')
    }
  }

  // ---------- 收藏 / 清空最近运行 ----------

  addFavorite(arg: unknown): void {
    const entry = this.resolveEntryArg(arg)
    if (!entry) {
      void vscode.window.showInformationMessage('请从任务管理器中选择要收藏的任务。')
      return
    }
    this.usage.addFavorite(entry.ref) // 已存在则无操作（10 方案 §10.1）
  }

  removeFavorite(arg: unknown): void {
    const entry = this.resolveEntryArg(arg)
    if (!entry) {
      void vscode.window.showInformationMessage('请从任务管理器中选择要取消收藏的任务。')
      return
    }
    this.usage.removeFavorite(entry.ref)
  }

  /** 模态确认后清空 recent；收藏不受影响（10 方案 §6.4） */
  async clearRecent(): Promise<void> {
    const choice = await vscode.window.showWarningMessage(
      '确定清空最近运行的任务记录？收藏不受影响。',
      { modal: true },
      '清空'
    )
    if (choice !== '清空') {
      return
    }
    this.usage.clearRecent()
  }

  dispose(): void {
    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = undefined
    }
    for (const subscription of this.subscriptions) {
      subscription.dispose()
    }
    this.treeProvider.dispose()
    this.status.dispose()
    this.usage.dispose()
  }
}
