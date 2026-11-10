/**
 * 视图相关标识（与 package.json 的 contributes 保持一致，单一来源）。
 * 09 方案阶段 2：itemsView / featureConfigView / staticConfigView 三视图随
 * 条目 / 特性配置 / 静态配置领域删除；v2.0：分支编译改造为 Webview 弹框；
 * v2.1：恢复「构建任务」树视图作为侧边栏入口（数据同一 HTTP 接口，见
 * taskManagerTreeProvider）——纯弹框无任何常驻菜单是 v2.0 的实测回归；
 * v2.6：分支编译整体改造为「任务管理」CRUD 实例（增删改查 + 查询参数 +
 * 分页表格），命令 / 视图 / 配置键随之更名为 taskManager / taskApiBaseUrl。
 */
export const VIEW = {
  /** ActivityBar 视图容器 ID */
  containerId: 'extStarter',
  /** 环境信息树视图 ID */
  envViewId: 'extStarter.envView',
  /** 环境初始化视图 ID */
  initViewId: 'extStarter.initView',
  /**
   * 任务管理树视图 ID（v2.6：原「构建任务」侧边栏入口）。
   * 命名区分：TaskManager = taskManager CRUD 实例（演示打桩/真实接口切换），
   * TaskExplorer = 工作区 tasks.json 的任务管理器（v2.3）——两者定位不同，勿混淆。
   */
  taskManagerViewId: 'extStarter.taskManagerView',
  /** 串口服务器树视图 ID */
  serialServersViewId: 'extStarter.serialServersView',
  /** 串口服务器树条目的 contextValue（未连接） */
  serialServerContextValue: 'serialServer',
  /** 串口服务器树条目的 contextValue（已连接，图标/菜单可区分） */
  serialServerConnectedContextValue: 'serialServerConnected',

  /** 任务管理器树视图 ID（v2.3：仅加载工作区 .vscode/tasks.json 任务；见上方命名区分） */
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
  /** 任务 label 按 - 分段产生的虚拟文件夹节点（v2.4，仅展示分组，不可运行） */
  taskExplorerTaskFolderContextValue: 'taskExplorerTaskFolder',

  /** 收藏夹树视图 ID（v3.4：文件/文件夹路径收藏，13 方案） */
  favoritesViewId: 'extStarter.favoritesView',
  /** 收藏条目的 contextValue */
  favoriteContextValue: 'favorite',

  /** 快捷命令树视图 ID（v3.5：终端命令收藏 + 别名 + 分组 + 单击执行，16 方案） */
  quickCommandsViewId: 'extStarter.quickCommandsView',
  /** 快捷命令条目的 contextValue */
  quickCommandContextValue: 'quickCommand',
  /** 快捷命令分组节点的 contextValue */
  quickCommandGroupContextValue: 'quickCommandGroup',
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

  // 任务管理（v2.6：分支编译改造为 CRUD 实例——增删改查 + 查询参数 + 分页表格）
  /** 任务管理：打开控制台弹框（上部查询参数 + 下部任务表格） */
  openTaskManager: 'extStarter.openTaskManager',
  /** 任务管理树视图标题栏：手动刷新任务列表（另有 3s 可见期自动轮询） */
  refreshTaskManager: 'extStarter.refreshTaskManager',

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

  // 收藏夹（v3.4：文件/文件夹路径收藏 + 别名 + 单击跳转，13 方案；
  // 与任务管理器的「任务收藏」addTaskToFavorites 正交——那个收藏的是 tasks.json 任务）
  /** 添加到收藏夹（资源管理器右键文件/文件夹单选多选、编辑器右键/标题栏当前文件） */
  addFavorite: 'extStarter.addFavorite',
  /** 快速打开收藏（QuickPick；命令面板 + 收藏夹视图标题栏） */
  quickOpenFavorites: 'extStarter.quickOpenFavorites',
  /** 打开收藏项（文件→编辑器；文件夹→资源管理器 reveal；树条目单击路由） */
  openFavorite: 'extStarter.openFavorite',
  /** 在资源管理器中显示收藏项（条目右键） */
  revealFavorite: 'extStarter.revealFavorite',
  /** 复制收藏项解析后的绝对路径（条目右键） */
  copyFavoritePath: 'extStarter.copyFavoritePath',
  /** 重命名收藏别名（条目右键；输入框预填现别名） */
  renameFavorite: 'extStarter.renameFavorite',
  /** 移除收藏（条目右键 + inline 悬停删除按钮；无需确认，可重新添加） */
  removeFavorite: 'extStarter.removeFavorite',

  // 快捷命令（v3.5：终端命令收藏 + 别名 + 显式分组 + 单击终端执行，16 方案；
  // 与收藏夹 favorites（收藏路径）、任务收藏 addTaskToFavorites（收藏 tasks.json 任务）正交）
  /** 新增快捷命令（手动输入命令文本 + 别名 + 分组；视图标题栏 + 命令面板） */
  addQuickCommand: 'extStarter.addQuickCommand',
  /** 收藏终端选中命令（剪贴板桥接读选区，无选区降级粘贴输入框；命令面板 + 终端右键） */
  captureTerminalSelection: 'extStarter.captureTerminalSelection',
  /** 快速执行快捷命令（QuickPick 模糊搜索，回车即在专用终端执行） */
  quickRunCommands: 'extStarter.quickRunCommands',
  /** 执行快捷命令（树节点单击 / inline ▶ / 右键路由；专用终端 sendText） */
  executeQuickCommand: 'extStarter.executeQuickCommand',
  /** 编辑命令文本（条目右键；输入框预填现文本） */
  editQuickCommand: 'extStarter.editQuickCommand',
  /** 重命名快捷命令别名（条目右键） */
  renameQuickCommand: 'extStarter.renameQuickCommand',
  /** 移动到分组（条目右键；QuickPick 列分组 + 未分组 + 新建分组） */
  moveQuickCommandToGroup: 'extStarter.moveQuickCommandToGroup',
  /** 复制命令文本到剪贴板（条目右键） */
  copyQuickCommand: 'extStarter.copyQuickCommand',
  /** 删除快捷命令（条目右键 + inline 悬停删除按钮） */
  removeQuickCommand: 'extStarter.removeQuickCommand',
  /** 新建命令分组（视图标题栏 + 命令面板） */
  createQuickCommandGroup: 'extStarter.createQuickCommandGroup',
  /** 重命名命令分组（分组节点右键） */
  renameQuickCommandGroup: 'extStarter.renameQuickCommandGroup',
  /** 删除命令分组（分组节点右键；模态确认，组内命令回落未分组） */
  removeQuickCommandGroup: 'extStarter.removeQuickCommandGroup',
} as const

