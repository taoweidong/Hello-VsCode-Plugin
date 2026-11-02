# 更新日志

本项目的所有显著变更都记录在此文件中。
格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [3.1.0] - 2026-11-02

### 变更（任务树形分组默认多层，对齐 vscode-taskexplorer）

- **默认拆 5 层、上限扩到 15 层**：`taskGroupMaxLevel` 默认值 1 → 5，可选范围
  1-5 → 1-15。`a-b-c-d` 默认即展示为 `a → b → c → d`，无需手工调深度；显式设
  `1` 仍可回退单层（`a-b-c` → `a → b-c`）。
- **短名按分段重拼**：连续分隔符（`a--b---c`）只忽略空段，叶子显示名不再残留
  多余的 `-`；多字符分隔符（如 `--`）按整串正确拆分。
- 测试：新增 5 例分组用例（显式单层 / 15 层钳制 / 连续横线 / 多字符分隔符 /
  混合深度），并改写默认分组用例为多层断言；宿主 E2E 适配默认多层，补
  `maxLevel=1` 配置覆盖断言。
- 文档：功能介绍、开发指南与设置说明同步新默认值与多级示例。

## [3.0.0] - 2026-11-01

### 变更（破坏性 · 项目与扩展改名）

- **项目与扩展更名**：GitHub 仓库 `vscode-starter-template` → `Hello-VsCode-Plugin`；
  扩展 ID `your-publisher.vscode-starter-template` → `your-publisher.hello-vscode-plugin`；
  品牌名统一为 **Hello VSCode Plugin** / **Hello VSCode 插件**（活动栏容器、命令
  分类、配置标题、输出通道、README 与全部文档及操作配图）。
- **升级注意**：扩展 ID 变更无法原地升级——旧版本（2.x）需先卸载再安装本版本。
  内部 ID 前缀 `extStarter.*` **保持不变**（命令 / 视图 / 配置 / 存储键全部兼容），
  用户设置与数据无缝沿用。
- package.json 的 name / repository / homepage / bugs / keywords 同步更新，
  package-lock 同步；README、agent.md、操作指导（含 4 张配图）、功能介绍、
  开发指南、历史方案报告全部改名。

## [2.5.0] - 2026-11-01

### 新增（任务树形展示配置化，继承 vscode-taskexplorer）

- **6 个新设置**（`extStarter.task*`，与开源项目分组配置一一对应）：
  `taskGroupWithSeparator`（分组开关，默认开）、`taskGroupSeparator`（分隔符，
  默认 `-`）、`taskGroupMaxLevel`（拆层深度上限 1-5，默认 1）、
  `taskGroupStripTaskLabel`（叶子短名，默认开）、`taskNumLastTasks`（最近运行
  展示条数 1-20，默认 10）、`taskExpanded`（最近运行/收藏默认展开态）。
- **叶子短名**：默认剥掉分组路径前缀只显示剩余段（`a-b-c` 在文件夹 a 下显示
  `b-c`），tooltip 首行保留完整名；entry 身份恒用完整 label。
- **运行中置顶**：最近运行组内正在执行的任务自动排到最前（对齐开源
  pushToTopOfSpecialFolder；记录语义不变——仅本扩展运行成功才入列）。
- 有意保留的设计差异：三组恒显空态占位、单击即运行、不加载用户级任务。
- 测试：配置矩阵单测 8 例（开关/分隔符/深度/短名/同名并入/容量/置顶/展开态，
  taskExplorer 共 96 例）；E2E 断言默认行为 + 配置改深度下钻（宿主 19 passing）；
  设置变更触发全树重建（单飞 refresh）。文档设置表同步。

## [2.4.0] - 2026-11-01

### 变更（任务管理器体验优化）

- **任务树形分组**：工作区任务组的任务 label 按 `-` 分段展示为虚拟文件夹树
  （`a-b-c` → a → b → 任务；叶子保留完整 label，三组展示一致、可检索）；
  任务名与文件夹同名时并入该文件夹，空段忽略；最近运行 / 收藏保持平铺。
- **视图排序与默认折叠**：「任务管理器」移到活动栏视图组最顶端，其余四个视图
  默认折叠（`visibility: "collapsed"`，VS Code 1.48+ 支持；用户手动展开后由
  编辑器记忆状态）。
- **修复「取消收藏」图标不显示**：清单里使用了不存在的 codicon `$(star-filled)`
  （codicon 集只有 `star` / `star-empty` / `star-full` / `star-half`，写错时按钮
  静默不显示），改为 `$(star-full)`。
- 测试：新增树形分组单测 3 例（分层 / 同名并入 / 空段忽略，taskExplorer 共 91 例）
  - E2E 适配虚拟文件夹下钻（宿主 19 passing）；功能介绍图标速查表与开发指南坑位
    同步。

## [2.3.0] - 2026-10-31

### 新增（TaskExplorer 任务管理器，10 方案落地）

- **侧边栏「任务管理器」视图**：只加载工作区 `.vscode/tasks.json` 定义的任务
  （`fetchTasks()` + `source === 'Workspace'` + 文件夹 scope 过滤；用户级 /
  `.code-workspace` / 扩展 provider 任务不出现）。树顶部固定「最近运行 → 收藏 →
  工作区任务」三组（空组显示「暂无」占位）；单根为 `tasks.json → 任务`，
  多根为「文件夹 → tasks.json → 任务」。
- **任务操作**：单击/行内/右键运行（`executeTask` 原生对象，`dependsOn` /
  `dependsOrder` 由 VS Code 任务引擎编排，依赖任务不污染最近运行）、运行中停止
  （扫描 `taskExecutions` 实时判定，图标转圈 + 按钮切换）、收藏/取消收藏、
  定位到 tasks.json 的 `label` 行（内置轻量 JSONC 扫描，注释/转义/重复 label
  容错，未命中降级打开顶部）；视图标题栏刷新按钮 + 文件 watcher（300ms 去抖）+
  工作区/信任变化自动刷新。
