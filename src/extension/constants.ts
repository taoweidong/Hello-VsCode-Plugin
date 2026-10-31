/**
 * 视图相关标识（与 package.json 的 contributes 保持一致，单一来源）。
 * 09 方案阶段 2：itemsView / featureConfigView / staticConfigView 三视图随
 * 条目 / 特性配置 / 静态配置领域删除；v2.0：分支编译改造为 Webview 弹框；
 * v2.1：恢复「构建任务」树视图作为侧边栏入口（数据同一 HTTP 接口，见
 * buildTasksTreeProvider）——纯弹框无任何常驻菜单是 v2.0 的实测回归。
 */
export const VIEW = {
  /** ActivityBar 视图容器 ID */
  containerId: 'extStarter',
  /** 环境信息树视图 ID */
  envViewId: 'extStarter.envView',
  /** 环境初始化视图 ID */
  initViewId: 'extStarter.initView',
  /** 构建任务树视图 ID（v2.1：分支编译侧边栏入口） */
  buildViewId: 'extStarter.buildView',
  /** 串口服务器树视图 ID */
  serialServersViewId: 'extStarter.serialServersView',
  /** 构建任务树条目的 contextValue */
  buildTaskContextValue: 'buildTask',
  /** 串口服务器树条目的 contextValue（未连接） */
  serialServerContextValue: 'serialServer',
  /** 串口服务器树条目的 contextValue（已连接，图标/菜单可区分） */
  serialServerConnectedContextValue: 'serialServerConnected',

  /** 任务管理器树视图 ID（v2.3：仅加载工作区 .vscode/tasks.json 任务） */
  taskExplorerViewId: 'extStarter.taskExplorerView',
  /** 工作区文件夹节点 */
  taskExplorerFolderContextValue: 'taskExplorerFolder',
  /** tasks.json 文件节点 */
  taskExplorerFileContextValue: 'tasksFile',
  /** 根分组：最近运行 */
  taskExplorerGroupRecentContextValue: 'taskExplorerGroupRecent',
  /** 根分组：收藏 */
  taskExplorerGroupFavoritesContextValue: 'taskExplorerGroupFavorites',
  /** 根分组：工作区任务 */
  taskExplorerGroupTasksContextValue: 'taskExplorerGroupTasks',
  /** 任务节点（未运行、未收藏） */
  taskExplorerTaskContextValue: 'workspaceTask',
  /** 任务节点（运行中、未收藏） */
  taskExplorerTaskRunningContextValue: 'workspaceTaskRunning',
  /** 任务节点（未运行、已收藏） */
  taskExplorerTaskFavoriteContextValue: 'workspaceTaskFavorite',
  /** 任务节点（运行中、已收藏） */
  taskExplorerTaskRunningFavoriteContextValue: 'workspaceTaskRunningFavorite',
} as const

/**
 * 命令 ID（与 package.json 的 contributes 保持一致）。
 * 09 方案阶段 2：37 → 16（保留 12 + 草稿箱 4，§3.3/§3.5）。
 */
