import { beforeEach, describe, expect, it } from 'vitest'
import * as vscode from 'vscode'
import { COMMAND } from '../../../extension/constants'
import { registerTaskExplorerCommands } from '../../../extension/commands/taskExplorerCommands'
import { TaskExplorerController } from '../../../extension/features/taskExplorer/taskExplorerController'
import type { WorkspaceTaskEntry } from '../../../extension/features/taskExplorer/taskSource'
import {
  __resetStubs,
  __setDocument,
  __setTaskExecutions,
  __stubs,
  createMementoStub,
  FakeTaskExecution,
  Uri,
} from '../stubs/vscode'
import { makeFolder, makeTask } from './support/fakeWorkspaceTask'

/**
 * 命令薄壳（10 方案 §10.1，§11.2 用例 ①-③）：8 条命令注册齐全、逐条委托
 * controller、带参命令无参调用给提示不抛错。
 */

const root = makeFolder('work', '/repo/work')

function makeEntry(task = makeTask({ name: 'build', folder: root })): WorkspaceTaskEntry {
  return {
    task: task as unknown as vscode.Task,
    folder: root as unknown as vscode.WorkspaceFolder,
    key: `${String(root.uri)}\u0000Workspace\u0000build`,
    label: task.name,
    ref: { scopeUri: String(root.uri), source: 'Workspace', name: task.name },
  }
}

beforeEach(() => {
  __resetStubs()
})

describe('registerTaskExplorerCommands（任务管理器命令）', () => {
  it('① 8 个命令全部注册', () => {
    const registered = new Map<string, (...args: unknown[]) => unknown>()
    const controller = new TaskExplorerController(
      createMementoStub(),
      vscode.window.createOutputChannel('test')
    )
    registerTaskExplorerCommands((id, cb) => registered.set(id, cb), { controller })
    expect([...registered.keys()].sort()).toEqual(
      [
        COMMAND.refreshTaskExplorer,
        COMMAND.runWorkspaceTask,
        COMMAND.stopWorkspaceTask,
        COMMAND.openTasksJson,
        COMMAND.locateTaskInTasksJson,
        COMMAND.addTaskToFavorites,
        COMMAND.removeTaskFromFavorites,
        COMMAND.clearRecentTasks,
      ].sort()
    )
    controller.dispose()
  })

  it('② 逐条委托 controller（刷新/运行/停止/定位/打开/收藏/取消/清空）', async () => {
    const registered = new Map<string, (...args: unknown[]) => unknown>()
    const controller = new TaskExplorerController(
      createMementoStub(),
      vscode.window.createOutputChannel('test')
    )
    registerTaskExplorerCommands((id, cb) => registered.set(id, cb), { controller })
    const invoke = (id: string, ...args: unknown[]): unknown => registered.get(id)?.(...args)

    const tasksJsonUri = Uri.file('/repo/work/.vscode/tasks.json')
    __setDocument(tasksJsonUri, '{ "tasks": [{ "label": "build" }] }')

    invoke(COMMAND.refreshTaskExplorer)
    expect(__stubs.recorded.some((e) => e.kind === 'fetchTasks')).toBe(true)

    const task = makeTask({ name: 'build', folder: root })
    await invoke(COMMAND.runWorkspaceTask, task)
    expect(__stubs.recorded.some((e) => e.kind === 'executeTask')).toBe(true)

    __setTaskExecutions([new FakeTaskExecution(task)])
    invoke(COMMAND.stopWorkspaceTask, task)
    expect(__stubs.recorded.some((e) => e.kind === 'taskTerminate')).toBe(true)

    await invoke(COMMAND.locateTaskInTasksJson, task)
    expect(__stubs.recorded.some((e) => e.kind === 'revealRange')).toBe(true)

    await invoke(COMMAND.openTasksJson, root)
    expect(__stubs.recorded.some((e) => e.kind === 'showTextDocument')).toBe(true)

    invoke(COMMAND.addTaskToFavorites, { kind: 'task', entry: makeEntry(task) })
    expect(controller.usage.isFavorite(`${String(root.uri)}\u0000Workspace\u0000build`)).toBe(true)
    invoke(COMMAND.removeTaskFromFavorites, { kind: 'task', entry: makeEntry(task) })
    expect(controller.usage.isFavorite(`${String(root.uri)}\u0000Workspace\u0000build`)).toBe(false)

    controller.usage.recordRun(
      { scopeUri: String(root.uri), source: 'Workspace', name: 'build' },
      1
    )
    __stubs.dialogQueue.push('清空')
    await invoke(COMMAND.clearRecentTasks)
    expect(controller.usage.getRecent()).toEqual([])
    controller.dispose()
  })

  it('③ 带参命令无参调用给提示不抛错', async () => {
    const registered = new Map<string, (...args: unknown[]) => unknown>()
    const controller = new TaskExplorerController(
      createMementoStub(),
      vscode.window.createOutputChannel('test')
    )
    registerTaskExplorerCommands((id, cb) => registered.set(id, cb), { controller })
    const invoke = (id: string, ...args: unknown[]): unknown => registered.get(id)?.(...args)

    const lastInfo = (): string | undefined =>
      (
        __stubs.recorded.filter((e) => e.kind === 'showInformationMessage').at(-1)?.args[0] as
          { message?: string } | undefined
      )?.message

    await invoke(COMMAND.runWorkspaceTask)
    expect(lastInfo()).toContain('请从任务管理器中选择要运行的任务')
    invoke(COMMAND.stopWorkspaceTask)
    expect(lastInfo()).toContain('请从任务管理器中选择要停止的任务')
    await invoke(COMMAND.locateTaskInTasksJson)
    expect(lastInfo()).toContain('请从任务管理器中选择要定位的任务')
    invoke(COMMAND.addTaskToFavorites)
    expect(lastInfo()).toContain('请从任务管理器中选择要收藏的任务')
    invoke(COMMAND.removeTaskFromFavorites)
    expect(lastInfo()).toContain('请从任务管理器中选择要取消收藏的任务')

    // 定位有提示但不打开文档（未选择目标即返回）
    expect(__stubs.recorded.some((e) => e.kind === 'showTextDocument')).toBe(false)
    controller.dispose()
  })
})