- **最近运行 / 收藏持久化**：只存任务身份（文件夹 + 来源 + 名称）到
  `workspaceState`，按工作区隔离、跨窗口恢复；最近运行展示 10 条（存 20）、
  收藏不限量；读取校验失败重置并告警、写失败内存继续生效；失效条目隐藏但保留，
  任务恢复后自动出现；「清空最近运行」模态确认且不影响收藏。
- **受限模式**：空态文案「受限模式下不加载任务」，运行命令前置 `isTrusted` 拦截，
  授予信任后自动加载。
- 8 条新命令（`extStarter.refreshTaskExplorer` 等）；不新增运行时依赖。

### 测试与工程化

- 新增 7 个单测文件 88 例（过滤矩阵 / 持久化校验 / JSONC 扫描边界 / 事件去抖 /
  三组树 / 图标三级判定 / 控制器编排 / 命令注册），`taskExplorer/**` 纳入覆盖率
  统计（行 99% / 分支 93%，阈值 90/85）；测试桩补 `tasks` API、`Task` 执行类、
  `Position/Range/Selection`、假文本文档与 watcher 句柄。
- **宿主 E2E 全流程 suite（真实 fetchTasks + 真实扩展命令，19 passing）**：临时
  改写仓库 `tasks.json` 注入 8 条多类型任务（shell/process/build/test 分组/
  dependsOn/Unicode 标签/注释噪声），断言任务发现与排序、三组树结构、真实运行 →
  运行态转圈 → 真实停止 → 状态恢复、定位命中 label 行（注释噪声不误命中）、
  收藏与最近运行分组；测毕自动恢复原文件。实测发现并修正两处真实宿主语义差异：
  分组比较须用 `group.id`（对象形式分组经 API 返回非单例）、全流程面板用例的
  创建竞态补轮询等待。
- 任务条目**图标优化**：按「运行态 > 分组 > 类型」三级判定——shell → `terminal`、
  process → `gear`、npm 等包脚本 → `package`，build/test 分组仍为 `tools`/`beaker`，
  运行中统一 `sync~spin`。
- 宿主集成 Task Explorer suite：8 命令注册断言 + 仓库 `npm: compile` 任务的
  `source/scope` 过滤假设实证（M0/R1）。
- 文档：功能介绍 07（含图标速查表）、开发指南 09（含 E2E fixtures 方式与
  `group.id` 坑）、docs 索引与根 README 功能表同步。

## [2.2.3] - 2026-10-25

### 修复（全量代码检视整改）

- **草稿箱数据完整性**（三处实测缺陷）：selection 草稿此前只存 40 字摘要——
  现保存**完整文本**（`content` 字段，64K 上限并显式标记截断）；所有变更改为
  **串行化「重读磁盘 → 变更 → 原子写」**（并发登记不丢条目、多窗口/手改不被覆盖）；
  损坏文件先复制 `.bak` 备份再按空数据继续（对齐 serverStore）。
- **环境初始化 inline ▶ 按钮失效**：`view/item/context` 传入树节点对象而命令只认
  字符串，单击内联按钮会误落 QuickPick——现归一化 `{ id }` 后直接执行该步骤。
- **拷贝命令失败静默回归**：剪贴板写入统一 try/catch → `showError`；全部文件被跳过
  时提示「未复制任何文件」（不再出现「已复制 0 个文件」）。
- **构建控制台真实接口失败路径**：提交成功后列表刷新失败不再判为提交失败
  （防假失败重复提交）；轮询失败记日志并向页面下发 error；HTTP 请求加 10s 超时
  （避免挂起请求使提交态永久锁定）。
- **探针超时预算**：单命令 8s → 6s（最坏 8 条候选 = 48s，低于任务超时 60s）。
- 环境快照按 `taskId=environment` 选取（原 `at(-1)` 在任务注册表扩展后可能取错）；
  单探针刷新日志不再伪造「耗时 0ms」；legacyMigration 新节名改用 `CONFIG.section`；
  迁移失败记日志（不再产生未处理拒绝）。

### 工程化

- 打包净化：`.vscodeignore` 排除 `.ext-starter/**` / `package.bat` / `tsconfig.node.json`，
  门禁第 ⑨ 步黑名单同步拦截；`.prettierignore` 修正遗留 `.crud-starter` 条目；
  删除已删文件 `buildService.ts` 的 eslint 豁免；门禁 --fast 提示语明确「第 ⑧ 步」。
- 测试：草稿箱 11 例（全文/截断/并发/外部修改/损坏备份）、构建面板失败路径 6 例、
  inline 步骤归一化、剪贴板失败可见化；README 目录树/协议分支数同步。

## [2.2.2] - 2026-10-25

### 变更

- **分支编译弹框宽度优化（用户实测反馈）**：宽度变体 `form`（560px 居中）→ `full`，
  主区占面板 ~95%；双卡片栅格布局——宽面板下「提交构建」表单卡与「构建任务」列表卡
  并排（5 : 7），窄面板（≤1000px）自动堆叠。e2e 同步断言主区 ≥90% 视口宽 + 双卡片并排。

## [2.2.1] - 2026-10-25

### 新增（真实环境全流程 E2E）

- **真实宿主全流程测试套件**（集成测试，随门禁第 ⑧ 步常驻）：在真实 VSCode 中
  黑盒验证「真编辑器选区 → 真剪贴板」「真临时文件 → 剪贴板（多选批量）」
  「草稿箱右键登记 → 真实落盘 → 追加 → 内容断言」「分支编译弹框面板 + 刷新」。
- 集成宿主改为**打开仓库根作为工作区**（`runTest.ts` launchArgs）——草稿箱等
  「工作区数据落盘」流程需要真实 workspaceFolders；测试自清场（数据文件与
  原子写临时残留）。
