import * as vscode from 'vscode'
import { COMMAND } from '../constants'
import { findProbeByLabel } from '../tasks/probes'
import { TaskRunner } from '../tasks/taskRunner'
import type { TaskItem, TaskResult, TaskStatus } from '../tasks/types'

export type EnvTreeNode =
  | { kind: 'task'; result: TaskResult }
  | { kind: 'item'; item: TaskItem }
  | { kind: 'info'; text: string; icon: string }

/** 任务级状态图标：与环境信息视图、右键菜单保持同一 codicon 语言。 */
const STATUS_ICONS: Record<TaskStatus | 'missing', string> = {
  ok: 'check',
  warn: 'warning',
  error: 'error',
  missing: 'circle-slash',
}

/**
 * 「环境信息」树视图：展示启动任务的执行结果。
 * - 任务执行中显示转圈占位，避免视图空白；
 * - 每个启动任务一个分组节点，其下是探测到的条目（版本号等）；
 * - 后续新增任务（动作类）无需改此视图，自动出现新分组。
 */
export class EnvironmentTreeProvider
  implements vscode.TreeDataProvider<EnvTreeNode>, vscode.Disposable
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<EnvTreeNode | undefined | void>()
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event

  private readonly subscription: vscode.Disposable

  constructor(private readonly runner: TaskRunner) {
    this.subscription = runner.onDidChangeItems(() => this._onDidChangeTreeData.fire())
  }

  getTreeItem(node: EnvTreeNode): vscode.TreeItem {
    switch (node.kind) {
      case 'task': {
        const treeItem = new vscode.TreeItem(
          node.result.taskTitle,
          vscode.TreeItemCollapsibleState.Expanded
        )
        treeItem.description = `${STATUS_LABEL[node.result.status]} · ${node.result.durationMs}ms`
        treeItem.iconPath = new vscode.ThemeIcon(STATUS_ICONS[node.result.status])
        treeItem.contextValue = 'envTask'
        treeItem.tooltip = new vscode.MarkdownString(
          `**${node.result.taskTitle}**\n\n- 状态：${STATUS_LABEL[node.result.status]}\n- 耗时：${node.result.durationMs}ms\n- 完成于：${new Date(node.result.finishedAt).toLocaleString()}`
        )
        return treeItem
      }
      case 'item': {
        const treeItem = new vscode.TreeItem(node.item.label, vscode.TreeItemCollapsibleState.None)
        treeItem.description = node.item.description ?? ''
        treeItem.iconPath = new vscode.ThemeIcon(STATUS_ICONS[node.item.status ?? 'missing'])
        if (node.item.tooltip) {
          treeItem.tooltip = node.item.tooltip
        }
        // 09 方案 §6.1：探针条目绑定单击「重新检测此项」（经 refreshEnvironment
        // 带参路由，单探针重检不阻塞其他条目）；系统信息条目（OS/VSCode）不绑定。
        if (findProbeByLabel(node.item.label)) {
          treeItem.command = {
            command: COMMAND.refreshEnvironment,
            title: '重新检测此项',
            arguments: [node.item.label],
          }
        }
        return treeItem
      }
      default: {
        const treeItem = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None)
        treeItem.iconPath = new vscode.ThemeIcon(node.icon)
        return treeItem
      }
    }
  }

  async getChildren(node?: EnvTreeNode): Promise<EnvTreeNode[]> {
    if (!node) {
      if (this.runner.isRunning) {
        return [{ kind: 'info', text: '正在检测环境…', icon: 'sync~spin' }]
      }
      const results = this.runner.lastResults
      if (!results.length) {
        return [{ kind: 'info', text: '尚未检测：点击右上角 ↻ 立即运行', icon: 'info' }]
      }
      return results.map((result): EnvTreeNode => ({ kind: 'task', result }))
    }
    if (node.kind === 'task') {
      return node.result.items.map((item): EnvTreeNode => ({ kind: 'item', item }))
    }
    return []
  }

  dispose(): void {
    this.subscription.dispose()
    this._onDidChangeTreeData.dispose()
  }
}

const STATUS_LABEL: Record<TaskStatus, string> = {
  ok: '正常',
  warn: '部分缺失',
  error: '失败',
}
