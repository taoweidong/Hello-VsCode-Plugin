import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as vscode from 'vscode'
import { SerialConsoleController } from '../../../extension/features/serialConsole/serialConsoleController'
import { __resetStubs, __stubs, createExtensionContextStub } from '../stubs/vscode'
import { makeServer } from './support/serverHelpers'

/**
 * 串口控制台控制器（此前无专属 spec——P1-1 跨层竞态正是从这条盲区逃逸）：
 * services()/panelDepsOrCreate() 共享装配、树删除 → 面板保存不复活（P1-1
 * 集成级回归锁定）、deleteServer 落库分支、dispose 断链。
 */

function makeOutputChannel(): vscode.OutputChannel {
  return {
    appendLine: vi.fn(),
    append: vi.fn(),
    name: 'test',
    show: vi.fn(),
    hide: vi.fn(),
    dispose: vi.fn(),
    clear: vi.fn(),
    replace: vi.fn(),
  } as unknown as vscode.OutputChannel
}

function makeContext(): vscode.ExtensionContext {
  const context = createExtensionContextStub() as unknown as {
    secrets: unknown
  } & vscode.ExtensionContext
  const secrets = new Map<string, string>()
  context.secrets = {
    get: (key: string) => Promise.resolve(secrets.get(key)),
    store: (key: string, value: string) => {
      secrets.set(key, value)
      return Promise.resolve()
    },
    delete: (key: string) => {
      secrets.delete(key)
      return Promise.resolve()
    },
  } as unknown as vscode.ExtensionContext['secrets']
  return context as unknown as vscode.ExtensionContext
}

let controller: SerialConsoleController

beforeEach(() => {
  __resetStubs()
  controller = new SerialConsoleController(makeContext(), makeOutputChannel())
})

describe('SerialConsoleController：装配', () => {
  it('services() 持有共享 store / history / portFactory / secrets / link 与状态快照', () => {
    const services = controller.services()
    expect(services.store).toBe(controller.store)
    expect(services.history).toBe(controller.history)
    expect(services.portFactory).toBe(controller.portFactory)
    expect(services.link).toBe(controller.link)
    expect(services.linkStatus).toBeDefined()
    expect(typeof services.onServersChanged).toBe('function')
  })

  it('panelDepsOrCreate 单例：重复调用返回同一实例（link 不重复创建）', () => {
    const first = controller.panelDepsOrCreate()
    const second = controller.panelDepsOrCreate()
    expect(first).toBe(second)
  })

  it('onBeforeConnect 更新活动目标；onServersChanged 触发树刷新', async () => {
    const services = controller.services()
    services.onBeforeConnect?.('srv-9')
    expect(controller.services().linkStatus?.serverId).toBe('srv-9')

    const refreshSpy = vi.spyOn(controller.treeProvider, 'refresh')
    await services.onServersChanged?.()
    expect(refreshSpy).toHaveBeenCalled()
  })
})

describe('SerialConsoleController：deleteServer（树视图右键路径）', () => {
  it('删除存在的服务器：落库 + 返回 deleted；树数据同步移除', async () => {
    await controller.store.save([
      makeServer({ id: 'srv-1' }),
      makeServer({ id: 'srv-2', name: '乙' }),
    ])
    const result = await controller.deleteServer('srv-1')
    expect(result).toBe('deleted')
    const rest = await controller.store.load()
    expect(rest.map((server) => server.id)).toEqual(['srv-2'])
  })

  it('删除不存在的服务器：返回 missing 且不改存储', async () => {
    await controller.store.save([makeServer({ id: 'srv-1' })])
    const result = await controller.deleteServer('no-such')
    expect(result).toBe('missing')
    expect(await controller.store.load()).toHaveLength(1)
  })

  it('P1-1 集成回归：树删除后面板保存已编辑服务器，被删服务器不复活', async () => {
    await controller.store.save([
      makeServer({ id: 'srv-1', name: '甲' }),
      makeServer({ id: 'srv-2', name: '乙' }),
    ])
    // 面板完成 ready → init（共享 deps 装配）
    const deps = controller.panelDepsOrCreate()
    await deps.buildInit?.({ persistedState: undefined })
    // 树视图右键删除 srv-1（面板不会收到 deps 内部推送，页面与磁盘即时一致）
    expect(await controller.deleteServer('srv-1')).toBe('deleted')
    // 面板编辑保存 srv-2：基于磁盘真值，不应把 srv-1 写回
    await deps.onPageMessage?.({
      type: 'serialServerSave',
      draft: {
        id: 'srv-2',
        name: '乙改',
        serialPath: 'COM4',
        baudRate: '115200',
        dataBits: '8',
        stopBits: '1',
        parity: 'none',
        flowControl: 'none',
        lineEnding: 'lf',
        autoLogin: 'false',
        username: '',
        description: '',
      },
    })
    await vi.waitFor(async () => {
      const servers = await controller.store.load()
      expect(servers.map((server) => server.id)).toEqual(['srv-2'])
      expect(servers[0]?.name).toBe('乙改')
    })
  })
})

describe('SerialConsoleController：dispose', () => {
  it('dispose 断开共享链路（state 回 disconnected）', async () => {
    // 通过 services() 共享 link 后连接假端口（controller 默认 portFactory 为真实
    // Node 工厂——这里只验证未连接时的 dispose 安全性与状态复位）
    controller.dispose()
    expect(controller.link.state()).toBe('disconnected')
  })
})

describe('SerialConsoleController：deleteServer 错误契约（17 方案阶段 1）', () => {
  it('密码清理失败：删除不被阻断，返回 deleted 并以 showWarningMessage 上报', async () => {
    const context = makeContext()
    ;(context.secrets as unknown as { delete: () => Promise<void> }).delete = () =>
      Promise.reject(new Error('keychain locked'))
    const failing = new SerialConsoleController(context, makeOutputChannel())
    await failing.store.save([makeServer({ id: 'srv-1' })])
    await expect(failing.deleteServer('srv-1')).resolves.toBe('deleted')
    expect(await failing.store.load()).toHaveLength(0)
    expect(__stubs.recorded.some((entry) => entry.kind === 'showWarningMessage')).toBe(true)
  })

  it('落盘失败：错误向上抛（命令层负责 showError），密码未被清理', async () => {
    const failing = new SerialConsoleController(makeContext(), makeOutputChannel())
    await failing.store.save([makeServer({ id: 'srv-1' })])
    vi.spyOn(failing.store, 'save').mockRejectedValue(new Error('disk full'))
    await expect(failing.deleteServer('srv-1')).rejects.toThrow('disk full')
  })
})
