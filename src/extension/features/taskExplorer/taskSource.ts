import * as vscode from 'vscode'

/**
 * 任务管理器数据层（v2.3，10 方案 §6）：工作区 `.vscode/tasks.json` 任务的
 * 发现、过滤、排序与分组。
 *
 * 关键红线：任务对象只来自 `fetchTasks()`，**绝不 `new vscode.Task(...)` 后交给
 * `executeTask`**——自建任务没有内部 `_id`，主线程按 DTO 重建时会丢 `dependsOn`，
 * 依赖编排语义与原生引擎不一致（10 方案 §3.3）。
 *
 * 过滤依据（10 方案 §3.2）：VS Code 对 tasks.json 任务的 source label 硬编码为
 * `'Workspace'`（含 shell/process 与 npm 等 contributed type）；用户级 tasks.json
 * 与 `.code-workspace` 级任务共享该 source 但没有文件夹 scope，用同一条件排除。
 */

/** VS Code 对 tasks.json 任务的硬编码 source label（非公开 API 语义，M0 已实测） */
const WORKSPACE_TASK_SOURCE = 'Workspace'

/** 任务身份：存 workspaceState 的最小四元组拆解，不存 Task 对象（10 方案 §6.1） */
export interface TaskRef {
  readonly scopeUri: string
  readonly source: string
  readonly name: string
}

/** 最近运行条目：TaskRef + 时间戳 */
export interface RecentTaskRef extends TaskRef {
  readonly lastRunAt: number
}

/** workspaceState 中的持久化结构（版本不符整体重置，见 taskUsageStore） */
export interface TaskUsage {
  readonly version: 1
  readonly favorites: TaskRef[]
  readonly recent: RecentTaskRef[]
}

/** 树内任务条目：fetchTasks 结果 + 所属文件夹 + 稳定 key */
export interface WorkspaceTaskEntry {
  readonly task: vscode.Task
  readonly folder: vscode.WorkspaceFolder
  /** `scopeUri + '\u0000' + source + '\u0000' + name`，多根同名任务不串扰 */
  readonly key: string
  /** task.name，用于排序 */
  readonly label: string
  /** 与 key 一一对应的持久化身份 */
  readonly ref: TaskRef
}

function isWorkspaceFolder(scope: vscode.Task['scope']): scope is vscode.WorkspaceFolder {
  return typeof scope === 'object' && scope !== null && 'uri' in scope
}

/** 唯一需要「猜」的过滤条件（M0 已在 1.85 与最新稳定版实测）；其余任务源全部排除 */
export function isWorkspaceFileTask(
  task: vscode.Task
): task is vscode.Task & { scope: vscode.WorkspaceFolder } {
  return task.source === WORKSPACE_TASK_SOURCE && isWorkspaceFolder(task.scope)
}

/** 由 Task 拼稳定 key（'\u0000' 分隔，避免普通字符拼撞） */
export function taskKey(task: vscode.Task): string {
  const folder = isWorkspaceFolder(task.scope) ? task.scope : undefined
  return taskKeyFromRef({
    scopeUri: folder ? String(folder.uri) : '',
    source: task.source,
    name: task.name,
  })
}

/** 由 TaskRef 拼回同一规则 key，保证「存储 → 匹配」不依赖对象引用 */
export function taskKeyFromRef(ref: TaskRef): string {
  return `${ref.scopeUri}\u0000${ref.source}\u0000${ref.name}`
}

/** Task → 可持久化身份（与 taskKey 同源） */
export function taskRef(task: vscode.Task): TaskRef {
  const folder = isWorkspaceFolder(task.scope) ? task.scope : undefined
  return {
    scopeUri: folder ? String(folder.uri) : '',
    source: task.source,
    name: task.name,
  }
}

/**
 * 取回并过滤工作区 tasks.json 任务。`fetchTasks` 抛错时不吞——交给 provider
 * 置错误态并写输出通道（10 方案 §6.2）。不去重：VS Code 保证同一文件夹内任务名唯一。
 */
export async function loadWorkspaceTasks(): Promise<WorkspaceTaskEntry[]> {
  const tasks = await vscode.tasks.fetchTasks()
  return tasks
    .filter(isWorkspaceFileTask)
    .map((task) => {
      const folder = task.scope as vscode.WorkspaceFolder
      return { task, folder, key: taskKey(task), label: task.name, ref: taskRef(task) }
    })
    .sort(
      (a, b) =>
        a.folder.name.localeCompare(b.folder.name, 'zh-Hans-CN') ||
        a.label.localeCompare(b.label, 'zh-Hans-CN')
    )
}

/** 按所属文件夹分组；多根展示顺序沿用 entries 已排序的文件夹出现顺序 */
export function groupByFolder(
  entries: readonly WorkspaceTaskEntry[]
): ReadonlyMap<vscode.WorkspaceFolder, WorkspaceTaskEntry[]> {
  const groups = new Map<vscode.WorkspaceFolder, WorkspaceTaskEntry[]>()
  for (const entry of entries) {
    const list = groups.get(entry.folder) ?? []
    list.push(entry)
    groups.set(entry.folder, list)
  }
  return groups
}
