import type { TaskExplorerController } from '../features/taskExplorer/taskExplorerController'
import { COMMAND } from '../constants'
import type { CommandRegistrar } from './shared'

/**
 * 任务管理器场景命令分组（v2.3，10 方案 §10）——8 条命令的薄壳，
 * 全部委托 TaskExplorerController（watcher / 信任 / 归一化 / 持久化都在控制器）。
 *
 * 带参命令（运行/停止/定位/收藏）在命令面板被无参调用时给出可操作提示，不抛错；
 * 运行/停止内部仍做 workspace.isTrusted 检查（菜单 when 不是安全边界）。
 */

export function registerTaskExplorerCommands(
  register: CommandRegistrar,
  deps: { controller: TaskExplorerController }
): void {
  const { controller } = deps

  register(COMMAND.refreshTaskExplorer, () => controller.refresh())
  register(COMMAND.runWorkspaceTask, (arg?: unknown) => controller.run(arg))
  register(COMMAND.stopWorkspaceTask, (arg?: unknown) => controller.stop(arg))
  register(COMMAND.openTasksJson, (arg?: unknown) => controller.openTasksJson(arg))
  register(COMMAND.locateTaskInTasksJson, (arg?: unknown) => controller.locate(arg))
  register(COMMAND.addTaskToFavorites, (arg?: unknown) => controller.addFavorite(arg))
  register(COMMAND.removeTaskFromFavorites, (arg?: unknown) => controller.removeFavorite(arg))
  register(COMMAND.clearRecentTasks, () => controller.clearRecent())
}
