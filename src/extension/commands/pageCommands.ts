import * as vscode from 'vscode'
import { COMMAND } from '../constants'
import type { InitService } from '../features/init/initService'
import { findProbeByLabel } from '../tasks/probes'
import type { TaskRunner } from '../tasks/taskRunner'
import { WebviewController } from '../../webview/host/webviewController'
import { type CommandRegistrar, statusIcon } from './shared'

/**
 * 功能页面场景命令分组（C-15 拆分；09 方案阶段 2 后）——组件画廊 /
 * 环境信息 / 环境初始化 / 任务管理（v2.6：Webview 弹框 taskManager）。
 */

/** 本组依赖（CommandDeps 中与本组相关的字段，由 index.ts 组装时整体传入）。 */
export interface PageCommandDeps {
  taskRunner: TaskRunner
  outputChannel: vscode.OutputChannel
  initService: InitService
  /** 打开任务管理弹框（v2.6：TaskManagerPanel.createOrShow，由 extension.ts 注入）。 */
  openTaskManager: () => void
  /** 刷新任务管理树视图（v2.6：标题栏命令的路由目标）。 */
  refreshTaskManager: () => void
  /** 扩展上下文：openGallery 打开画廊页面需要（WebviewController.createOrShow 第二参）。 */
  context: vscode.ExtensionContext
  /** 单探针重检（09 方案 §6.1：树节点单击「重新检测此项」的路由目标）。 */
  recheckEnvironmentItem: (label: string) => Promise<void>
}

export function registerPageCommands(register: CommandRegistrar, deps: PageCommandDeps): void {
  const {
    taskRunner,
    outputChannel,
    initService,
    openTaskManager,
    refreshTaskManager,
    context,
    recheckEnvironmentItem,
  } = deps

  /* ---------- 开发用：组件画廊（设计系统视觉验收基准） ---------- */
  register(COMMAND.openGallery, () => {
    WebviewController.createOrShow('gallery', context)
  })

  /* ---------- 启动任务 / 环境信息（环境信息视图标题栏与命令面板） ---------- */
  // 09 方案 §6.1：带 label 参数（树节点单击）→ 单探针重检；无参 → 全量检测
  register(COMMAND.refreshEnvironment, (label?: unknown) => {
    if (typeof label === 'string' && findProbeByLabel(label)) {
      void recheckEnvironmentItem(label)
      return
    }
    void taskRunner.runAll()
  })

  register(COMMAND.showEnvironmentOutput, () => {
    outputChannel.show(true)
  })

  /* ---------- 功能页面：环境初始化（清单 + 单步动作模式） ---------- */
  register(COMMAND.runAllInit, () => {
    void initService.runAll()
  })

  register(COMMAND.runInitStep, async (arg?: unknown) => {
    // 树节点单击传 state.id（string）；view/item/context inline 按钮传树节点对象（{ id }）——
    // 两者都归一化为步骤 id（评审修复：此前 inline ▶ 会落到 QuickPick 而非执行该步骤）
    const stepId =
      typeof arg === 'string'
        ? arg
        : typeof arg === 'object' &&
            arg !== null &&
            typeof (arg as { id?: unknown }).id === 'string'
          ? (arg as { id: string }).id
          : undefined
    if (stepId) {
      void initService.runStep(stepId)
      return
    }
    // 无参调用（命令面板）：QuickPick 引导选择步骤
    const states = initService.getStates()
    if (!states.length) {
      return
    }
    const picked = await vscode.window.showQuickPick(
      states.map((state) => ({
        label: `${statusIcon(state.status)} ${state.title}`,
        description: state.status === 'idle' ? state.description : state.message,
        id: state.id,
      })),
      { title: '选择要执行的初始化步骤', matchOnDescription: true }
    )
    if (picked) {
      void initService.runStep(picked.id)
    }
  })

  /* ---------- 功能页面：任务管理（典型 CRUD 实例：增删改查 + 查询 + 分页） ---------- */
  // v2.6：任务管理 = Webview 弹框（上部查询参数 + 下部任务表格）；无参设计，
  // 命令面板 / 树视图标题栏 / 任务条目单击统一入口
  register(COMMAND.openTaskManager, () => {
    openTaskManager()
  })

  // 任务管理树视图标题栏刷新
  register(COMMAND.refreshTaskManager, () => {
    refreshTaskManager()
  })
}
