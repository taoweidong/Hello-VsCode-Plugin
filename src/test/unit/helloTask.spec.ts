import { describe, expect, it } from 'vitest'
import * as vscode from 'vscode'
import { helloTask } from '../../extension/tasks/helloTask'
import { TASKS } from '../../extension/tasks/taskRegistry'
import { TaskRunner } from '../../extension/tasks/taskRunner'
import { __resetStubs, __stubs } from './stubs/vscode'
import type { TaskContext, TaskResult } from '../../extension/tasks/types'

/**
 * 初始化脚本（VSCode 打开时自动执行的启动任务，特性需求 2026-10-24）：
 * - helloTask 为「动作类」脚本最小样板：向输出通道打印 Hello World 并产出结果条目；
 * - TASKS 注册表即预留的扩展接口（新增脚本 = 加一项，框架零改动）。
 */

function makeContext(): TaskContext {
  return {
    output: vscode.window.createOutputChannel('Hello VSCode Plugin Test'),
    signal: {
      isCancellationRequested: false,
      onCancellationRequested: () => ({ dispose: () => {} }),
    },
  } as unknown as TaskContext
}

describe('helloTask（初始化脚本演示）', () => {
  it('执行后向控制台打印 Hello World 并产出 ok 结果条目', async () => {
    __resetStubs()
    const ctx = makeContext()
    const result = await helloTask.run(ctx)
    expect(result.status).toBe('ok')
    expect(result.taskId).toBe('hello')
    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toMatchObject({ label: 'Hello World', status: 'ok' })
    expect(String(result.items[0].description)).toContain('Hello, World!')
    // 执行过程实时打印在控制台（输出通道）
    expect(__stubs.outputLines.some((line) => line.includes('[初始化脚本]'))).toBe(true)
    expect(__stubs.outputLines.some((line) => line.includes('Hello, World!'))).toBe(true)
  })
})

describe('TASKS 启动任务注册表（预留的扩展接口）', () => {
  it('注册表 = 初始化脚本（hello）在前 + 环境检测（environment）在后', () => {
    expect(TASKS.map((task) => task.id)).toEqual(['hello', 'environment'])
  })

  it('清单声明 onStartupFinished：VSCode 窗口加载完成即激活（无需打开文件夹或点击插件）', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pkg = require('../../../package.json') as { activationEvents: string[] }
    expect(pkg.activationEvents).toContain('onStartupFinished')
  })

  it('经 TaskRunner 依次执行：控制台先打印脚本输出再打印结果汇总', async () => {
    __resetStubs()
    // 环境检测注入假 run（避免真实子进程探测），只验证调度顺序与控制台打印
    const fakeEnv = {
      ...TASKS[1],
      run: async (): Promise<TaskResult> => ({
        taskId: 'environment',
        taskTitle: '环境检测',
        status: 'ok',
        durationMs: 1,
        finishedAt: new Date().toISOString(),
        items: [],
      }),
    }
    const runner = new TaskRunner(
      [TASKS[0], fakeEnv],
      vscode.window.createOutputChannel('Hello VSCode Plugin Test')
    )
    await runner.runAll()
    const scriptLine = __stubs.outputLines.findIndex((line) => line.includes('[初始化脚本]'))
    const doneLine = __stubs.outputLines.findIndex((line) => line.includes('初始化脚本 完成'))
    expect(scriptLine).toBeGreaterThanOrEqual(0)
    expect(doneLine).toBeGreaterThan(scriptLine) // 先执行脚本、后写结果汇总
    expect(__stubs.outputLines.some((line) => line.includes('开始执行 2 个任务'))).toBe(true)
  }, 15000)
})
