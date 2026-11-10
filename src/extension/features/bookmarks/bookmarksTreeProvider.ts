import * as vscode from 'vscode'
import { COMMAND, VIEW } from '../../constants'
import type { BookmarkItem, BookmarksService } from './bookmarksService'

/**
 * 「书签」树视图（v3.6，14 方案 §6，第 8 视图）。
 *
 * - 数据唯一来源 BookmarksService（onDidChange 驱动刷新，无轮询）；
 * - 两级结构：文件分组节点（label=basename、description=所在目录，单击=跳转组内第一条）
 *   → 书签条目（label=行文本快照、description=L 行号，单击=跳转）；
 * - 分组按存储 path 升序、组内按 line 升序（ordered 空间顺序即导航顺序，区别于
 *   收藏夹「新插头部」的 MRU 语义）；
 * - 空态 / 加载失败以 info 节点呈现（失败保留旧数据不清空）。
 */

export type BookmarkTreeNode =
  | { kind: 'file'; path: string; children: BookmarkItem[] }
  | { kind: 'bookmark'; item: BookmarkItem }
  | { kind: 'info'; text: string; icon: string }

/** POSIX 目录部分（根级文件返回 undefined → 不显示 description）。 */
function dirnamePosix(path: string): string | undefined {
  const index = path.lastIndexOf('/')
  return index > 0 ? path.slice(0, index) : undefined
}

function basenamePosix(path: string): string {
  const index = path.lastIndexOf('/')
  return index >= 0 ? path.slice(index + 1) : path
}

export class BookmarksTreeProvider
  implements vscode.TreeDataProvider<BookmarkTreeNode>, vscode.Disposable
{
  private readonly subscription: vscode.Disposable

  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    BookmarkTreeNode | undefined | void
  >()
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event

  constructor(private readonly bookmarks: BookmarksService) {
    this.subscription = bookmarks.onDidChange(() => this._onDidChangeTreeData.fire())
  }

  getTreeItem(node: BookmarkTreeNode): vscode.TreeItem {
    if (node.kind === 'info') {
      const info = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None)
      info.iconPath = new vscode.ThemeIcon(node.icon)
      return info
    }
    if (node.kind === 'file') {
      const treeItem = new vscode.TreeItem(basenamePosix(node.path), vscode.TreeItemCollapsibleState.Expanded)
      treeItem.description = dirnamePosix(node.path)
      treeItem.iconPath = new vscode.ThemeIcon('file')
      // 单击文件组 = 跳转其第一个书签（组内按 line 升序，children[0] 即最近顶端）
      treeItem.command = {
        command: COMMAND.jumpToBookmark,
        title: '跳转到书签',
        arguments: [node.children[0]],
      }
      treeItem.contextValue = VIEW.bookmarkFileContextValue
      treeItem.tooltip = new vscode.MarkdownString(
        [`**${node.path}**`, `- 共 ${node.children.length} 条书签`].join('\n')
      )
      return treeItem
    }
    const item = node.item
    const treeItem = new vscode.TreeItem(item.text, vscode.TreeItemCollapsibleState.None)
    treeItem.description = `L${item.line + 1}`
    treeItem.iconPath = new vscode.ThemeIcon('bookmark')
    treeItem.command = {
      command: COMMAND.jumpToBookmark,
      title: '跳转到书签',
      arguments: [item],
    }
    treeItem.contextValue = VIEW.bookmarkContextValue
    treeItem.tooltip = new vscode.MarkdownString(
      [
        `**${item.path}:L${item.line + 1}**`,
        `- 打点时间：${new Date(item.addedAt).toLocaleString()}`,
        `- 行文本为打点时快照，可能已过期`,
      ].join('\n')
    )
    return treeItem
  }

  async getChildren(element?: BookmarkTreeNode): Promise<BookmarkTreeNode[]> {
    if (element?.kind === 'file') {
      return element.children.map((item): BookmarkTreeNode => ({ kind: 'bookmark', item }))
    }
    if (this.bookmarks.loadError) {
      return [
        { kind: 'info', text: `书签数据加载失败：${this.bookmarks.loadError}`, icon: 'error' },
      ]
    }
    const items = this.bookmarks.ordered()
    if (items.length === 0) {
      return [
        {
          kind: 'info',
          text: '暂无书签：在编辑器中按 Ctrl+Alt+K 给当前行添加书签',
          icon: 'bookmark',
        },
      ]
    }
    // ordered 已按 (toPosix(path), line) 升序——按 path 分组即保序
    const groups: BookmarkTreeNode[] = []
    for (const item of items) {
      const last = groups.at(-1)
      if (last?.kind === 'file' && last.path === item.path) {
        last.children.push(item)
      } else {
        groups.push({ kind: 'file', path: item.path, children: [item] })
      }
    }
    return groups
  }

  dispose(): void {
    this.subscription.dispose()
    this._onDidChangeTreeData.dispose()
  }
}
