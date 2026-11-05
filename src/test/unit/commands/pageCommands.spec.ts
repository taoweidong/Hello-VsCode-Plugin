import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as vscode from 'vscode'
import {
  registerPageCommands,
  type PageCommandDeps,
} from '../../../extension/commands/pageCommands'
import { COMMAND } from '../../../extension/constants'
import { InitService } from '../../../extension/features/init/initService'
import { TaskRunner } from '../../../extension/tasks/taskRunner'
import { __resetStubs, __stubs } from '../stubs/vscode'

/**
 * 功能页面命令组（此前仅 runInitStep 入参归一化有用例）：
 * refreshEnvironment 双路由（label 命中探针 → 单检；否则全量）、
 * showEnvironmentOutput、runAllInit、runInitStep 无参 QuickPick 路径、
 * openTaskManager / refreshTaskManager 的路由。
 */

function makeDeps() {
  const output = vscode.window.createOutputChannel('test')
  const taskRunner = new TaskRunner([], output)
  const initService = new InitService([], output)
  const deps: PageCommandDeps & { spies: Record<string, ReturnType<typeof vi.fn>> } = {
    taskRunner,
    outputChannel: output,
    initService,
    openTaskManager: vi.fn(),
    refreshTaskManager: vi.fn(),
    context: { extensionUri: vscode.Uri.file(process.cwd()) } as unknown as vscode.ExtensionContext,
    recheckEnvironmentItem: vi.fn(async () => undefined),
    spies: {},
  }
  deps.spies.recheck = deps.recheckEnvironmentItem as unknown as ReturnType<typeof vi.fn>
  deps.spies.openTaskManager = deps.openTaskManager as unknown as ReturnType<typeof vi.fn>
  deps.spies.refreshTaskManager = deps.refreshTaskManager as unknown as ReturnType<typeof vi.fn>
  return deps
}

/** 命令注册记录器：key → 回调。 */
function makeRegistrar() {
  const registered = new Map<string, (...args: unknown[]) => unknown>()
  return {
    registered,
    register: (commandId: string, callback: (...args: unknown[]) => unknown): void => {
      registered.set(commandId, callback)
    },
  }
}

let registrar: ReturnType<typeof makeRegistrar>
let deps: ReturnType<typeof makeDeps>

beforeEach(() => {
  __resetStubs()
  registrar = makeRegistrar()
  deps = makeDeps()
  registerPageCommands(registrar.register, deps)
})

describe('refreshEnvironment 双路由', () => {
  it('string 参数且命中探针注册表：单探针重检，不全量运行', () => {
    registrar.registered.get(COMMAND.refreshEnvironment)?.('Node.js')
    expect(deps.spies.recheck).toHaveBeenCalledWith('Node.js')
    expect(__stubs.outputLines.join('\n')).not.toContain('开始执行')
  })

  it('string 参数但未命中（系统条目 / 陈旧 label）：降级全量检测', async () => {
    registrar.registered.get(COMMAND.refreshEnvironment)?.('操作系统')
    await vi.waitFor(() => {
      expect(deps.taskRunner.isRunning).toBe(false)
    })
    expect(__stubs.outputLines.join('\n')).toContain('开始执行 0 个任务')
    expect(deps.spies.recheck).not.toHaveBeenCalled()
  })

  it('无参调用（命令面板）：全量检测', async () => {
    registrar.registered.get(COMMAND.refreshEnvironment)?.()
    await vi.waitFor(() => {
      expect(__stubs.outputLines.join('\n')).toContain('开始执行 0 个任务')
    })
    expect(deps.spies.recheck).not.toHaveBeenCalled()
  })
})

describe('runInitStep 无参 QuickPick 路径', () => {
  it('有步骤清单时弹 QuickPick，选中后执行该步骤', async () => {
    const output = vscode.window.createOutputChannel('t')
    const steps = new InitService(
      [
        {
          id: 'workspace',
          title: '检查工作区',
          description: '确认已打开工作区',
          run: async () => 'ok',
        },
      ],
      output
    )
    deps.initService = steps
    registrar = makeRegistrar()
    registerPageCommands(registrar.register, deps)
    __stubs.dialogQueue.push({ label: '$(circle-outline) 检查工作区', id: 'workspace' })
    await registrar.registered.get(COMMAND.runInitStep)?.()
    await vi.waitFor(() => {
      expect(steps.getStates()[0]?.status).toBe('done')
    })
  })

  it('无步骤清单：直接返回不弹 QuickPick', async () => {
    await registrar.registered.get(COMMAND.runInitStep)?.()
    expect(__stubs.recorded.some((entry) => entry.kind === 'showQuickPick')).toBe(false)
  })
})

describe('其余路由', () => {
  it('showEnvironmentOutput 调 outputChannel.show；openTaskManager / refreshTaskManager 路由注入目标', () => {
    registrar.registered.get(COMMAND.showEnvironmentOutput)?.()
    registrar.registered.get(COMMAND.openTaskManager)?.()
    registrar.registered.get(COMMAND.refreshTaskManager)?.()
    expect(__stubs.recorded.some((entry) => entry.kind === 'outputShow')).toBe(true)
    expect(deps.spies.openTaskManager).toHaveBeenCalledTimes(1)
    expect(deps.spies.refreshTaskManager).toHaveBeenCalledTimes(1)
  })

  it('runAllInit 调 initService.runAll', async () => {
    const runAllSpy = vi.spyOn(deps.initService, 'runAll').mockResolvedValue(undefined)
    registrar.registered.get(COMMAND.runAllInit)?.()
    expect(runAllSpy).toHaveBeenCalledTimes(1)
  })

  it('openGallery：WebviewController.createOrShow 打开画廊页面', () => {
    registrar.registered.get(COMMAND.openGallery)?.()
    expect(__stubs.recorded.some((entry) => entry.kind === 'createWebviewPanel')).toBe(true)
  })
})
