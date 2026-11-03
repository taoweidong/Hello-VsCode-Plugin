import * as vscode from 'vscode'
import { COMMAND, CONFIG } from '../constants'
import type { SerialConsoleController } from '../features/serialConsole/serialConsoleController'
import { SerialConsolePanel } from '../features/serialConsole/serialConsolePanel'
import type { SerialServerNode } from '../features/serialConsole/serialServersTreeProvider'
import type { CommandRegistrar } from './shared'

/**
 * 串口控制台场景命令分组——打开控制台 / 新增 / 编辑 / 连接 / 删除 / 刷新。
 *
 * 服务器的新增与编辑在控制台页面内完成（页面持有表单），命令只负责
 * 打开页面并（可能）预选目标；删除在树侧落库（controller.deleteServer）。
 *
 * 09 方案阶段 2（S1/S3）：特性开关体系退场——
 * - S1：serialConsole 开关改为普通配置项 extStarter.serialConsoleEnabled；
 * - S3：删除确认不再读 confirmDelete 开关，一律模态确认。
 */

export interface SerialConsoleCommandDeps {
  controller: SerialConsoleController
  /** 扩展上下文：SerialConsolePanel.configure 已由 extension.ts 完成，此处仅类型完备。 */
  context: vscode.ExtensionContext
}

export function registerSerialConsoleCommands(
  register: CommandRegistrar,
  deps: SerialConsoleCommandDeps
): void {
  const { controller } = deps

  /** 开关关闭时命令给出可操作提示（设置项 extStarter.serialConsoleEnabled）。 */
  const isEnabled = (): boolean =>
    vscode.workspace
      .getConfiguration(CONFIG.section)
      .get<boolean>(CONFIG.serialConsoleEnabled, true)

  const guard =
    <TArgs extends unknown[]>(run: (...args: TArgs) => unknown): ((...args: TArgs) => unknown) =>
    (...args: TArgs) => {
      if (!isEnabled()) {
        void vscode.window.showInformationMessage(
          '串口控制台功能已关闭：可在设置（extStarter.serialConsoleEnabled）中开启。'
        )
        return
      }
      return run(...args)
    }

  const openPanel = (initialServerId?: string): void => {
    SerialConsolePanel.createOrShow(controller.services(), initialServerId)
  }

  register(
    COMMAND.openSerialConsole,
    guard(() => openPanel())
  )

  register(
    COMMAND.addSerialServer,
    guard(() => openPanel())
  )

  // 「编辑」与「连接」当前是同一动作（打开面板并预选服务器，P3-C3 收敛为同一
  // handler）：将来语义分叉时在此拆开，避免只改一处
  const openPanelWithNodeId = guard((node?: SerialServerNode) => openPanel(node?.server.id))

  register(COMMAND.editSerialServer, openPanelWithNodeId)

  register(COMMAND.connectSerialServer, openPanelWithNodeId)

  register(
    COMMAND.deleteSerialServer,
    guard(async (node?: SerialServerNode) => {
      const server = node?.server
      if (!server) {
        return
      }
      // S3：一律模态确认（原 confirmDelete 特性开关已随体系退场）
      const choice = await vscode.window.showWarningMessage(
        `确定删除服务器「${server.name}」（${server.serialPath}）？已保存的登录密码将一并清除。`,
        { modal: true },
        '删除'
      )
      if (choice !== '删除') {
        return
      }
      const result = await controller.deleteServer(server.id)
      if (result === 'missing') {
        void vscode.window.showWarningMessage('服务器不存在（可能已被删除），列表已刷新。')
      }
    })
  )

  register(
    COMMAND.refreshSerialServers,
    guard(() => controller.treeProvider.refresh())
  )
}
