import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as nodeFs from 'node:fs'
import * as nodeOs from 'node:os'
import * as nodePath from 'node:path'
import * as vscode from 'vscode'
import { __resetStubs, __stubs } from './stubs/vscode'
import { INIT_STEP_TIMEOUT_MS, InitService } from '../../extension/features/init/initService'
import { createInitSteps } from '../../extension/features/init/initSteps'
import type { InitStep } from '../../extension/features/init/initSteps'
import type { TaskResult } from '../../extension/tasks/types'

const outputLines = (): string[] => __stubs.outputLines

function makeService(steps: InitStep[]): InitService {
  return new InitService(steps, vscode.window.createOutputChannel('CRUD Starter Test'))
}

/** T5.4 / P1-12：InitService 单步互斥 + 步骤超时。 */
describe('InitService 生命周期', () => {
  beforeEach(() => {
    __resetStubs()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('runAll 执行期间 runStep 被忽略并记录到输出通道（互斥）', async () => {
    let releaseFirst!: () => void
    const steps: InitStep[] = [
      {
        id: 'a',
        title: 'A',
        description: '',
        async run() {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve
          })
          return 'ok-a'
        },
      },
      { id: 'b', title: 'B', description: '', run: async () => 'ok-b' },
    ]
    const svc = makeService(steps)
    const running = svc.runAll()
    await Promise.resolve()
    expect(svc.isRunning).toBe(true)
    await svc.runStep('b') // runAll 进行中：应直接返回
    expect(
      outputLines().some((line) => line.includes('被忽略') && line.includes('初始化正在执行中'))
    ).toBe(true)
    // R-C-21：只写输出通道时用户单击步骤「毫无反应」——必须同时有可见提示
    expect(
      __stubs.recorded.some(
        (call) =>
          call.kind === 'showInformationMessage' &&
          String((call.args[0] as { message?: unknown } | undefined)?.message ?? '').includes('B')
      )
    ).toBe(true)
    expect(svc.getStates().find((state) => state.id === 'b')?.status).toBe('idle') // 未被执行
    releaseFirst()
    await running
    // runAll 自身会把 b 执行完
    expect(svc.getStates().map((state) => state.status)).toEqual(['done', 'done'])
  })

  it('步骤超时（timeoutMs）：挂死步骤被裁决为 failed，后续步骤继续', async () => {
    vi.useFakeTimers()
    const steps: InitStep[] = [
      {
        id: 'hang',
        title: '挂死步骤',
        description: '',
        timeoutMs: 100,
        run: () => new Promise<string>(() => undefined),
      },
      { id: 'after', title: '后续', description: '', run: async () => 'ok' },
    ]
    const svc = makeService(steps)
    const pending = svc.runAll()
    await vi.advanceTimersByTimeAsync(100)
    await pending
    const states = svc.getStates()
    expect(states[0].status).toBe('failed')
    expect(states[0].message).toContain('步骤超时')
    expect(states[0].message).toContain('100')
    expect(states[1].status).toBe('done')
  })

  it('缺省步骤超时为 INIT_STEP_TIMEOUT_MS（120s）', async () => {
    vi.useFakeTimers()
    const steps: InitStep[] = [
      {
        id: 'hang',
        title: '挂死',
        description: '',
        run: () => new Promise<string>(() => undefined),
      },
    ]
    const svc = makeService(steps)
    const pending = svc.runAll()
    await vi.advanceTimersByTimeAsync(INIT_STEP_TIMEOUT_MS - 1)
    expect(svc.getStates()[0].status).toBe('running')
    await vi.advanceTimersByTimeAsync(1)
    await pending
    expect(svc.getStates()[0].status).toBe('failed')
    expect(svc.getStates()[0].message).toContain('步骤超时')
  })

  it('步骤超时：向运行中步骤下发取消信号（ctx.signal，P2-B2）', async () => {
    let cancelled = false
    const steps: InitStep[] = [
      {
        id: 'cooperative',
        title: '协作步骤',
        description: '',
        timeoutMs: 50,
        async run(ctx) {
          // 模拟探测型步骤：监听取消信号，收到即尽快退出
          return await new Promise<string>((resolve) => {
            const timer = setTimeout(() => resolve('自然结束'), 1000)
            ctx.signal?.onCancellationRequested(() => {
              cancelled = true
              clearTimeout(timer)
              resolve('已取消')
            })
          })
        },
      },
    ]
    const svc = makeService(steps)
    await svc.runAll()
    expect(svc.getStates()[0]?.status).toBe('failed')
    expect(svc.getStates()[0]?.message).toContain('步骤超时')
    expect(cancelled).toBe(true)
  })

  it('单步失败不阻断后续步骤（原有容错保持）', async () => {
    const steps: InitStep[] = [
      { id: 'a', title: 'A', description: '', run: async () => 'ok-a' },
      {
        id: 'b',
        title: 'B',
        description: '',
        run: async () => {
          throw new Error('bad')
        },
      },
      { id: 'c', title: 'C', description: '', run: async () => 'ok-c' },
    ]
    const svc = makeService(steps)
    await svc.runAll()
    expect(svc.getStates().map((state) => state.status)).toEqual(['done', 'failed', 'done'])
    expect(svc.getStates()[1].message).toBe('bad')
  })
})