export const COMMAND = {
  // 启动任务 / 环境信息
  /** 环境信息视图标题栏：重新执行启动任务 */
  refreshEnvironment: 'extStarter.refreshEnvironment',
  /** 打开启动任务的输出通道 */
  showEnvironmentOutput: 'extStarter.showEnvironmentOutput',

  // 环境初始化
  /** 环境初始化：执行全部步骤 */
  runAllInit: 'extStarter.runAllInit',
  /** 环境初始化：执行单个步骤（树条目单击 / inline 按钮） */
  runInitStep: 'extStarter.runInitStep',

  // 分支编译（v2.0：Webview 弹框 buildConsole，HTTP 接口打桩模拟）
  /** 分支编译：打开构建控制台（表单提交 + 任务列表） */
  buildBranch: 'extStarter.buildBranch',
  /** 构建任务树视图标题栏：手动刷新任务列表（另有 3s 可见期自动轮询） */
  buildRefreshTasks: 'extStarter.buildRefreshTasks',

  // Webview 页面（Vue 3）
  /** 打开组件画廊（开发用：设计系统视觉验收基准） */
  openGallery: 'extStarter.openGallery',
  /** 打开串口控制台页面（命令面板 / 视图标题栏） */
  openSerialConsole: 'extStarter.openSerialConsole',

  // 串口命令控制台
  /** 新增串口服务器（打开控制台页面表单） */
  addSerialServer: 'extStarter.addSerialServer',
  /** 编辑串口服务器（打开控制台页面并预选） */
  editSerialServer: 'extStarter.editSerialServer',
  /** 删除串口服务器（树右键；模态确认 + 清理密码） */
  deleteSerialServer: 'extStarter.deleteSerialServer',
  /** 连接串口服务器并打开控制台（树条目单击 / inline 按钮） */
  connectSerialServer: 'extStarter.connectSerialServer',
  /** 刷新串口服务器树视图 */
  refreshSerialServers: 'extStarter.refreshSerialServers',

  // 草稿箱（右键示例新载体，09 方案 §3.5；8 条右键入口 = editor/context 4 + explorer/context 3 + editor/title 1）
  /** 编辑器右键：登记选中文本到草稿箱 */
  draftSelection: 'extStarter.draftSelection',
  /** 编辑器右键：追加选中文本到最近一条草稿 */
  appendDraftSelection: 'extStarter.appendDraftSelection',
  /** 资源管理器右键 / 编辑器右键与标题栏：登记文件（支持多选批量） */
  draftFile: 'extStarter.draftFile',
  /** 资源管理器右键：登记文件夹内容为草稿 */
  draftFolder: 'extStarter.draftFolder',

  // 拷贝示例（v2.2：右键把内容拷贝出来到剪贴板——与草稿箱「落盘」对照的最基础示例）
  /** 编辑器右键：复制选中文本到剪贴板 */
  copySelection: 'extStarter.copySelection',
  /** 资源管理器右键：复制文件内容到剪贴板（支持多选批量） */
  copyFileContent: 'extStarter.copyFileContent',
  /** 资源管理器右键：复制文件路径到剪贴板 */
  copyFilePath: 'extStarter.copyFilePath',

  // 任务管理器（v2.3：工作区 .vscode/tasks.json 任务视图，10 方案）
  /** 视图标题栏：刷新任务列表（清空去抖队列并立即重新 fetchTasks） */
  refreshTaskExplorer: 'extStarter.refreshTaskExplorer',
  /** 运行任务（单击任务条目 / 行内 ▶ / 右键；executeTask 交原生引擎） */
  runWorkspaceTask: 'extStarter.runWorkspaceTask',
  /** 停止任务（运行中条目；终止匹配的 TaskExecution） */
  stopWorkspaceTask: 'extStarter.stopWorkspaceTask',
  /** 打开 tasks.json（folder/file 节点单击；多根 QuickPick 选择文件夹） */
  openTasksJson: 'extStarter.openTasksJson',
  /** 定位到 tasks.json 对应 label 行（内置 JSONC 扫描，失败降级打开顶部） */
  locateTaskInTasksJson: 'extStarter.locateTaskInTasksJson',
  /** 收藏任务（星标；写 workspaceState，按工作区隔离） */
  addTaskToFavorites: 'extStarter.addTaskToFavorites',
  /** 取消收藏任务 */
  removeTaskFromFavorites: 'extStarter.removeTaskFromFavorites',
  /** 清空最近运行（模态确认；只清 recent，不影响收藏） */
  clearRecentTasks: 'extStarter.clearRecentTasks',
} as const

/**
 * 配置项键名（对应设置里的 extStarter.*）。
 * v2.0：新增 buildApiBaseUrl（分支编译 HTTP 接口基地址，留空 = 打桩模拟）。
 */
export const CONFIG = {
  section: 'extStarter',
  /** 激活时是否自动执行启动任务 */
  runStartupTasks: 'runStartupTasks',
  /** 串口控制台开关（特性开关体系退场后平铺，09 §3.4/S1） */
  serialConsoleEnabled: 'serialConsoleEnabled',
  /**
   * 构建任务 HTTP 接口基地址（v2.0 分支编译改造）：
   * 留空（默认）= 打桩模拟；填写后切换真实接口（POST/GET /builds）。
   */
  buildApiBaseUrl: 'buildApiBaseUrl',
} as const

/**
 * 存储相关常量。
 * 09 方案阶段 2：条目存储键随领域删除，仅保留串口侧；新增草稿箱数据文件。
 */
export const STORAGE = {
  /** 串口服务器：未打开工作区时，globalState 的存储键 */
  serialServersMementoKey: 'extStarter.serialServers',
  /** 串口命令历史（全局共享、自动去重）：globalState 的存储键 */
  serialCommandHistoryKey: 'extStarter.serialCommandHistory',
  /** 串口服务器登录密码的 SecretStorage 键前缀（完整键为 `<前缀><服务器id>.password`） */
  serialServerSecretPrefix: 'extStarter.serialServer.',
  /**
   * 草稿箱数据文件（相对工作区根）。
   * 已同步进 .gitignore（v2.0 起脏检查随 BuildService 删除，不再有自阻断风险）。
   */
  draftsFileName: '.vscode/ext-starter.drafts.json',
  /** 任务管理器最近运行/收藏（workspaceState，按工作区隔离；v2.3） */
  taskExplorerUsageKey: 'extStarter.taskExplorer.usage',
} as const
