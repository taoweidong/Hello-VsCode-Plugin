import { beforeEach, describe, expect, it } from 'vitest'
import * as vscode from 'vscode'
import {
  groupByFolder,
  isWorkspaceFileTask,
  loadWorkspaceTasks,
  taskKey,
  taskKeyFromRef,
  taskRef,
} from '../../../extension/features/taskExplorer/taskSource'
import { __resetStubs, __stubs, TaskScope } from '../stubs/vscode'
import { asTask, makeFolder, makeTask, toEntry } from './support/fakeWorkspaceTask'

/**
 * 任务管理器数据层（10 方案 §6）：source+scope 过滤、稳定 key、排序、分组。
 * 过滤矩阵对应 §11.2 taskSource.spec.ts 用例 ①-⑧。
 */

const root = makeFolder('work', '/repo/work')
const other = makeFolder('other', '/repo/other', 1)

beforeEach(() => {
  __resetStubs()
})

describe('isWorkspaceFileTask（source + scope 过滤）', () => {
  it('① source=Workspace + WorkspaceFolder scope → 保留', () => {
    const task = makeTask({ name: 'build', folder: root })
    expect(isWorkspaceFileTask(asTask(task))).toBe(true)
  })

  it('② 扩展 provider 任务（source=npm）→ 排除', () => {
    const task = makeTask({ name: 'compile', folder: root, source: 'npm' })
    expect(isWorkspaceFileTask(asTask(task))).toBe(false)
  })

  it('③ 用户级 tasks.json 任务（scope=TaskScope.Workspace）→ 排除', () => {
    const task = makeTask({
      name: 'user-task',
      folder: root,
      source: 'Workspace',
    })
    task.scope = TaskScope.Workspace
    expect(isWorkspaceFileTask(asTask(task))).toBe(false)
  })

  it('④ .code-workspace 级任务（scope 退化为 TaskScope.Workspace）→ 排除', () => {
    const task = makeTask({ name: 'ws-task', folder: root })
    task.scope = TaskScope.Workspace
    expect(isWorkspaceFileTask(asTask(task))).toBe(false)
  })
})

describe('taskKey / taskRef（稳定身份）', () => {
  it('key 由 scopeUri + source + name 组成，多根同名任务 key 不同（⑥）', () => {
    const a = makeTask({ name: 'build', folder: root })
    const b = makeTask({ name: 'build', folder: other })
    expect(taskKey(asTask(a))).not.toBe(taskKey(asTask(b)))
    expect(taskKey(asTask(a))).toBe(`${String(root.uri)}\u0000Workspace\u0000build`)
  })

  it('taskRef / taskKeyFromRef 互逆（⑧）', () => {
    const task = makeTask({ name: 'build', folder: root })
    const ref = taskRef(asTask(task))
    expect(ref).toEqual({ scopeUri: String(root.uri), source: 'Workspace', name: 'build' })
    expect(taskKeyFromRef(ref)).toBe(taskKey(asTask(task)))
  })

  it('非文件夹 scope（用户级）时 scopeUri 为空串（防御分支）', () => {
    const task = makeTask({ name: 'orphan', folder: root })
    task.scope = TaskScope.Workspace
    expect(taskKey(asTask(task))).toBe(`\u0000Workspace\u0000orphan`)
    expect(taskRef(asTask(task)).scopeUri).toBe('')
  })
})

describe('loadWorkspaceTasks（加载 + 排序）', () => {
  it('只保留工作区 tasks.json 任务并按文件夹名/任务名排序（⑦）', async () => {
    const betaTask = makeTask({ name: 'beta', folder: root })
    const alphaTask = makeTask({ name: 'alpha', folder: root })
    const npmTask = makeTask({ name: 'compile', folder: root, source: 'npm' })
    __stubs.workspaceFolders = [root]
    __stubs.workspaceTasks = [betaTask, npmTask, alphaTask]

    const entries = await loadWorkspaceTasks()
    expect(entries.map((entry) => entry.label)).toEqual(['alpha', 'beta'])
    expect(entries[0]?.task).toBe(alphaTask)
    expect(entries[0]?.folder).toBe(root)
    expect(entries[0]?.ref.name).toBe('alpha')
  })

  it('同根同名任务不去重（VS Code 保证文件夹内唯一，加载层不覆盖）（⑤）', async () => {
    const first = makeTask({ name: 'build', folder: root })
    const second = makeTask({ name: 'build', folder: root })
    __stubs.workspaceFolders = [root]
    __stubs.workspaceTasks = [first, second]

    const entries = await loadWorkspaceTasks()
    expect(entries).toHaveLength(2)
    expect(entries[0]?.task).toBe(first)
    expect(entries[1]?.task).toBe(second)
  })

  it('fetchTasks 抛错时不吞（交给 provider 置错误态）', async () => {
    __stubs.fetchTasksError = new Error('host offline')
    await expect(loadWorkspaceTasks()).rejects.toThrow('host offline')
  })
})

describe('groupByFolder（分组）', () => {
  it('按 folder 对象分组，组内保持排序', () => {
    const a = makeTask({ name: 'a', folder: root })
    const b = makeTask({ name: 'b', folder: root })
    const c = makeTask({ name: 'c', folder: other })
    const entries = [a, b, c].map(toEntry) as unknown as Parameters<typeof groupByFolder>[0]
    const groups = groupByFolder(entries)
    expect(groups.size).toBe(2)
    expect(groups.get(root as unknown as vscode.WorkspaceFolder)?.map((e) => e.label)).toEqual([
      'a',
      'b',
    ])
    expect(groups.get(other as unknown as vscode.WorkspaceFolder)?.map((e) => e.label)).toEqual([
      'c',
    ])
  })
})
