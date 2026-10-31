import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as vscode from 'vscode'
import { TaskExplorerController } from '../../../extension/features/taskExplorer/taskExplorerController'
import type { WorkspaceTaskEntry } from '../../../extension/features/taskExplorer/taskSource'
import {
  __fireWorkspaceFoldersChanged,
  __fireWorkspaceTrustGranted,
  __resetStubs,
  __setDocument,
  __setTaskExecutions,
  __stubs,
  createMementoStub,
  FakeTaskExecution,
  TextEditorRevealType,
  Uri,
} from '../stubs/vscode'
import { makeFolder, makeTask, setWorkspace } from './support/fakeWorkspaceTask'

/**
 * 控制器编排（10 方案 §8/§9，§11.2 用例 ①-⑯）：
 * watcher 300ms 去抖、手动刷新清队列、信任/工作区刷新、运行/停止/定位/收藏/清空。
 */

const root = makeFolder('work', '/repo/work')

function makeController(memento = createMementoStub()): TaskExplorerController {
  return new TaskExplorerController(memento, vscode.window.createOutputChannel('test'))
}

function lastRecord(kind: string): { args: unknown[] } | undefined {
  return __stubs.recorded.filter((e) => e.kind === kind).at(-1)
}

function recordsOf(kind: string): number {
  return __stubs.recorded.filter((e) => e.kind === kind).length
}

const lastInfo = (): string | undefined =>
  (lastRecord('showInformationMessage')?.args[0] as { message?: string } | undefined)?.message
const lastWarn = (): string | undefined =>
  (lastRecord('showWarningMessage')?.args[0] as { message?: string } | undefined)?.message
const lastError = (): string | undefined =>
  (lastRecord('showErrorMessage')?.args[0] as { message?: string } | undefined)?.message

function makeEntry(task = makeTask({ name: 'build', folder: root })): WorkspaceTaskEntry {
  return {
    task: task as unknown as vscode.Task,
    folder: root as unknown as vscode.WorkspaceFolder,
    key: `${String(root.uri)}\u0000Workspace\u0000build`,
    label: task.name,
    ref: { scopeUri: String(root.uri), source: 'Workspace', name: task.name },
  }
}

function taskNode(entry: WorkspaceTaskEntry): unknown {
  return { kind: 'task', entry }
}

