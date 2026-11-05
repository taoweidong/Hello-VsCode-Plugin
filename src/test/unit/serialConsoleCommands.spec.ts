import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as vscode from 'vscode'
import { registerSerialConsoleCommands } from '../../extension/commands/serialConsoleCommands'
import { COMMAND, CONFIG } from '../../extension/constants'
import { SerialConsoleController } from '../../extension/features/serialConsole/serialConsoleController'
import { SerialConsolePanel } from '../../extension/features/serialConsole/serialConsolePanel'
import type { SerialServerNode } from '../../extension/features/serialConsole/serialServersTreeProvider'
import { __resetStubs, __setConfig, __stubs, createExtensionContextStub } from './stubs/vscode'

/** 串口控制台命令组：注册完整性 + 行为分支（特性开关守卫 / 删除确认 / 刷新）。 */

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

function makeNode(id = 'srv-1'): SerialServerNode {
  return {
    server: {
      id,
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
    },
  }
}

/** 命令注册记录器：key → 回调。 */
function makeRegistrar() {
  const registered = new Map<string, (...args: unknown[]) => unknown>()
  const register = (commandId: string, callback: (...args: unknown[]) => unknown): void => {
    registered.set(commandId, callback)
  }
  return { registered, register }
}

let controller: SerialConsoleController

beforeEach(() => {
  __resetStubs()
  controller = new SerialConsoleController(makeContext(), makeOutputChannel())
})

afterEach(() => {
  controller.dispose()
  vi.restoreAllMocks()
})

describe('registerSerialConsoleCommands', () => {
  it('注册全部 6 个命令', () => {
    const { registered, register } = makeRegistrar()
    registerSerialConsoleCommands(register, { controller })
    for (const key of [
      COMMAND.openSerialConsole,
      COMMAND.addSerialServer,
      COMMAND.editSerialServer,
      COMMAND.deleteSerialServer,
      COMMAND.connectSerialServer,
      COMMAND.refreshSerialServers,
    ]) {
      expect(registered.has(key)).toBe(true)
    }
  })

  it('openSerialConsole / connectSerialServer 打开面板（connect 带预选目标）', () => {
    const panelSpy = vi
      .spyOn(SerialConsolePanel, 'createOrShow')
      .mockImplementation(() => undefined)
    const { registered, register } = makeRegistrar()
    registerSerialConsoleCommands(register, { controller })

    registered.get(COMMAND.openSerialConsole)?.()
    expect(panelSpy).toHaveBeenCalledWith(expect.anything(), undefined)

    registered.get(COMMAND.connectSerialServer)?.(makeNode('srv-9'))
    expect(panelSpy).toHaveBeenLastCalledWith(expect.anything(), 'srv-9')
  })

  it('serialConsoleEnabled 关闭时给出提示且不打开面板（S1）', () => {
    __setConfig(CONFIG.section, CONFIG.serialConsoleEnabled, false)
    const panelSpy = vi
      .spyOn(SerialConsolePanel, 'createOrShow')
      .mockImplementation(() => undefined)
    const { registered, register } = makeRegistrar()
    registerSerialConsoleCommands(register, { controller })

    registered.get(COMMAND.openSerialConsole)?.()
    expect(panelSpy).not.toHaveBeenCalled()
    expect(__stubs.recorded.some((entry) => entry.kind === 'showInformationMessage')).toBe(true)
  })

  it('refreshSerialServers 刷新树视图', () => {
    const refreshSpy = vi.spyOn(controller.treeProvider, 'refresh')
    const { registered, register } = makeRegistrar()
    registerSerialConsoleCommands(register, { controller })
    registered.get(COMMAND.refreshSerialServers)?.()
    expect(refreshSpy).toHaveBeenCalled()
  })

  it('deleteSerialServer：模态确认后删除并清理（S3：一律确认）', async () => {
    __stubs.dialogQueue.push('删除')
    const deleteSpy = vi.spyOn(controller, 'deleteServer').mockResolvedValue('deleted' as never)
    const { registered, register } = makeRegistrar()
    registerSerialConsoleCommands(register, { controller })
    await registered.get(COMMAND.deleteSerialServer)?.(makeNode('srv-7'))
    expect(deleteSpy).toHaveBeenCalledWith('srv-7')
  })

  it('deleteSerialServer：模态取消则不删除', async () => {
    // 桩的 showWarningMessage 返回 undefined（等于用户取消模态）
    const deleteSpy = vi.spyOn(controller, 'deleteServer').mockResolvedValue('deleted' as never)
    const { registered, register } = makeRegistrar()
    registerSerialConsoleCommands(register, { controller })
    await registered.get(COMMAND.deleteSerialServer)?.(makeNode('srv-7'))
    expect(deleteSpy).not.toHaveBeenCalled()
  })
})

describe('SerialConsoleController.deleteServer', () => {
  it('落库删除 + 清理密码 + 删除不存在时返回 missing', async () => {
    const context = makeContext()
    const controller2 = new SerialConsoleController(context, makeOutputChannel())
    // 预置一条服务器（经 store）
    const server = makeNode('srv-x').server
    await controller2.store.save([server])
    await context.secrets.store('extStarter.serialServer.srv-x.password', 'p')

    expect(await controller2.deleteServer('srv-x')).toBe('deleted')
    expect(await controller2.store.load()).toEqual([])
    await expect(
      context.secrets.get('extStarter.serialServer.srv-x.password')
    ).resolves.toBeUndefined()

    expect(await controller2.deleteServer('srv-x')).toBe('missing')
    controller2.dispose()
  })
})
