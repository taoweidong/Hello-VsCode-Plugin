import * as vscode from 'vscode'
import type { BookmarkItem, BookmarksService } from '../features/bookmarks/bookmarksService'
import { COMMAND } from '../constants'
import { requireTreeItem, type CommandRegistrar, showError } from './shared'

/**
 * 书签场景命令分组（v3.6，14 方案 §5 + 实施期修正 jumpToBookmark）——8 条命令的薄壳，
 * 全部委托 BookmarksService。
 *
 - toggleBookmark：活动编辑器当前行打/取消（行文本快照由服务截取）；
   无活动编辑器 / 非 file: 协议如实提示，不产生数据；
 - jumpToNext/PreviousBookmark：循环导航委托服务（排序与回绕口径见 service.next）；
 - 带参命令（jump/remove）无参调用给出可操作提示，不抛错；
   quickOpenBookmarks 用 QuickPick 列出全部书签，回车即跳转；
   clearBookmarks 模态确认后清空；openBookmarksDataFile 打开存储 JSON。
 */

export interface BookmarksCommandDeps {
  bookmarks: BookmarksService
}

/** 入参形状守卫（树节点经 TreeItem.command 传回的 BookmarkItem）。 */
function isBookmarkItem(value: unknown): value is BookmarkItem {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { id?: unknown }).id === 'string' &&
    typeof (value as { path?: unknown }).path === 'string' &&
    typeof (value as { line?: unknown }).line === 'number'
  )
}

const EMPTY_HINT = '暂无书签：在编辑器中按 Ctrl+Alt+K 给当前行添加书签。'

export function registerBookmarksCommands(
  register: CommandRegistrar,
  deps: BookmarksCommandDeps
): void {
  const { bookmarks } = deps

  register(COMMAND.toggleBookmark, async () => {
    const editor = vscode.window.activeTextEditor
    if (!editor) {
      void vscode.window.showInformationMessage('没有活动的编辑器。')
      return
    }
    if (editor.document.uri.scheme !== 'file') {
      void vscode.window.showInformationMessage('代码书签仅支持本地文件。')
      return
    }
    const line = editor.selection.active.line
    try {
      const result = await bookmarks.toggle(
        editor.document.uri,
        line,
        editor.document.lineAt(line).text
      )
      const message = result.added
        ? `已添加书签（第 ${line + 1} 行）。`
        : `已移除书签（第 ${line + 1} 行）。`
      void vscode.window.showInformationMessage(message)
    } catch (err) {
      showError(err)
    }
  })

  const jumpRelative = async (direction: 'next' | 'prev'): Promise<void> => {
    if (bookmarks.list().length === 0) {
      void vscode.window.showInformationMessage(EMPTY_HINT)
      return
    }
    const editor = vscode.window.activeTextEditor
    const target = bookmarks.next(
      editor?.document.uri,
      editor ? editor.selection.active.line : undefined,
      direction
    )
    if (!target) {
      return
    }
    try {
      await bookmarks.jump(target)
    } catch (err) {
      showError(err)
    }
  }

  register(COMMAND.jumpToNextBookmark, () => jumpRelative('next'))

  register(COMMAND.jumpToPreviousBookmark, () => jumpRelative('prev'))

  register(COMMAND.quickOpenBookmarks, async () => {
    const items = bookmarks.ordered()
    if (items.length === 0) {
      void vscode.window.showInformationMessage(EMPTY_HINT)
      return
    }
    const picked = await vscode.window.showQuickPick(
      items.map((item) => ({
        label: `${item.path.split(/[\\/]/).pop() || item.path}:${item.line + 1}`,
        description: item.text,
        detail: item.path,
        item,
      })),
      { placeHolder: '跳转到书签…' }
    )
    if (!picked) {
      return
    }
    try {
      await bookmarks.jump(picked.item)
    } catch (err) {
      showError(err)
    }
  })

  register(COMMAND.jumpToBookmark, async (arg?: unknown) => {
    const item = requireTreeItem(arg, isBookmarkItem, `请从「书签」视图调用跳转。`)
    if (!item) {
      return
    }
    try {
      await bookmarks.jump(item)
    } catch (err) {
      showError(err)
    }
  })

  register(COMMAND.removeBookmark, async (arg?: unknown) => {
    const item = requireTreeItem(arg, isBookmarkItem, `请从「书签」视图调用移除。`)
    if (!item) {
      return
    }
    try {
      const removed = await bookmarks.remove(item.id)
      if (removed) {
        void vscode.window.showInformationMessage(`已移除书签（${item.path}:L${item.line + 1}）。`)
      }
    } catch (err) {
      showError(err)
    }
  })

  register(COMMAND.clearBookmarks, async () => {
    const confirmed = await vscode.window.showWarningMessage(
      '确定清空全部书签？此操作不可撤销。',
      { modal: true },
      '清空'
    )
    if (confirmed !== '清空') {
      return
    }
    try {
      const count = await bookmarks.clear()
      void vscode.window.showInformationMessage(`已清空 ${count} 条书签。`)
    } catch (err) {
      showError(err)
    }
  })

  // 15 方案口径：打开数据文件——文件缺失先写空信封（所见即存储格式），失败如实提示
  register(COMMAND.openBookmarksDataFile, async () => {
    try {
      await bookmarks.ensureDataFile()
      await vscode.commands.executeCommand('vscode.open', bookmarks.dataFileUri())
    } catch (err) {
      showError(err)
    }
  })
}
