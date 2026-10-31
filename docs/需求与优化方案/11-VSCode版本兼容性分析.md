# 11 · VSCode / vscode-server 版本兼容性分析

> 分析对象：v2.3.0 工作区（`engines.vscode: ^1.85.0`）。
> 分析方法：全量扫描 `src/extension` 的 `vscode.*` API 调用清单 → 交叉核对构建目标（esbuild / Vite）→
> 打包链路（vsce / `.vscodeignore` / 原生模块 prebuild）→ vscode-server（远端 SSH / WSL / 容器）专项核对。
> 本文所有 `文件:行号` 均指 2026-11-01 工作区快照；**新增 API 调用后需复核 §3**。
>
> **一句话结论**：唯一的硬性版本要求来自 `package.json` 自声明的 `engines.vscode`；
> 代码真实兼容下限约为 **1.75**，降至 `^1.75.0` 不需要改动任何业务代码。

## 1. 结论摘要

| 约束因素                         | 现值/位置                                                        | 实际版本下限 | 说明                                                                           |
| -------------------------------- | ---------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------ |
| `engines.vscode`（唯一强制门槛） | `package.json:29` → `^1.85.0`                                    | **1.85**     | Marketplace 与 vscode-server 安装期硬校验，低于此版本拒绝安装/启用             |
| Extension API 调用面（§3）       | 全量扫描 `src/extension`                                         | ≈ 1.57       | 最「新」的是 Workspace Trust（1.56/57）与 `tasks.taskExecutions`（1.57）       |
| 激活事件 `onStartupFinished`     | `package.json:33-35`                                             | **1.75**     | 1.74 及以下视为未知事件、**永不激活**（扩展整体瘫痪，而非降级）                |
| Webview 前端构建目标             | `vite.config.ts` 未设 `build.target` → Vite 7 默认基线           | ≈ **1.75**   | Vite 7 默认 ≈ Chromium 107；VSCode 1.75 = Chromium 108 刚好覆盖，1.74 = 102 ❌ |
| 宿主打包语法目标                 | `scripts/build-extension.ts:26` → `target: 'es2022'`             | ≈ 1.75       | 1.75–1.78 宿主 Node 16.17 完整支持 ES2022 语法                                 |
| `@types/vscode`（仅类型面）      | `package.json:505` 声明 `^1.85.0`，lockfile 实际解析 **1.138.0** | —（不强制）  | 类型面超前于运行时声明，存在「编译能过、旧版崩」的漂移风险（§2.2）             |
| `engines.node: >=20.19.0`        | `package.json:30`                                                | —（不强制）  | 只约束本机开发构建（npm install），与 VSCode 宿主无关（§5.4）                  |

**vscode-server 结论**：安装校验与桌面版同源（按 `engines.vscode`）；原生模块 serialport
随包携带全平台 N-API prebuild，远端 Linux server **开箱即用、无需重编译**；串口模块加载失败
有优雅降级，不影响其余功能（§5）。

## 2. 声明层：强制要求从哪来

### 2.1 `engines.vscode` 是唯一闸门

- `package.json:29` 声明 `^1.85.0`（VSCode 1.85，2023-11，Electron 25 / Chromium 114 / Node 18.15）。
- VSCode 1.85 对应的 vscode-server 版本同为 1.85 —— 远端窗口安装扩展时，server 侧 extension host
  执行与桌面版相同的兼容性校验，**server 版本 < 1.85 时扩展无法安装/启用**。
- `^1.85.0` 的语义是「1.85.0 ≤ 宿主 < 2.0.0」：对**新版** VSCode 无上限约束（一直向上兼容），
  版本要求只体现在**下限**上。因此「兼容老版本」的诉求完全取决于这个下限值定多高。

### 2.2 `@types/vscode` 类型面漂移（建议收口）

- 声明为 `^1.85.0`，lockfile 实际解析到 `@types/vscode@1.138.0`（`^` 拉取最新 1.x 类型）。
- 后果：类型检查（`check-types`）用 1.138 的 API 面做校验，但运行时承诺的是 1.85 ——
  若有人顺手使用一个 1.90+ 的 API，**编译通过、跑在 1.85 上运行期崩溃**（`undefined is not a function` 类）。
- 当前代码未触发该风险（§3 清单最「新」约 1.57），但这是埋着的坑。
- **建议**：把 `@types/vscode` 锁为与 `engines.vscode` 下限一致的**精确版本**（如 `"1.85.0"`，
  去掉 `^`），让类型面等于承诺面；升级下限时同步上调。

## 3. 代码层：API 调用清单与版本下限

对 `src/extension` 全量 `grep -E "vscode\.[A-Za-z]+(\.[A-Za-z]+)?"` 统计（约 30 类 API），
按引入版本从新到旧列出有代表性的条目：

