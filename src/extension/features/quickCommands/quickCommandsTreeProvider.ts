import * as vscode from 'vscode'
import { COMMAND, VIEW } from '../../constants'
import { UNGROUPED_LABEL } from './quickCommandsService'
import type {
  QuickCommandGroup,
  QuickCommandItem,
  QuickCommandsService,
} from './quickCommandsService'

/**
 * 「快捷命令」树视图（v3.5，16 方案）。
 *
 * - 数据唯一来源 QuickCommandsService（onDidChange 驱动刷新，无轮询）；
 * - 两级树：分组节点（label 含计数，未分组固定末位且无内容不显示）→ 命令节点；
 * - 命令节点：label = 别名，description = 命令单行截断，
 *   单击路由 executeQuickCommand（在专用终端执行）；
 * - 空态 / 加载失败以 info 节点呈现（失败保留旧数据不清空）。
 */

export type QuickCommandTreeNode =
  | { kind: 'group'; group: QuickCommandGroup | null; children: QuickCommandItem[] }
  | { kind: 'command'; item: QuickCommandItem; group: QuickCommandGroup | null }
  | { kind: 'info'; text: string; icon: string }

/** 命令文本的单行展示形态（空白折叠 + 截断，仅影响展示不改存储）。 */
function singleLine(command: string, max = 60): string {
  const collapsed = command.replace(/\s+/g, ' ').trim()
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed
}

export class QuickCommandsTreeProvider
  implements vscode.TreeDataProvider<QuickCommandTreeNode>, vscode.Disposable
{
  private readonly subscription: vscode.Disposable

  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    QuickCommandTreeNode | undefined | void
  >()
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event

  constructor(private readonly quickCommands: QuickCommandsService) {
    this.subscription = quickCommands.onDidChange(() => this._onDidChangeTreeData.fire())
  }

  getTreeItem(node: QuickCommandTreeNode): vscode.TreeItem {
    if (node.kind === 'info') {
      const info = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None)
      info.iconPath = new vscode.ThemeIcon(node.icon)
      return info
    }
    if (node.kind === 'group') {
      const label = node.group ? node.group.name : UNGROUPED_LABEL
      const treeItem = new vscode.TreeItem(
        `${label} (${node.children.length})`,
        vscode.TreeItemCollapsibleState.Collapsed
      )
      treeItem.iconPath = new vscode.ThemeIcon(node.group ? 'folder' : 'inbox')
      treeItem.contextValue = VIEW.quickCommandGroupContextValue
      return treeItem
    }
    const item = node.item
    const treeItem = new vscode.TreeItem(item.name, vscode.TreeItemCollapsibleState.None)
    treeItem.description = singleLine(item.command)
    treeItem.iconPath = new vscode.ThemeIcon('terminal')
    // 单击直达：在专用终端执行（带参路由同一命令）
    treeItem.command = {
      command: COMMAND.executeQuickCommand,
      title: '执行快捷命令',
      arguments: [item],
    }
    treeItem.contextValue = VIEW.quickCommandContextValue
    treeItem.tooltip = new vscode.MarkdownString(
      [
        `**${item.name}**`,
        `- 命令：\`${item.command.replace(/`/g, '\\`')}\``,
        `- 分组：${node.group ? node.group.name : UNGROUPED_LABEL}`,
        `- 已执行：${item.useCount ?? 0} 次${item.lastUsedAt ? `（最近 ${new Date(item.lastUsedAt).toLocaleString()}）` : ''}`,
        `- 收藏于：${new Date(item.addedAt).toLocaleString()}`,
      ].join('\n')
    )
    return treeItem
  }

  async getChildren(element?: QuickCommandTreeNode): Promise<QuickCommandTreeNode[]> {
    if (element) {
      return element.kind === 'group'
        ? element.children.map((item): QuickCommandTreeNode => ({
            kind: 'command',
            item,
            group: element.group,
          }))
        : []
    }
    if (this.quickCommands.loadError) {
      return [
        {
          kind: 'info',
          text: `快捷命令数据加载失败：${this.quickCommands.loadError}`,
          icon: 'error',
        },
      ]
    }
    const commands = this.quickCommands.listCommands()
    const groups = this.quickCommands.listGroups()
    if (groups.length === 0 && commands.length === 0) {
      return [
        {
          kind: 'info',
          text: '暂无快捷命令：命令面板「新增快捷命令」，或在终端选中命令后收藏',
          icon: 'terminal',
        },
      ]
    }
    const nodes: QuickCommandTreeNode[] = groups.map((group) => ({
      kind: 'group',
      group,
      children: commands.filter((item) => item.groupId === group.id),
    }))
    const ungrouped = commands.filter((item) => item.groupId === null)
    if (ungrouped.length > 0) {
      nodes.push({ kind: 'group', group: null, children: ungrouped }) // 未分组固定末位
    }
    return nodes
  }

  dispose(): void {
    this.subscription.dispose()
    this._onDidChangeTreeData.dispose()
  }
}