/**
 * 配置项键名（对应设置里的 extStarter.*）。
 * v2.0：新增构建接口基地址（分支编译，留空 = 打桩模拟）；
 * v2.6：随「任务管理」改造更名为 taskApiBaseUrl（GET/POST/PUT/DELETE /tasks）。
 */
export const CONFIG = {
  section: 'extStarter',
  /** 激活时是否自动执行启动任务 */
  runStartupTasks: 'runStartupTasks',
  /** 串口控制台开关（特性开关体系退场后平铺，09 §3.4/S1） */
  serialConsoleEnabled: 'serialConsoleEnabled',
  /**
   * 任务管理后端接口基地址（v2.6 任务管理改造）：
   * 留空（默认）= 打桩模拟；填写后切换真实接口（GET/POST/PUT/DELETE /tasks）。
   */
  taskApiBaseUrl: 'taskApiBaseUrl',

  // 任务管理器树形展示（v2.5 继承 vscode-taskexplorer 的分组配置体系；v3.1 默认 5 层）
  /** 是否按分隔符分组任务 label（默认 true） */
  taskGroupWithSeparator: 'taskGroupWithSeparator',
  /** 分组分隔符（默认 '-'） */
  taskGroupSeparator: 'taskGroupSeparator',
  /** 分组深度上限 1-15（默认 5：a-b-c-d 拆成 a→b→c→d 多层） */
  taskGroupMaxLevel: 'taskGroupMaxLevel',
  /** 叶子是否剥掉分组前缀只显示剩余段（默认 true，完整名见 tooltip） */
  taskGroupStripTaskLabel: 'taskGroupStripTaskLabel',
  /** 最近运行展示条数 1-20（存储上限恒 20） */
  taskNumLastTasks: 'taskNumLastTasks',
  /** 最近运行/收藏分组的默认展开状态 */
  taskExpanded: 'taskExpanded',

  /** 快捷命令执行时是否复用专用终端 QuickCommand（v3.5，16 方案；false = 每次新建） */
  quickCommandReuseTerminal: 'quickCommandReuseTerminal',
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
  /**
   * 收藏夹数据文件（相对工作区根；v3.4，13 方案）。
   * 已同步进 .gitignore。
   */
  favoritesFileName: '.vscode/favorites.json',
  /**
   * 收藏夹：未打开工作区时，globalStorage 目录下的明文 JSON 文件名（v3.6，15 方案——
   * 手动拷贝即备份迁移）。
   */
  favoritesGlobalFileName: 'favorites.json',
  /** 收藏夹旧 globalState 存储键：仅供激活期一次性迁移读取旧数据（15 方案，迁移后清除） */
  favoritesMementoKey: 'extStarter.favorites',
  /**
   * 快捷命令数据文件（相对工作区根；v3.5，16 方案）。
   * 已同步进 .gitignore。
   */
  quickCommandsFileName: '.vscode/quick-commands.json',
  /** 快捷命令：未打开工作区时，globalState 的存储键 */
  quickCommandsMementoKey: 'extStarter.quickCommands',
} as const