| API / 能力                                                 | 使用位置（示例）                          | 引入版本 |
| ---------------------------------------------------------- | ----------------------------------------- | -------- |
| `workspace.taskExecutions`                                 | taskExplorerController（任务运行/停止）   | 1.57     |
| `workspace.onDidGrantWorkspaceTrust`                       | index.ts（信任授予后重建启动任务）        | 1.57     |
| `workspace.isTrusted` + `capabilities.untrustedWorkspaces` | index.ts / environmentTask.ts（信任门禁） | 1.56     |
| `Uri.joinPath`                                             | assetResolver 等（12 处）                 | 1.51     |
| `createTreeView({ showCollapseAll })`                      | index.ts:129（任务管理器视图）            | 1.50     |
| `workspace.fs`（readFile/writeFile/createDirectory 等）    | jsonFileStore、草稿箱等（18 处）          | 1.47     |
| `createWebviewPanel` / `createOutputChannel(name)`         | webviewController.ts:215 / index.ts:39    | 1.46     |
| `MarkdownString` tooltip / `ThemeIcon` / `EventEmitter`    | 各 TreeProvider                           | ≤ 1.47   |
| `asWebviewUri` / `cspSource`                               | webviewController.ts:324-334              | 1.38     |
| `registerWebviewPanelSerializer`                           | webviewController.ts:171（面板恢复）      | 1.15     |
| Task / ShellExecution / ProcessExecution / TaskGroup       | environmentTask 等（14 处）               | ≤ 1.41   |
| `vscode.version`（环境探针展示用）                         | environmentTask.ts:105                    | 1.x 早期 |

webview 宿主侧（`src/webview/host/`）全部为上述老 API：`enableScripts`、
`retainContextWhenHidden`、`localResourceRoots`（面板创建选项，1.4x 以前）、
`onDidReceiveMessage`/`postMessage`（1.3x 以前）。**未使用** `enableForms`（1.67+）、
`resolveTreeItem`（1.70+）、`TreeItemLabel.highlights`（1.59+）等任何 1.58+ 的新 API。

## 4. 非 API 因素：真正把下限垫到 1.75 的三件事

### 4.1 激活事件 `onStartupFinished`（1.75 转正）

- `package.json:33-35` 仅声明 `onStartupFinished` 一个激活事件（启动完成后延迟激活，不拖慢启动）。
- 该事件 2021 年起以 proposed API 形式存在，**1.75（2023-01）转正**。
- 1.74 及以下宿主把它当未知事件忽略 ⇒ 扩展**永远不会激活**，命令/视图全部失效
  （`contributes` 静态注册的视图容器仍显示，但树为空、命令报「command not found」）。
- 这是**整体失效**级约束，因此 1.75 是「不改代码」能到的下限；再往下必须改激活策略（§6.2）。

### 4.2 Webview 前端构建目标（Vite 7 默认基线 ≈ Chromium 107）

- `vite.config.ts` 未显式设置 `build.target`，取 Vite 7 默认 `baseline-widely-available`
  （约 Chrome/Edge 107 / Firefox 104 / Safari 16 量级）。
- 宿主 Chromium 对照（来源见 §7）：1.75–1.78 = Chromium 108 ✓；1.74 = Chromium 102 ❌。
- 页面代码本身很干净：无 `:has()`（105+）、`structuredClone`（98+）等超基线浏览器 API，
  CSP 为标准 nonce 方案（`webviewHtml.ts:41`），`<script type="module">` 在任何版本 webview 均可用。
- **建议**：显式声明 `build.target`（如 `'chrome108'` 或与 engines 对齐的值），防御未来
  Vite 大版本升级静默抬高 Chromium 基线。

### 4.3 宿主打包语法目标 `es2022`

- `scripts/build-extension.ts:26` 以 `target: 'es2022'` 输出 CJS。ES2022 语法（类字段、
  私有方法、静态块）在 Node 16.6+（V8 9.4+）完整支持 ⇒ 1.75–1.78 的 Node 16.17 宿主可直接运行。
- 注意 esbuild 只降级**语法**不注入 DOM/polyfill，宿主侧无浏览器 API 依赖，不受影响。

### 4.4 宿主版本对照表

| VSCode 版本 | Electron | Chromium | Node  | 本扩展可运行？（不改代码）              |
| ----------- | -------- | -------- | ----- | --------------------------------------- |
| ≤ 1.74      | 19       | 102      | 16.x  | ❌（激活事件不识别 + webview 基线不足） |
| 1.75–1.78   | 22       | 108      | 16.17 | ✅（理论可跑，需按 §6.1 冒烟验证）      |
| 1.79–1.85   | 25       | 114      | 18.15 | ✅（1.85 为当前声明下限）               |
| 1.86–1.87   | 27       | 118      | 18.17 | ✅                                      |
| 1.88+       | 29+      | 122+     | 20.9+ | ✅（`^1.85.0` 无上限，自动兼容）        |

