import * as vscode from 'vscode'
import type { FavoriteItem, FavoritesService } from '../features/favorites/favoritesService'
import { COMMAND } from '../constants'
import { type CommandRegistrar, showError } from './shared'

/**
 * 收藏夹场景命令分组（v3.4，13 方案）——7 条命令的薄壳，全部委托 FavoritesService。
 *
 - addFavorite：资源管理器右键收 (uri, uris[])（单选/多选批量）、编辑器右键/标题栏收当前文件；
   单条添加弹别名输入框（默认 basename，可留空），批量添加直接用 basename 并汇总提示；
 - 带参命令（open/reveal/copy/rename/remove）无参调用给出可操作提示，不抛错；
   quickOpenFavorites 用 QuickPick 列出全部收藏，回车即打开。
 */

export interface FavoritesCommandDeps {
  favorites: FavoritesService
}

/** 入参归一化为 Uri（资源管理器右键传入；其他来源可能传任意值）。 */
function toUri(value: unknown): vscode.Uri | undefined {
  return value instanceof vscode.Uri ? value : undefined
}

/** 当前编辑器文件 URI（未打开文件时 undefined）。 */
function currentFileUri(): vscode.Uri | undefined {
  return vscode.window.activeTextEditor?.document.uri
}

function isFavoriteItem(value: unknown): value is FavoriteItem {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { id?: unknown }).id === 'string' &&
    typeof (value as { path?: unknown }).path === 'string'
  )
}

function requireItem(value: unknown, action: string): FavoriteItem | undefined {
  if (isFavoriteItem(value)) {
    return value
  }
  void vscode.window.showInformationMessage(`请从「收藏夹」视图${action}。`)
  return undefined
}

export function registerFavoritesCommands(
  register: CommandRegistrar,
  deps: FavoritesCommandDeps
): void {
  const { favorites } = deps

  register(COMMAND.addFavorite, async (uri?: unknown, uris?: unknown[]) => {
    // 多选批量（explorer/context 传入 [uri, uris[]]）；单选 / 编辑器侧当前文件
    const batch = Array.isArray(uris) ? uris.map(toUri).filter((u): u is vscode.Uri => !!u) : []
    const single = toUri(uri) ?? currentFileUri()
    const targets = batch.length > 0 ? batch : single ? [single] : []
    if (targets.length === 0) {
      void vscode.window.showInformationMessage('没有可收藏的文件或文件夹。')
      return
    }
    let alias: string | undefined
    if (targets.length === 1) {
      const fallback = targets[0].fsPath.split(/[\\/]/).pop() || ''
      alias = await vscode.window.showInputBox({
        prompt: '收藏别名（留空使用文件/文件夹名）',
        value: fallback,
      })
      if (alias === undefined) {
        return // 用户取消输入框
      }
    }
    try {
      const result = await favorites.add(targets, alias)
      const parts: string[] = []
      if (result.added > 0) {
        parts.push(`已收藏 ${result.added} 项`)
      }
      if (result.skipped > 0) {
        parts.push(`${result.skipped} 项跳过（不可访问或已收藏）`)
      }
      if (parts.length > 0) {
        void vscode.window.showInformationMessage(`收藏夹：${parts.join('，')}。`)
      }
    } catch (err) {
      showError(err)
    }
  })

  register(COMMAND.quickOpenFavorites, async () => {
    const items = favorites.list()
    if (items.length === 0) {
      void vscode.window.showInformationMessage('收藏夹为空：先在资源管理器右键添加收藏。')
      return
    }
    const picked = await vscode.window.showQuickPick(
      items.map((item) => ({
        label: item.name,
        description: item.path,
        detail: item.isFolder ? '文件夹' : '文件',
        item,
      })),
      { placeHolder: '打开收藏…' }
    )
    if (!picked) {
      return
    }
    try {
      await favorites.open(picked.item)
    } catch (err) {
      showError(err)
    }
  })

  register(COMMAND.openFavorite, async (arg?: unknown) => {
    const item = requireItem(arg, '调用打开')
    if (!item) {
      return
    }
    try {
      await favorites.open(item)
    } catch (err) {
      showError(err)
    }
  })

  register(COMMAND.revealFavorite, async (arg?: unknown) => {
    const item = requireItem(arg, '调用显示')
    if (!item) {
      return
    }
    try {
      await favorites.reveal(item)
    } catch (err) {
      showError(err)
    }
  })

  register(COMMAND.copyFavoritePath, async (arg?: unknown) => {
    const item = requireItem(arg, '复制路径')
    if (!item) {
      return
    }
    try {
      const absolute = await favorites.absolutePath(item)
      await vscode.env.clipboard.writeText(absolute)
      void vscode.window.showInformationMessage(`已复制路径：${absolute}`)
    } catch (err) {
      showError(err)
    }
  })

  register(COMMAND.renameFavorite, async (arg?: unknown) => {
    const item = requireItem(arg, '重命名别名')
    if (!item) {
      return
    }
    const name = await vscode.window.showInputBox({
      prompt: '新的收藏别名',
      value: item.name,
    })
    if (name === undefined) {
      return
    }
    try {
      const renamed = await favorites.rename(item.id, name)
      if (!renamed) {
        void vscode.window.showInformationMessage('别名不能为空，或收藏项已不存在。')
      }
    } catch (err) {
      showError(err)
    }
  })

  register(COMMAND.removeFavorite, async (arg?: unknown) => {
    const item = requireItem(arg, '移除收藏')
    if (!item) {
      return
    }
    try {
      const removed = await favorites.remove(item.id)
      if (removed) {
        void vscode.window.showInformationMessage(`已从收藏夹移除「${item.name}」。`)
      }
    } catch (err) {
      showError(err)
    }
  })
}
