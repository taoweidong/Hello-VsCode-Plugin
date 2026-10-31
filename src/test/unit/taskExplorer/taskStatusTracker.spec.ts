import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as vscode from 'vscode'
import { TaskStatusTracker } from '../../../extension/features/taskExplorer/taskStatusTracker'
import { taskKey } from '../../../extension/features/taskExplorer/taskSource'
import {
  __fireTaskEnd,
  __fireTaskStart,
  __resetStubs,
  __setTaskExecutions,
  __stubs,
  FakeTaskExecution,
} from '../stubs/vscode'
import { makeFolder, makeTask } from './support/fakeWorkspaceTask'

/**
 * 运行态跟踪（10 方案 §7.6/§8.3，§11.2 用例 ①-⑧）：
 * 事件 100ms 去抖、isRunning 实时扫描 taskExecutions、terminate 逐个吞错。
 */

const root = makeFolder('work', '/repo/work')
const other = makeFolder('other', '/repo/other', 1)

beforeEach(() => {
  __resetStubs()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

function makeTracker(): TaskStatusTracker {
  return new TaskStatusTracker(vscode.window.createOutputChannel('test'))
}

describe('TaskStatusTracker（运行态跟踪）', () => {
  it('① 开始事件 100ms 后触发一次变更', () => {
    const tracker = makeTracker()
    let events = 0
    tracker.onDidChange(() => (events += 1))
    const task = makeTask({ name: 'build', folder: root })
    const execution = new FakeTaskExecution(task)
    __setTaskExecutions([execution])

    __fireTaskStart(execution)
    expect(events).toBe(0) // 去抖窗口内未触发
    vi.advanceTimersByTime(100)
    expect(events).toBe(1)
    tracker.dispose()
  })

  it('② 结束事件触发变更；⑧ 去抖窗口内重复事件只发一次', () => {
    const tracker = makeTracker()
    let events = 0
    tracker.onDidChange(() => (events += 1))
    const task = makeTask({ name: 'build', folder: root })
    const execution = new FakeTaskExecution(task)

    __fireTaskStart(execution)
    __fireTaskEnd(execution)
    __fireTaskStart(execution)
    vi.advanceTimersByTime(100)
    expect(events).toBe(1)

    __fireTaskEnd(execution)
    vi.advanceTimersByTime(100)
    expect(events).toBe(2)
    tracker.dispose()
  })

  it('③ isRunning 按 key 命中/不命中', () => {
    const tracker = makeTracker()
    const task = makeTask({ name: 'build', folder: root })
    __setTaskExecutions([new FakeTaskExecution(task)])

    expect(tracker.isRunning(taskKey(task as unknown as vscode.Task))).toBe(true)
    expect(tracker.isRunning(`${String(root.uri)}\u0000Workspace\u0000missing`)).toBe(false)
    tracker.dispose()
  })

  it('④ 同根同名但不同文件夹不误判', () => {
    const tracker = makeTracker()
    const inRoot = makeTask({ name: 'build', folder: root })
    const inOther = makeTask({ name: 'build', folder: other })
    __setTaskExecutions([new FakeTaskExecution(inRoot)])

    expect(tracker.isRunning(taskKey(inOther as unknown as vscode.Task))).toBe(false)
    expect(tracker.isRunning(taskKey(inRoot as unknown as vscode.Task))).toBe(true)
    tracker.dispose()
  })

  it('⑤ 多个执行全部终止并返回匹配数', () => {
    const tracker = makeTracker()
    const task = makeTask({ name: 'build', folder: root })
    const first = new FakeTaskExecution(task)
    const second = new FakeTaskExecution(task)
    __setTaskExecutions([first, second])

    expect(tracker.terminate(taskKey(task as unknown as vscode.Task))).toBe(2)
    tracker.dispose()
  })

  it('⑥ terminate 抛错被吞并继续（输出通道记录）', () => {
    const tracker = makeTracker()
    const task = makeTask({ name: 'build', folder: root })
    const throwing = new FakeTaskExecution(task)
    throwing.terminate = () => {
      throw new Error('already finished')
    }
    const normal = new FakeTaskExecution(task)
    __setTaskExecutions([throwing, normal])

    expect(tracker.terminate(taskKey(task as unknown as vscode.Task))).toBe(2)
    expect(__stubs.outputLines.join('\n')).toContain('停止任务「build」失败')
    tracker.dispose()
  })

  it('⑦ dispose 后不再响应事件（去抖计时器也被清理）', () => {
    const tracker = makeTracker()
    let events = 0
    tracker.onDidChange(() => (events += 1))
    const execution = new FakeTaskExecution(makeTask({ name: 'build', folder: root }))

    tracker.dispose()
    __fireTaskStart(execution)
    vi.advanceTimersByTime(500)
    expect(events).toBe(0)
  })

  it('⑦b 去抖计时器未到即 dispose → 取消计时器', () => {
    const tracker = makeTracker()
    let events = 0
    tracker.onDidChange(() => (events += 1))
    const execution = new FakeTaskExecution(makeTask({ name: 'build', folder: root }))

    __fireTaskStart(execution)
    tracker.dispose() // 100ms 内 dispose：计时器被清理
    vi.advanceTimersByTime(500)
    expect(events).toBe(0)
  })
})
