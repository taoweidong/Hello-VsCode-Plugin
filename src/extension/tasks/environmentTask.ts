import { exec } from 'child_process'
import * as os from 'os'
import * as vscode from 'vscode'
import { ENVIRONMENT_PROBES, findProbeByLabel, type EnvironmentProbe } from './probes'
import type { StartupTask, TaskContext, TaskItem, TaskResult, TaskStatus } from './types'

// 单命令超时 6s：探针候选命令最坏 8 条 × 6s = 48s，留出余量低于任务超时 60s
const PROBE_TIMEOUT_MS = 6000

/**
 * 探测命令执行器：返回 (err, stdout, stderr) 三元组（与 node:child_process.exec 回调对齐）。
 * 抽成可注入依赖便于单元测试（注入假执行器复现「命令失败但 stdout 有内容」等场景，E6）。
 */
export type ProbeExecutor = (
  command: string,
  timeoutMs: number
) => Promise<{ err: Error | null; stdout: string; stderr: string }>

/** 默认执行器：真实 shell 探测（windowsHide，超时由 exec 实现）。 */
const defaultExecutor: ProbeExecutor = (command, timeoutMs) =>
  new Promise((resolve) => {
    exec(command, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ err: err ?? null, stdout: stdout ?? '', stderr: stderr ?? '' })
    })
  })

/** 取首行并 trim。 */
function firstLine(value: string): string {
  return value.trim().split(/\r?\n/)[0]?.trim() ?? ''
}

/**
 * 执行一条探测命令并返回其输出的首行；失败或无输出返回空串（不抛错）。
 * E6 修正：**err 非空时一律视为失败**——不再「stdout 有内容即成功」
 * （打印帮助文本后退出的失败命令不能被当成功）；仅退出码为 0 时才接受 stderr
 * （兼容旧版 Python 把 --version 输出到 stderr 的行为，Java -version 同理）。
 */
async function execCapture(executor: ProbeExecutor, command: string): Promise<string> {
  const { err, stdout, stderr } = await executor(command, PROBE_TIMEOUT_MS)
  if (err) {
    return ''
  }
  const out = firstLine(stdout)
  if (out) {
    return out
  }
  if (stderr) {
    return firstLine(stderr)
  }
  return ''
}

/** 依序尝试一组候选命令（fallback 链），返回首个有输出版本号的结果。 */
async function probeVersion(
  executor: ProbeExecutor,
  commands: readonly string[],
  signal?: TaskContext['signal']
): Promise<{ version: string; command?: string }> {
  for (const command of commands) {
    if (signal?.isCancellationRequested) {
      return { version: '' }
    }
    const output = await execCapture(executor, command)
    if (output) {
      return { version: output, command }
    }
  }
  return { version: '' }
}

/**
 * 单个探针 → 树条目（09 方案 §6.1：探针注册表驱动的通用执行路径）。
 * 单探针失败只影响自身条目（missing），不阻塞其他探针。
 */
async function probeToItem(
  executor: ProbeExecutor,
  probe: EnvironmentProbe,
  signal?: TaskContext['signal']
): Promise<TaskItem> {
  const hit = await probeVersion(executor, probe.commands, signal)
  if (hit.version) {
    return {
      label: probe.label,
      description: probe.parse ? probe.parse(hit.version) : hit.version,
      tooltip: `检测命令：${hit.command ?? ''}（点击重新检测）`,
      status: 'ok',
    }
  }
  return {
    label: probe.label,
    description: '未检测到',
    tooltip: `${probe.missingHint ?? `已尝试：${probe.commands.join('、')}`}（点击重新检测）`,
    status: 'missing',
  }
}

/** 与环境探测无关的系统信息条目（操作系统 / VSCode 宿主）。 */
function systemItems(): TaskItem[] {
  return [
    {
      label: '操作系统',
      description: `${os.type()} ${os.release()}（${process.arch}）`,
      status: 'ok',
    },
    { label: 'VSCode', description: `${vscode.env.appName} ${vscode.version}`, status: 'ok' },
  ]
}

/** 环境检测任务的 taskId（index.ts 的定位/重检逻辑与任务注册共用，P3-06 单一来源）。 */
export const ENVIRONMENT_TASK_ID = 'environment'

/**
 * 构造环境检测任务（executor 可注入，默认真实探测）。
 * 09 方案阶段 3：从硬编码六项改为「遍历 ENVIRONMENT_PROBES 注册表 + 2 系统项」，
 * 新增一种语言检测只需在 probes.ts 加一条数据。
 */
export function createEnvironmentTask(executor: ProbeExecutor = defaultExecutor): StartupTask {
  const task: StartupTask = {
    id: ENVIRONMENT_TASK_ID,
    title: '环境检测',
    timeoutMs: 60000,

    async run(ctx: TaskContext): Promise<TaskResult> {
      const startedAt = Date.now()
      const cancelled = () => ctx.signal.isCancellationRequested

      // 探针相互独立，并行探测（P2-B5：串行最坏 8×6s=48s → 并行最坏 6s）；
      // 单探针内部的候选命令回退链保持串行，Promise.all 保序 → 条目顺序与注册表一致
      const probeItems = await Promise.all(
        ENVIRONMENT_PROBES.map((probe) => probeToItem(executor, probe, ctx.signal))
      )
      const items: TaskItem[] = [...probeItems, ...systemItems()]

      // ---- 汇总状态：全部就绪 → ok；有缺失 → warn；执行中被取消 → warn + 说明 ----
      const missing = items.filter((item) => item.status !== 'ok').length
      const status: TaskStatus = missing === 0 ? 'ok' : 'warn'

      return {
        taskId: task.id,
        taskTitle: task.title,
        status,
        durationMs: Date.now() - startedAt,
        finishedAt: new Date().toISOString(),
        items,
        summary: cancelled() ? '任务已取消，以上为部分探测结果。' : undefined,
      }
    },
  }
  return task
}

/** 内置启动任务：环境检测（注册表默认项，executor 为真实探测）。 */
export const environmentTask: StartupTask = createEnvironmentTask()

/**
 * 单探针重检（09 方案 §6.1：树节点单击「重新检测此项」）。
 * 按条目 label 路由到探针；label 不属于任何探针（如操作系统 / VSCode）返回 undefined。
 */
export async function recheckProbeByLabel(
  label: string,
  executor: ProbeExecutor = defaultExecutor
): Promise<TaskItem | undefined> {
  const probe = findProbeByLabel(label)
  return probe ? probeToItem(executor, probe) : undefined
}

/** 供输出通道使用的格式化报告。 */
export function formatTaskResult(result: TaskResult): string[] {
  const time = new Date(result.finishedAt).toLocaleTimeString()
  const lines: string[] = [`[${time}] ${result.taskTitle} 完成，耗时 ${result.durationMs}ms`]
  for (const item of result.items) {
    const mark = item.status === 'ok' ? '✓' : '✗'
    const pad = item.label.padEnd(12, ' ')
    lines.push(`  ${mark} ${pad}${item.description ?? ''}`)
  }
  if (result.summary) {
    lines.push(`  ! ${result.summary}`)
  }
  return lines
}