- 命令返回诊断结果对象（`executeCommand` 透传 handler 返回值）：真实环境
  全流程断言不再依赖 toast 捕获，也是「可测试命令」的示范。

### 修复

- **草稿箱命令失败不再静默**：`draftSelection` / `appendDraftSelection` /
  `draftFile` 原为 `void promise.then(...)`——异步失败完全不可见（真实环境
  排障中实测踩坑），现统一 `.catch(showError)` 如实呈现。

## [2.2.0] - 2026-10-25

### 新增

- **拷贝示例命令组**（`copyCommands.ts`，命令 17 → 20）：右键把内容「拷贝出来」到
  剪贴板，与草稿箱「落盘」形成对照的最基础示例——
  - 编辑器右键「复制选中文本」（精确复制选区，反馈含字符数）；
  - 资源管理器右键「复制文件内容」（多选批量以 `=== 路径 ===` 分隔；1MB 大小上限、
    NUL 字节二进制防护、失败逐个警告不中断）；
  - 资源管理器右键「复制文件路径」（多选每行一个）。
- i18n 双语文案随命令同步；开发指南 05 补充拷贝示例说明。

## [2.1.3] - 2026-10-25

### 变更（样式缺陷系统性封堵：v2.1.2 教训沉淀为两道永久防线）

- **门禁逐页 CSS 链校验**（`scripts/checks/manifest.ts` 第 ⑥ 步）：每个 Webview 页面的
  CSS 收集链（入口 + imports 递归，与 assetResolver 同构）必须包含设计令牌
  （tokens.css）与 codicon 字体样式，缺失即红并给出修复指引。已反向验证：
  移除 tokens 导入后门禁精准拦截。
- **e2e 样式生效统一防线**（`helpers.loadPage`）：所有页面加载后断言 `--ui-border`
  令牌已生效（判据用令牌存在性而非宽度——AppShell 有 full 全宽变体，宽度不可靠；
  harness 主题注入只写 `--vscode-*`，无混淆）。

### 排查结论

- 全量核查三个页面（gallery / serialConsole / buildConsole）的构建产物 CSS 链：
  tokens 与 codicon 均 ✅ 可达——**除 buildConsole（v2.1.2 已修）外无其他页面受影响**。

## [2.1.2] - 2026-10-25

### 修复

- **分支编译页面样式完全丢失（裸文本）**：`buildConsole/main.ts` 漏 import
  `tokens.css`——全部 `var(--ui-*)` 令牌落空，按钮透明 / 卡片无边框 / 宽度不限
  （gallery / serialConsole 均有该导入，新页面遗漏；e2e 只断言字体与 DOM，测不出
  CSS 缺失的盲区）。

### 变更

- **弹框布局重设计（双卡片结构）**：「提交构建」表单卡与「构建任务」列表卡视觉分离
  （卡片边框 / 表面 / 小节头 / 发丝线分隔）；刷新按钮移入列表卡头（归属它刷新的数据）；
  任务条目增加状态色点与**进度条**（`--ui-progress` 令牌）；错误反馈条卡片化。
- e2e 新增**样式生效断言**（AppShell 宽度受限 + 卡片边框 solid），补上 CSS 收集链
  断裂无法被测试捕获的盲区。

## [2.1.1] - 2026-10-25

### 修复

- **面板打开失败不再静默**：`WebviewController.createOrShow` 此前 `void open()` 会吞掉
  面板创建 / 资源装配的异常——命令执行成功但界面无任何反应（排查实测的「点了没反应」
  温床）。失败现在经日志与错误提示如实呈现，并清理死控制器。
- **构建任务树视图事件驱动刷新**：弹框提交成功后即时刷新侧边栏（此前依赖 3s 轮询，
  最长延迟 3s 才出现新任务）。

### 测试

- 新增宿主集成冒烟：`buildBranch` 执行 → 真实 tabGroups 出现面板标签页 →
  `buildRefreshTasks` 可执行（经公开 API 断言——测试进程与扩展 bundle 是两个模块
  实例，不能查内部注册表；测试宿主的 `Tab` 不暴露 viewType，按 label 兼容匹配）。

## [2.1.0] - 2026-10-25

### 新增

- **恢复「构建任务」树视图**（分支编译侧边栏入口）：v2.0 纯弹框改造丢失了活动栏
  可见入口（实测回归）。视图数据与弹框页同源（同一 BuildApiClient：打桩内存表 /
  真实 HTTP 接口），任务条目展示分支 / 状态图标（构建中旋转）/ 进度 / 类型，
  单击打开弹框；标题栏「打开控制台 / 刷新」按钮找回 view/title 菜单示例。
- **可见期轮询**：`onDidChangeVisibility` 门控（视图隐藏即停，不空转打真实接口），
  初始可见性显式处理；标题栏新增 `buildRefreshTasks` 刷新命令（命令 16 → 17）。
- 空态与拉取失败以 info 节点呈现（失败保留旧数据不清空）。

## [2.0.0] - 2026-10-25

### 变更（破坏性）

- **分支编译重构为 Webview 弹框**：表单填写（分支名 / 构建类型 / 备注）→ 提交 HTTP
  接口创建构建任务 → 轮询拉取任务列表展示（状态徽标 / 进度 / 3s 轮询）。
  原 `buildView` 树视图与本地 git 流水线（`BuildService`：脏检查 / git checkout /
  `npm run package` / vsce 打包，559 行）整体退役；`buildBranch` 命令改为打开弹框
  （命令面板入口）。视图 4 → 3、页面 2 → 3、菜单 23 → 21、配置 2 → 3。

### 新增

- **构建任务 HTTP 客户端抽象**（`buildApiClient.ts`）：`baseUrl` 留空（默认）=
  `StubBuildApiClient` 打桩模拟（内存任务表 + 定时器推进 queued → running →
  success/failed，确定性失败规则：分支名含 fail）；配置
  `extStarter.buildApiBaseUrl` 切换 `HttpBuildApiClient`（POST/GET /builds，
  Node 20 全局 fetch）——真实服务端契约 = `BuildSubmitPayload` / `BuildTask`。
