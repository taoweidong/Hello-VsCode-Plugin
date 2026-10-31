# VSCode Extension Starter（VSCode 扩展初始化模板）

一个 **VSCode 插件初始化项目（模板）**：收敛为「4 个可抄的示例 + 1 套自洽基座」——
可插拔环境探针、任务编排、HTTP 弹框对接（分支编译）、真实业务（串口控制台）四种典型模式，
配 Webview 页面框架（Vue 3）与 VSCode 原生设计系统。克隆后照着示例加功能，全程不碰基座。

> 📚 **文档总入口**：[`docs/README.md`](docs/README.md)（含「我想做什么」快速路由与文档维护约定）。
> AI 编码代理请先读 [`agent.md`](agent.md)（门禁 / 测试 / 版本号规约等强制约定）。
>
> | 文档分层        | 目录                                                    | 面向               | 什么时候读                                   |
> | --------------- | ------------------------------------------------------- | ------------------ | -------------------------------------------- |
> | 一 · 上手与调试 | [`docs/操作指导/`](docs/操作指导/README.md)             | 第一次接触项目的人 | 克隆之后、动手之前（30 分钟跑通）            |
> | 二 · 功能介绍   | [`docs/功能介绍/`](docs/功能介绍/README.md)             | 使用者 / 评估者    | 想知道「每个功能是什么、怎么用」             |
> | 三 · 二次开发   | [`docs/开发指南/`](docs/开发指南/README.md)             | 开发者 / AI 代理   | 加功能、写测试、打包（代码地图 + 实操 + 坑） |
> | 四 · 设计与决策 | [`docs/需求与优化方案/`](docs/需求与优化方案/README.md) | 想了解来龙去脉的人 | 评审设计、理解历史方案 01~09                 |
>
> 🎯 **需求与优化方案**（需求细化 / 缺陷分析 / 技术选型 / 设计系统 / 路线图）：
> 见 [`docs/需求与优化方案/`](https://github.com/taoweidong/vscode-starter-template/blob/main/docs/需求与优化方案/README.md)。
> v1.0.0 起项目由「CRUD 演示集合」重构为扩展初始化模板（09 方案），ID 前缀
> `crudStarter.*` → `extStarter.*`，旧版设置 / 数据在激活时自动迁移。

## 功能一览（5 视图 / 3 页面 / 28 命令）

| 视图       | 示例模式     | 说明（功能级开发文档见 [docs/开发指南/](docs/开发指南/README.md)）                                                              |
| ---------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| 环境信息   | ① 可插拔探针 | 探针注册表（`probes.ts`：Python/Node/npm/Java/Git）+ 系统 2 项；**单击任一探针条目单独重检**，新增语言 = 加一条数据             |
| 环境初始化 | ③ 任务编排   | 3 步骤注册表（检查工作区 / 创建产物目录 / 环境快照），单步超时裁决、互斥、失败不阻断                                            |
| （分支编译 | ③ HTTP 对接  | v2.0 已改造为 Webview 弹框（命令面板「打开分支编译控制台」），见下方页面表                                                      |
| → 弹框）   |              |                                                                                                                                 |
| 串口服务器 | ② 真实业务   | 录入串口服务器（密码进 SecretStorage）、连接下发命令、实时输出、历史 MRU 去重；串口开关在设置 `extStarter.serialConsoleEnabled` |
| 任务管理器 | ③ API 投影   | 只加载工作区 `.vscode/tasks.json` 任务：最近运行 / 收藏 / 工作区任务三组树，运行/停止/收藏/定位，`dependsOn` 交原生引擎（v2.3） |

| Webview 页面 | 说明                                                                                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 组件画廊     | 设计系统视觉验收基准（开发用），新页面的最佳抄写起点                                                                                                   |
| 串口控制台   | 真实业务页面：服务器表单（SchemaForm 驱动）/ 命令输入 / 输出流 / 历史 5 个子组件                                                                       |
| 分支编译     | HTTP 弹框示例：SchemaForm 填写（分支名 / 构建类型 / 备注）→ 提交 → 任务列表（状态徽标 / 进度 / 3s 轮询）；`extStarter.buildApiBaseUrl` 留空 = 打桩模拟 |

**启动脚本（VSCode 打开加载时自动执行）**：激活事件声明 `onStartupFinished`——**窗口加载
完成即执行，不要求打开文件夹，也不要求用户点击插件**（装了插件就生效）。自动运行启动任务：
先执行「初始化脚本」（当前内置演示：向输出通道打印 `Hello, World!`），随后环境检测
（含 Python 版本检查），全过程逐行打印在输出通道（控制台）中；开关
`extStarter.runStartupTasks`（默认开启）。
**预留的扩展接口**：新增脚本 = 实现 `StartupTask` 接口并在 `taskRegistry.ts` 的 `TASKS`
数组加一项，调度 / 超时 / 异常降级 / 控制台打印 / 视图分组全部自动生效。

**草稿箱（右键示例载体）**：编辑器右键（登记选中 / 追加到最近草稿 / 登记当前文件）、
资源管理器右键（登记文件·支持多选批量 / 登记文件夹内容）、编辑器标题栏——共 8 条入口，
统一写入工作区 `.vscode/ext-starter.drafts.json`（原子写、上限 100 条）。

**拷贝示例（v2.2，右键把内容拷出来）**：编辑器右键「复制选中文本」、资源管理器右键
「复制文件内容」（支持多选批量，1MB 上限 + 二进制防护）与「复制文件路径」——
剪贴板写入的最基础示例，与草稿箱「落盘」形成对照。

**任务管理器（v2.3，Task API 投影）**：侧边栏新视图只加载工作区 `.vscode/tasks.json`
的任务（`fetchTasks()` + `source/scope` 过滤），顶部固定「最近运行 / 收藏 / 工作区任务」
三组；单击运行（`executeTask`，`dependsOn` 由原生引擎编排）、运行中可停止、星标收藏、
一键定位到 tasks.json 的 `label` 行（内置轻量 JSONC 扫描，零新依赖）；最近运行与收藏
按工作区持久化（workspaceState）。

表单基座：**Vue 3 + SchemaForm**（由领域字段表 `SchemaFieldDef[]` 经 `deriveFormSchema` 派生，
字段渲染 / 校验 / 回填零特例），视觉走自研 VSCode 原生设计系统（语义令牌 + 基础组件，
详见 [`docs/需求与优化方案/04-VSCode原生设计系统.md`](https://github.com/taoweidong/vscode-starter-template/blob/main/docs/需求与优化方案/04-VSCode原生设计系统.md)），
自动适配深浅色与高对比度主题、严格 CSP、`Esc` 取消 / `Ctrl+Enter` 保存、草稿自动恢复。

## 菜单与右键菜单示例（典型场景）

| 菜单位置           | 入口 / 触发方式                                     | 典型场景                                                      | 对应命令                                                                                                                |
| ------------------ | --------------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 视图标题栏         | 各面板右上角（刷新 / 输出 / 全部初始化 / 串口）     | 手动触发与刷新                                                | `refreshEnvironment` `showEnvironmentOutput` `runAllInit` `openSerialConsole` `addSerialServer` `refreshSerialServers`  |
| 树条目 inline 按钮 | 单击树条目或条目内联按钮                            | 执行单个初始化步骤 / 连接串口服务器 / 运行·停止·收藏·定位任务 | `runInitStep` `connectSerialServer` `runWorkspaceTask` `stopWorkspaceTask` `addTaskToFavorites` `locateTaskInTasksJson` |
| 树条目右键菜单     | 右键串口服务器条目（连接态菜单不同）                | 连接 / 编辑 / 删除（模态确认）                                | `connectSerialServer` `editSerialServer` `deleteSerialServer`                                                           |
| 编辑器右键菜单     | 选中文本右键（登记 / 追加）；无选区右键（登记文件） | 选中文本一键入草稿箱；给最近一条草稿补充内容；登记当前文件    | `draftSelection` `appendDraftSelection` `draftFile`                                                                     |
| 资源管理器右键菜单 | 右键文件（单选 / 多选批量）或文件夹                 | 登记文件到草稿箱；整个目录内容登记为一条汇总草稿              | `draftFile` `draftFolder`                                                                                               |
| 编辑器标题栏       | 文件页签右上角图标按钮                              | 对当前打开的文件做同样登记                                    | `draftFile`                                                                                                             |
| 命令面板           | `Ctrl+Shift+P` 输入 "Extension Starter"             | 无鼠标操作路径；「打开分支编译控制台」弹框提交构建任务        | 全部命令                                                                                                                |

### 菜单开发要点（示例中的关键模式）

1. **右键菜单传参约定**：`explorer/context` 的命令收到 `(uri, uris[])` 两个参数——
   被右键的资源与多选集合；`view/item/context` 收到树节点元素与多选集合。
   草稿箱命令（`src/extension/commands/draftCommands.ts`）是「宿主如何拿到上下文」的完整示范。

2. **按上下文显示**：`when` 子句控制菜单出现时机——树条目菜单用 `viewItem == serialServer` /
   `serialServerConnected`（对应 `TreeItem.contextValue`），编辑器选区菜单用
   `editorTextFocus && editorHasSelection`，多选区分 `listMultiSelection`。

3. **树条目单击命令**：`TreeItem.command` 可绑定带参路由（如探针条目单击 =
   `refreshEnvironment` + label 参数，实现单探针重检）。

4. **i18n**：菜单 / 命令文案全部走 `package.nls.json`（英文默认）+ `package.nls.zh-cn.json`
   的 `%key%` 占位符，新增命令记得两份文案都加。

## UI 风格约定

扩展的 UI 目标是「像 VSCode 团队自己出品的一样」，后续增改界面时请遵守以下约定：

| 约定           | 做法                                                                                                                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 颜色零硬编码   | 只使用 `--vscode-*` 主题令牌（输入框、按钮、错误、焦点色等），自动适配深浅色与高对比度主题                                                                                                 |
| 单一字体与字阶 | 只用 `--vscode-font-family`；标题 1.3em/600，正文 13px，提示 0.9em                                                                                                                         |
| 图标语言统一   | codicon 语义名单一来源 `src/webview/ui/iconNames.ts`（webview 侧）；宿主树视图直接用 `ThemeIcon`。新增图标先加进映射表                                                                     |
| 布局刻度       | 全部尺寸走 `--ui-*` 令牌（门禁强制：padding/margin/gap/圆角/高宽/字号不允许 px 字面量）                                                                                                    |
| 主按钮在右     | 确认键（保存/删除）在右侧、次要在左侧，与 VSCode 模态对话框一致                                                                                                                            |
| 动效克制       | 仅 0.1s 的 hover/focus 过渡，无阴影、无渐变、无入场动画                                                                                                                                    |
| 反馈闭环       | 成功用「已…」toast，失败给可修正的行内提示；确认弹窗按钮动词与操作同名                                                                                                                     |
| 键盘可达       | 表单 `Esc` 取消、`Ctrl+Enter` 保存、打开即聚焦首字段；QuickPick/输入框均有 `Esc` 退出约定                                                                                                  |
| 设计系统基线   | 全部令牌 / 组件规格与状态矩阵见 [04 · VSCode 原生设计系统](https://github.com/taoweidong/vscode-starter-template/blob/main/docs/需求与优化方案/04-VSCode原生设计系统.md)，画廊页可实时巡检 |
| 资源相对引用   | webview 构建设置 `base: './'`（CSS 内 `url()` 相对解析），门禁红线禁止产物 CSS 出现站点根绝对引用——违反即字体 404、图标全灭（v0.7.0 的真实事故）                                           |

## 快速开始

环境要求：Node.js ≥ 20.19（开发工具链）、VSCode ≥ 1.85。

```bash
npm install
npm run gate      # 一键式质量门禁：lint/格式→类型→双构建→静态一致性→单测(覆盖率)→集成（推荐先跑）
```

然后**用 VSCode 打开本项目文件夹，按 `F5`** 即可启动调试窗口：

> AI 编码代理请先阅读根目录的 `agent.md`——其中包含单元测试与质量门禁的强制协议。

调试窗口中的体验路径：

1. 活动栏出现「扩展模板」图标，点击进入侧边栏（4 个视图）；「构建任务」视图标题栏可打开分支编译弹框，任务列表实时轮询；
2. 窗口加载完成即自动执行启动任务（无需打开文件夹或点击插件；初始化脚本 Hello World + 环境检测，含 Python 版本检查），过程打印在输出通道（`extStarter.runStartupTasks` 可关闭）；之后点标题栏 ↻ 或单击任一探针条目按需重检；
3. `npm run gate -- --with-e2e` 可追加 Webview E2E（Playwright + Edge）。

其他常用脚本：

```bash
npm run compile       # 类型检查（tsc + vue-tsc）+ 宿主构建 + Webview 构建
npm run watch         # 宿主构建监听模式（调试时配合使用）
npm run package       # 生产构建（宿主 + Webview）
npm run test:unit     # 快速单元测试（Vitest，不启动 VSCode，秒级）
npm test              # 仅运行宿主集成测试（首次会自动下载测试用 VSCode，耗时较长）
npm run test:e2e      # Webview 页面测试（Playwright + Edge，需先构建 Webview）
npm run lint          # ESLint 检查（eslint .）
npm run format:check  # Prettier 格式检查（format 可一键修复）
npm run package:vsix  # 一键打包离线 .vsix（内置 vsce，免全局安装）
```

## 目录结构与架构

```
vscode-starter-template/
├── package.json                  # 插件清单：命令、视图、菜单、配置（文案走 %key% 占位符）
├── package.nls.json              # manifest 文案（英文默认）
├── package.nls.zh-cn.json        # manifest 文案（简体中文）
├── vite.config.ts                # Webview（Vue 3）构建：多入口 + manifest + base './'
├── vitest.config.ts              # 单元 / 组件测试（Vitest + vscode 测试桩）
├── tsconfig.json                 # 解决方案引用（node + webview 两工程）
├── tsconfig.node.json            # 宿主侧（CommonJS / ES2022 / 无 DOM lib）
├── tsconfig.webview.json         # Webview 侧（ESNext + DOM + bundler 解析）
├── scripts/                      # 构建与门禁脚本（build-extension.ts / gate.ts / checks/）
├── media/icon.svg                # 活动栏图标
└── src/
    ├── extension/                # 宿主侧全部代码（只 import vscode，不 import Vue）
    │   ├── index.ts              # 入口：组装服务 → 视图 → 命令（含旧键迁移）
    │   ├── constants.ts          # 命令/视图/配置/存储 ID 的单一来源
    │   ├── commands/             # 命令按场景分组（pageCommands / serialConsoleCommands / draftCommands）
    │   ├── features/
    │   │   ├── drafts/           # 草稿箱：右键示例的数据落点（原子写 + 上限）
    │   │   ├── init/             # 环境初始化：步骤注册表 + 状态机
    │   │   ├── build/            # 分支编译：HTTP 弹框（表单提交 + 任务列表，打桩/真实接口）
    │   │   └── serialConsole/    # 串口控制台：存储 / 历史 / 链路 / 面板与树视图
    │   ├── providers/            # 树视图（环境信息）
    │   ├── services/             # 原子写 / 旧键迁移
    │   └── tasks/
    │       ├── probes.ts         # ★ 可插拔环境探针注册表（新增语言 = 加一条数据）
    │       ├── taskRegistry.ts   # ★ 启动任务注册表（新增任务只改这里）
    │       ├── taskRunner.ts     # 调度器：顺序执行、异常降级、事件通知、单条目更新
    │       └── environmentTask.ts # 内置任务：遍历探针注册表 + 系统项
    ├── webview/                  # Webview 侧（不 import vscode；唯一契约 protocol.ts）
    │   ├── pages.ts              # ★ 页面注册表（gallery / serialConsole；新增页面在此登记）
    │   ├── protocol.ts           # 宿主 ↔ 页面消息协议与运行时守卫（24 分支）
    │   ├── formSchema.ts         # 表单字段派生（deriveFormSchema：领域无关）
    │   ├── host/                 # 宿主侧面板控制器 / HTML 外壳 / 资源解析
    │   ├── ui/                   # VSCode 原生设计系统（语义令牌 + 基础组件）
    │   ├── components/           # SchemaForm + 五类字段组件
    │   └── apps/                 # 页面（gallery / serialConsole / buildConsole）
    ├── ui/                       # 宿主侧共享（markdown 转义等）
    └── test/                     # 集成测试（mocha + @vscode/test-electron）+ 单测（vitest）
```

边界规则（写进门禁与 README）：

- `src/extension/**` 只 import `vscode`，不 import Vue / Webview 侧代码；
- `src/webview/**` 不 import `vscode`，只通过 `postMessage` 与宿主通信；
- 唯一的跨侧契约 = `src/webview/protocol.ts`（纯类型 + 运行时守卫，零依赖）。

数据流（串口控制台为例，单向）：

```
树视图 / 控制台页面 / 命令
        │  调用
        ▼
SerialConsoleController（链路状态 + 面板注册表 + 依赖装配）
        │  读写
        ▼
serverStore（工作区 JSON 文件 + Memento 双实现，原子写）
```

## 如何扩展

### 1. 新增一种环境探针（探针注册表）

> 以下各节是速查摘要；**逐步实操与常见坑**见 [docs/开发指南/](docs/开发指南/README.md)（按功能逐篇：启动任务 / 初始化 / 编译 / 串口 / 草稿箱 / Webview / 命令与 i18n / 测试打包）。

在 `src/extension/tasks/probes.ts` 的 `ENVIRONMENT_PROBES` 加一项：

```ts
{ id: 'go', label: 'Go', commands: ['go version'], parse: (raw) => raw.replace(/^go\s*/i, '') }
```

完成。环境检测条目、缺失提示、**树视图单击单独重检**全部自动跟随，零改动其他文件。

### 1.5 新增一个启动脚本（初始化脚本注册表）

VSCode 打开时会自动执行 `taskRegistry.ts` 中 `TASKS` 数组里的全部任务并打印到输出通道。
新增脚本 = 实现 `StartupTask` 接口 + 数组加一项：

```ts
// src/extension/tasks/myScript.ts —— 动作类脚本最小样板（helloTask.ts 即现成示例）
export const myTask: StartupTask = {
  id: 'my-script',
  title: '我的脚本',
  async run(ctx) {
    ctx.output.appendLine('[我的脚本] 执行中…') // 实时打印到控制台
    return {
      taskId: 'my-script',
      taskTitle: '我的脚本',
      status: 'ok',
      durationMs: 0,
      finishedAt: new Date().toISOString(),
      items: [],
    }
  },
}
// taskRegistry.ts：TASKS = [helloTask, myTask, environmentTask]
```

调度、超时裁决、异常降级、控制台打印、「环境信息」视图分组全部自动生效。

### 2. 新增一个命令

1. `src/extension/constants.ts` 的 `COMMAND` 中加 ID；
2. `package.json` 的 `contributes.commands`（需要按钮就同时配 `menus`）加声明，
   文案用 `%command.xxx.title%` 占位符并在两份 nls 文件补文案；
3. `src/extension/commands/` 对应场景分组中 `register(COMMAND.xxx, ...)` 写实现。

门禁第 ⑥ 步静态校验「清单 ↔ 常量 ↔ 注册」三方闭合，漏一处立刻红。

### 3. 新增一个 Webview 页面

1. 复制 `src/webview/apps/gallery/` 出新目录，写 `main.ts` + `App.vue`；
2. `src/webview/pages.ts` 的 `WEBVIEW_PAGES` 加一行（id / 标题 / 入口）。

Vite 入口、manifest 解析、e2e harness、宿主面板控制器全部自动跟随——这就是「加一个页面
只碰两个文件」的基座承诺。页面 ↔ 宿主的消息分支在 `protocol.ts` 追加联合类型与守卫 case。

### 4. 新增一个带表单的领域（SchemaForm 驱动）

仿照 `src/extension/features/serialConsole/serverSchema.ts`：

1. 定义 `SERVER_FIELD_DEFS: SchemaFieldDef[]` 字段表（text/textarea/select/boolean）；
2. `deriveFormSchema(SERVER_FIELD_DEFS)` 派生表单字段，经 `toFieldDefs` 组装 init 载荷；
3. 页面用 `SchemaForm` 渲染——校验、回填、默认值全部由字段表驱动，「加字段只改一处」。

### 5. 打包发布

```bash
npm run package:vsix            # 一键：完整构建 + vsce 打包 → release/<name>-<version>.vsix
npm run package:vsix -- --clean # 打包前清空 release/ 归档目录（重新归档）
```

Windows 下也可**双击根目录的 `package.bat`**（命令行用法 `package.bat [--clean]`）：
内部等价 `npm run package:vsix`，结束时暂停显示结果，未装 Node 时给出安装提示。

- 跨平台（Linux / Windows 通用）：脚本为纯 Node 实现（`scripts/package-vsix.ts`），无 shell 语法；
- vsce（`@vscode/vsce`）已内置在 devDependencies，**无需全局安装**；
- 产物统一归档到仓库根目录的 `release/`（已被 `.gitignore` 与 `.vscodeignore` 排除，根目录保持整洁）；
- 门禁第 ⑨ 步已内置 vsce 黑白名单与 bundle 体积预算（宿主 ≤150KB、单 chunk ≤100KB、vsix ≤20MB）。

发布到市场（需 publisher 账号 + PAT）：

```bash
npx vsce publish
```

发布前记得：修改 `package.json` 的 `publisher` 与 `repository`（LICENSE / 图标 / categories 等
元数据已随模板就绪）。

## 说明与已知限制

- **v1.0.0 破坏性变更**：ID 前缀 `crudStarter.*` → `extStarter.*`。旧版设置（串口开关）与
  Memento 数据在激活时自动迁移并提示；SecretStorage 密码在首次自动登录时惰性搬迁。
  用户自定义的 keybindings / when 条件需手动更新。
- 工作区数据文件（`.vscode/serial-servers.json`、`.vscode/*.drafts.json` 等）均已 gitignore；
  新增落盘文件记得同步 `.gitignore`（v2.0 起本地脏检查随 BuildService 退役）。
- `npm test` / 完整 `npm run gate` 首次运行会下载独立的测试版 VS Code（实测约 1GB，
  缓存在 `.vscode-test/` 复用；只要类型检查时用 `npm run check-types` 即可）。
- Webview 页面基于 Vue 3（runtime-only，经 Vite 构建），**未引入通用 UI 框架 / toolkit**——
  组件为自研的 VSCode 原生设计系统；扩展宿主（Node 侧）运行时依赖仅 `serialport`
  （串口控制台功能，N-API 预编译跨平台，经 `.vscodeignore` 否定项随 vsix 分发）。
- 串口命令历史为全局共享（跨服务器复用）：trim 后精确去重、MRU 置顶、上限 200 条；
  登录密码只存 VSCode SecretStorage，数据文件与日志零明文。
- 发布元数据已就绪：LICENSE（MIT）、128×128 图标（`media/icon.png`，可用
  `npx tsx scripts/generate-icon.ts` 从 SVG 重新生成）、`categories` / `homepage` / `bugs`。
