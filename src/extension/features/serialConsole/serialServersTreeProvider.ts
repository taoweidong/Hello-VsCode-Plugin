import * as vscode from 'vscode'
import { COMMAND } from '../../constants'
import type { SerialServer } from './models'
import type { LinkStatusSnapshot } from './serialConsolePanel'

/**
 * 「串口服务器」树视图：服务器列表（名称 + 串口·波特率 + 连接状态）。
 * 数据每次刷新从 store 拉取；连接状态读共享快照（面板/控制器更新）。
 * 单击条目 = 连接并打开控制台（与其他功能树的单击行为一致）。
 */
export class SerialServersTreeProvider
  implements vscode.TreeDataProvider<SerialServerNode>, vscode.Disposable
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    SerialServerNode | undefined | void
  >()
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event

  constructor(
    private readonly deps: {
      loadServers: () => Promise<SerialServer[]>
      getStatus: () => LinkStatusSnapshot
    }
  ) {}

  refresh(): void {
    this._onDidChangeTreeData.fire()
  }

  getTreeItem(node: SerialServerNode): vscode.TreeItem {
    const { server } = node
    const status = this.deps.getStatus()
    const isActive = status.serverId === server.id
    const connected = isActive && status.state === 'connected'
    const connecting = isActive && status.state === 'connecting'

    const item = new vscode.TreeItem(server.name, vscode.TreeItemCollapsibleState.None)
    item.description = `${server.serialPath} · ${server.baudRate}`
    item.iconPath = new vscode.ThemeIcon(
      connected ? 'circle-filled' : connecting ? 'sync~spin' : 'server'
    )
    item.contextValue = connected ? 'serialServerConnected' : 'serialServer'
    item.tooltip = this.buildTooltip(server, status)
    item.command = {
      command: COMMAND.connectSerialServer,
      title: '连接并打开控制台',
      arguments: [node],
    }
    return item
  }

  async getChildren(): Promise<SerialServerNode[]> {
    try {
      const servers = await this.deps.loadServers()
      return servers.map((server) => ({ server }))
    } catch {
      return [] // 加载失败静默为空列表：警告已由 store 的 onWarning 上报输出通道
    }
  }

  private buildTooltip(server: SerialServer, status: LinkStatusSnapshot): vscode.MarkdownString {
    const statusLabel =
      status.serverId === server.id
        ? {
            connecting: '连接中…',
            connected: '● 已连接',
            error: '连接出错',
            disconnected: '已断开',
          }[status.state]
        : '未连接'
    const lines = [
      `**${server.name}**（${server.serialPath} · ${server.baudRate}）`,
      '',
      `- 状态：${statusLabel}`,
      `- 参数：${server.dataBits}${server.parity === 'none' ? 'N' : server.parity === 'even' ? 'E' : 'O'}${server.stopBits}${server.flowControl === 'hardware' ? ' · 硬件流控' : ''}`,
      `- 换行符：${server.lineEnding.toUpperCase()}`,
    ]
    if (server.autoLogin && server.username) {
      lines.push(`- 自动登录：${server.username}`)
    }
    if (server.description) {
      lines.push(`- 备注：${server.description}`)
    }
    lines.push('', '单击连接并打开控制台')
    const tooltip = new vscode.MarkdownString()
    tooltip.appendMarkdown(lines.join('\n'))
    return tooltip
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose()
  }
}

export interface SerialServerNode {
  server: SerialServer
}