- 协议新增 `buildList` / `buildListRequest` 分支（24 条）与 `BuildTaskWire` 线类型；
  构建表单经 `BUILD_FIELD_DEFS` 字段表驱动（SchemaForm）。

### 移除

- `DEFAULT_DIRTY_IGNORES` 脏检查机制随 `BuildService` 退役（工作区数据文件仅保留
  `.gitignore` 防护）；`extStarter.buildBranch` 不再有 view/title / inline 菜单入口。

## [1.0.0] - 2026-10-24

### 变更（破坏性）

- **项目定位收敛**：按 09 方案从「CRUD 演示集合」重构为「Hello VSCode 插件」——
  删除条目 / 特性配置 / 静态配置三视图及全部相关代码（7→4 视图、37→16 命令、
  42→23 菜单条目、2 子菜单与 2 快捷键清零、8→2 配置项），源码 −33% / 测试 −40%。
- **ID 前缀迁移**：`crudStarter.*` → `extStarter.*`（命令 / 视图 / 配置 / 存储 / Secret 键），
  旧版设置与 Memento 数据在激活时自动迁移，SecretStorage 密码惰性搬迁；
  用户自定义 keybindings / when 条件需手动更新。

### 新增

- **启动脚本**：VSCode 窗口加载完成即自动执行（`onStartupFinished`，无需打开文件夹或交互）——
  初始化脚本「Hello World」+ 环境检测（含 Python 版本检查），过程打印输出通道；
  扩展接口：实现 `StartupTask` 接口并在 `taskRegistry.ts` 的 `TASKS` 数组加一项。
- **环境探针注册表**（`probes.ts`）：Python/Node/npm/Java/Git，新增语言 = 加一条数据；
  树视图单击探针条目可单独重检。
- **草稿箱**：8 条右键入口（编辑器 / 资源管理器 / 标题栏）统一落盘
  `.vscode/ext-starter.drafts.json`（原子写、上限 100 条）。
- **i18n**：manifest 文案外置 `package.nls.json` / `package.nls.zh-cn.json`（27 键）。
- **打包**：`npm run package:vsix` 跨平台归档到 `release/`（纯 Node 脚本）+
  Windows 双击入口 `package.bat`。

### 修复

- **Webview 图标全不显示**：vite `base: './'` 根治 CSS 内字体 404；
  门禁新增「产物 CSS 禁止站点根绝对引用」红线，e2e 改 `/webview/**` 子路径路由 +
  字体加载断言，消除 harness 假绿。
- 分支编译脏检查默认忽略串口数据文件，修掉「用过串口 → 分支编译永远自阻断」。

### 工程化

- 目录收敛 `src/extension/`（宿主侧）与 `src/webview/`（跨侧契约仅 protocol.ts）；
  tsconfig 三段拆分；门禁前缀改动态读取；宿主 bundle 83.5 → 66.4 KB。

## [0.7.0] - 2026-10-24

### 新增

- **串口命令控制台**（superpowers 方法论驱动设计，规格见
  `docs/superpowers/specs/2026-10-24-serial-command-console-design.md`）：
  - 服务器信息录入：侧边栏「串口服务器」树视图 + 控制台页内 Schema 表单
    （名称 / 串口 / 波特率 / 数据位 / 停止位 / 校验位 / 流控 / 命令换行符 / 自动登录 / 备注），
    数据存工作区 `.vscode/serial-servers.json`（原子写 + 损坏自动备份），
    登录密码仅存 VSCode SecretStorage（数据文件与日志零明文）。
  - 串口命令下发：本机 COM 口（serialport@12，N-API 预编译跨平台），状态机驱动，
    输出 40ms 批处理防消息洪泛，换行符按服务器配置追加，连接中可取消（代际守卫），
    面板关闭自动断开；可选自动登录按时序发送凭据（凭据不进命令历史）。
  - 历史命令（自动去重）：trim 精确匹配去重、MRU 置顶、useCount 累计、上限 200 条淘汰，
    页面支持搜索 / 单击填入 / 双击直发 / 单条删除 / 清空。
  - 实时输出：控制台流式渲染（自动滚动可暂停、缓冲裁剪、清空、发送本地回显）。
  - 独立页面与菜单：`serialConsole` Webview 页面 + 6 个命令 + 树视图右键 / inline 菜单 +
    `crudStarter.features.serialConsole` 特性开关。
- **方法论资产**：安装 superpowers 技能集至 `~/.zcode/skills/`；设计规格与实现计划
  落盘 `docs/superpowers/{specs,plans}/`。

### 工程化

- **首个生产依赖 serialport@^12.0.0**：esbuild external + `.vscodeignore` 否定项随 vsix
  分发全平台 prebuild（vsix 约 2.5 MB）；门禁第 9 步升级为含依赖黑白名单 + prebuild
  存在性校验 + 20 MB vsix 体积预算。
- `deriveFormSchema` 参数化为通用字段表（条目 / 服务器领域共用，条目行为回归锁定）；
  WebviewController 新增 `onDispose` 钩子（面板销毁释放会话资源）。
- E2E：harness 页面注册表补 `serialConsole`；新增串口控制台 3 个用例（17 个全绿）。

### 工程化（M6 · 工程化与文档收口）

- **ESLint + Prettier**：flat config（`eslint.config.ts`，@eslint/js + typescript-eslint 推荐 +
  eslint-plugin-vue vue3-recommended + eslint-config-prettier，jiti 加载）；`.prettierrc` /
  `.prettierignore` 按现有风格（单引号 / 无分号 / printWidth 100 / 尾逗号 es5）；全量一次性
  格式化（139 文件，行为不变）；`npm run lint` / `npm run format:check` 全绿，定向规则豁免
  在配置内逐条注明原因。
