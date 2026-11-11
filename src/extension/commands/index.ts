import * as vscode from 'vscode'
import type { BookmarksService } from '../features/bookmarks/bookmarksService'
import type { DraftBoxService } from '../features/drafts/draftBoxService'
import type { FavoritesService } from '../features/favorites/favoritesService'
import type { InitService } from '../features/init/initService'
import type { QuickCommandsService } from '../features/quickCommands/quickCommandsService'
import type { TaskExplorerController } from '../features/taskExplorer/taskExplorerController'
import type { TaskRunner } from '../tasks/taskRunner'
import { registerBookmarksCommands } from './bookmarksCommands'
import { registerCopyCommands } from './copyCommands'
import { registerDraftCommands } from './draftCommands'
import { registerFavoritesCommands } from './favoritesCommands'
import { registerPageCommands } from './pageCommands'
import { registerQuickCommandsCommands } from './quickCommandsCommands'
import { registerTaskExplorerCommands } from './taskExplorerCommands'
import type { CommandRegistrar } from './shared'

/** 命令层依赖集合：新增功能时在此扩展，避免参数列表无限增长。 */
export interface CommandDeps {
  taskRunner: TaskRunner
  outputChannel: vscode.OutputChannel
  initService: InitService
  /** 打开任务管理弹框（v2.6：TaskManagerPanel.createOrShow，extension.ts 注入闭包）。 */
  openTaskManager: () => void
  /** 刷新任务管理树视图（v2.6）。 */
  refreshTaskManager: () => void
  /** 草稿箱（右键示例载体，09 方案 §3.5） */
  drafts: DraftBoxService
  /** 单探针重检（09 方案 §6.1：环境树节点单击路由）。 */
  recheckEnvironmentItem: (label: string) => Promise<void>
  /** 任务管理器（v2.3：工作区 .vscode/tasks.json 任务视图，10 方案） */
  taskExplorer: TaskExplorerController
  /** 收藏夹（v3.4：文件/文件夹路径收藏 + 别名 + 单击跳转，13 方案） */
  favorites: FavoritesService
  /** 快捷命令（v3.5：终端命令收藏 + 别名 + 分组 + 单击执行，16 方案） */
  quickCommands: QuickCommandsService
  /** 代码书签（v3.6：行级书签 + Ctrl+Alt+K，14 方案） */
  bookmarks: BookmarksService
}

/**
 * 命令注册中心：所有命令集中在此注册，每个命令对应一种「菜单入口 + 典型场景」。
 * 场景与菜单位置的完整对照表见 README。
 *
 * 具体命令按场景维度下沉到分组文件（pageCommands 功能页面 /
 * draftCommands 草稿箱 / 各功能命令组），共享工具在 shared.ts；
 * 本文件只保留组装逻辑与持有 ExtensionContext 的 register 闭包。
 * 命令注册键与清单的闭合由门禁第 ⑥ 步静态校验。
 */
export function registerCommands(context: vscode.ExtensionContext, deps: CommandDeps): void {
  const register: CommandRegistrar = (commandId, callback) => {
    context.subscriptions.push(vscode.commands.registerCommand(commandId, callback))
  }
  registerPageCommands(register, { ...deps, context })
  registerDraftCommands(register, { drafts: deps.drafts })
  registerCopyCommands(register) // v2.2：拷贝示例（无宿主依赖，剪贴板即全部）
  registerTaskExplorerCommands(register, { controller: deps.taskExplorer }) // v2.3：任务管理器
  registerFavoritesCommands(register, { favorites: deps.favorites }) // v3.4：收藏夹
  registerQuickCommandsCommands(register, { quickCommands: deps.quickCommands }) // v3.5：快捷命令
  registerBookmarksCommands(register, { bookmarks: deps.bookmarks }) // v3.6：代码书签
}
