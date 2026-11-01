import type { StartupTask, TaskContext, TaskResult } from './types'

/**
 * 内置演示任务：初始化脚本（动作类 StartupTask 的最小示例）。
 *
 * VSCode 打开（扩展激活）时随启动任务自动执行（受 extStarter.runStartupTasks 控制，
 * 默认开启），执行过程经 TaskRunner 逐行打印到输出通道（控制台：命令面板
 * 「Hello VSCode Plugin: 打开环境信息输出」即可查看）。
 *
 * ★ 预留的扩展接口（与任务框架同一条路）：新增初始化脚本 = 实现 StartupTask
 *   接口并在 taskRegistry.ts 的 TASKS 数组加一项——调度、超时裁决、异常降级、
 *   控制台打印、「环境信息」视图分组全部自动生效，零改动框架代码。
 *   本任务即「动作类」脚本的最小样板；「检测类」脚本见 environmentTask（探针注册表）。
 */
export const helloTask: StartupTask = {
  id: 'hello',
  title: '初始化脚本',
  timeoutMs: 10000,

  async run(ctx: TaskContext): Promise<TaskResult> {
    const startedAt = Date.now()
    const message = 'Hello, World!（Hello VSCode Plugin 初始化脚本）'
    // 执行过程实时打印到控制台（输出通道）；结果同时进「环境信息」视图分组
    ctx.output.appendLine(`[初始化脚本] ${message}`)
    return {
      taskId: 'hello',
      taskTitle: '初始化脚本',
      status: 'ok',
      durationMs: Date.now() - startedAt,
      finishedAt: new Date().toISOString(),
      items: [{ label: 'Hello World', description: message, status: 'ok' }],
    }
  },
}
