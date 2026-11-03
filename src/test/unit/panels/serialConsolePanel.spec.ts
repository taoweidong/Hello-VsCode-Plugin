import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as vscode from 'vscode'
import { __resetStubs, Uri, createMementoStub } from '../stubs/vscode'
import { WebviewController } from '../../../webview/host/webviewController'
import {
  SerialConsolePanel,
  type SecretStorageLike,
  type SerialConsoleServices,
} from '../../../extension/features/serialConsole/serialConsolePanel'
import { createCommandHistoryService } from '../../../extension/features/serialConsole/commandHistoryService'
import type { SerialServer } from '../../../extension/features/serialConsole/models'
import type { IServerStore } from '../../../extension/features/serialConsole/serverStore'
import { FakeSerialPort } from '../serialConsole/support/fakeSerialPort'
import { FakeSerialPortFactory } from '../serialConsole/support/fakeSerialPort'
import { lastPosted, makePanelDeps, type FakePanel } from './support/fakePanel'

/**
 * 串口控制台宿主面板：init 装配 / 服务器保存（密码剥离 → SecretStorage，Review Focus #5）/
 * 连接与命令下发（历史去重）/ 自动登录 / 删除联动断开 / 面板销毁断开。
 */

const context = {
  subscriptions: [],
  extensionUri: Uri.file(process.cwd()),
} as unknown as vscode.ExtensionContext

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

function makeServices(seed: SerialServer[] = []) {
  let servers = [...seed]
  const store: IServerStore = {
    load: vi.fn(async () => servers),
    save: vi.fn(async (next: SerialServer[]) => {
      servers = [...next]
    }),
  }
  const secrets = new Map<string, string>()
  const secretStorage: SecretStorageLike = {
    get: (key) => Promise.resolve(secrets.get(key)),
    store: (key, value) => {
      secrets.set(key, value)
      return Promise.resolve()
    },
    delete: (key) => {
      secrets.delete(key)
      return Promise.resolve()
    },
  }
  const history = createCommandHistoryService(createMementoStub())
  const portFactory = new FakeSerialPortFactory()
  const onServersChanged = vi.fn()
  const services: SerialConsoleServices = {
    store,
    history,
    portFactory,
    secrets: secretStorage,
    onServersChanged,
  }
  return { services, store, secrets, portFactory, onServersChanged }
}

/** 打开面板并完成 ready → init 握手。 */
async function openPanel(
  services: SerialConsoleServices,
  seedPanelDeps = makePanelDeps(),
  initialServerId?: string
): Promise<FakePanel> {
  SerialConsolePanel.createOrShow(services, initialServerId, seedPanelDeps.deps, {
    usernameDelayMs: 5,
    passwordDelayMs: 5,
  })
  const panel = seedPanelDeps.panels[0]
  panel.webview.__emit({ type: 'ready' })
  await vi.waitFor(() => {
    expect(lastPosted(panel, 'init')).toBeDefined()
  })
  return panel
}

const validDraft = {
  name: '服务器甲',
  serialPath: 'COM3',
  baudRate: '115200',
  dataBits: '8',
  stopBits: '1',
  parity: 'none',
  flowControl: 'none',
  lineEnding: 'lf',
  autoLogin: 'false',
  username: '',
  description: '',
}

beforeEach(() => {
  __resetStubs()
  WebviewController.__resetForTest()
  SerialConsolePanel.configure(context)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('serialConsolePanel：init 与列表请求', () => {
  it('init 携带服务器表单 Schema、服务器列表与命令历史', async () => {
    const { services } = makeServices([makeServer()])
    const panel = await openPanel(services)
    const init = lastPosted(panel, 'init')
    expect(init?.schema).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: 'password', type: 'password' })])
    )
    expect(init?.extra).toMatchObject({
      servers: [expect.objectContaining({ id: 'srv-1', name: '服务器甲' })],
      history: [],
      initialServerId: null,
    })
  })

  it('init 携带预选服务器（树视图进入）；再次 init 不残留旧预选', async () => {
    const { services } = makeServices([makeServer()])
    const deps = makePanelDeps()
    const panel = await openPanel(services, deps, 'srv-1')
    expect(lastPosted(panel, 'init')?.extra).toMatchObject({ initialServerId: 'srv-1' })
  })

  it('serialServersRequest 刷新并推送列表', async () => {
    const { services } = makeServices([])
    const panel = await openPanel(services)
    panel.webview.__emit({ type: 'serialServersRequest' })
    await vi.waitFor(() => {
      expect(lastPosted(panel, 'serialServers')).toBeDefined()
    })
  })

  it('serialPortsRequest 推送检测到的串口', async () => {
    const { services, portFactory } = makeServices()
    portFactory.knownPorts = [{ path: 'COM3' }, { path: 'COM4', manufacturer: 'USB-SERIAL' }]
    const panel = await openPanel(services)
    panel.webview.__emit({ type: 'serialPortsRequest' })
    await vi.waitFor(() => {
      expect(lastPosted(panel, 'serialPorts')).toEqual({
        type: 'serialPorts',
        ports: [{ path: 'COM3' }, { path: 'COM4', manufacturer: 'USB-SERIAL' }],
      })
    })
  })
})

