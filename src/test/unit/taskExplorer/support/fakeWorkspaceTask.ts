import * as vscode from 'vscode'
import {
  __setWorkspaceTasks,
  __stubs,
  ProcessExecution,
  ShellExecution,
  Task,
  Uri,
  type WorkspaceFolderLike,
} from '../../stubs/vscode'

/**
 * 任务管理器（v2.3）单测共享构造器：
 * - folder / task 对象在 `__stubs.workspaceFolders` 与 fetchTasks 结果之间
 *   **必须复用同一实例**——树 provider 以对象身份分组（§6.3），多根测试尤须注意；
 * - Task 桩按真实 API 构造签名（definition, scope, name, source, execution?, problemMatchers?）。
 */

export function makeFolder(name: string, path: string, index = 0): WorkspaceFolderLike {
  return { uri: Uri.file(path), name, index }
}

/** 桩 Task → 真实 vscode.Task 类型边界（运行时同一对象，仅供 product 纯函数签名） */
export function asTask(task: Task): vscode.Task {
  return task as unknown as vscode.Task
}

export interface MakeTaskOptions {
  name: string
  /** 任务所属文件夹（同时用作 scope） */
  folder: WorkspaceFolderLike
  /** definition.type（默认 'shell'；process/npm 用于类型图标断言） */
  definitionType?: string
  /** 默认 'Workspace'（VS Code 对 tasks.json 任务的硬编码 source） */
  source?: string
  execution?: ShellExecution | ProcessExecution
  group?: unknown
  detail?: string
  isBackground?: boolean
}

export function makeTask(options: MakeTaskOptions): Task {
  const task = new Task(
    { type: options.definitionType ?? 'shell', task: options.name },
    options.folder,
    options.name,
    options.source ?? 'Workspace',
    options.execution
  )
  if (options.group !== undefined) {
    task.group = options.group
  }
  if (options.detail !== undefined) {
    task.detail = options.detail
  }
  if (options.isBackground) {
    task.isBackground = true
  }
  return task
}

export function makeShellExecution(commandLine: string, cwd?: string): ShellExecution {
  return cwd === undefined
    ? new ShellExecution(commandLine)
    : new ShellExecution(commandLine, { cwd })
}

/** 一步完成多根场景装配：工作区文件夹 + fetchTasks 结果（folder 实例必须同源复用） */
export function setWorkspace(folders: WorkspaceFolderLike[], tasks: Task[]): void {
  __stubs.workspaceFolders = folders
  __setWorkspaceTasks(tasks)
}

/** Task → WorkspaceTaskEntry（groupByFolder 等纯函数测试用；类型跨桩/真实边界集中转换） */
export function toEntry(task: Task): {
  task: Task
  folder: WorkspaceFolderLike
  key: string
  label: string
  ref: { scopeUri: string; source: string; name: string }
} {
  const folder = task.scope as WorkspaceFolderLike
  return {
    task,
    folder,
    key: `${String(folder.uri)}\u0000${task.source}\u0000${task.name}`,
    label: task.name,
    ref: { scopeUri: String(folder.uri), source: task.source, name: task.name },
  }
}
