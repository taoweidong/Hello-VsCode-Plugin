# agent.md — AI 编码代理工作约定

> 本文件是 AI 编码代理在本仓库（Hello-VsCode-Plugin）工作时的**强制约定**。
> 任何会话中修改代码 / 配置 / 文档之前，先读完本文件再动手。

## 项目概述

- **是什么**：Hello VSCode 插件（v1.0.0 起由「CRUD 演示集合」按 09 方案收敛重构）：
  6 视图（任务管理器 / 收藏夹 / 快捷命令 / 环境信息 / 环境初始化 / 任务管理）+ 2 Webview 页面
  （gallery 组件画廊 / taskManager 任务管理 CRUD 弹框）+ 草稿箱右键示例（8 条入口）+
  启动任务框架（窗口加载完成自动执行：初始化脚本 + 环境探针）。
- **技术栈**：TypeScript（strict，tsconfig node / webview 双工程）+ esbuild（宿主构建）+
  Vite（Webview 构建）+ Vitest（单测）+ mocha/@vscode/test-electron（集成）+ Playwright（e2e）。
- **仓库**：https://github.com/taoweidong/Hello-VsCode-Plugin
- **扩展内品牌**：Hello VSCode Plugin / Hello VSCode 插件（ID 前缀 `extStarter`，manifest 文案走
  `package.nls*.json` 的 `%key%` 占位符）。总览事实源是根目录 `README.md`（精简版，
  详情在 docs 五层文档）；**文档总入口**是 `docs/README.md`（五层 + 历史归档：
  操作指导 / 功能介绍 / 基础系统介绍 / 设计架构 / 开发指南 / 需求与优化方案），
  按功能的二次开发文档在 `docs/开发指南/`。

## 一键式质量门禁（强制）

```bash
npm run gate
```

- **协议：每次对话结束前必须执行。** 只要本轮改过代码 / 配置 / 文档，收尾前先跑门禁；
  全部步骤通过后才允许向用户报告「完成」或执行 `git commit` / `git push`。
- 门禁内容（`tsx scripts/gate.ts`，fail-fast，`--fast` 跳过宿主集成测试）：
  ① Lint 与格式检查（eslint / prettier）→ ② 类型检查（tsc strict + vue-tsc）→
  ③ 宿主生产构建（esbuild）→ ④ Webview 构建（vite build）→ ⑤ 测试编译 →
  ⑥ 静态一致性检查（package.json 清单 ↔ src/extension/constants.ts ↔ 视图 when ↔
  命令注册 ↔ Webview manifest，见 `scripts/checks/manifest.ts`；命令前缀动态读取
  CONFIG.section，结构校验、不含项目身份断言）→
  ⑦ 单元测试（Vitest + 覆盖率阈值，不启动 VSCode）→ ⑧ 宿主集成测试（@vscode/test-electron）
  → ⑨ 打包内容与产物体积校验（vsce ls 黑白名单 + bundle 预算）；
  另有第⑩步 Webview E2E（Playwright），仅 `--with-e2e` 显式触发，默认不进门禁。
- **首次运行会自动下载测试用 VS Code**（约 1GB，缓存在 `.vscode-test/`，已被 gitignore），
  之后复用缓存，属正常现象。
- 任一步骤失败：修复后重跑；确实无法修复时，必须在交付说明中如实披露失败步骤与原因，
  禁止静默跳过或伪造通过。
- 提交规约：Conventional Commits（feat / fix / chore / test / docs / refactor），
  提交前 `git status` 确认无意外文件；推送直接 `git push origin main`（凭据走 GCM，
  不要把 token 写进任何命令或文件）。

## 单元测试协议（强制）

- **每一次 AI 交互都必须执行前端与后端的单元测试，全部通过后才允许提交代码。**
  本项目两侧共用同一条命令：`npm run test:unit`（Vitest，一次性覆盖宿主侧「后端」
  （`src/extension/**`，node 环境）与 Webview 侧「前端」（`src/webview/**` 及其
  `src/test/unit/webview/` 用例，jsdom 环境）的全部单元 / 组件用例，不启动 VSCode，
  全量 < 30s）。两侧用例都必须通过——只绿一侧不算通过。
  - **测试未通过时不得提交**：先定位并修复问题，再重新运行验证，直到全部通过；
    禁止跳过、注释或伪造测试通过；
  - 日常对话轮次：每轮改过代码 / 配置 / 文档，收尾前必须跑 `npm run test:unit`
    （即使本轮不提交——测试是行为一致性的验证手段）；
  - 提交前 / 收尾前：完整 `npm run gate`（快速迭代可用 `npm run gate -- --fast`
    跳过宿主集成测试，但单元测试永远不可跳过）。
