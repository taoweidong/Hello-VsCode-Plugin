import * as vscode from 'vscode'
import { COMMAND } from '../../constants'
import type { FavoriteItem, FavoritesService } from './favoritesService'

/**
 * 「收藏夹」树视图（v3.4，13 方案）。
 *
 * - 数据唯一来源 FavoritesService（onDidChange 驱动刷新，无轮询）；
 * - 条目：label = 别名，description = 存储路径，图标按 文件/文件夹 区分；
 * - 单击条目路由 openFavorite（文件→编辑器；文件夹→资源管理器 reveal）；
 * - 空态 / 加载失败以 info 节点呈现（失败保留旧数据不清空）。
 */

export type FavoriteTreeNode =
  { kind: 'favorite'; item: FavoriteItem } | { kind: 'info'; text: string; icon: string }

export class FavoritesTreeProvider
  implements vscode.TreeDataProvider<FavoriteTreeNode>, vscode.Disposable
{
  private readonly subscription: vscode.Disposable

  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    FavoriteTreeNode | undefined | void
  >()
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event

  constructor(private readonly favorites: FavoritesService) {
    this.subscription = favorites.onDidChange(() => this._onDidChangeTreeData.fire())
  }

  getTreeItem(node: FavoriteTreeNode): vscode.TreeItem {
    if (node.kind === 'info') {
      const info = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None)
      info.iconPath = new vscode.ThemeIcon(node.icon)
      return info
    }
    const item = node.item
    const treeItem = new vscode.TreeItem(item.name, vscode.TreeItemCollapsibleState.None)
    treeItem.description = item.path
    treeItem.iconPath = new vscode.ThemeIcon(item.isFolder ? 'folder' : 'file')
    // 单击直达：文件→编辑器，文件夹→资源管理器 reveal（带参路由同一命令）
    treeItem.command = {
      command: COMMAND.openFavorite,
      title: '打开收藏项',
      arguments: [item],
    }
    treeItem.contextValue = 'favorite'
    treeItem.tooltip = new vscode.MarkdownString(
      [
        `**${item.name}**（${item.isFolder ? '文件夹' : '文件'}）`,
        `- 路径：${item.path}`,
        `- 收藏于：${new Date(item.addedAt).toLocaleString()}`,
      ].join('\n')
    )
    return treeItem
  }

  async getChildren(): Promise<FavoriteTreeNode[]> {
    if (this.favorites.loadError) {
      return [
        { kind: 'info', text: `收藏数据加载失败：${this.favorites.loadError}`, icon: 'error' },
      ]
    }
    const items = this.favorites.list()
    if (items.length === 0) {
      return [
        {
          kind: 'info',
          text: '暂无收藏：在资源管理器右键文件/文件夹 → 添加到收藏夹',
          icon: 'star-empty',
        },
      ]
    }
    return items.map((item): FavoriteTreeNode => ({ kind: 'favorite', item }))
  }

  dispose(): void {
    this.subscription.dispose()
    this._onDidChangeTreeData.dispose()
  }
}
