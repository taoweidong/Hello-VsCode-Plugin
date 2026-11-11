# 功能介绍（第二层 · 使用者视角）

> 每个功能一篇：是什么、怎么用（入口与操作）、相关设置、数据落点、常见问题。
> 要**改代码 / 二次开发**请先读 [../基础系统介绍/](../基础系统介绍/README.md)（系统能力
> 与公开接口）、[../设计架构/](../设计架构/README.md)（架构与决策），再到第五层
> [../开发指南/](../开发指南/README.md)——每篇功能介绍末尾都有对应链接。

## 功能总表（v5.1 · 6 视图 / 2 页面 / 44 命令）

| 功能                  | 一句话说明                                                                | 介绍文档                                                  | 开发文档                                            |
| --------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------- |
| 收藏夹                | 任意文件/文件夹路径收藏：别名、单击直达、QuickPick 快开（v3.4）           | [08-收藏夹](08-收藏夹.md)                                 | [开发指南 11](../开发指南/11-收藏夹.md)             |
| 快捷命令              | 终端命令收藏：别名、分组、命令序列逐条执行、专用终端执行、QuickPick 快跑  | [09-快捷命令](09-快捷命令.md)                             | [开发指南 12](../开发指南/12-快捷命令.md)           |
| 启动脚本与环境信息    | VSCode 打开即自动执行初始化脚本 + 环境探针，结果树状展示、可单探针重检    | [01-启动脚本与环境信息](01-启动脚本与环境信息.md)         | [开发指南 01](../开发指南/01-启动任务与环境探针.md) |
| 环境初始化            | 步骤清单式编排：检查工作区 / 产物目录 / 环境快照，单步可重跑              | [02-环境初始化](02-环境初始化.md)                         | [开发指南 02](../开发指南/02-环境初始化.md)         |
| 任务管理（CRUD 实例） | 上部查询参数 + 下部分页表格，支持增删改查（HTTP 打桩/真实）+ 侧边栏任务树 | [03-任务管理](03-任务管理.md)                             | [开发指南 03](../开发指南/03-任务管理.md)           |
| 草稿箱（右键登记）    | 8 条右键入口把选中内容 / 文件登记到工作区草稿数据文件                     | [05-草稿箱](05-草稿箱.md)                                 | [开发指南 05](../开发指南/05-草稿箱与右键菜单.md)   |
| 拷贝示例（右键复制）  | 右键把选中文本 / 文件内容 / 文件路径复制到剪贴板                          | [06-拷贝示例](06-拷贝示例.md)                             | [开发指南 05](../开发指南/05-草稿箱与右键菜单.md)   |
| 任务管理器            | 只加载工作区 `.vscode/tasks.json` 任务：三组树、运行/停止/收藏/定位       | [07-TaskExplorer任务管理器](07-TaskExplorer任务管理器.md) | [开发指南 09](../开发指南/09-任务管理器.md)         |

## 菜单与右键入口速查（44 条命令的分布）

