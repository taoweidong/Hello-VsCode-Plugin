import * as vscode from 'vscode'
import { environmentTask } from '../../tasks/environmentTask'
import { TaskSignalSource } from '../../tasks/taskRunner'
import type { TaskSignal, TaskResult } from '../../tasks/types'
import { writeJsonAtomic } from '../../services/stores/atomicWrite'

/**
 * 初始化步骤定义（09 方案阶段 2：dataFile / staticConfig 两步骤随
 * storagePath 配置与静态配置领域删除，5 → 3——workspace / artifactDir / envSnapshot）。
 */

/** 初始化步骤的执行上下文。 */
export interface InitContext {
  /** 当前工作区根目录（未打开工作区时为 undefined） */
  workspaceRoot?: vscode.Uri
  output: vscode.OutputChannel
  /**
   * 取消信号（P2-B2）：步骤超时 / 扩展停用时由 InitService 触发。
   * 探测型步骤应在候选命令间隙检查并尽快退出；缺省时步骤自建（独立运行场景）。
   */
  signal?: TaskSignal
}

/**
 * 初始化步骤定义：返回成功信息；失败直接抛错（由 InitService 记录为 failed）。
 * timeoutMs 可选（默认 120s，见 InitService）：挂死步骤被裁决为 failed。
 * 新增步骤在本数组加一项即可（注册表模式）。
 */
export interface InitStep {
  id: string
  title: string
  description: string
  /** 步骤超时（毫秒）；缺省 INIT_STEP_TIMEOUT_MS。 */
  timeoutMs?: number
  run(ctx: InitContext): Promise<string>
}

/** createInitSteps 的可注入依赖。 */
export interface CreateInitStepsOptions {
  /**
   * 环境快照 getter（T5.4 / P1-12）：返回扩展宿主已缓存的环境检测结果；
   * 有结果时 envSnapshot 步骤直接复用（避免最坏约 48s 的重复全量探测），
   * 无结果（undefined）才现场运行 environmentTask。
   */
  getEnvironmentSnapshot?: () => TaskResult | undefined
}

export function createInitSteps(options?: CreateInitStepsOptions): InitStep[] {
  return [
    {
      id: 'workspace',
      title: '检查工作区',
      description: '确认已打开工作区文件夹，后续初始化动作都落在工作区内',
      async run(ctx) {
        if (!ctx.workspaceRoot) {
          throw new Error('未打开工作区，无法初始化。请先打开一个文件夹。')
        }
        return `工作区就绪：${ctx.workspaceRoot.fsPath}`
      },
    },
    {
      id: 'artifactDir',
      title: '创建构建产物目录',
      description: '创建 .ext-starter/ 目录，用于存放环境快照等本地产物',
      async run(ctx) {
        if (!ctx.workspaceRoot) {
          throw new Error('未打开工作区。')
        }
        const dirUri = vscode.Uri.joinPath(ctx.workspaceRoot, '.ext-starter')
        await vscode.workspace.fs.createDirectory(dirUri)
        return `目录就绪：${dirUri.fsPath}`
      },
    },
    {
      id: 'envSnapshot',
      title: '写入环境快照',
      description: '运行环境检测并保存到 .ext-starter/environment.json，便于核对环境一致性',
      async run(ctx) {
        if (!ctx.workspaceRoot) {
          throw new Error('未打开工作区。')
        }
        // T5.4 / P1-12：优先复用宿主注入的快照（如启动任务已探测过），无则现场运行；
        // signal 优先用 InitContext 下发的（超时/停用可协作取消，P2-B2）
        const snapshotSource = options?.getEnvironmentSnapshot?.()
        const result =
          snapshotSource ??
          (await environmentTask.run({
            output: ctx.output,
            workspaceRoot: ctx.workspaceRoot,
            signal: ctx.signal ?? new TaskSignalSource().signal,
          }))
        const snapshot = {
          finishedAt: result.finishedAt,
          status: result.status,
          items: result.items.map((item) => ({
            name: item.label,
            version: item.description,
            status: item.status,
          })),
        }
        const fileUri = vscode.Uri.joinPath(ctx.workspaceRoot, '.ext-starter/environment.json')
        // 原子写（P2-B2）：临时文件 + rename，超时重跑 / 并发路径不产生损坏 JSON
        await writeJsonAtomic(fileUri, snapshot)
        const okCount = result.items.filter((item) => item.status === 'ok').length
        const reused = snapshotSource ? '（复用已有检测结果）' : ''
        return `快照已写入${reused}（${okCount}/${result.items.length} 项就绪）。`
      },
    },
  ]
}
