import * as vscode from 'vscode'
import { registerCommands } from './commands'
import { CONFIG, VIEW } from './constants'
import {
  BuildConsolePanel,
  createBuildConsoleDeps,
  createBuildConsoleServices,
} from './features/build/buildConsolePanel'
import { BuildTasksTreeProvider } from './features/build/buildTasksTreeProvider'
import { DraftBoxService } from './features/drafts/draftBoxService'
import { InitService } from './features/init/initService'
import { InitTreeProvider } from './features/init/initTreeProvider'
import { createInitSteps } from './features/init/initSteps'
import { SerialConsoleController } from './features/serialConsole/serialConsoleController'
import { SerialConsolePanel } from './features/serialConsole/serialConsolePanel'
import { TaskExplorerController } from './features/taskExplorer/taskExplorerController'
import { EnvironmentTreeProvider } from './providers/environmentTreeProvider'
import { migrateLegacyKeys } from './services/legacyMigration'
import { recheckProbeByLabel } from './tasks/environmentTask'
import { TaskRunner } from './tasks/taskRunner'
import { TASKS } from './tasks/taskRegistry'
import { WebviewController, type WebviewControllerDeps } from '../webview/host/webviewController'
import type { WebviewPageId } from '../webview/pages'

/**
 * 插件入口：只做「组装」——各功能视图、命令、启动任务。
 * 各层职责见 README 的架构说明。
 *
 * 激活时机（package.json activationEvents: ['onStartupFinished']）：
 * VSCode 窗口加载完成即激活——不要求打开文件夹，也不要求用户与插件交互
 * （装了即执行），随后按 runStartupTasks 自动运行初始化脚本与环境检测。
 * 扩展宿主按窗口存在，「每次开窗」是 VSCode 提供的最接近「打开时执行」的粒度。
 *
 * 09 方案阶段 2：条目 CRUD / 特性配置 / 静态配置三链路删除
 * （C14：本文件的存储装配、selfDataIgnorePrefix、静态配置 watcher、
 * ItemFormPanel / ConfigFormPanel / ImportWizardPanel 接线一并清理）。
 */