| 菜单位置           | 入口 / 触发方式                                            | 典型场景                                                                                                                                 | 对应命令                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------ | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 视图标题栏         | 各面板右上角（刷新 / 输出 / 全部初始化 / ⭐快开等）        | 手动触发与刷新；收藏夹 QuickPick 快速打开 + 数据文件直达；快捷命令新增/新增序列/快跑/建组                                                | `refreshEnvironment` `showEnvironmentOutput` `runAllInit` `refreshTaskExplorer` `openTasksJson` `quickOpenFavorites` `openFavoritesDataFile` `addQuickCommand` `addQuickCommandSequence` `quickRunCommands` `createQuickCommandGroup`                                                                                                                                           |
| 树条目 inline 按钮 | 单击树条目或条目内联按钮                                   | 执行单个初始化步骤 / 运行·停止·收藏·定位任务 / 移除收藏                                                                                  | `runInitStep` `runWorkspaceTask` `stopWorkspaceTask` `addTaskToFavorites` `removeTaskFromFavorites` `locateTaskInTasksJson` `removeFavorite`                                                                                                                                                                                                                                    |
| 树条目右键菜单     | 右键任务 / 收藏条目 / 快捷命令与分组                       | 运行 / 停止 / 收藏 / 定位 / 打开 tasks.json；收藏打开·显示·复制路径·重命名·移除；快捷命令执行·编辑·改名·移动·复制·删除 + 分组重命名/删除 | `runWorkspaceTask` `stopWorkspaceTask` `addTaskToFavorites` `locateTaskInTasksJson` `clearRecentTasks` `openFavorite` `revealFavorite` `copyFavoritePath` `renameFavorite` `removeFavorite` `executeQuickCommand` `editQuickCommand` `renameQuickCommand` `moveQuickCommandToGroup` `copyQuickCommand` `removeQuickCommand` `renameQuickCommandGroup` `removeQuickCommandGroup` |
| 编辑器右键菜单     | 选中文本右键（登记 / 追加 / 复制）；无选区右键（登记文件） | 选中文本一键入草稿箱；补充最近草稿；登记 / 复制 / 收藏当前文件                                                                           | `draftSelection` `appendDraftSelection` `draftFile` `copySelection` `addFavorite`                                                                                                                                                                                                                                                                                               |
| 资源管理器右键菜单 | 右键文件（单选 / 多选批量）或文件夹                        | 登记文件到草稿箱；整个目录内容登记为一条汇总草稿；复制文件内容 / 路径；收藏文件/文件夹（多选批量）                                       | `draftFile` `draftFolder` `copyFileContent` `copyFilePath` `addFavorite`                                                                                                                                                                                                                                                                                                        |
| 编辑器标题栏       | 文件页签右上角图标按钮                                     | 对当前打开的文件做同样登记 / 收藏                                                                                                        | `draftFile` `addFavorite`                                                                                                                                                                                                                                                                                                                                                       |
| 终端右键菜单       | 终端区域右键                                               | 把终端选中（或当前）命令一键收藏为快捷命令                                                                                               | `captureTerminalSelection`                                                                                                                                                                                                                                                                                                                                                      |
| 命令面板           | `Ctrl+Shift+P` 输入 "Hello VSCode Plugin"                  | 无鼠标操作路径；「打开任务管理」弹框做增删改查；「快速打开收藏」直达                                                                     | 全部命令                                                                                                                                                                                                                                                                                                                                                                        |

> 传参约定 / `when` 子句 / i18n 等开发要点见 [开发指南 07](../开发指南/07-命令视图与i18n.md)
> 与 [开发指南 05](../开发指南/05-草稿箱与右键菜单.md)。

## 全局设置（10 项）

| 设置项                                 | 默认   | 说明                                                                        |
| -------------------------------------- | ------ | --------------------------------------------------------------------------- |
| `extStarter.runStartupTasks`           | 开启   | 激活时自动执行启动任务（初始化脚本 + 环境检测）                             |
| `extStarter.taskApiBaseUrl`            | 留空   | 任务管理 HTTP 接口基地址（GET/POST/PUT/DELETE /tasks）；留空 = 内置打桩模拟 |
| `extStarter.taskGroupWithSeparator`    | 开启   | 任务 label 按分隔符拆入虚拟文件夹分组                                       |
| `extStarter.taskGroupSeparator`        | `-`    | 任务分组分隔符                                                              |
| `extStarter.taskGroupMaxLevel`         | 5      | 分组拆层深度上限（1-15；多个分隔符逐层拆成树）                              |
| `extStarter.taskGroupStripTaskLabel`   | 开启   | 叶子任务剥掉分组前缀只显示剩余段（完整名见 tooltip）                        |
| `extStarter.taskNumLastTasks`          | 10     | 「最近运行」展示条数（1-20，存储上限恒 20）                                 |
| `extStarter.taskExpanded`              | 全展开 | 最近运行 / 收藏分组的默认展开状态                                           |
| `extStarter.quickCommandReuseTerminal` | 开启   | 快捷命令执行复用专用终端 QuickCommand（关闭则每次新建）                     |

## 数据与文件落点

| 文件                              | 说明                              | 已 gitignore |
| --------------------------------- | --------------------------------- | ------------ |
| `.vscode/ext-starter.drafts.json` | 草稿箱数据（原子写、上限 100 条） | ✅           |
| `.vscode/favorites.json`          | 收藏夹数据（原子写、上限 200 条） | ✅           |
| `.ext-starter/`                   | 环境初始化工件目录（环境快照）    | ✅           |