/** T5.4 / P1-12：envSnapshot 快照复用。 */
describe('createInitSteps：envSnapshot 快照复用', () => {
  let rootDir: string

  beforeEach(() => {
    __resetStubs()
    rootDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'crud-env-snapshot-'))
  })

  afterEach(() => {
    nodeFs.rmSync(rootDir, { recursive: true, force: true })
  })

  const runEnvStep = (options?: { getEnvironmentSnapshot?: () => unknown }): Promise<string> => {
    const steps = createInitSteps(
      options as { getEnvironmentSnapshot?: () => TaskResult | undefined }
    )
    const envStep = steps.find((step) => step.id === 'envSnapshot')
    if (!envStep) {
      throw new Error('envSnapshot 步骤未注册')
    }
    return envStep.run({
      workspaceRoot: vscode.Uri.file(rootDir),
      output: vscode.window.createOutputChannel('CRUD Starter Test'),
    })
  }

  it('注入 getEnvironmentSnapshot：直接复用结果，不再现场探测', async () => {
    const reused: TaskResult = {
      taskId: 'environment',
      taskTitle: '环境检测',
      status: 'ok',
      durationMs: 1,
      finishedAt: '2026-01-01T00:00:00.000Z',
      items: [
        { label: 'Python', description: '3.11.4', status: 'ok' },
        { label: 'Node.js', description: 'v20.11.0', status: 'ok' },
      ],
    }
    let getterCalls = 0
    const message = await runEnvStep({
      getEnvironmentSnapshot: () => {
        getterCalls += 1
        return reused
      },
    })
    expect(getterCalls).toBe(1)
    expect(message).toContain('复用')
    expect(message).toContain('2/2')
    // 快照内容来自注入结果
    const snapshot = JSON.parse(
      nodeFs.readFileSync(nodePath.join(rootDir, '.ext-starter', 'environment.json'), 'utf8')
    ) as { items: { name: string }[] }
    expect(snapshot.items.map((item) => item.name)).toEqual(['Python', 'Node.js'])
  })

  it('getter 返回 undefined：回退现场运行 environmentTask（写出真实快照文件）', async () => {
    const message = await runEnvStep({ getEnvironmentSnapshot: () => undefined })
    expect(message).not.toContain('复用')
    expect(message).toMatch(/快照已写入（\d+\/\d+ 项就绪）/)
    const snapshot = JSON.parse(
      nodeFs.readFileSync(nodePath.join(rootDir, '.ext-starter', 'environment.json'), 'utf8')
    ) as { items: { name: string; status?: string }[] }
    expect(snapshot.items.some((item) => item.name === 'Node.js' && item.status === 'ok')).toBe(
      true
    )
  }, 15000)
})