- **门禁重构（P1-14 收口）**：步骤重排为 8 步（① lint/格式 → ② 类型 → ③ 宿主构建 →
  ④ Webview 构建 → ⑤ 测试编译 → ⑥ 静态一致性 → ⑦ 单测+覆盖率阈值 → ⑧ 宿主集成，--fast
  跳过⑧）；静态检查去硬编码——删除项目名 / repository 身份断言，「视图数 ≥ 6」改为
  constants VIEW ↔ manifest 双向结构校验 + 菜单 `view == xxx` 目标存在性；命令提取正则支持
  数字与连字符；**新增**命令注册检查（清单 ↔ `register(COMMAND.xxx`）与特性开关一致性
  （FEATURE_FLAGS key+defaultValue ↔ `crudStarter.features.*` 双向）与图标存在检查；
  `FORM_SCHEMA` 数量须与 `ITEM_FIELD_DEFS` 一致（派生约束进门禁）；改名实验通过。
- **CI（E1）**：`.github/workflows/ci.yml`——windows-latest 跑完整 gate + `test:e2e`
  （Playwright 用自带 Edge），ubuntu-latest 跑 `gate -- --fast`；Node 20 + `npm ci` +
  `.vscode-test` 缓存（key 含 lockfile 哈希）；PR 与 main push 触发，并发组取消旧跑。
- **发布元数据（E2/E3）**：LICENSE（MIT）；`scripts/generate-icon.ts`（Playwright msedge
  截图 SVG → 128×128 PNG）生成 `media/icon.png`；`package.json` 补 `license` / `icon` /
  `categories` / `homepage` / `bugs`；`.vscodeignore` 增补 tests/ 测试产物；README docs
  链接改绝对 URL（Marketplace 0 404）；`vsce package --no-dependencies` **零警告**
  （263.73 KB / 52 文件）。
- **测试修复（P1-13 收口）**：「getGitInfo 识别 main」改为 os.tmpdir 临时 git fixture
  （init + commit + 建分支，finally 清理），不再依赖本仓库分支状态；环境检测用例改语义
  断言（Node.js 必检到，Python/Git 状态 ∈ {ok, missing}）。
- **formSchema 领域派生**：`FORM_SCHEMA` 由 `ITEM_FIELD_DEFS`（`src/domain/itemSchema.ts`）
  经 `deriveFormSchema` 派生（datalist 等 UI 附加属性以声明式表叠加，不污染领域定义），
  「加字段 = 领域 Schema 一处（模型类型可选）」正式收口；配套单测（含「加字段自动出现」
  与一致性锁定）。
- **P1-08 作用域修复**：`setFeatureValue` 写入前 `inspect()` 检查工作区覆盖——有覆盖写
  Workspace（与生效来源一致，修复「点击开关无反应」），无覆盖维持 Global；配套单测。
- **覆盖率阈值**（实测：整体 93.2L/88.85B/94.06F/93.36S）：整体 92L/87B，services 90L/85B、
  models 95L/93B、domain 81L/73B（`coerceBooleanField` 为预留路径，接入 boolean 字段后可
  提至 85+）、protocol 100；`vitest run --coverage` 进门禁，阈值失败即红。
- **模型去 Node 依赖**：`createId` 改用 `globalThis.crypto.randomUUID()`（Node ≥ 20 内建
  全局），models 不再 import `crypto` 模块——领域 Schema 可被 Webview 类型程序
  （types:[]）安全引用，支撑 formSchema 派生。
- **文档一致性（D1–D10 清零）**：README（表单面板 Vue 3 / 领域 Schema 加字段流程 /
  getStore 换源说明 / 目录树补 domain / 下载体积统一实测约 1GB / UI 约定表补设计系统
  基线行）；agent.md（门禁 8 步 / 硬性规约第 2 条改领域 Schema + Vue 组件化 / 架构图补
  domain 与 webview）；操作指导 03（加字段一处 / 测试分层动态描述 / 阅读顺序补
  domain+webview）；02 全部 P0/P1 标 ✅、W/C 组与 E1/E2/E3/E5 标注修复、遗留项（E4/E6/
  E7/E8、T1–T5）保留；05 里程碑与任务表加完成标记 + M6 偏差说明。

### 新增（M2 · 单元测试基建与工具链）

- **全量单元测试层**：Vitest + jsdom + `vscode` 测试桩（`src/test/unit/stubs/vscode.ts`，
  EventEmitter / window 录制器 / workspace.fs / getConfiguration / watcher 桩），
  `npm run test:unit` 不启动 VSCode、全量 < 10s（210+ 用例）；覆盖率阈值进入配置。
- **一键打包离线 .vsix**：`npm run package:vsix`（`@vscode/vsce` 内置 devDependency，
  免全局安装）；`.vscodeignore` 目标态（排除 scripts / agent.md / 配置文件）。
- **构建脚本 TypeScript 化**：`esbuild.js` → `scripts/build-extension.ts`、
  `gate.js` → `scripts/gate.ts`（fail-fast + `--fast` 跳过宿主集成；静态检查拆分至
  `scripts/checks/manifest.ts`），统一经 `tsx` 执行；源码树不再包含 JS 脚本。
- **agent.md 单元测试协议**：每轮对话结束 / 提交前必须执行并通过单元测试
  （日常 `test:unit`，收尾完整 `gate`）；新增代码测试先行。
- 开发环境 Node 要求提升至 ≥ 20.19（Vite 7 / Vitest 5 工具链）。

### 新增（M2/M3 · Vue 3 Webview 底座与 VSCode 原生设计系统）

- **Vite + Vue 3 管线**：`vite.config.ts` 多入口（页面注册表 `src/webview/pages.ts`
  单一来源）+ manifest + runtime-only Vue + 严格 CSP（无 unsafe-eval/unsafe-inline）。