- **新增代码必须优先补充单元测试**：新增模块 / 命令 / 服务方法 / Webview 组件时，
  随代码一并提交对应测试用例（先写用例再实现）；修复 bug 必须先编写能复现问题的
  测试，再修复并保证用例通过。
- 测试不得跳过、注释或伪造通过；确实无法测试的代码，先重构可测性再交付。
- 单元测试写在 `src/test/unit/**/*.spec.ts`；`vscode` 模块由 `vitest.config.ts` 的
  alias 指向 `src/test/unit/stubs/vscode.ts` 测试桩（含 EventEmitter / window 录制器 /
  workspace.fs / getConfiguration / watcher 桩），只许增量扩展、不得删除已有导出。
- 覆盖率统计面与阈值见 `vitest.config.ts`（12 方案阶段 4 起统计面覆盖全部可测模块，
  阈值 = 实测值减约 1pt 余量）；测试分层与工具见 `docs/需求与优化方案/01-需求细化.md`
  （NFR-07）与 `03-技术选型与架构.md`（§6 测试架构）。

## 版本号规约（强制）

- **每个包含代码变更的提交，必须在同一提交内按变更幅度更新 `package.json` 的 `version`**，
  并同步更新 `CHANGELOG.md`（Keep a Changelog 格式：定版记 `## [x.y.z] - 日期` 段，
  未定版的累积变更先记 `## [Unreleased]`，发布时定版）。
- 幅度判定（语义化版本，拿不准时从严取更高一位）：
  - **major**：破坏性变更——命令 / 视图 / 配置 / 存储键 ID 变更，删除公开命令 / 视图 / 配置项，
    清单结构不兼容，旧数据无法沿用；
  - **minor**：新增功能——新命令 / 视图 / Webview 页面 / 启动任务 / 服务能力等向后兼容增量；
  - **patch**：缺陷修复、无行为变化的重构、样式与文案调整、测试与工具链变更。
- **豁免**：仅文档（docs / README / agent.md / CHANGELOG 本身）或 CI 配置的提交不要求升版本。
- 版本号与 CHANGELOG 不同步的提交不得推送；`npm run package:vsix` 产物名含版本号，
  升版后旧归档不会自动清理（需要时用 `package:vsix -- --clean`）。

## 架构分层（改代码前对照）

```
src/extension/（宿主侧，只 import vscode，不 import Vue）
  index.ts        组装：数据迁移/清理 → 启动任务 → 视图 → 命令（激活时机 onStartupFinished）
  constants.ts    命令 / 视图 / 配置 / 存储 ID 的单一来源
  commands/       页面 / 草稿箱 / 拷贝 / 任务 / 收藏 / 快捷命令命令组 + shared
  features/       drafts 草稿箱 / init 任务编排 / taskManager 任务管理（CRUD 实例） /
                  taskExplorer 任务树 / favorites 收藏夹 / quickCommands 快捷命令
  providers/      环境信息树视图
  services/       serialCleanup 串口遗留数据清理 + stores/（atomicWrite 原子写、
                  jsonEnvelopeStore 信封存储、queuedFileStore 串行写队列）
  tasks/          StartupTask 注册表（taskRegistry）+ TaskRunner 调度 + probes 环境探针
src/webview/（Vue 3，禁止 import vscode；唯一跨侧契约 protocol.ts）
  pages.ts 页面注册表 / host/ 宿主控制器 / components/ SchemaForm / ui/ 设计系统 / apps/ 页面
src/ui/（宿主侧共享：markdown 转义）
src/test/（unit: Vitest + vscode 测试桩；集成: mocha + @vscode/test-electron）
```

### 硬性规约

1. **单一来源**：命令 ID / 视图 ID / 配置键只在 `src/extension/constants.ts` 定义，
   `package.json` 的 contributes 必须与之同步（门禁第 ⑥ 步会校验，新增命令三处缺一不可：
   constants → package.json → src/extension/commands/ 的 `register(COMMAND.xxx`）。
2. **表单 Schema 派生**：领域字段表（如 `serverSchema.ts` 的 `SERVER_FIELD_DEFS`）经
   `deriveFormSchema`（src/webview/formSchema.ts）派生表单字段，加字段只改领域一处；
   Webview 页面 Vue 3 组件化，禁止在页面硬编码业务字段。
