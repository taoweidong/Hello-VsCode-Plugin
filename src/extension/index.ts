import * as vscode from 'vscode'
import { registerCommands } from './commands'
import { CONFIG, VIEW } from './constants'
import {
  TaskManagerPanel,
  createTaskManagerDeps,
  createTaskManagerServices,
} from './features/taskManager/taskManagerPanel'
import { TaskManagerTreeProvider } from './features/taskManager/taskManagerTreeProvider'
import { DraftBoxService } from './features/drafts/draftBoxService'
import { FavoritesService } from './features/favorites/favoritesService'
import { FavoritesTreeProvider } from './features/favorites/favoritesTreeProvider'
import {
  createFavoritesStore,
  migrateFavoritesMementoToFile,
} from './features/favorites/favoritesService'
import {
  migrateQuickCommandsMementoToFile,
  createQuickCommandsStore,
  QuickCommandsService,
} from './features/quickCommands/quickCommandsService'
import { QuickCommandsTreeProvider } from './features/quickCommands/quickCommandsTreeProvider'
import { InitService } from './features/init/initService'
import { InitTreeProvider } from './features/init/initTreeProvider'
import { createInitSteps } from './features/init/initSteps'
import { TaskExplorerController } from './features/taskExplorer/taskExplorerController'
import { EnvironmentTreeProvider } from './providers/environmentTreeProvider'
import {
  cleanupBookmarksLegacyData,
  cleanupSerialLegacyData,
} from './services/legacyFeatureCleanup'
import { registerTreeView } from './services/treeViewRegistration'
import { ENVIRONMENT_TASK_ID, recheckProbeByLabel } from './tasks/environmentTask'
import { TaskRunner } from './tasks/taskRunner'
import { TASKS } from './tasks/taskRegistry'
import { reasonOf } from './services/errors'
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

  // 15 方案（v3.6）：无工作区收藏数据从 globalState 一次性迁移到 globalStorage 明文 JSON
  // （与有无工作区无关地无条件执行，幂等；写成功才清旧键，失败保留旧数据如实上报）
  void migrateFavoritesMementoToFile(context, {
    onWarning: (message) => outputChannel.appendLine(`[收藏夹] ${message}`),
    onMigrated: (fileUri) => {
      outputChannel.appendLine(`[收藏夹] 无工作区收藏数据已迁移到：${fileUri.fsPath}`)
      void vscode.window.showInformationMessage(`无工作区收藏数据已迁移到文件：${fileUri.fsPath}`)
    },
  }).catch((err: unknown) => {
    const message = reasonOf(err)
    outputChannel.appendLine(`[收藏夹] 旧数据迁移失败（旧数据保留在 globalState）：${message}`)
    void vscode.window.showErrorMessage(`收藏数据迁移失败（旧数据已保留）：${message}`)
  })

  // 17 方案阶段 4：无工作区快捷命令数据从 globalState 一次性迁移到 globalStorage
  // 明文 JSON（对齐收藏夹 15 方案口径，幂等；写成功才清旧键，失败保留旧数据）
  void migrateQuickCommandsMementoToFile(context, {
    onWarning: (message) => outputChannel.appendLine(`[快捷命令] ${message}`),
    onMigrated: (fileUri) => {
      outputChannel.appendLine(`[快捷命令] 无工作区数据已迁移到：${fileUri.fsPath}`)
      void vscode.window.showInformationMessage(
        `无工作区快捷命令数据已迁移到文件：${fileUri.fsPath}`
      )
    },
  }).catch((err: unknown) => {
    const message = reasonOf(err)
    outputChannel.appendLine(`[快捷命令] 旧数据迁移失败（旧数据保留在 globalState）：${message}`)
    void vscode.window.showErrorMessage(`快捷命令数据迁移失败（旧数据已保留）：${message}`)
  })

  // v4.0.0 串口功能下线：一次性清理遗留数据（工作区数据文件 / SecretStorage 密码 /
  // globalState 旧键）；幂等，失败不阻断激活，仅输出通道留痕
  void cleanupSerialLegacyData(context, (message) => outputChannel.appendLine(`[清理] ${message}`))
  // v5.0.0 书签功能下线：清理遗留数据文件（工作区 .vscode/bookmarks.json + globalStorage）
  void cleanupBookmarksLegacyData(context, (message) =>
    outputChannel.appendLine(`[清理] ${message}`)
  )

  // ---------- 启动任务（环境信息） ----------
  const taskRunner = new TaskRunner(TASKS, outputChannel)
  context.subscriptions.push(taskRunner)
  const envProvider = new EnvironmentTreeProvider(taskRunner)
  context.subscriptions.push(envProvider)
  registerTreeView(context, outputChannel, VIEW.envViewId, envProvider)
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
      taskRunner.updateItem(ENVIRONMENT_TASK_ID, item)
    }
  }

  // ---------- 功能页面：环境初始化 / 任务管理（v2.6 CRUD 实例） ----------
  // 环境快照复用（P1-12）：初始化的 envSnapshot 步骤优先复用启动任务已缓存的结果
  const initService = new InitService(
    createInitSteps({
      getEnvironmentSnapshot: () =>
        taskRunner.lastResults.find((result) => result.taskId === ENVIRONMENT_TASK_ID),
    }),
    outputChannel
  )
  context.subscriptions.push(initService)
  const initProvider = new InitTreeProvider(() => initService.getStates())
  context.subscriptions.push(
    initService.onDidChangeItems(() => initProvider.refresh()),
    initProvider
  )
  registerTreeView(context, outputChannel, VIEW.initViewId, initProvider)

  // ---------- 任务管理（v2.6：Webview 弹框 + HTTP 打桩/真实接口；侧边栏树视图） ----------
  const taskManagerServices = createTaskManagerServices(outputChannel)
  context.subscriptions.push({ dispose: () => taskManagerServices.api.dispose() })
  TaskManagerPanel.configure(context)
  // 「任务管理」树视图：与弹框页同源数据；可见期轮询（onDidChangeVisibility 门控）
  const taskManagerProvider = new TaskManagerTreeProvider(taskManagerServices.api)
  context.subscriptions.push(taskManagerProvider)
  taskManagerServices.onAfterChange = () => void taskManagerProvider.refresh()
  const taskManagerTreeView = registerTreeView(
    context,
    outputChannel,
    VIEW.taskManagerViewId,
    taskManagerProvider
  )
  if (taskManagerTreeView) {
    context.subscriptions.push(
      taskManagerTreeView.onDidChangeVisibility((event) =>
        taskManagerProvider.setPolling(event.visible)
      )
    )
  }
  taskManagerProvider.setPolling(taskManagerTreeView?.visible ?? false) // 初始可见性（事件只在变化时触发）

  // ---------- 草稿箱（右键示例载体，09 §3.5） ----------
  const drafts = new DraftBoxService(() => vscode.workspace.workspaceFolders?.[0]?.uri)
  context.subscriptions.push(drafts)
  void drafts.load()

  // ---------- 任务管理器（v2.3：仅工作区 .vscode/tasks.json 任务，10 方案） ----------
  const taskExplorer = new TaskExplorerController(context.workspaceState, outputChannel)
  context.subscriptions.push(taskExplorer)
  registerTreeView(context, outputChannel, VIEW.taskExplorerViewId, taskExplorer.treeProvider, {
    showCollapseAll: true,
  })

  // ---------- 收藏夹（v3.4：文件/文件夹路径收藏 + 别名 + 单击跳转，13 方案） ----------
  const favorites = new FavoritesService(
    createFavoritesStore(context, {
      onWarning: (message) => outputChannel.appendLine(`[收藏夹] ${message}`),
    })
  )
  context.subscriptions.push(favorites)
  void favorites.load()
  const favoritesProvider = new FavoritesTreeProvider(favorites)
  context.subscriptions.push(favoritesProvider)
  registerTreeView(context, outputChannel, VIEW.favoritesViewId, favoritesProvider)

  // ---------- 快捷命令（v3.5：终端命令收藏 + 别名 + 分组 + 单击执行，16 方案） ----------
  const quickCommands = new QuickCommandsService(
    createQuickCommandsStore(context, {
      onWarning: (message) => outputChannel.appendLine(`[快捷命令] ${message}`),
    })
  )
  context.subscriptions.push(quickCommands)
  void quickCommands.load()
  const quickCommandsProvider = new QuickCommandsTreeProvider(quickCommands)
  context.subscriptions.push(quickCommandsProvider)
  registerTreeView(context, outputChannel, VIEW.quickCommandsViewId, quickCommandsProvider)

  // ---------- Webview 页面装配（M4）：面板上下文 + 序列化器（窗口重载恢复） ----------
  WebviewController.registerSerializer(
    context,
    (pageId: WebviewPageId): WebviewControllerDeps => {
      switch (pageId) {
        case 'taskManager':
          // 恢复面板：重建表单 schema 与消息处理（查询参数 / 分页 / 增删改查）
          return createTaskManagerDeps(taskManagerServices)
        default:
          return {} // gallery 无宿主侧业务
      }
    },
    (message) => outputChannel.appendLine(`[webview] ${message}`)
  )

  registerCommands(context, {
    taskRunner,
    outputChannel,
    initService,
    openTaskManager: () => TaskManagerPanel.createOrShow(taskManagerServices),
    refreshTaskManager: () => void taskManagerProvider.refresh(),
    drafts,
    recheckEnvironmentItem,
    taskExplorer,
    favorites,
    quickCommands,
  })
}

export function deactivate(): void {
  // 所有资源已通过 context.subscriptions 统一释放
}