- **Webview 宿主框架**：`webviewController`（单例面板 / 幂等 dispose / dirty 确认 /
  10s 提交超时 / serializer）、`webviewHtml`（CSP 外壳纯函数）、`assetResolver`
  （manifest 资源解析）、`protocol.ts`（双向消息判别联合 + 运行时守卫）。
- **VSCode 原生设计系统**：`ui/tokens.css` 语义令牌全表（--ui-* → --vscode-*）+
  12 个基础组件（VButton/VInput/VTextarea/VSelect/VCheckbox/VFormField/VToolbar/
  VEmptyState/VLoading/VBadge/AppShell 等，零硬编码颜色，间距 4/8/12/16/24）+
  codicon 图标统一 + **组件画廊页面**（gallery，全部组件 × 状态）。
- 4 个页面入口就位（itemForm / featureConfig / importWizard / gallery，前三者为
  M4 迁移占位）；Webview 单页 JS+CSS 远低于 200KB 预算。

### 修复（M1 · 数据可靠性，P0 三连）

- **数据文件损坏不再自动移走/清空**：解析失败时复制备份（.corrupt-*.bak，原文件
  留在原地）并弹窗三选（以空数据继续 / 打开原文件 / 取消）；IO 错误不再误判为损坏；
  备份失败显式报错。
- **原子写**：临时文件 → 读回校验 → rename 替换；任何失败原文件保持不变。
- **storagePath 路径白名单**（P0-03）：拒绝绝对路径 / `..` / glob 字符 / 非 .json，
  必须位于工作区内；非法时回退默认路径并警告；配置 scope 收紧为 machine。
- **加载校验与迁移**：条目运行时守卫 + 默认值补齐 + 重复 id 处理 + 坏条目隔离上报；
  存储格式升级为 `{schemaVersion:2, items}`（旧数组自动迁移）；BOM 容错。
- **并发与生命周期**：loadPromise 单飞、写操作串行队列、保存成功才提交缓存（失败
  回滚重读）、reload generation 防竞态、watcher 300ms 防抖 + 自写抑制 + 删除事件
  不清空数据、StorageController 在工作区/配置变化时重建 store 与 watcher
  （service 实例稳定，命令引用不失效）。
- 新增单元测试 100+ 例（路径矩阵 / 损坏恢复 / 原子写 / 迁移 / 并发 / watcher /
  生命周期）；含 3 例 `it.fails` 哨兵（「加字段全链路不丢」，M5 领域 Schema 修复后转绿）。

### 新增（M4 · Vue 3 页面迁移与命令层）

- **三个 Webview 页面全部 Vue 3 化**：条目表单（新增/预填/编辑回填）、特性配置
  （开关列表）、批量导入向导（多步骤）；`SchemaForm` + 五类字段组件由 init 消息
  携带的 Schema 驱动；旧字符串渲染器 `formHtml.ts` **删除下线**。
- **表单体验**：草稿持久化（`setState` 500ms 防抖 + 恢复提示 + 丢弃按钮）、dirty
  上报与切换目标模态确认、窗口重载 serializer 恢复、提交在途禁用 + 10s 超时恢复、
  校验错误按字段定位（aria-invalid + role=alert）、IME 组合期不误触 Esc/Ctrl+Enter。
- **批量导入向导（新页面）**：来源选择（浏览对话框）→ 预览去重（同名标注、上限
  50）→ 分批执行（每批 ≤20，进度 + 取消即停保留已完成）→ 结果汇总；资源管理器
  右键「将文件夹内容登记为条目」升级为打开向导并预填路径。
- **命令层清理**：批量删除/设优先级走 `removeMany/updateMany`（单次写盘，missing
  如实报告）；编辑/追加/改优先级基于最新数据（消灭树节点旧快照丢更新）；「更多
  操作」真动态化（优先级标注当前值）并统一删除确认开关；`runInitStep/toggleFeature`
  无参 QuickPick 引导；build warn 有反馈；剪贴板异常捕获；Markdown 复制转义；文件
  摘录 1MB/二进制防护；文件入口拒文件夹；选择器列出全部条目并标注过滤状态；
  「打开数据文件」按当前数据源类型给出准确文案（动态获取 store）。
- 门禁更新：新增 Webview 构建（vite build）步骤；静态一致性检查改为校验
  `dist/webview/.vite/manifest.json` 与页面注册表入口一致。
- 新增组件/页面/面板测试 105 例。

### 新增/修复（M5 · 承诺兑现与生命周期）

- **领域 Schema 单一来源**（`src/domain/itemSchema.ts`）：`coerceDraft / toDraft /
cloneDraft / applyPatch`；未知字段透传——「加字段」在表单渲染、校验、克隆、追加、
  落盘往返全链路不再丢字段（**P0-04 关闭**，3 个哨兵用例转绿）。
- **ItemService 批量 API**：`createMany / updateMany / removeMany`（单次读盘/写盘/
  事件，事务语义，任一失败整体不写盘）。
- **任务框架生命周期**：`TaskContext`（输出通道/工作区根/取消信号）+ 每任务超时 +
  逐任务进度事件 + 结果形状校验 + try/finally（异常不再永久忙）；环境探测修正
  「err 非空即失败」。
- **环境初始化**：单步与全部执行互斥、步骤超时、环境快照复用启动任务最近结果。
- **分支编译**（**P0-05 / P1-09 / P1-10 关闭**）：Workspace Trust 守卫 +
  `capabilities.untrustedWorkspaces: limited` 声明；构建互斥；全流程进度与取消
  （spawn 参数数组、shell:false，Windows 下 npm 经固定常量 cmd 包装）；分支名改用
  `git check-ref-format` 校验；脏检查排除插件自身数据文件与 `.crud-starter/`；
  切换分支前模态确认「将停留在目标分支」，失败附恢复指引。