3. **图标语言**：webview 侧 codicon 语义名单一来源为 `src/webview/ui/iconNames.ts`；
   宿主树视图直接用 `ThemeIcon`。同一概念全插件同图标。
4. **UI 规约**：颜色只用 `--vscode-*` 主题令牌；尺寸走 `--ui-*` 令牌（样式门禁强制）；
   主按钮在右；动效仅 0.1s hover/focus；成功反馈以「已…」开头
   （详见 [docs/开发指南/00-架构与目录.md](docs/开发指南/00-架构与目录.md)「UI 风格约定」）。
5. **右键菜单传参**：`view/item/context` 命令第一个参数是树节点元素（需 `toItem()` 归一化），
   第二个参数是多选集合；`TreeItem.command` 传的才是原始对象。
6. **shell 拼接外部输入前必须白名单校验**（先例：分支名 `BRANCH_NAME_PATTERN`）。
7. **测试卫生**：测试创建的临时目录必须在 `finally` 中 `fs.rmSync` 清理。
8. **eslint 豁免管理**：新增文件级 / 目录级豁免必须在注释中注明根因与消除条件；随代码修复及时删除豁免，禁止只增不减。
9. **webview 禁用浏览器模态**：`window.confirm / alert / prompt` 在 VS Code webview
   沙箱（iframe 无 allow-modals）下被静默忽略——confirm 恒返回 false、alert/prompt
   无任何效果。确认交互一律改用页内两段式布防确认（首点布防、限时内再点执行）或经
   宿主 `showWarningMessage` 模态，禁止依赖 confirm 返回值（样式门禁会扫描
   `src/webview` 违规；第五轮评估 P0 教训）。

## 常用命令

| 命令                   | 用途                                                                                          |
| ---------------------- | --------------------------------------------------------------------------------------------- |
| `npm run gate`         | 一键式质量门禁（提交 / 收尾必跑；`-- --fast` 跳过宿主集成，`-- --with-e2e` 追加 Webview E2E） |
| `npm run test:unit`    | 快速单元测试（Vitest，不启动 VSCode，日常每轮必跑）                                           |
| `npm run test:e2e`     | Webview 页面测试（Playwright + Edge，先构建 Webview）                                         |
| `npm run lint`         | ESLint 检查（flat config，eslint.config.ts）                                                  |
| `npm run format:check` | Prettier 格式检查（`npm run format` 一键修复）                                                |
| `npm run compile`      | 类型检查（tsc + vue-tsc）+ 宿主构建 + Webview 构建                                            |
| `npm run watch`        | 宿主构建监听模式（调试时用）                                                                  |
| `npm run package`      | 类型检查 + 生产构建（宿主 + Webview）                                                         |
| `npm run package:vsix` | 一键打包离线 .vsix 并归档到 release/（免全局安装 vsce，跨平台）                               |
| `npm test`             | 仅跑宿主集成测试（需 .vscode-test 缓存）                                                      |
| `F5`（VSCode）         | 启动扩展开发宿主调试                                                                          |

## 已知事项

- 集成测试依赖 `.vscode-test/` 缓存；删除后首次门禁/测试会重新下载 VS Code。
- 工作区运行时数据文件（`.vscode/*.drafts.json` / `favorites.json` /
  `quick-commands.json` 等）已 gitignore——新增落盘文件同步 `.gitignore`
  （v2.0 起本地脏检查随 BuildService 退役）。
- v4.0.0 串口 / v5.0.0 书签功能已下线：激活时会一次性清理遗留数据
  （串口：数据文件 + SecretStorage 密码 + globalState 旧键；书签：工作区与
  globalStorage 数据文件），见 `services/legacyFeatureCleanup.ts`。
- **不要与旧包 `vscode-starter-template`（≤ 2.5.0）同时安装**：两者共享 `extStarter`
  命名空间的视图容器 / 视图 / webview ID，新版激活会报 `No view is registered with id: …`
  或 `Serializer … already registered`；卸载旧扩展并重载窗口即可（v5.0.1 起单视图注册
  失败会降级为告警，不再拖垮整个激活，但视图仍无法注册，必须卸载旧包）。
- 发布到市场前：改 `publisher` 与 `repository` 即可（LICENSE / 128×128 图标 / categories
  等元数据已就绪，图标可用 `npx tsx scripts/generate-icon.ts` 从 SVG 重新生成）。
- CI（`.github/workflows/ci.yml`）：Windows 跑完整门禁 + Playwright e2e；Ubuntu 跑
  `gate -- --fast`（宿主集成需 GUI）。
