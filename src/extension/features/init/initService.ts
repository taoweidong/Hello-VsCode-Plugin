import * as vscode from 'vscode'
import { TaskSignalSource } from '../../tasks/taskRunner'
import type { InitContext, InitStep } from './initSteps'

export type StepStatus = 'idle' | 'running' | 'done' | 'failed'

export interface StepState {
  id: string
  title: string
  description: string
  status: StepStatus
  /** 执行结果信息（成功信息或失败原因） */
  message?: string
  durationMs?: number
}

/** 单步骤默认超时（毫秒）：挂死步骤被裁决为 failed，不锁死整个初始化（P1-12）。 */
export const INIT_STEP_TIMEOUT_MS = 120000

/**
 * 环境初始化状态机：管理每个步骤的执行状态。
 * - 单步失败不中断后续步骤（与 TaskRunner 同构的容错策略）；
 * - 状态经事件通知树视图刷新；
 * - 步骤可单独重跑，也可全部执行；
 * - runStep 复用 running 互斥（T5.4 / P1-12）：runAll 执行期间单步直接返回并记录，
 *   杜绝并发写同一文件；步骤支持超时（timeoutMs，默认 120s）。
 * - 超时裁决同时经 ctx.signal 向运行中的步骤下发取消信号（P2-B2）：探测型步骤
 *   在候选命令间隙尽快退出，避免「状态已 failed、步骤仍在后台写文件」与后续
 *   步骤并发；不协作的挂死步骤不阻塞后续（既有超时契约保持）。
 */
export class InitService implements vscode.Disposable {
  private states: StepState[]
  private running = false
  /** 当前运行中步骤的取消信号源（超时 / dispose 时触发；无步骤运行时为 undefined）。 */
  private signalSource: TaskSignalSource | undefined

  private readonly _onDidChangeItems = new vscode.EventEmitter<void>()
  readonly onDidChangeItems = this._onDidChangeItems.event

  constructor(
    private readonly steps: InitStep[],
    private readonly output: vscode.OutputChannel
  ) {
    this.states = steps.map((step) => ({
      id: step.id,
      title: step.title,
      description: step.description,
      status: 'idle',
    }))
  }

  get isRunning(): boolean {
    return this.running
  }

  getStates(): StepState[] {
    return [...this.states]
  }

  /** 执行单个步骤（按 id）。初始化整体执行期间触发会被忽略（互斥）。 */
  async runStep(stepId: string): Promise<void> {
    const step = this.steps.find((item) => item.id === stepId)
    const state = this.states.find((item) => item.id === stepId)
    if (!step || !state) {
      return
    }
    if (this.running) {
      // T5.4 / P1-12：runAll 执行期间不允许单步交错（并发写同一文件风险）
      const reason = '初始化正在执行中，单步执行已被忽略（等待整体结束后重试）。'
      this.output.appendLine(`[初始化] 单步执行「${step.title}」被忽略：${reason}`)
      // R-C-21：只写输出通道时，用户单击树视图步骤会「毫无反应」——补一条可见提示
      void vscode.window.showInformationMessage(`「${step.title}」：${reason}`)
      return
    }
    await this.execute(step, state)
  }

  /** 依次执行全部步骤。 */
  async runAll(): Promise<void> {
    if (this.running) {
      return
    }
    this.running = true
    try {
      this._onDidChangeItems.fire()
      for (const step of this.steps) {
        const state = this.states.find((item) => item.id === step.id)
        if (!state) {
          continue
        }
        await this.execute(step, state)
      }
    } finally {
      this.running = false
      this._onDidChangeItems.fire()
    }
  }

  private async execute(step: InitStep, state: StepState): Promise<void> {
    const startedAt = Date.now()
    state.status = 'running'
    state.message = undefined
    this._onDidChangeItems.fire()

    const signalSource = new TaskSignalSource()
    this.signalSource = signalSource
    const ctx: InitContext = {
      workspaceRoot: vscode.workspace.workspaceFolders?.[0]?.uri,
      output: this.output,
      signal: signalSource.signal,
    }
    // 步骤超时（P1-12）：挂死步骤（如不可取消的全量环境探测）被裁决为 failed
    const timeoutMs = step.timeoutMs ?? INIT_STEP_TIMEOUT_MS
    let timedOut = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true
        reject(new Error(`步骤超时（超过 ${timeoutMs}ms）`))
      }, timeoutMs)
    })
    try {
      const message = await Promise.race([step.run(ctx), timeoutPromise])
      state.status = 'done'
      state.message = message
      state.durationMs = Date.now() - startedAt
      this.output.appendLine(`[初始化] ✓ ${step.title}：${message}（${state.durationMs}ms）`)
    } catch (err) {
      state.status = 'failed'
      state.message = timedOut
        ? `步骤超时（超过 ${timeoutMs}ms）`
        : err instanceof Error
          ? err.message
          : String(err)
      state.durationMs = Date.now() - startedAt
      this.output.appendLine(`[初始化] ✗ ${step.title}：${state.message}`)
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer)
      }
      // 超时路径：向仍在运行的步骤请求取消（P2-B2），不再有运行中步骤
      signalSource.cancel()
      signalSource.dispose()
      this.signalSource = undefined
    }
    this._onDidChangeItems.fire()
  }

  dispose(): void {
    // 停用时请求运行中的步骤尽快退出（步骤经 ctx.signal 协作）
    this.signalSource?.cancel()
    this._onDidChangeItems.dispose()
  }
}