beforeEach(() => {
  __resetStubs()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('TaskExplorerController（刷新编排）', () => {
  it('① watcher 变化 300ms 去抖只刷新一次', async () => {
    setWorkspace([root], [])
    const controller = makeController()
    const watcher = __stubs.fileWatchers.at(-1)!
    watcher.__fireChange()
    watcher.__fireChange()
    watcher.__fireChange()
    expect(recordsOf('fetchTasks')).toBe(0)
    await vi.advanceTimersByTimeAsync(300)
    expect(recordsOf('fetchTasks')).toBe(1)
    controller.dispose()
  })

  it('② 手动刷新清空去抖队列并立即执行', async () => {
    setWorkspace([root], [])
    const controller = makeController()
    const watcher = __stubs.fileWatchers.at(-1)!
    watcher.__fireChange()
    controller.refresh() // 立即执行 + 清队列
    await vi.advanceTimersByTimeAsync(0)
    expect(recordsOf('fetchTasks')).toBe(1)
    await vi.advanceTimersByTimeAsync(600)
    expect(recordsOf('fetchTasks')).toBe(1) // 队列已清，无第二次
    controller.dispose()
  })

  it('③ 工作区文件夹变化立即刷新；④ 授予信任立即刷新', async () => {
    setWorkspace([root], [])
    const controller = makeController()
    __fireWorkspaceFoldersChanged()
    await vi.advanceTimersByTimeAsync(0)
    expect(recordsOf('fetchTasks')).toBe(1)
    __fireWorkspaceTrustGranted()
    await vi.advanceTimersByTimeAsync(0)
    expect(recordsOf('fetchTasks')).toBe(2)
    controller.dispose()
  })

  it('⑯ dispose 释放 watcher 与监听', async () => {
    setWorkspace([root], [])
    const controller = makeController()
    controller.dispose()
    const watcher = __stubs.fileWatchers.at(-1)!
    watcher.__fireChange()
    __fireWorkspaceFoldersChanged()
    __fireWorkspaceTrustGranted()
    await vi.advanceTimersByTimeAsync(600)
    expect(recordsOf('fetchTasks')).toBe(0)
  })
})

describe('TaskExplorerController（运行 / 停止）', () => {
  it('⑤ 未信任 → 警告且不执行、不记录', async () => {
    setWorkspace([root], [makeTask({ name: 'build', folder: root })])
    __stubs.isTrusted = false
    const controller = makeController()
    await controller.run(makeEntry().task)
    expect(lastWarn()).toContain('受限模式')
    expect(recordsOf('executeTask')).toBe(0)
    expect(controller.usage.getRecent()).toEqual([])
    controller.dispose()
  })

  it('⑥ 运行成功 → executeTask 收到原始 Task + recordRun；不重新 fetchTasks', async () => {
    const task = makeTask({ name: 'build', folder: root })
    setWorkspace([root], [task])
    const controller = makeController()
    await controller.refresh()
    const fetches = recordsOf('fetchTasks')

    await controller.run(task) // TreeItem.command 路径：原始 Task
    expect(lastRecord('executeTask')?.args[0]).toBe(task) // 红线：不重建执行对象
    expect(controller.usage.getRecent()).toMatchObject([
      { scopeUri: String(root.uri), source: 'Workspace', name: 'build' },
    ])
    expect(recordsOf('fetchTasks')).toBe(fetches) // 运行不触发 fetchTasks
    controller.dispose()
  })

  it('⑥b 树节点参数同样可运行（归一化）', async () => {
    setWorkspace([root], [])
    const controller = makeController()
    await controller.run(taskNode(makeEntry()))
    expect(recordsOf('executeTask')).toBe(1)
    controller.dispose()
  })

  it('⑦ 运行失败 → 错误通知 + 输出通道 + 不记录', async () => {
    setWorkspace([root], [])
    __stubs.executeTaskError = new Error('source invalid')
    const controller = makeController()
    await controller.run(makeEntry().task)
    expect(lastError()).toBe('运行任务失败：source invalid')
    expect(__stubs.outputLines.join('\n')).toContain('运行失败：source invalid')
    expect(controller.usage.getRecent()).toEqual([])
    controller.dispose()
  })

  it('⑧ 无参运行提示不报错', async () => {
    setWorkspace([root], [])
    const controller = makeController()
    await controller.run(undefined)
    expect(lastInfo()).toContain('请从任务管理器中选择要运行的任务')
    expect(recordsOf('executeTask')).toBe(0)
    controller.dispose()
  })

  it('⑨ stop：有匹配逐个 terminate；无匹配提示', () => {
    setWorkspace([root], [])
    const controller = makeController()
    const task = makeTask({ name: 'build', folder: root })
    const execution = new FakeTaskExecution(task)
    __setTaskExecutions([execution, new FakeTaskExecution(task)])
    controller.stop(task)
    expect(recordsOf('taskTerminate')).toBe(2)

    __setTaskExecutions([])
    controller.stop(task)
    expect(lastInfo()).toBe('任务未在运行：build')
    controller.dispose()
  })

  it('⑨b stop 未信任拦截；无参提示', () => {
    setWorkspace([root], [])
    __stubs.isTrusted = false
    const controller = makeController()
    controller.stop(makeEntry().task)
    expect(lastWarn()).toContain('受限模式')

    __stubs.isTrusted = true
    controller.stop(undefined)
    expect(lastInfo()).toContain('请从任务管理器中选择要停止的任务')
    controller.dispose()
  })
})

describe('TaskExplorerController（定位）', () => {
  const tasksJsonUri = Uri.file('/repo/work/.vscode/tasks.json')

  it('⑩ 定位命中 → 打开带 selection 并 reveal', async () => {
    const content = '{\n  "tasks": [\n    {\n      "label": "build"\n    }\n  ]\n}'
    __setDocument(tasksJsonUri, content)
    setWorkspace([root], [])
    const controller = makeController()
    await controller.locate(makeEntry().task)
    const show = lastRecord('showTextDocument')?.args[0] as
      { uriOrDocument?: unknown; options?: { selection?: unknown; preview?: boolean } } | undefined
    expect(show?.options?.preview).toBe(false)
    const selection = show?.options?.selection as { start: { line: number } }
    expect(selection.start.line).toBe(3)
    const reveal = lastRecord('revealRange')?.args[0] as { revealType?: number } | undefined
    expect(reveal?.revealType).toBe(TextEditorRevealType.InCenterIfOutsideViewport)
    controller.dispose()
  })

  it('⑪ 定位未命中 → 打开顶部 + 警告', async () => {
    __setDocument(tasksJsonUri, '{ "tasks": [{ "label": "other" }] }')
    setWorkspace([root], [])
    const controller = makeController()
    await controller.locate(makeEntry().task)
    const show = lastRecord('showTextDocument')?.args[0] as
      { options?: { selection?: unknown } } | undefined
    expect(show?.options?.selection).toBeUndefined()
    expect(lastWarn()).toContain('未能定位任务行')
    controller.dispose()
  })

  it('⑫ 文件不存在 → 提示不崩', async () => {
    setWorkspace([root], [])
    const controller = makeController()
    await controller.locate(makeEntry().task)
    expect(lastWarn()).toContain('未找到 .vscode/tasks.json')
    controller.dispose()
  })

  it('定位无参提示', async () => {
    setWorkspace([root], [])
    const controller = makeController()
    await controller.locate(undefined)
    expect(lastInfo()).toContain('请从任务管理器中选择要定位的任务')
    controller.dispose()
  })
})

describe('TaskExplorerController（边角）', () => {
  it('⑮d 未打开工作区文件夹 → 提示', async () => {
    const controller = makeController()
    await controller.openTasksJson()
    expect(lastInfo()).toContain('未打开工作区文件夹')
    controller.dispose()
  })

  it('⑯b 去抖计时器未到即 dispose → 不再刷新', async () => {
    setWorkspace([root], [])
    const controller = makeController()
    const watcher = __stubs.fileWatchers.at(-1)!
    watcher.__fireChange()
    controller.dispose() // 300ms 内 dispose
    await vi.advanceTimersByTimeAsync(600)
    expect(recordsOf('fetchTasks')).toBe(0)
  })
})

describe('TaskExplorerController（打开 tasks.json / 收藏 / 清空）', () => {
  const tasksJsonUri = Uri.file('/repo/work/.vscode/tasks.json')

  it('⑮a 单根直开', async () => {
    __setDocument(tasksJsonUri, '{}')
    setWorkspace([root], [])
    const controller = makeController()
    await controller.openTasksJson()
    const show = lastRecord('showTextDocument')?.args[0] as
      { uriOrDocument?: { uri: Uri } } | undefined
    expect(String(show?.uriOrDocument?.uri)).toBe(String(tasksJsonUri))
    controller.dispose()
  })

  it('⑮b 多根 QuickPick 选择文件夹', async () => {
    const other = makeFolder('other', '/repo/other', 1)
    __setDocument(tasksJsonUri, '{}')
    setWorkspace([root, other], [])
    const controller = makeController()
    __stubs.dialogQueue.push({ folder: root })
    await controller.openTasksJson()
    expect(
      String((lastRecord('showQuickPick')?.args[0] as { items?: unknown }).items ?? '').length
    ).toBeGreaterThan(0)
    expect(recordsOf('showTextDocument')).toBe(1)
    controller.dispose()
  })

  it('⑮c 文件不存在 → 提示', async () => {
    setWorkspace([root], [])
    const controller = makeController()
    await controller.openTasksJson(root)
    expect(lastWarn()).toContain('未找到 .vscode/tasks.json')
    controller.dispose()
  })

  it('⑬ 收藏/取消收藏委托 store（含节点参数归一化）', () => {
    setWorkspace([root], [])
    const controller = makeController()
    controller.addFavorite(taskNode(makeEntry()))
    expect(controller.usage.isFavorite(`${String(root.uri)}\u0000Workspace\u0000build`)).toBe(true)
    controller.removeFavorite(taskNode(makeEntry()))
    expect(controller.usage.isFavorite(`${String(root.uri)}\u0000Workspace\u0000build`)).toBe(false)

    controller.addFavorite(undefined) // 无参提示
    expect(lastInfo()).toContain('请从任务管理器中选择要收藏的任务')
    controller.dispose()
  })

  it('⑭ 清空最近需模态确认：取消不写、确认后收藏不受影响', async () => {
    setWorkspace([root], [])
    const controller = makeController()
    controller.usage.addFavorite({ scopeUri: String(root.uri), source: 'Workspace', name: 'build' })
    controller.usage.recordRun(
      { scopeUri: String(root.uri), source: 'Workspace', name: 'build' },
      1
    )

    __stubs.dialogQueue.push(undefined) // 取消
    await controller.clearRecent()
    expect(controller.usage.getRecent()).toHaveLength(1)

    __stubs.dialogQueue.push('清空')
    await controller.clearRecent()
    expect(controller.usage.getRecent()).toEqual([])
    expect(controller.usage.getFavorites()).toHaveLength(1)
    controller.dispose()
  })
})