export function activate(context: vscode.ExtensionContext): void {
  const outputChannel = vscode.window.createOutputChannel('Hello VSCode Plugin')
  context.subscriptions.push(outputChannel)

  // 阶段 5.4（09 §5.2）：v0.x 旧命名数据一次性迁移（配置 / Memento；Secret 惰性搬迁）
  void migrateLegacyKeys(context)
    .then((migrated) => {
      if (migrated) {
        void vscode.window.showInformationMessage(
          '已将旧版（v0.x）设置与数据迁移到新命名（extStarter），旧键已清理。'
        )
      }
    })
    .catch((err: unknown) => {
      outputChannel.appendLine(`[迁移] 旧键迁移失败（不影响使用）：${String(err)}`)
    })

  // ---------- 启动任务（环境信息） ----------
  const taskRunner = new TaskRunner(TASKS, outputChannel)
  context.subscriptions.push(taskRunner)
  const envProvider = new EnvironmentTreeProvider(taskRunner)
  context.subscriptions.push(
    envProvider,
    vscode.window.createTreeView(VIEW.envViewId, { treeDataProvider: envProvider })
  )
  if (
    vscode.workspace.getConfiguration(CONFIG.section).get<boolean>(CONFIG.runStartupTasks, true)
  ) {
    // runAll 不 await——探测走子进程，不能阻塞激活流程
    void taskRunner.runAll()
  }
  // 09 方案 §6.1：单探针重检——只跑目标探针并就地更新缓存结果（不阻塞其他条目）
  const recheckEnvironmentItem = async (label: string): Promise<void> => {
    const item = await recheckProbeByLabel(label)
    if (item) {
      taskRunner.updateItem('environment', item)
    }
  }

  // ---------- 功能页面：环境初始化 / 分支编译（v2.0 弹框） ----------
  // 环境快照复用（P1-12）：初始化的 envSnapshot 步骤优先复用启动任务已缓存的结果
  const initService = new InitService(
    createInitSteps({
      getEnvironmentSnapshot: () =>
        taskRunner.lastResults.find((result) => result.taskId === 'environment'),
    }),
    outputChannel
  )
  context.subscriptions.push(initService)
  const initProvider = new InitTreeProvider(() => initService.getStates())
  context.subscriptions.push(
    initService.onDidChangeItems(() => initProvider.refresh()),
    initProvider,
    vscode.window.createTreeView(VIEW.initViewId, { treeDataProvider: initProvider })
  )

  // ---------- 分支编译（v2.0：Webview 弹框 + HTTP 打桩/真实接口；v2.1：恢复侧边栏入口） ----------
  const buildConsoleServices = createBuildConsoleServices(outputChannel)
  context.subscriptions.push({ dispose: () => buildConsoleServices.api.dispose() })
  BuildConsolePanel.configure(context)
  // 「构建任务」树视图：与弹框页同源数据；可见期轮询（onDidChangeVisibility 门控）
  const buildTasksProvider = new BuildTasksTreeProvider(buildConsoleServices.api)
  context.subscriptions.push(buildTasksProvider)
  buildConsoleServices.onAfterSubmit = () => void buildTasksProvider.refresh()
  const buildTreeView = vscode.window.createTreeView(VIEW.buildViewId, {
    treeDataProvider: buildTasksProvider,
  })
  context.subscriptions.push(
    buildTreeView,
    buildTreeView.onDidChangeVisibility((event) => buildTasksProvider.setPolling(event.visible))
  )
  buildTasksProvider.setPolling(buildTreeView.visible) // 初始可见性（事件只在变化时触发）

  // ---------- 串口命令控制台：控制器（共享链路/状态）+ 树视图 ----------
  const serialConsole = new SerialConsoleController(context, outputChannel)
  context.subscriptions.push(serialConsole)
  context.subscriptions.push(
    vscode.window.createTreeView(VIEW.serialServersViewId, {
      treeDataProvider: serialConsole.treeProvider,
    })
  )

  // ---------- 草稿箱（右键示例载体，09 §3.5） ----------
  const drafts = new DraftBoxService(() => vscode.workspace.workspaceFolders?.[0]?.uri)
  context.subscriptions.push(drafts)
  void drafts.load()

  // ---------- 任务管理器（v2.3：仅工作区 .vscode/tasks.json 任务，10 方案） ----------
  const taskExplorer = new TaskExplorerController(context.workspaceState, outputChannel)
  context.subscriptions.push(taskExplorer)
  context.subscriptions.push(
    vscode.window.createTreeView(VIEW.taskExplorerViewId, {
      treeDataProvider: taskExplorer.treeProvider,
      showCollapseAll: true,
    })
  )

  // ---------- Webview 页面装配（M4）：面板上下文 + 序列化器（窗口重载恢复） ----------
  SerialConsolePanel.configure(context)
  WebviewController.registerSerializer(context, (pageId: WebviewPageId): WebviewControllerDeps => {
    switch (pageId) {
      case 'serialConsole':
        // 复用控制器的面板依赖：共享串口链路与状态，恢复面板功能完整
        return serialConsole.panelDepsOrCreate()
      case 'buildConsole':
        // 恢复面板：重建表单 schema 与消息处理（任务列表随 init 后轮询刷新）
        return createBuildConsoleDeps(buildConsoleServices)
      default:
        return {} // gallery 无宿主侧业务
    }
  })

  registerCommands(context, {
    taskRunner,
    outputChannel,
    initService,
    openBuildConsole: () => BuildConsolePanel.createOrShow(buildConsoleServices),
    refreshBuildTasks: () => void buildTasksProvider.refresh(),
    serialConsole,
    drafts,
    recheckEnvironmentItem,
    taskExplorer,
  })
}

export function deactivate(): void {
  // 所有资源已通过 context.subscriptions 统一释放
}
