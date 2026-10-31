import * as vscode from 'vscode'
import { COMMAND, VIEW } from '../../constants'
import type { WorkspaceTaskEntry } from './taskSource'
import { groupByFolder, loadWorkspaceTasks, taskKeyFromRef } from './taskSource'
import type { TaskStatusTracker } from './taskStatusTracker'
import type { TaskUsageStore } from './taskUsageStore'

/**
 * 任务管理器树视图（v2.3，10 方案 §7）：三个根分组**固定显示、顺序固定**——
 * 「最近运行 → 收藏 → 工作区任务」，空组也显示「暂无」占位（可发现性）。
 *
 * - 工作区任务组：单根为 `tasks.json → 任务`，多根为「文件夹 → tasks.json → 任务」；
 * - 三个 group 节点持有固定实例（只替换 children），刷新后展开状态不丢；
 * - 运行态在 getTreeItem 时实时查询 status.isRunning（不缓存布尔值），最近运行/
 *   收藏/工作区任务三处同 key 节点显示天然一致；
 * - usage / status 变化只 fire（不重新 fetchTasks）；fetchTasks 仅由 refresh()
 *   触发（首次展开、watcher、工作区/信任变化、手动刷新）；
 * - 失效 ref（任务改名/文件夹移除）直接隐藏：favorites 存储保留、recent 由上限淘汰。
 */

export type TaskExplorerGroup = 'recent' | 'favorites' | 'tasks'

export type TaskExplorerNode =
  | { kind: 'group'; group: TaskExplorerGroup; children: TaskExplorerNode[]; count: number }
  | { kind: 'folder'; folder: vscode.WorkspaceFolder; entries: WorkspaceTaskEntry[] }
  | { kind: 'file'; folder: vscode.WorkspaceFolder; entries: WorkspaceTaskEntry[] }
  | { kind: 'task'; entry: WorkspaceTaskEntry }
  | { kind: 'info'; text: string; icon: string; tooltip?: string }

/** 最近运行展示上限（存储上限 20 在 TaskUsageStore） */
const RECENT_DISPLAY_LIMIT = 10

const GROUP_LABEL: Record<TaskExplorerGroup, string> = {
  recent: '最近运行',
  favorites: '收藏',
  tasks: '工作区任务',
}

const GROUP_ICON: Record<TaskExplorerGroup, string> = {
  recent: 'history',
  favorites: 'star-full',
  tasks: 'list-tree',
}

const GROUP_CONTEXT_VALUE: Record<TaskExplorerGroup, string> = {
  recent: VIEW.taskExplorerGroupRecentContextValue,
  favorites: VIEW.taskExplorerGroupFavoritesContextValue,
  tasks: VIEW.taskExplorerGroupTasksContextValue,
}

/**
 * task.group（按 id 比较）→ 展示中文名（仅设计覆盖的 build/test；其余不展示）。
 * 注意：真实宿主中对象形式分组（{"kind":"build","isDefault":true}）返回的
 * TaskGroup 不是 vscode.TaskGroup.Build 单例，必须用 `.id` 比较而非对象身份。
 */
const TASK_GROUP_LABEL: Record<string, string> = {
  build: '构建',
  test: '测试',
}

/** 非运行态图标第 1 优先级：任务分组（build → tools，test → beaker） */
const TASK_GROUP_ICON: Record<string, string> = {
  build: 'tools',
  test: 'beaker',
}

/**
 * 第 2 优先级：按任务执行类型区分（definition.type）——shell 普通终端脚本、
 * process 独立进程、npm 等 package 脚本一眼可辨；未知 contributed 类型回落 terminal。
 */
const TASK_TYPE_ICON: Record<string, string> = {
  shell: 'terminal',
  process: 'gear',
  npm: 'package',
}

function taskIcon(task: vscode.Task): string {
  const groupIcon = task.group ? TASK_GROUP_ICON[task.group.id] : undefined
  if (groupIcon) {
    return groupIcon
  }
  const type = (task.definition as { type?: unknown } | undefined)?.type
  return (typeof type === 'string' && TASK_TYPE_ICON[type]) || 'terminal'
}

function taskContextValue(running: boolean, favorite: boolean): string {
  if (running) {
    return favorite
      ? VIEW.taskExplorerTaskRunningFavoriteContextValue
      : VIEW.taskExplorerTaskRunningContextValue
  }
  return favorite ? VIEW.taskExplorerTaskFavoriteContextValue : VIEW.taskExplorerTaskContextValue
}

