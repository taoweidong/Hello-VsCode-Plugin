import * as vscode from 'vscode'
import {
  WebviewController,
  type WebviewControllerDeps,
} from '../../../webview/host/webviewController'
import { createCommandHistoryService, type CommandHistoryService } from './commandHistoryService'
import {
  createSerialConsoleDeps,
  toServerWire,
  type LinkStatusSnapshot,
  type SerialConsoleServices,
} from './serialConsolePanel'
import { createNodeSerialPortFactory, type SerialPortFactory } from './serialPortFactory'
import { createSerialLinkService, type SerialLinkService } from './serialLinkService'
import { SerialServersTreeProvider } from './serialServersTreeProvider'
import { createServerStore, type IServerStore } from './serverStore'
import { removeServerEverywhere } from './serverRemoval'

/**
 * 串口控制台的扩展级组装单元（extension.ts 只与它对接）：
 * - 持有共享 SerialLinkService（串口消息经控制器 hooks 推送到当前面板）；
 * - 持有连接状态快照与树视图（树徽标 / 树刷新）；
 * - 为面板（新建与序列化恢复）提供同一份 WebviewControllerDeps；
 * - 提供树视图右键删除的落库路径（面板打开时同步推送最新列表）。
 */
export class SerialConsoleController implements vscode.Disposable {
  readonly store: IServerStore
  readonly history: CommandHistoryService
  readonly portFactory: SerialPortFactory
  readonly link: SerialLinkService
  readonly treeProvider: SerialServersTreeProvider

  private readonly linkStatus: LinkStatusSnapshot = {
    serverId: undefined,
    state: 'disconnected',
  }
  private activeServerId: string | undefined
  private panelDeps: WebviewControllerDeps | undefined
  private readonly logChannel: vscode.OutputChannel

  constructor(
    private readonly context: vscode.ExtensionContext,
    outputChannel: vscode.OutputChannel
  ) {
    this.logChannel = outputChannel
    this.store = createServerStore(context, {
      onWarning: (message) => outputChannel.appendLine(`[serial] ${message}`),
    })
    this.history = createCommandHistoryService(context.globalState)
    this.portFactory = createNodeSerialPortFactory()
    this.link = createSerialLinkService(this.portFactory, {
      onData: (text, seq) => void this.post({ type: 'serialData', seq, text }),
      onState: (state, error) => {
        this.linkStatus.state = state
        this.linkStatus.serverId = this.activeServerId
        void this.post({
          type: 'serialState',
          serverId: this.activeServerId ?? null,
          state,
          error,
        })
        this.treeProvider.refresh()
      },
    })
    this.treeProvider = new SerialServersTreeProvider({
      loadServers: () => this.store.load(),
      getStatus: () => this.linkStatus,
    })
  }

  /** 面板服务（面板新建 / 命令打开共用同一份，串口链路与状态全局唯一）。 */
  services(): SerialConsoleServices {
    return {
      store: this.store,
      history: this.history,
      portFactory: this.portFactory,
      secrets: this.context.secrets,
      link: this.link,
      linkStatus: this.linkStatus,
      onBeforeConnect: (serverId) => {
        this.activeServerId = serverId
        this.linkStatus.serverId = serverId
      },
      onServersChanged: () => this.treeProvider.refresh(),
      logger: (message) => this.logChannel?.appendLine(`[serial] ${message}`),
    }
  }

  /** 面板依赖（含序列化恢复路径）；同一实例复用，link 不重复创建。 */
  panelDepsOrCreate(): WebviewControllerDeps {
    this.panelDeps ??= createSerialConsoleDeps(this.services())
    return this.panelDeps
  }

  /**
   * 树视图右键删除：核心逻辑收敛到 removeServerEverywhere（与面板路径同实现）；
   * 面板打开时同步推送最新列表（避免页面缓存悬空）。落盘失败向上抛
   * （命令层统一 showError），密码清理失败以告警呈现、不阻断删除。
   */
  async deleteServer(id: string): Promise<'deleted' | 'missing'> {
    const result = await removeServerEverywhere(
      {
        store: this.store,
        secrets: this.context.secrets,
        link: this.link,
        logger: (message) => this.logChannel?.appendLine(`[serial] ${message}`),
      },
      id
    )
    if (result.status === 'missing') {
      return 'missing'
    }
    if (result.secretError) {
      void vscode.window.showWarningMessage(result.secretError)
    }
    await this.post({ type: 'serialServers', servers: result.rest.map(toServerWire) })
    this.treeProvider.refresh()
    return 'deleted'
  }

  dispose(): void {
    this.link.disconnect()
    this.treeProvider.dispose()
  }

  private post(message: Parameters<WebviewController['post']>[0]): unknown {
    return WebviewController.get('serialConsole')?.post(message)
  }
}