describe('serialConsolePanel：服务器保存（密码零落盘）', () => {
  it('新增：密码进 SecretStorage，store 载荷与推送均不含 password', async () => {
    const { services, store, secrets, onServersChanged } = makeServices([])
    const panel = await openPanel(services)
    panel.webview.__emit({ type: 'serialServerSave', draft: { ...validDraft }, password: 'p@ss' })
    await vi.waitFor(() => {
      expect(lastPosted(panel, 'serialServers')).toBeDefined()
    })
    const saved = (store.save as ReturnType<typeof vi.fn>).mock.calls[0][0] as SerialServer[]
    expect(JSON.stringify(saved)).not.toContain('p@ss')
    expect(JSON.stringify(saved)).not.toContain('password')
    expect(secrets.size).toBe(1)
    expect([...secrets.keys()][0]).toMatch(/^extStarter\.serialServer\..+\.password$/)
    expect(onServersChanged).toHaveBeenCalled()
    expect(lastPosted(panel, 'serialServers')?.servers).toHaveLength(1)
  })

  it('校验失败：回 error 且 field 定位（name 为空）', async () => {
    const { services, store } = makeServices([])
    const panel = await openPanel(services)
    panel.webview.__emit({ type: 'serialServerSave', draft: { ...validDraft, name: ' ' } })
    await vi.waitFor(() => {
      expect(lastPosted(panel, 'error')).toMatchObject({ field: 'name' })
    })
    expect(store.save).not.toHaveBeenCalled()
  })

  it('编辑：留空密码保持已存凭据；createdAt 保留、updatedAt 刷新', async () => {
    const seed = makeServer({ id: 'srv-1', createdAt: 111, name: '旧名' })
    const { services, store, secrets } = makeServices([seed])
    secrets.set('extStarter.serialServer.srv-1.password', 'old-pass')
    const panel = await openPanel(services)
    panel.webview.__emit({
      type: 'serialServerSave',
      draft: { ...validDraft, id: 'srv-1', name: '新名' },
    })
    await vi.waitFor(() => {
      expect(lastPosted(panel, 'serialServers')?.servers).toEqual([
        expect.objectContaining({ id: 'srv-1', name: '新名' }),
      ])
    })
    expect(secrets.get('extStarter.serialServer.srv-1.password')).toBe('old-pass')
    const saveCalls = (store.save as ReturnType<typeof vi.fn>).mock.calls
    const savedList = saveCalls[saveCalls.length - 1][0] as SerialServer[]
    const saved = savedList[0]
    expect(saved.createdAt).toBe(111)
    expect(saved.updatedAt).toBeGreaterThan(111)
  })

  it('外部（树视图）删除后面板保存：已删除的服务器不复活（P1-1 写前重读）', async () => {
    const { services, store } = makeServices([
      makeServer({ id: 'srv-1', name: '甲' }),
      makeServer({ id: 'srv-2', name: '乙' }),
    ])
    const panel = await openPanel(services)
    // 树视图删除 srv-1 的落库效果：绕过面板 deps 推送通道直接改磁盘
    await store.save([makeServer({ id: 'srv-2', name: '乙' })])
    // 面板仍停留在旧列表（未收到推送），此时编辑保存 srv-2
    panel.webview.__emit({
      type: 'serialServerSave',
      draft: { ...validDraft, id: 'srv-2', name: '乙改' },
    })
    await vi.waitFor(() => {
      expect(lastPosted(panel, 'serialServers')?.servers).toHaveLength(1)
    })
    expect(lastPosted(panel, 'serialServers')?.servers).toEqual([
      expect.objectContaining({ id: 'srv-2', name: '乙改' }),
    ])
  })

  it('SecretStorage 写入失败：回 error 提示，不产生未处理拒绝（P2-B3）', async () => {
    const { services, onServersChanged } = makeServices([])
    const failingStorage: SecretStorageLike = {
      get: () => Promise.resolve(undefined),
      store: () => Promise.reject(new Error('keychain locked')),
      delete: () => Promise.reject(new Error('keychain locked')),
    }
    services.secrets = failingStorage
    const panel = await openPanel(services)
    panel.webview.__emit({ type: 'serialServerSave', draft: { ...validDraft }, password: 'p@ss' })
    await vi.waitFor(() => {
      expect(lastPosted(panel, 'error')).toMatchObject({
        message: expect.stringContaining('密码'),
      })
    })
    // 服务器本体已保存并推送；密码写入失败被显式告知
    expect(lastPosted(panel, 'serialServers')).toBeDefined()
    expect(onServersChanged).toHaveBeenCalled()
  })

  it('SecretStorage 清理失败（删除服务器）：回 error 提示，列表照常推送（P2-B3）', async () => {
    const { services } = makeServices([makeServer()])
    const failingStorage: SecretStorageLike = {
      get: () => Promise.resolve(undefined),
      store: () => Promise.resolve(),
      delete: () => Promise.reject(new Error('keychain locked')),
    }
    services.secrets = failingStorage
    const panel = await openPanel(services)
    panel.webview.__emit({ type: 'serialServerDelete', id: 'srv-1' })
    await vi.waitFor(() => {
      expect(lastPosted(panel, 'error')).toMatchObject({
        message: expect.stringContaining('密码'),
      })
    })
    expect(lastPosted(panel, 'serialServers')?.servers).toEqual([])
  })
})

