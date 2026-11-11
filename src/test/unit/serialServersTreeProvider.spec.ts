import { describe, expect, it, vi } from 'vitest'
import * as vscode from 'vscode'
import { COMMAND } from '../../extension/constants'
import type { SerialServer } from '../../extension/features/serialConsole/models'
import type { LinkStatusSnapshot } from '../../extension/features/serialConsole/serialConsolePanel'
import { SerialServersTreeProvider } from '../../extension/features/serialConsole/serialServersTreeProvider'

function makeServer(overrides: Partial<SerialServer> = {}): SerialServer {
  return {
    id: 'srv-1',
    name: '服务器甲',
    serialPath: 'COM3',
    baudRate: 115200,
    dataBits: 8,
    stopBits: 1,
    parity: 'none',
    flowControl: 'none',
    lineEnding: 'lf',
    autoLogin: false,
    username: '',
    description: '',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function makeProvider(
  servers: SerialServer[],
  status: LinkStatusSnapshot = { serverId: undefined, state: 'disconnected' }
) {
  const loadServers = vi.fn(async () => servers)
  const provider = new SerialServersTreeProvider({ loadServers, getStatus: () => status })
  return { provider, loadServers }
}

describe('SerialServersTreeProvider', () => {
  it('getChildren 从 store 加载并包装节点', async () => {
    const { provider } = makeProvider([makeServer(), makeServer({ id: 'srv-2' })])
    const children = await provider.getChildren()
    expect(children.map((node) => node.server?.id)).toEqual(['srv-1', 'srv-2'])
  })

  it('加载失败 → 错误节点（P3-11：不再静默空树，警告仍由 store 上报）', async () => {
    const provider = new SerialServersTreeProvider({
      loadServers: () => Promise.reject(new Error('io')),
      getStatus: () => ({ serverId: undefined, state: 'disconnected' }),
    })
    const nodes = await provider.getChildren()
    expect(nodes).toHaveLength(1)
    expect(nodes[0]?.server).toBeUndefined()
    expect(nodes[0]?.errorMessage).toContain('服务器列表加载失败')
    const item = provider.getTreeItem(nodes[0]!)
    expect(item.contextValue).toBe('serialServersError')
    expect(item.label).toContain('服务器列表加载失败')
  })

  it('未连接条目：描述为 串口·波特率，contextValue=serialServer，单击命令为连接', async () => {
    const { provider } = makeProvider([makeServer()])
    const [node] = await provider.getChildren()
    const item = provider.getTreeItem(node)
    expect(item.label).toBe('服务器甲')
    expect(item.description).toBe('COM3 · 115200')
    expect(item.contextValue).toBe('serialServer')
    expect(item.command).toMatchObject({
      command: COMMAND.connectSerialServer,
      arguments: [node],
    })
  })

  it('已连接条目：contextValue=serialServerConnected（菜单/图标可区分）', async () => {
    const { provider } = makeProvider([makeServer()], {
      serverId: 'srv-1',
      state: 'connected',
    })
    const [node] = await provider.getChildren()
    expect(provider.getTreeItem(node).contextValue).toBe('serialServerConnected')
  })

  it('连接中/出错状态不误标为已连接', async () => {
    for (const state of ['connecting', 'error', 'disconnected'] as const) {
      const { provider } = makeProvider([makeServer()], { serverId: 'srv-1', state })
      const [node] = await provider.getChildren()
      expect(provider.getTreeItem(node).contextValue).toBe('serialServer')
    }
  })

  it('tooltip 汇总参数与状态；自动登录信息只在开启时出现', async () => {
    const { provider } = makeProvider([
      makeServer({ autoLogin: true, username: 'root', flowControl: 'hardware' }),
    ])
    const [node] = await provider.getChildren()
    const tooltip = provider.getTreeItem(node).tooltip as vscode.MarkdownString
    expect(tooltip.value).toContain('115200')
    expect(tooltip.value).toContain('硬件流控')
    expect(tooltip.value).toContain('root')

    const plain = makeProvider([makeServer()])
    const [plainNode] = await plain.provider.getChildren()
    const plainTooltip = plain.provider.getTreeItem(plainNode).tooltip as vscode.MarkdownString
    expect(plainTooltip.value).not.toContain('自动登录')
  })

  it('refresh 触发 onDidChangeTreeData', () => {
    const { provider } = makeProvider([])
    let fired = false
    provider.onDidChangeTreeData(() => (fired = true))
    provider.refresh()
    expect(fired).toBe(true)
  })
})
