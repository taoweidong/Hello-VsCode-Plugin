import * as vscode from 'vscode'

/** 启动任务的状态。 */
export type TaskStatus = 'ok' | 'warn' | 'error'

/** 任务产出的单条信息（树视图的一行）。 */
export interface TaskItem {
  label: string
  /** 主值，如版本号 */
  description?: string
  /** 悬停详情，如原始命令输出 */
  tooltip?: string
  status?: TaskStatus | 'missing'
}

/** 一个启动任务的执行结果。 */
export interface TaskResult {
  taskId: string
  taskTitle: string
  status: TaskStatus
  durationMs: number
  finishedAt: string
  items: TaskItem[]
  /** 异常时的补充说明 */
  summary?: string
}

/**
 * 任务取消信号（T5.4 / P1-11）：与 vscode.CancellationToken 结构兼容的最小接口。
 * TaskRunner 在 dispose（扩展停用）时触发，任务内部可据此提前终止长耗时操作。
 */
export interface TaskSignal {
  isCancellationRequested: boolean
  onCancellationRequested(listener: () => void): vscode.Disposable
}

/** 任务执行上下文（T5.4）：任务不再自行获取宿主环境，统一由调度器注入。 */
export interface TaskContext {
  /** 输出通道（任务写日志用，与 TaskRunner 共用同一通道）。 */
  output: vscode.OutputChannel
  /** 当前工作区根目录（未打开工作区时为 undefined）。 */
  workspaceRoot?: vscode.Uri
  /** 取消信号（TaskRunner dispose 时触发）。 */
  signal: TaskSignal
}

/**
 * 启动任务定义：插件激活时可自动执行的「脚本」。
 *
 * 当前内置任务做环境信息探测（Python/Node 版本等）；
 * 后续的「动作类」任务（如初始化、同步、构建等）同样实现本接口，
 * 在 src/extension/tasks/taskRegistry.ts 的 TASKS 数组中注册即可被框架调度。
 */
export interface StartupTask {
  id: string
  title: string
  /**
   * 单任务超时（毫秒）：超时由 TaskRunner 统一裁决为 error「任务超时」。
   * 缺省 60000（见 taskRunner.ts 的 DEFAULT_TASK_TIMEOUT_MS）。
   */
  timeoutMs?: number
  /** 执行任务。ctx 由 TaskRunner 注入（输出通道 / 工作区根 / 取消信号）。 */
  run(ctx: TaskContext): Promise<TaskResult>
}