- 新增单测 68 例；宿主集成测试 28 例全绿。

### 文档

- **docs/需求与优化方案/**：五篇方案文档——
  - `01-需求细化`：目标体系 G1-G6、功能需求 FR-01~FR-17、非功能 NFR-01~NFR-13，
    逐条 Given/When/Then 验收标准与追踪矩阵；
  - `02-现状差距与缺陷分析`：P0×5 / P1×17 / P2 30+ 缺陷清单（含 file:line 证据）、
    需求达成度矩阵、文档偏差表 D1-D10、根因与风险矩阵；
  - `03-技术选型与架构`：13 条 ADR、目标架构与目录、Vite+esbuild 双构建、
    CSP 矩阵、消息协议、三层测试架构、一键 VSIX 打包设计；
  - `04-VSCode原生设计系统`：语义令牌全表、组件规格与状态矩阵、组件画廊、
    样式门禁规则；
  - `05-优化方案与路线图`：M1-M6 任务清单（文件/验收/测试/工期）、DoD、
    测试矩阵、度量指标、第一周执行清单。
- **技术决策（已确认）**：TypeScript 全量化；Webview 页面全部迁移 Vue 3
  （runtime-only + Vite 多入口）；组件视觉对齐 VSCode 原生（语义令牌 + 自研轻量
  组件库，不引入通用 UI 框架）；6 个原生 TreeView 保持 VSCode Extension API。
- **agent.md**：新增「单元测试协议（强制）」——每轮对话结束 / 代码提交前必须执行
  并通过单元测试（现阶段以 `npm run gate` 为执行出口，M2 引入
  `npm run test:unit` 后切换）；新增代码必须优先补充单元测试，修复 bug 先写
  复现用例；测试不得跳过或伪造通过。
- 计划内（M2 落地）：`npm run test:unit`（Vitest 单元 / 组件测试，不下载 VS Code，
  目标 < 30s，含覆盖率阈值）；`npm run package:vsix`（一键打包离线 .vsix，
  `@vscode/vsce` 内置 devDependency，免全局安装，门禁含 `vsce ls` 内容校验）。
- 主 README 与操作指导索引增加方案入口。

## [0.6.1] - 2026-10-01

### 新增

- **docs/操作指导/** 操作指导目录：
  - `01-环境准备与代码下载`：前置软件清单、克隆/ZIP 两种获取方式、依赖安装、
    门禁验证与常见问题；
  - `02-开发与调试步骤`：F5 调试全流程、断点与调试控制台、六大视图体验路径、
    watch 调试循环、常见调试问题对照表；
  - `03-插件开发指南`：改身份/改模型加字段/换数据源/加命令视图/扩展启动任务/
    门禁与测试/打包发布七步法；
  - 目录索引 + 8 张 VSCode Dark+ 风格 SVG 示意图（GitHub 原生渲染）。
- 主 README 增加操作指导导航；`.vscodeignore` 排除 `docs/**`（不打入 .vsix）。

## [0.6.0] - 2026-10-01

### 新增

- **一键式质量门禁**：`npm run gate` 依次执行类型检查 → 生产构建 → 测试编译 →
  静态一致性检查（package.json 清单 ↔ constants ↔ 视图 when ↔ 表单渲染运行时验证，
  内嵌于 `scripts/gate.js`）→ 全量单元测试，任一步失败即非零退出并输出失败详情。
- **agent.md**：AI 编码代理强制约定——每次对话结束前必须执行 `npm run gate` 并全部通过后
  才能提交推送；含架构分层、单一来源、Schema 驱动、UI 规约等硬性条目。
- **单元测试 18 → 26**：新增 JsonFileStore（空文件 / 往返 / 损坏自动备份）、MementoStore、
  条目树视图（分类分组 / 过滤平铺）、表单渲染器（CSP / datalist / boolean 开关）、
  分支编译服务（未打开工作区路径）。

## [0.5.2] - 2026-10-01

### 变更

- 项目更名为 **Hello-VsCode-Plugin**：GitHub 仓库、`package.json` 的 name/repository、
  文档中的项目路径同步更新；扩展内品牌（CRUD Starter 视图名 / 命令分类 / 输出通道）保持不变，
  继续描述插件自身功能。

## [0.5.1] - 2026-10-01

### 修复

- 分支编译：`git checkout` 失败不再产生未处理的 Promise 拒绝（改为记录为编译失败结果）；
  分支名增加合法性校验（防注入）并在命令中加引号；命令层补充 `.catch` 兜底。
- 环境初始化：数据文件路径改为跟随 `crudStarter.storagePath` 配置，
  修复用户自定义存储路径后初始化会在默认位置创建错误文件的问题。

### 优化

- 表单渲染器去除业务特例：`datalist` 由 Schema 字段声明（`FormField.datalist`），
  渲染器不再感知具体字段；移除未使用的 webview 参数，签名简化为 `renderFormHtml(payload)`。
- 分支编译视图的 Git 信息增加 5 秒 TTL 缓存，频繁刷新不再反复 spawn git 进程。
- 集成测试清理自身产生的临时目录，不再向系统 Temp 残留 `crud-static-test-*`。
- 工程配置：tsconfig 增加 `noFallthroughCasesInSwitch`；package.json 补充 `repository`；
  `.gitignore` 增加 `.crud-starter/`。

## [0.5.0] - 2026-10-01

### 新增

- **资源管理器右键（文件/文件夹）**：
  - 登记文件并摘录内容：右键文件创建条目，前 20 行内容自动进入描述；
  - 将文件夹内容登记为条目：右键文件夹批量创建（每个文件一条，上限 50 个，静默创建 + 通知）。
- **编辑器内容右键**：
  - 从选中文本快速新增条目：跳过表单静默创建，适合连续登记；
  - 将选中内容追加到条目：QuickPick 选择已有条目，带时间戳追加进描述；
  - 登记当前文件为条目（无选区时显示，与资源管理器登记共用同一表单流程）。
- 「登记文件」表单流程抽取为共享辅助函数，资源管理器 / 编辑器 / 标题栏三处入口统一。

## [0.4.0] - 2026-10-01

### 新增

- **四个功能页面**（活动栏「CRUD Starter」容器下，各演示一种典型插件 UI 模式）：
  - **环境初始化**（清单 + 单步动作）：5 个初始化步骤（检查工作区 / 初始化数据文件 /
    生成静态配置 / 创建产物目录 / 写入环境快照），单击执行单步或「全部初始化」，
    步骤失败不阻断后续；
  - **特性配置**（设置读写 + Schema 表单）：5 个特性开关（删除确认 / 成功通知 / 优先级图标 /
    视图徽标 / 自动刷新），树视图单击即切换；「打开特性配置页面」提供 Schema 驱动的
    Webview 批量编辑表单，保存写入 `crudStarter.features.*` 并实时生效；
  - **静态配置**（只读展示 + 文件联动）：展示工作区 `.vscode/crud-starter.config.json`
    （环境初始化可生成默认模板），文件被修改后自动刷新，可一键打开编辑；
  - **分支编译出包**（任务自动化）：展示当前分支与分支清单，单击分支执行
    `npm run package`（切换分支前强制检查工作区干净），检测到 vsce 时追加 `.vsix` 打包，
    进度通知 + 输出通道日志 + 最近一次编译结果。
- 表单框架支持 `boolean` 控件；取值 / 回填 / 必填校验改为完全 Schema 驱动，条目表单与
  配置页面共用同一渲染器。
- 新命令 6 个：全部初始化、执行初始化步骤、打开特性配置页面、切换特性开关、
  打开静态配置文件、选择分支编译出包。

## [0.3.0] - 2026-10-01

### 新增

- **启动任务框架**（`src/tasks/`）：
  - 插件激活时自动执行启动脚本，当前内置「环境检测」任务：探测 Python
    （`py -3` → `python` → `python3` 回退链）、Node.js、npm、Git 版本与操作系统、VSCode 信息；
  - 活动栏新增「环境信息」树视图：任务分组 + 状态图标（✓ 正常 / ✗ 未检测到）+ 版本号 + 耗时；
  - 结果同步写入输出通道「CRUD Starter」（视图标题栏按钮可打开）；
  - 新命令：`刷新环境信息`、`打开环境信息输出`；
  - 新配置：`crudStarter.runStartupTasks`（默认开启，关闭后仅手动执行）。
- 扩展点：后续「动作类」启动任务（初始化、同步、构建等）实现 `StartupTask` 接口并在
  `taskRegistry.ts` 注册即可，调度与视图零改动。
- 菜单修正：视图标题栏按钮增加 `when` 条件，各视图只显示属于自己的按钮。

### 修复

- 修复新增「环境信息」视图后，原条目列表的标题栏按钮（＋/🔍/↻）会同时出现在两个视图的问题。

## [0.2.1] - 2026-10-01

### 优化（UI 风格统一）

- Webview 表单：
  - 全部颜色改用 `--vscode-*` 主题令牌（含占位符、错误背景、按键提示），自动适配深浅色与高对比度主题；
  - 单栏 560px 居中布局，标题区 + 分隔线 + 副标题（新增/编辑文案区分）；
  - 字段级校验状态：出错字段红框 + 行内错误提示，输入即清除；
  - 主按钮右置（与 VSCode 模态对话框一致），保存期间禁用防重复提交；
  - 底部新增键盘提示（`Esc` 取消 / `Ctrl+Enter` 保存），打开表单自动聚焦名称字段。
- 图标语言全局统一：优先级 codicon（arrow-up/dash/arrow-down）抽取为共享模块，
  树视图、QuickPick 选择列表、tooltip 三处使用同一映射；tooltip 同步加入 codicon。
- QuickPick：选择列表带优先级图标、描述取首行；「更多操作」动态菜单按
  条目操作/优先级/复制/危险操作分组（与右键菜单分组同构），并补充「复制名称」项。
- 反馈闭环补齐：新增/更新成功后 toast 提示，与删除/克隆的反馈格式一致（「已…」）。
- 活动栏图标微调（圆角、线宽、右下角 ＋ 提示可新增）。

## [0.2.0] - 2026-10-01

### 新增

- 菜单与右键菜单全景示例：
  - 编辑器右键菜单：从选中文本新增条目（表单自动预填，快捷键 `Alt+S`）。
  - 资源管理器右键菜单 / 编辑器标题栏：将文件添加为条目（记录文件路径）。
  - 树条目右键子菜单：「设置优先级」（高/中/低，支持批量）与「复制…」（名称/Markdown/JSON）。
  - 动态菜单示例「更多操作…」：QuickPick 实现的可编程菜单，操作后保持打开。
  - 多选批量操作：树视图开启 `canSelectMany`，批量删除 / 批量设置优先级。
  - 快捷键示例：`Alt+N` 新增条目。
- README 新增「菜单与右键菜单示例」场景对照表与菜单开发要点。

### 修复

- 树右键菜单传参归一化：右键菜单传入树节点元素而单击命令传入原始 `Item`，
  统一经 `toItem()` 归一化，修复右键「编辑/克隆」可能找不到条目的问题。

## [0.1.0] - 2026-10-01

### 新增

- 初始化插件模板：侧边栏树视图（按分类分组、优先级图标、关键字过滤、空状态提示）。
- Webview 表单面板（Schema 驱动，自动渲染字段，支持新增与编辑回填）。
- 完整增删改查 + 克隆，删除带模态确认。
- 数据源抽象 `IItemStore`，默认实现为工作区 JSON 文件；未打开工作区时退回全局存储。
- 数据文件被外部修改时自动刷新（FileSystemWatcher）。
- 服务层集成测试脚手架（`npm test`）。