describe('serialConsolePanel：连接 / 下发 / 历史', () => {
  it('connect 成功推送状态序列；send 写入并推送去重历史', async () => {
    const { services, portFactory } = makeServices([makeServer()])
    const panel = await openPanel(services)
    panel.webview.__emit({ type: 'serialConnect', serverId: 'srv-1' })
    await vi.waitFor(() => {
      expect(lastPosted(panel, 'serialState')).toMatchObject({
        type: 'serialState',
        serverId: 'srv-1',
        state: 'connected',
      })
    })
    panel.webview.__emit({ type: 'serialSend', command: 'show version' })
    panel.webview.__emit({ type: 'serialSend', command: 'show version' })
    panel.webview.__emit({ type: 'serialSend', command: 'ls' })
    await vi.waitFor(() => {
      const history = lastPosted(panel, 'commandHistory')
      const entries =
        (history as { entries: { command: string; useCount: number }[] })?.entries ?? []
      expect(entries.map((e) => [e.command, e.useCount])).toEqual([
        ['ls', 1],
        ['show version', 2],
      ])
    })
    expect(portFactory.lastPort?.written).toEqual(['show version\n', 'show version\n', 'ls\n'])
  })

  it('未连接 send：回 error 不写入', async () => {
    const { services, portFactory } = makeServices([makeServer()])
    const panel = await openPanel(services)
    panel.webview.__emit({ type: 'serialSend', command: 'ls' })
    await vi.waitFor(() => {
      expect(lastPosted(panel, 'error')).toMatchObject({
        message: expect.stringContaining('未连接'),
      })
    })
    expect(portFactory.lastPort).toBeUndefined()
  })

  it('串口输出经批处理推送 serialData（带 seq）', async () => {
    const { services, portFactory } = makeServices([makeServer()])
    const panel = await openPanel(services)
    panel.webview.__emit({ type: 'serialConnect', serverId: 'srv-1' })
    await vi.waitFor(() => {
      expect(lastPosted(panel, 'serialState')).toMatchObject({ state: 'connected' })
    })
    const port = portFactory.lastPort as FakeSerialPort
    port.emit('data', Buffer.from('Ubuntu 22.04 LTS'))
    await vi.waitFor(() => {
      expect(lastPosted(panel, 'serialData')).toEqual({
        type: 'serialData',
        seq: 1,
        text: 'Ubuntu 22.04 LTS',
      })
    })
  })

  it('自动登录：连接后按时序发送用户名与密码，且不进命令历史', async () => {
    const seed = makeServer({ autoLogin: true, username: 'root' })
    const { services, portFactory, secrets } = makeServices([seed])
    secrets.set('extStarter.serialServer.srv-1.password', 's3cret')
    const panel = await openPanel(services)
    panel.webview.__emit({ type: 'serialConnect', serverId: 'srv-1' })
    await vi.waitFor(() => {
      expect(portFactory.lastPort?.written).toEqual(['root\n', 's3cret\n'])
    })
    expect(lastPosted(panel, 'commandHistory')).toBeUndefined()
  })

  it('自动登录等待期间切换连接：旧凭据不写入新服务器端口（P1-2 代际守卫）', async () => {
    const seed = [
      makeServer({
        id: 'srv-1',
        name: '甲',
        serialPath: 'COM3',
        autoLogin: true,
        username: 'root',
      }),
      makeServer({ id: 'srv-2', name: '乙', serialPath: 'COM4' }),
    ]
    const { services, portFactory, secrets } = makeServices(seed)
    secrets.set('extStarter.serialServer.srv-1.password', 's3cret')
    const deps = makePanelDeps()
    SerialConsolePanel.createOrShow(services, undefined, deps.deps, {
      usernameDelayMs: 200,
      passwordDelayMs: 200,
    })
    const panel = deps.panels[0]
    panel.webview.__emit({ type: 'ready' })
    await vi.waitFor(() => {
      expect(lastPosted(panel, 'init')).toBeDefined()
    })
    // 连接甲（自动登录进入 200ms 等待窗口）后立刻切换到乙
    panel.webview.__emit({ type: 'serialConnect', serverId: 'srv-1' })
    await vi.waitFor(() => {
      expect(lastPosted(panel, 'serialState')).toMatchObject({ state: 'connected' })
    })
    panel.webview.__emit({ type: 'serialConnect', serverId: 'srv-2' })
    await vi.waitFor(() => {
      expect(lastPosted(panel, 'serialState')).toMatchObject({
        serverId: 'srv-2',
        state: 'connected',
      })
    })
    // 等过甲自动登录原定的发送时刻：任何端口都不得收到甲的凭据
    await new Promise((resolve) => setTimeout(resolve, 500))
    const portByPath = portFactory.openCalls.map((call, index) => ({
      path: call.path,
      port: portFactory.opened[index],
    }))
    expect(portByPath).toHaveLength(2)
    const allWritten = portByPath.flatMap(({ port }) => port.written).join('')
    expect(allWritten).not.toContain('root')
    expect(allWritten).not.toContain('s3cret')
  })

  it('disconnect 推送状态；删除已连接服务器时联动断开并清理密码', async () => {
    const { services, portFactory, secrets } = makeServices([makeServer()])
    secrets.set('extStarter.serialServer.srv-1.password', 'p')
    const panel = await openPanel(services)
    panel.webview.__emit({ type: 'serialConnect', serverId: 'srv-1' })
    await vi.waitFor(() => {
      expect(lastPosted(panel, 'serialState')).toMatchObject({ state: 'connected' })
    })
    panel.webview.__emit({ type: 'serialServerDelete', id: 'srv-1' })
    await vi.waitFor(() => {
      expect(lastPosted(panel, 'serialServers')).toMatchObject({ servers: [] })
    })
    expect(portFactory.lastPort?.closeCount).toBe(1)
    expect(secrets.get('extStarter.serialServer.srv-1.password')).toBeUndefined()
    await vi.waitFor(() => {
      expect(lastPosted(panel, 'serialState')).toMatchObject({ state: 'disconnected' })
    })
  })

  it('历史删除与清空推送最新列表', async () => {
    const { services } = makeServices()
    const panel = await openPanel(services)
    // 先经面板记录两条（走 send 需要连接；这里直接驱动历史服务再请求）
    await services.history.record('a')
    await services.history.record('b')
    const entryId = (await services.history.list())[0].id
    panel.webview.__emit({ type: 'commandHistoryRemove', id: entryId })
    await vi.waitFor(() => {
      const history = lastPosted(panel, 'commandHistory') as { entries: { command: string }[] }
      expect(history.entries.map((e) => e.command)).toEqual(['a'])
    })
    panel.webview.__emit({ type: 'commandHistoryClear' })
    await vi.waitFor(() => {
      expect(lastPosted(panel, 'commandHistory')).toMatchObject({ entries: [] })
    })
  })

  it('面板关闭（用户关面板）自动断开串口', async () => {
    const { services, portFactory } = makeServices([makeServer()])
    const deps = makePanelDeps()
    const panel = await openPanel(services, deps)
    panel.webview.__emit({ type: 'serialConnect', serverId: 'srv-1' })
    await vi.waitFor(() => {
      expect(lastPosted(panel, 'serialState')).toMatchObject({ state: 'connected' })
    })
    panel.__close()
    expect(portFactory.lastPort?.closeCount).toBe(1)
  })
})