/** tooltip 命令行展示：Shell / Process / 复合任务三种形态分别降级（10 方案 §7.4） */
function describeExecution(task: vscode.Task): string {
  const execution = task.execution as vscode.ShellExecution | vscode.ProcessExecution | undefined
  if (!execution) {
    return '`复合任务（无直接命令）`'
  }
  if ('process' in execution) {
    const args = execution.args.length > 0 ? ` ${execution.args.join(' ')}` : ''
    return `\`${execution.process}${args}\``
  }
  if (typeof execution.commandLine === 'string') {
    return `\`${execution.commandLine}\``
  }
  const command =
    typeof execution.command === 'string' ? execution.command : (execution.command?.value ?? '')
  const args = (execution.args ?? [])
    .map((arg) => (typeof arg === 'string' ? arg : arg.value))
    .join(' ')
  return `\`${[command, args].filter(Boolean).join(' ')}\``
}

function executionCwd(task: vscode.Task): string | undefined {
  const execution = task.execution as vscode.ShellExecution | vscode.ProcessExecution | undefined
  const cwd = execution?.options?.cwd
  return cwd === undefined ? undefined : String(cwd)
}

function buildTaskTooltip(
  entry: WorkspaceTaskEntry,
  state: { running: boolean; favorite: boolean }
): vscode.MarkdownString {
  const task = entry.task
  const lines: string[] = [`**${task.name}**`, `来源：${task.source}（.vscode/tasks.json）`]
  const groupLabel = task.group ? TASK_GROUP_LABEL[task.group.id] : undefined
  if (groupLabel) {
    lines.push(`分组：${groupLabel}`)
  }
  if (task.detail) {
    lines.push(`详情：${task.detail}`)
  }
  lines.push(`命令：${describeExecution(task)}`)
  const cwd = executionCwd(task)
  if (cwd) {
    lines.push(`工作目录：\`${cwd}\``)
  }
  lines.push('依赖：由 VS Code 任务引擎自动编排（dependsOn / dependsOrder）')
  if (task.isBackground) {
    lines.push('后台任务：是（需 problemMatcher 判定就绪）')
  }
  const states: string[] = []
  if (state.running) {
    states.push('运行中')
  }
  if (state.favorite) {
    states.push('已收藏')
  }
  if (states.length > 0) {
    lines.push(`状态：${states.join('、')}`)
  }
  // isTrusted 保持默认 false：不拼接可执行命令链接
  return new vscode.MarkdownString(lines.join('\n'))
}

