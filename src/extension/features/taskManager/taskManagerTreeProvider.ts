import * as vscode from 'vscode'
import { COMMAND } from '../../constants'
import type { TaskApiClient, TaskItem } from './taskApiClient'

/**
 * 「任务管理」树视图（侧边栏入口）。
 *
 * - 数据与弹框页同源（同一 TaskApiClient：打桩内存表 / 真实 HTTP 接口）；
 * - **可见期轮询**：视图可见时每 3s 拉取列表（onDidChangeVisibility 门控，
 *   隐藏即停——真实接口场景不空转）；标题栏刷新命令手动触发同一路径；
 * - 单击任务条目打开任务管理弹框（TreeItem.command 路由 openTaskManager）；
 * - 空态 / 拉取失败以 info 节点呈现（错误保留旧数据不清空）。
 */

export type TaskTreeNode =
  { kind: 'task'; task: TaskItem } | { kind: 'info'; text: string; icon: string }

const STATUS_ICONS: Record<TaskItem['status'], string> = {
  queued: 'clock',
  running: 'sync~spin',
  success: 'check',
  failed: 'error',
}

const STATUS_LABEL: Record<TaskItem['status'], string> = {
  queued: '排队中',
  running: '构建中',
  success: '成功',
  failed: '失败',
}

const BUILD_TYPE_LABEL: Record<TaskItem['buildType'], string> = {
  full: '完整',
  incremental: '增量',
}

const POLL_INTERVAL_MS = 3000
/** 树视图一次拉取的最大条数（超出时以弹框分页查询为准）。 */
const TREE_PAGE_SIZE = 100

export class TaskManagerTreeProvider
  implements vscode.TreeDataProvider<TaskTreeNode>, vscode.Disposable
{
  private tasks: TaskItem[] = []
  private loadError: string | undefined
  private pollTimer: ReturnType<typeof setInterval> | undefined
  /** 进行中的拉取（单飞：树轮询 / 页面轮询 / 手动刷新并发时复用同一请求）。 */
  private inflight: Promise<void> | undefined

  private readonly _onDidChangeTreeData = new vscode.EventEmitter<TaskTreeNode | undefined | void>()
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event

  constructor(private readonly api: TaskApiClient) {}

  /** 轮询开关（extension.ts 按视图可见性调用；幂等）。 */
  setPolling(enabled: boolean): void {
    if (enabled && this.pollTimer === undefined) {
      void this.refresh()
      this.pollTimer = setInterval(() => void this.refresh(), POLL_INTERVAL_MS)
    } else if (!enabled && this.pollTimer !== undefined) {
      clearInterval(this.pollTimer)
      this.pollTimer = undefined
    }
  }

  /**
   * 手动 / 轮询共用的拉取路径；进行中调用复用同一 Promise（单飞，对齐
   * taskExplorerTreeProvider 惯例：轮询与手动刷新并发不叠加请求）。
   * 失败保留旧数据并提示。
   */
  refresh(): Promise<void> {
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
      const page = await this.api.query({ page: 1, pageSize: TREE_PAGE_SIZE })
      this.tasks = page.items
      this.loadError = undefined
    } catch (err) {
      this.loadError = err instanceof Error ? err.message : String(err)
    }
    this._onDidChangeTreeData.fire()
  }

  getTreeItem(node: TaskTreeNode): vscode.TreeItem {
    if (node.kind === 'info') {
      const info = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None)
      info.iconPath = new vscode.ThemeIcon(node.icon)
      return info
    }
    const task = node.task
    const item = new vscode.TreeItem(task.name, vscode.TreeItemCollapsibleState.None)
    const statusLabel = STATUS_LABEL[task.status]
    item.description =
      task.status === 'running'
        ? `${statusLabel} ${task.progress}% · ${BUILD_TYPE_LABEL[task.buildType]}`
        : `${statusLabel} · ${BUILD_TYPE_LABEL[task.buildType]}`
    item.iconPath = new vscode.ThemeIcon(STATUS_ICONS[task.status])
    // 单击任务打开任务管理弹框（带参路由同一命令，无新增命令；
    // 条目无右键菜单，故不设 contextValue——第五轮清理：移除无引用的死配置）
    item.command = { command: COMMAND.openTaskManager, title: '在控制台查看', arguments: [] }
    item.tooltip = new vscode.MarkdownString(
      [
        `**${task.name}**（${task.branch}）`,
        `- 类型：${BUILD_TYPE_LABEL[task.buildType]}`,
        `- 状态：${statusLabel}${task.status === 'running' ? `（${task.progress}%）` : ''}`,
        task.message ? `- 信息：${task.message}` : '',
        task.notes ? `- 备注：${task.notes}` : '',
        `- 创建于：${new Date(task.createdAt).toLocaleString()}`,
        task.finishedAt ? `- 结束于：${new Date(task.finishedAt).toLocaleString()}` : '',
      ]
        .filter(Boolean)
        .join('\n')
    )
    return item
  }

  async getChildren(): Promise<TaskTreeNode[]> {
    if (this.loadError) {
      return [{ kind: 'info', text: `列表拉取失败：${this.loadError}`, icon: 'error' }]
    }
    if (this.tasks.length === 0) {
      return [{ kind: 'info', text: '暂无任务：点击标题栏「打开控制台」新建', icon: 'info' }]
    }
    return this.tasks.map((task): TaskTreeNode => ({ kind: 'task', task }))
  }

  dispose(): void {
    this.setPolling(false)
    this._onDidChangeTreeData.dispose()
  }
}
