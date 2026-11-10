import * as vscode from 'vscode'
import { reasonOf } from '../../services/errors'
import { taskKey } from './taskSource'

/**
 * 任务运行态跟踪（v2.3，10 方案 §7.6 / §8.3）。
 *
 * - 运行态一律以 `tasks.taskExecutions` 实时扫描为准，**不以事件计数为准**
 *   （不维护脆弱的「开始/结束计数」，事件只用来触发刷新）；
 * - `onDidStartTask` / `onDidEndTask` 触发时 `taskExecutions` 可能尚未更新，
 *   100ms 去抖后由 provider 重新渲染即可稳定；去抖窗口内的重复事件只发一次；
 * - `terminate` 终止匹配 key 的全部执行；`terminate()` 在任务已结束时可能抛错，
 *   逐个 try/catch 记录输出通道后继续（10 方案 §8.3）。
 */

/** 事件 → 变更通知的去抖间隔（onDidStartTask 时执行列表可能滞后） */
const CHANGE_DEBOUNCE_MS = 100

export class TaskStatusTracker implements vscode.Disposable {
  private debounceTimer: ReturnType<typeof setTimeout> | undefined

  private readonly _onDidChange = new vscode.EventEmitter<void>()
  readonly onDidChange = this._onDidChange.event

  private readonly subscriptions: vscode.Disposable[] = [
    vscode.tasks.onDidStartTask(() => this.scheduleChange()),
    vscode.tasks.onDidEndTask(() => this.scheduleChange()),
  ]

  constructor(private readonly output: vscode.OutputChannel) {}

  /** 该 key（folder+source+name）当前是否有活动执行 */
  isRunning(key: string): boolean {
    return vscode.tasks.taskExecutions.some((execution) => taskKey(execution.task) === key)
  }

  /**
   * 终止匹配 key 的全部 TaskExecution，返回匹配数量（含 terminate 抛错的执行）。
   * 运行中的依赖任务是否随之结束由引擎决定（API 无法枚举依赖）。
   */
  terminate(key: string): number {
    const executions = vscode.tasks.taskExecutions.filter(
      (execution) => taskKey(execution.task) === key
    )
    for (const execution of executions) {
      try {
        execution.terminate()
      } catch (error) {
        const message = reasonOf(error)
        this.output.appendLine(`[taskExplorer] 停止任务「${execution.task.name}」失败：${message}`)
      }
    }
    return executions.length
  }

  private scheduleChange(): void {
    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer)
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined
      this._onDidChange.fire()
    }, CHANGE_DEBOUNCE_MS)
  }

  dispose(): void {
    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = undefined
    }
    for (const subscription of this.subscriptions) {
      subscription.dispose()
    }
    this._onDidChange.dispose()
  }
}
