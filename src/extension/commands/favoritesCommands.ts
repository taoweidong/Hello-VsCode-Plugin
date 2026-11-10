import * as vscode from 'vscode'
import type { FavoriteItem, FavoritesService } from '../features/favorites/favoritesService'
import { COMMAND } from '../constants'
import { requireTreeItem, resolveExplorerTargets, type CommandRegistrar, showError } from './shared'

/**
 * 收藏夹场景命令分组（v3.4，13 方案；v3.6 增 openFavoritesDataFile，15 方案）——
 * 8 条命令的薄壳，全部委托 FavoritesService。
 *
 - addFavorite：资源管理器右键收 (uri, uris[])（单选/多选批量）、编辑器右键/标题栏收当前文件；
   单条添加弹别名输入框（默认 basename，可留空），批量添加直接用 basename 并汇总提示；
 - 带参命令（open/reveal/copy/rename/remove）无参调用给出可操作提示，不抛错；
   quickOpenFavorites 用 QuickPick 列出全部收藏，回车即打开；
 - openFavoritesDataFile：确保数据文件存在后用编辑器打开——手动备份/迁移直接拷该文件。
 */

export interface FavoritesCommandDeps {
  favorites: FavoritesService
}

function isFavoriteItem(value: unknown): value is FavoriteItem {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { id?: unknown }).id === 'string' &&
    typeof (value as { path?: unknown }).path === 'string'
  )
}

export function registerFavoritesCommands(
  register: CommandRegistrar,
  deps: FavoritesCommandDeps
): void {
  const { favorites } = deps

  register(COMMAND.addFavorite, async (uri?: unknown, uris?: unknown[]) => {
    // 多选批量（explorer/context 传入 [uri, uris[]]）；单选 / 编辑器侧当前文件
    const targets = resolveExplorerTargets(uri, uris)
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
    const item = requireTreeItem(arg, isFavoriteItem, `请从「收藏夹」视图调用打开。`)
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
    const item = requireTreeItem(arg, isFavoriteItem, `请从「收藏夹」视图调用显示。`)
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
    const item = requireTreeItem(arg, isFavoriteItem, `请从「收藏夹」视图复制路径。`)
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
    const item = requireTreeItem(arg, isFavoriteItem, `请从「收藏夹」视图重命名别名。`)
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
    const item = requireTreeItem(arg, isFavoriteItem, `请从「收藏夹」视图移除收藏。`)
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

  // 15 方案：打开数据文件——文件缺失先写空信封（所见即存储格式），失败如实提示
  register(COMMAND.openFavoritesDataFile, async () => {
    try {
      await favorites.ensureDataFile()
      await vscode.commands.executeCommand('vscode.open', favorites.dataFileUri())
    } catch (err) {
      showError(err)
    }
  })
}
