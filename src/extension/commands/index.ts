import * as vscode from 'vscode'
import type { DraftBoxService } from '../features/drafts/draftBoxService'
import type { InitService } from '../features/init/initService'
import type { SerialConsoleController } from '../features/serialConsole/serialConsoleController'
import type { TaskExplorerController } from '../features/taskExplorer/taskExplorerController'
import type { TaskRunner } from '../tasks/taskRunner'
import { registerCopyCommands } from './copyCommands'
import { registerDraftCommands } from './draftCommands'
import { registerPageCommands } from './pageCommands'
import { registerSerialConsoleCommands } from './serialConsoleCommands'
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
  /** 串口命令控制台（树视图 + 面板 + 历史的扩展级组装单元） */
  serialConsole: SerialConsoleController
  /** 草稿箱（右键示例载体，09 方案 §3.5） */
  drafts: DraftBoxService
  /** 单探针重检（09 方案 §6.1：环境树节点单击路由）。 */
  recheckEnvironmentItem: (label: string) => Promise<void>
  /** 任务管理器（v2.3：工作区 .vscode/tasks.json 任务视图，10 方案） */
  taskExplorer: TaskExplorerController
}

/**
 * 命令注册中心：所有命令集中在此注册，每个命令对应一种「菜单入口 + 典型场景」。
 * 场景与菜单位置的完整对照表见 README。
 *
 * 具体命令按场景维度下沉到分组文件（pageCommands 功能页面 /
 * serialConsoleCommands 串口 / draftCommands 草稿箱），共享工具在 shared.ts；
 * 本文件只保留组装逻辑与持有 ExtensionContext 的 register 闭包。
 * 命令注册键与清单的闭合由门禁第 ⑥ 步静态校验。
 */
export function registerCommands(context: vscode.ExtensionContext, deps: CommandDeps): void {
  const register: CommandRegistrar = (commandId, callback) => {
    context.subscriptions.push(vscode.commands.registerCommand(commandId, callback))
  }
  registerPageCommands(register, { ...deps, context })
  registerSerialConsoleCommands(register, { controller: deps.serialConsole })
  registerDraftCommands(register, { drafts: deps.drafts })
  registerCopyCommands(register) // v2.2：拷贝示例（无宿主依赖，剪贴板即全部）
  registerTaskExplorerCommands(register, { controller: deps.taskExplorer }) // v2.3：任务管理器
}