export class TaskExplorerTreeProvider
  implements vscode.TreeDataProvider<TaskExplorerNode>, vscode.Disposable
{
  private entries: WorkspaceTaskEntry[] = []
  private entryByKey = new Map<string, WorkspaceTaskEntry>()
  private loadError: string | undefined
  private loaded = false
  private inflight: Promise<void> | undefined

  private readonly groupNodes: Record<TaskExplorerGroup, TaskExplorerNode>

  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    TaskExplorerNode | undefined | void
  >()
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event

  private readonly subscriptions: vscode.Disposable[]

  constructor(
    private readonly usage: TaskUsageStore,
    private readonly status: TaskStatusTracker,
    private readonly output: vscode.OutputChannel
  ) {
    this.groupNodes = {
      recent: { kind: 'group', group: 'recent', children: [], count: 0 },
      favorites: { kind: 'group', group: 'favorites', children: [], count: 0 },
      tasks: { kind: 'group', group: 'tasks', children: [], count: 0 },
    }
    // usage 变化（运行记录/收藏）只重建分组 children；status 变化只影响渲染，
    // 二者都不重新 fetchTasks（10 方案 §9「运行态与数据刷新解耦」）
    this.subscriptions = [
      usage.onDidChange(() => this.rebuildGroups()),
      status.onDidChange(() => this._onDidChangeTreeData.fire()),
    ]
  }

  /** 重新 fetchTasks；进行中调用复用同一 Promise（单飞，watcher 抖动不叠加） */
  async refresh(): Promise<void> {
    if (this.inflight) {
      return this.inflight
    }
    this.inflight = this.doLoad().finally(() => {
      this.inflight = undefined
    })
    return this.inflight
  }

  private async doLoad(): Promise<void> {
    try {
      this.entries = await loadWorkspaceTasks()
      this.loadError = undefined
    } catch (error) {
      // 失败保留上次成功结果（与 BuildTasksTreeProvider 行为一致）
      this.loadError = error instanceof Error ? error.message : String(error)
      this.output.appendLine(`[taskExplorer] 任务加载失败：${this.loadError}`)
    }
    this.entryByKey = new Map(this.entries.map((entry) => [entry.key, entry]))
    this.loaded = true
    this.rebuildGroups()
  }

  /** 重建三组 children 并 fire（usage 变化路径；不重新 fetchTasks） */
  private rebuildGroups(): void {
    const recent = this.buildRecentChildren()
    const favorites = this.buildFavoritesChildren()
    const tasks = this.buildTasksChildren()
    this.groupNodes.recent = {
      kind: 'group',
      group: 'recent',
      children: recent,
      count: recent.filter((node) => node.kind === 'task').length,
    }
    this.groupNodes.favorites = {
      kind: 'group',
      group: 'favorites',
      children: favorites,
      count: favorites.filter((node) => node.kind === 'task').length,
    }
    this.groupNodes.tasks = {
      kind: 'group',
      group: 'tasks',
      children: tasks,
      count: this.entries.length,
    }
    this._onDidChangeTreeData.fire()
  }

  /** 匹配不到的 ref 直接隐藏；重置提示 + 空态占位见 10 方案 §7.5 */
  private buildRecentChildren(): TaskExplorerNode[] {
    const nodes: TaskExplorerNode[] = []
    if (this.usage.wasReset) {
      nodes.push({
        kind: 'info',
        text: '本地记录已重置',
        icon: 'warning',
        tooltip: '阅读输出通道详情',
      })
    }
    const matched: WorkspaceTaskEntry[] = []
    for (const ref of this.usage.getRecent()) {
      const entry = this.entryByKey.get(taskKeyFromRef(ref))
      if (entry && !matched.some((item) => item.key === entry.key)) {
        matched.push(entry)
        if (matched.length >= RECENT_DISPLAY_LIMIT) {
          break
        }
      }
    }
    if (matched.length === 0) {
      nodes.push({
        kind: 'info',
        text: '暂无最近运行的任务',
        icon: 'info',
        tooltip: '运行过的任务会出现在这里',
      })
      return nodes
    }
    return [...nodes, ...matched.map((entry): TaskExplorerNode => ({ kind: 'task', entry }))]
  }

  private buildFavoritesChildren(): TaskExplorerNode[] {
    const nodes: TaskExplorerNode[] = []
    if (this.usage.wasReset) {
      nodes.push({
        kind: 'info',
        text: '本地记录已重置',
        icon: 'warning',
        tooltip: '阅读输出通道详情',
      })
    }
    const matched = this.usage
      .getFavorites()
      .map((ref) => this.entryByKey.get(taskKeyFromRef(ref)))
      .filter((entry): entry is WorkspaceTaskEntry => entry !== undefined)
      .sort((a, b) => a.label.localeCompare(b.label, 'zh-Hans-CN'))
    if (matched.length === 0) {
      nodes.push({
        kind: 'info',
        text: '暂无收藏的任务',
        icon: 'info',
        tooltip: '点击任务行内的星标收藏',
      })
      return nodes
    }
    return [...nodes, ...matched.map((entry): TaskExplorerNode => ({ kind: 'task', entry }))]
  }

  private buildTasksChildren(): TaskExplorerNode[] {
    if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
      return [
        { kind: 'info', text: '未打开工作区文件夹：无法读取 .vscode/tasks.json', icon: 'info' },
      ]
    }
    if (!vscode.workspace.isTrusted) {
      // fetchTasks 在受限模式下返回 []（信任门禁），必须单独识别才能给出可行动提示
      return [{ kind: 'info', text: '受限模式下不加载任务：信任工作区后自动刷新', icon: 'shield' }]
    }
    const nodes: TaskExplorerNode[] = []
    if (this.loadError) {
      nodes.push({
        kind: 'info',
        text: `任务加载失败：${this.loadError}`,
        icon: 'error',
        tooltip: '已保留上次成功加载的任务列表；查看输出通道了解详情',
      })
    }
    if (this.entries.length === 0) {
      if (!this.loadError) {
        nodes.push({ kind: 'info', text: '未在 .vscode/tasks.json 中发现任务', icon: 'info' })
      }
      return nodes
    }
    const folders = vscode.workspace.workspaceFolders
    if (folders.length === 1) {
      return [...nodes, { kind: 'file', folder: folders[0], entries: this.entries }]
    }
    // 多根按 workspaceFolders 顺序展示（保持资源管理器顺序），无任务的文件夹不显示
    const groups = groupByFolder(this.entries)
    for (const folder of folders) {
      const entries = groups.get(folder)
      if (entries && entries.length > 0) {
        nodes.push({ kind: 'folder', folder, entries })
      }
    }
    return nodes
  }

  async getChildren(element?: TaskExplorerNode): Promise<TaskExplorerNode[]> {
    if (element === undefined && !this.loaded) {
      await this.refresh() // 首次展开：fetchTasks + 读取 usage，期间 View 自带 loading
    }
    if (element === undefined) {
      return [this.groupNodes.recent, this.groupNodes.favorites, this.groupNodes.tasks]
    }
    switch (element.kind) {
      case 'group':
        return element.children
      case 'folder':
        return [{ kind: 'file', folder: element.folder, entries: element.entries }]
      case 'file':
        return element.entries.map((entry): TaskExplorerNode => ({ kind: 'task', entry }))
      case 'task':
      case 'info':
        return []
    }
  }

  getTreeItem(node: TaskExplorerNode): vscode.TreeItem {
    switch (node.kind) {
      case 'group': {
        const item = new vscode.TreeItem(
          GROUP_LABEL[node.group],
          vscode.TreeItemCollapsibleState.Expanded
        )
        item.iconPath = new vscode.ThemeIcon(GROUP_ICON[node.group])
        item.description = node.group === 'tasks' ? `${node.count} 个` : `${node.count} 条`
        item.contextValue = GROUP_CONTEXT_VALUE[node.group]
        item.id = `group:${node.group}`
        return item
      }
      case 'folder': {
        const item = new vscode.TreeItem(
          node.folder.name,
          vscode.TreeItemCollapsibleState.Collapsed
        )
        item.description = `${node.entries.length} 个任务`
        item.iconPath = new vscode.ThemeIcon('folder')
        item.contextValue = VIEW.taskExplorerFolderContextValue
        item.command = {
          command: COMMAND.openTasksJson,
          title: '打开 tasks.json',
          arguments: [node.folder],
        }
        item.id = `folder:${String(node.folder.uri)}`
        return item
      }
      case 'file': {
        const tasksJson = vscode.Uri.joinPath(node.folder.uri, '.vscode', 'tasks.json')
        const item = new vscode.TreeItem('tasks.json', vscode.TreeItemCollapsibleState.Expanded)
        item.resourceUri = tasksJson
        item.description = `${node.entries.length} 个任务`
        item.contextValue = VIEW.taskExplorerFileContextValue
        item.command = {
          command: COMMAND.openTasksJson,
          title: '打开 tasks.json',
          arguments: [node.folder],
        }
        item.id = `file:${String(tasksJson)}`
        return item
      }
      case 'task': {
        const { entry } = node
        const running = this.status.isRunning(entry.key)
        const favorite = this.usage.isFavorite(entry.key)
        const item = new vscode.TreeItem(entry.label, vscode.TreeItemCollapsibleState.None)
        item.iconPath = new vscode.ThemeIcon(running ? 'sync~spin' : taskIcon(entry.task))
        item.description = entry.task.group ? TASK_GROUP_LABEL[entry.task.group.id] : undefined
        item.contextValue = taskContextValue(running, favorite)
        // TreeItem.command 传原始 vscode.Task（仓库约定）：executeTask 必须拿到
        // fetchTasks 返回的对象，重建节点会丢内部 _id 与依赖语义
        item.command = {
          command: COMMAND.runWorkspaceTask,
          title: '运行任务',
          arguments: [entry.task],
        }
        item.tooltip = buildTaskTooltip(entry, { running, favorite })
        item.id = `task:${entry.key}`
        return item
      }
      case 'info': {
        const item = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None)
        item.iconPath = new vscode.ThemeIcon(node.icon)
        if (node.tooltip) {
          item.tooltip = node.tooltip
        }
        return item
      }
    }
  }

  dispose(): void {
    for (const subscription of this.subscriptions) {
      subscription.dispose()
    }
    this._onDidChangeTreeData.dispose()
  }
}