## 5. vscode-server 专项（远端 SSH / WSL / 容器）

### 5.1 安装校验

vscode-server 与桌面版共享扩展兼容性协议：远端窗口安装 VSIX 时按 `engines.vscode` 校验，
server 版本必须 ≥ 1.85。降级 engines（§6.1）后远端同步受益。

### 5.2 原生模块 serialport：跨平台随包，无需远端重编译

- 依赖唯一的生产依赖 `serialport@^12`（`package.json:534`）走 N-API（ABI 稳定，跨 Node 14–24
  通用），其 `@serialport/bindings-cpp` 包内自带**全平台 prebuild**，实测目录含
  `linux-x64`、`linux-arm64`、`linux-arm`、`darwin-x64+arm64`、`win32-x64`、`win32-ia32`、`android-*`。
- `.vscodeignore` 精确白名单：排除 `node_modules/**` 后回加 `serialport` / `@serialport` /
  `node-gyp-build` / `debug` / `ms` —— Windows 上打的 VSIX 天然包含 Linux 二进制，
  装进 Linux vscode-server **开箱即用**，无需 server 端重编译。
- N-API 保证了「宿主 Node 从 16.17 → 20.x 漂移不影响二进制加载」，这正是它对老版本兼容的关键性质。

### 5.3 加载失败的优雅降级

`serialPortFactory.ts:76-82`：`createRequire(__filename)` 惰性 `require('serialport')`，
失败抛 `SerialPortUnavailableError`（带可操作提示），串口控制台不可用但**其余功能不受影响**。
即使遇到意外环境（如 musl 的 Alpine server），也只是少一个功能而非扩展崩溃。

### 5.4 两个澄清

- `engines.node: >=20.19.0`（`package.json:30`）只在本机 `npm install` / 构建时由 npm 校验，
  **VSCode 宿主不读它**——1.85 宿主是 Node 18.15，与该声明无关，不构成远端要求。
- 未声明 `extensionKind`：默认「UI + workspace」均可运行，远端窗口装在 server 侧；
  本扩展的树视图 / Webview 面板 / 文件系统操作均为远端可用形态，无「必须 UI 侧」的 API。

## 6. 兼容更老版本的路径（「不特别老」的落地建议）

### 6.1 降到 1.75：零代码改动（推荐动作）

1. `package.json`：`engines.vscode` → `^1.75.0`；`@types/vscode` → `"1.75.0"`（精确，去 `^`）；
2. `vite.config.ts` 显式加 `build.target: 'chrome108'`（与 1.75 基线对齐，固定语义）；
3. 重打 VSIX（`npm run package:vsix`），在一台 1.75 桌面版 / vscode-server 上冒烟：
   五个树视图、两个 Webview 弹框（分支编译 / 串口控制台）、任务运行/停止、串口枚举、信任门禁。

### 6.2 更老的版本为什么不建议

| 目标版本    | 需要的改动                                                                                                                            | 评估            |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| 1.74 及以下 | 激活策略改 `*`（牺牲「启动完成后激活」语义）+ Vite target 降到 chrome102 以下                                                         | ❌ 不推荐       |
| 1.58 以下   | 拆除 `TreeItemLabel.highlights` 类依赖（当前未用，暂无项）                                                                            | —               |
| 1.57 以下   | 移除 Workspace Trust 门禁（`isTrusted`/`onDidGrantWorkspaceTrust`/`untrustedWorkspaces` capability）与 `taskExecutions`，改用降级方案 | ❌ 收益极低     |
| 1.47 以下   | `workspace.fs` 全部换回 `node:fs` + workspace 路径拼接                                                                                | ❌ 违背架构选型 |

1.75 与 1.85 之间的宿主差异（Electron 22→25、Node 16→18）对本扩展的 API 面无实质影响，
1.75 是成本/收益的最优点。

## 7. 参考与其他文档的关系

- 版本映射来源：[VS Code 1.75 Release Notes（Electron 22 / Chromium 108 / Node 16.17）](https://code.visualstudio.com/updates/v1_75)、
  [ewanharris/vscode-versions（各版本 Electron/Chromium/Node 对照表）](https://github.com/ewanharris/vscode-versions)。
- 相关：[03-技术选型与架构](03-技术选型与架构.md)（Vite/esbuild 双构建、CSP 矩阵）、
  [08-第三轮三审报告](08-代码质量与UI设计三审报告.md)（打包与 .vscodeignore 白名单）。
- 复核触发条件：新增 `vscode.*` API 调用、调整 `engines.vscode`、升级 Vite 大版本。
