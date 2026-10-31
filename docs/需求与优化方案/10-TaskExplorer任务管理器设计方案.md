# TaskExplorer 任务管理器设计方案（仅 `.vscode/tasks.json`）

> 文档分层：第四层 · 设计与决策（10）｜**状态**：已实施（v2.3.0，2026-10-31；实现见 `src/extension/features/taskExplorer/`，M0 假设经宿主集成测试实证）｜**目标版本**：v2.3.0（minor）
> 编制：2026-10-31｜修订：v2.1（2026-10-31）增补「最近运行 / 收藏 / 刷新按钮 / 运行·停止·定位到 tasks.json 行」，并明确最近运行与收藏固定显示在视图顶部。
> 需求来源：参考 [vscode-taskexplorer](https://github.com/spmeesseman/vscode-taskexplorer) ，在当前插件中新增任务管理功能，**只加载工作区 `.vscode/tasks.json` 定义的任务**并树形展示。
> 本轮范围：设计方案 + 功能代码实现（原稿为「只出方案」，实施轮同日完成）。

---

## 0. 结论先行

**采用「VS Code 原生 Task API 投影」方案**：用 `vscode.tasks.fetchTasks()` 取回任务，只保留 `task.source === 'Workspace' && task.scope` 是工作区文件夹（`WorkspaceFolder`）的任务，再挂到自有 `TreeView` 上；运行直接 `vscode.tasks.executeTask(task)`。

这样做的三个直接收益：

1. **过滤天然精确**：工作区 `.vscode/tasks.json` 解析出的任务（含 `shell`/`process`/`npm` 等 contributed type）都会带上 `source='Workspace'` 与所属 `WorkspaceFolder` 的 `scope`；而用户级 `tasks.json`、`.code-workspace` 级任务共享 `source` 标签但**没有文件夹 scope**，会被同一条件排除（依据见 §3.2）。
2. **`dependsOn` 零成本正确**：`fetchTasks()` 返回的 `Task` 带内部 `_id`，`executeTask` 会走 `TaskHandleDTO` 交回主线程**按 id 重新解析**，`dependsOn` / `dependsOrder` / 循环检测 / 失败短路全部由 VS Code 任务引擎完成，扩展不复制一套编排逻辑（依据见 §3.3）。
3. **不新增运行时依赖**：不引入 `jsonc-parser`、不读文件做二次解析、不复刻变量替换与 provider 解析，包体与打包白名单不受影响（门禁约束见 §12.3）。

在此之上补齐**任务运营能力**（v2.1 增补）：

- 视图顶部**固定**显示「最近运行」「收藏」两个分组（顺序：最近运行 → 收藏 → 工作区任务），即使为空也显示「暂无」占位，便于发现。
- 每个任务节点支持：**运行**、**停止**（运行中）、**收藏/取消收藏**、**定位到 tasks.json 对应 `label` 行**；标题栏提供**刷新**按钮。
- 最近运行 / 收藏只存任务身份（`scopeUri + source + name`）到 `workspaceState`，跨窗口恢复、按工作区隔离；不存 Task 对象，不复制输出。
- 定位采用**内置轻量 JSONC 扫描**（只找 `"label"` 行），不新增依赖；解析失败时降级为打开文件顶部并提示（§4.3、§8.4）。

**明确不做的**：不解析 `tasks.json` 用于发现/执行、不展示依赖关系边、不做执行历史（输出/耗时/退出码统计）与使用统计、不做多任务源探测。依赖关系在 API 层不可得（任务 `definition` 不含 `dependsOn`，依据见 §3.4），若后续产品上必须展示，再走 P2「只读解析用于展示」的增量方案（§4.4），不影响本期执行正确性。

---

## 1. 背景与目标

### 1.1 现状

插件目前有 4 个 `TreeView`（环境信息、环境初始化、分支编译、串口服务器）与 1 个构建 Webview，**没有任务视图**。仓库自身的 `.vscode/tasks.json` 定义了两条 npm 类型任务（`npm: compile`、`npm: watch`），但只能在「终端 → 运行任务」或命令面板中看到，缺少与插件其他能力一致的统一入口。

### 1.2 目标

| 编号 | 目标                                                                                       |
| ---- | ------------------------------------------------------------------------------------------ |
| G1   | 自动发现并展示**仅**工作区 `.vscode/tasks.json` 定义的任务                                 |
| G2   | 树形展示：工作区任务组下 单根为「tasks.json → 任务」，多根为「文件夹 → tasks.json → 任务」 |
| G3   | 单击/行内按钮即可运行；`dependsOn`、`dependsOrder` 语义与 VS Code 原生一致                 |
| G4   | 运行中的任务有可辨识状态（图标/菜单切换），可停止                                          |
| G5   | 文件变化、工作区文件夹变化、信任授予后自动刷新；无轮询                                     |
| G6   | 不新增运行时依赖；单测覆盖新增模块；不破坏现有 9 步门禁                                    |
| G7   | 视图顶部**固定**展示「最近运行」「收藏」两个分组（为空也显示占位）                         |
| G8   | 任务可收藏/取消收藏，运行后自动进入最近运行；两者按工作区持久化                            |
| G9   | 任务节点可一键定位到 `.vscode/tasks.json` 中对应 `label` 行；标题栏可刷新                  |

### 1.3 非目标

- 不做 `tasks.json` 之外的任何任务源（npm 自动探测、gulp、grunt、make、maven、gradle、ant、脚本文件探测等）——即使它们在 VS Code 里可用。
- 不做执行历史（输出、耗时、退出码曲线、使用统计）；「最近运行」只保留最近任务身份（默认展示 10 条），不保存输出，不跨工作区共享。
- 不提供收藏夹多层级、标签、搜索过滤；收藏与最近运行均为工作区级（`workspaceState`）。
- 不自建「任务执行器 / 依赖编排器」，不镜像终端输出。
- 不支持在受限模式（Restricted Mode）下运行任务。
- 不改 Webview、不改构建脚本、不新增第三方依赖。

### 1.4 用户示例的行为推演

需求给出的 `tasks.json`（`version: "2.0.0"`，两条 shell 任务，`common-down_pack_code` 依赖 `common-down_pwd_xml`）：

```json
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "common-down_pack_code",
      "type": "shell",
      "command": "python down_local_pack_file.py ${workspaceRoot}/Output/ru_local_pack",
      "dependsOn": ["common-down_pwd_xml"],
      "options": { "cwd": "${workspaceRoot}/Inner/rusoft/ci/local_pack/" }
    },
    {
      "label": "common-down_pwd_xml",
      "type": "shell",
      "command": "rsync -r XXXXXXX::code/pw/XXXX.xml ./XXX.xml",
      "options": { "cwd": "${workspaceRoot}/../" }
    }
  ]
}
```

单根工作区下树形（顶部两个分组固定显示，空时显示「暂无」）：

```text
最近运行 (1)
└─ common-down_pack_code
收藏 (1)
└─ common-down_pwd_xml
工作区任务 (2)
└─ tasks.json (2)
   ├─ common-down_pack_code
   └─ common-down_pwd_xml
```

- 最近运行/收藏中的节点与「工作区任务」中的是同一任务的引用；运行态、收藏态、定位行为完全一致。
- 运行 `common-down_pack_code` 后，它进入「最近运行」首位；收藏 `common-down_pwd_xml` 后，它同时出现在「收藏」与「工作区任务」中（去重仅发生在各自列表内部）。

单击 `common-down_pack_code`：

1. 扩展调用 `executeTask(common-down_pack_code)`；
2. 主线程按 `(workspaceFolder, taskId)` 重新解析出 tasks.json 原始任务；
3. 引擎先执行依赖 `common-down_pwd_xml`（`cwd` 为 `${workspaceRoot}/../`），默认**并行启动所有依赖并等待完成后**再执行本任务命令；
4. 依赖成功后执行 `python down_local_pack_file.py ${workspaceRoot}/Output/ru_local_pack`（`cwd` 为 `${workspaceRoot}/Inner/rusoft/ci/local_pack/`）；
5. 两个任务节点在各自执行期间显示 `sync~spin`，结束后恢复；`${workspaceRoot}` 由引擎解析（该变量已废弃但仍兼容，建议用户改用 `${workspaceFolder}`）。

---

## 2. 范围与需求对齐

| 需求            | 方案落点                                                           | 验收                                 |
| --------------- | ------------------------------------------------------------------ | ------------------------------------ |
| 自动加载任务    | `WorkspaceTaskSource.load()`（`fetchTasks` + `source/scope` 过滤） | 打开含 tasks.json 的工作区即出现任务 |
| 只加载该类      | 过滤掉用户级、`.code-workspace` 级、扩展 provider 任务             | 负向用例（§11.2）                    |
| 树形加载        | 顶部「最近运行/收藏」+「工作区任务」三组；单根 3 层、多根 4 层     | 单根、多根快照断言                   |
| 任务定义方式    | 直接使用 VS Code 解析结果，支持 `shell`/`process`/contributed type | 仓库自带 npm 任务可见（§11.3）       |
| dependsOn       | 交原生引擎（TaskHandle 重解析）                                    | 手工验收 + 引擎日志                  |
| 最近运行        | 运行成功后写入 `workspaceState`，顶部固定分组，展示最近 10 条      | 运行→置顶；重开窗口仍在              |
| 收藏            | 星标切换，写 `workspaceState`，顶部固定分组                        | 收藏/取消收藏；重开窗口仍在          |
| 任务级操作      | 运行 / 停止 / 收藏 / 定位 / 刷新                                   | 行内按钮 + 右键菜单                  |
| 定位 tasks.json | 内置 JSONC 扫描 `label` 行 + 打开并选中                            | 正确定位行；异常降级到文件顶部       |
| 刷新按钮        | `view/title` 刷新命令，清空去抖队列                                | 点击即重新加载                       |

---

## 3. 调研结论与依据

### 3.1 vscode-taskexplorer 的可借鉴点

调研基于其删除源码前的最后提交 [`ebe6de92`](https://github.com/spmeesseman/vscode-taskexplorer/tree/ebe6de92fa8040175c8ad6a702e5057ca71446f2)（master 源码已于 2025-08-14 删除）。

| 借鉴                                    | 说明                                                                                    |
| --------------------------------------- | --------------------------------------------------------------------------------------- |
| 用 `fetchTasks()` 而非自解析 tasks.json | 内置 provider 已把变量、provider 类型、多根解析好；扩展只做来源筛选                     |
| 执行只调 `executeTask(task)`            | `dependsOn` 完全交给引擎（其源码中 `dependsOn` 出现 0 次）                              |
| `contextValue` 驱动菜单                 | 运行中把 `workspaceTask` 切成 `workspaceTaskRunning`，行内按钮随 `when` 自动切换        |
| 运行态用 `tasks.taskExecutions` 匹配    | 不维护脆弱的「开始/结束计数」；本文进一步用事件触发 + 扫描执行列表                      |
| watcher 刷新                            | 文件变化后刷新；本文补 300ms 去抖，避免其「无 debounce 导致事件风暴」的已知问题（#133） |
| 顶部最近运行 / 收藏分组                 | 取其轻量形态：固定置顶、按工作区持久化；不做多夹层、特殊夹、统计 Webview                |
| 状态栏显示运行中任务                    | **不采用**（一期范围控制），运行态在树内表达即可                                        |

| 舍弃                                                                         | 原因                                                            |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------- |
| ant/gradle/maven/gulp/grunt/make 等 10+ 任务源探测                           | 与「只加载 tasks.json」需求相悖，且占其体积主体                 |
| Favorites / Last Tasks 的完整实现（多夹层、User Tasks 夹、使用统计 Webview） | 超出需求；本期只保留顶部轻量「最近运行 / 收藏」，不存输出与统计 |
| 分隔符分组、`hide` 过滤                                                      | 前者非需求；后者需要二次解析文件，列为 P2                       |
| 终端名模糊匹配                                                               | 脆弱；本方案不接管终端，只调 API                                |
| 47 条命令                                                                    | 本方案 8 条命令，够用即可                                       |

### 3.2 为什么 `source + scope` 能精确锁定工作区 `tasks.json`

源码链路（VS Code `main` 分支）：

| 事实                                                                                                                                                          | 证据                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fetchTasks` 返回「tasks.json 任务 + 各 provider 任务」，`TaskFilter` 只有 `type`，没有来源过滤                                                               | `src/vs/workbench/api/common/extHostTask.ts:489-500`；API 文档 _Tasks_ 页                                                                                                                                         |
| tasks.json 解析时，User / WorkspaceFile / Workspace 三种来源的任务 label 都硬编码为 `'Workspace'`                                                             | `src/vs/workbench/contrib/tasks/common/taskConfiguration.ts:1446`（`const label = 'Workspace'`）、`:1590-1602`（三处 source 构造）                                                                                |
| 普通 `shell`/`process` 自定义任务由 `CustomTask.from` 生成，source 取配置文件来源                                                                             | `taskConfiguration.ts:1567-1646`                                                                                                                                                                                  |
| `type: "npm"` 等 contributed type 先解析为 `ConfiguringTask`，再由 provider 解析；`createCustomTask` **沿用配置文件 source**                                  | `taskConfiguration.ts:1677-1726`（`Object.assign({}, configuredProps._source, { customizes: contributedTask.defines })`）                                                                                         |
| 因此 `source === 'Workspace'` 覆盖 tasks.json 中**所有类型**的任务，而不是只有 shell                                                                          | 上述两条合并结论                                                                                                                                                                                                  |
| 用户级 tasks.json / `.code-workspace` 任务虽然 label 同为 `'Workspace'`，但 source 不带 `config.workspaceFolder`，API 侧 `scope` 退化为 `TaskScope.Workspace` | `src/vs/workbench/api/browser/mainThreadTask.ts:292-309`（Workspace kind 才设置 scope URI，User/WorkspaceFile 不设置）；`src/vs/workbench/api/common/extHostTask.ts:265-266`（无 scope 时 `TaskScope.Workspace`） |
| 扩展 provider 的任务 source 为扩展名（如 `npm`、`gulp`），scope 多为 `TaskScope.Workspace` 或全局                                                             | `src/vs/workbench/api/browser/mainThreadTask.ts:292-309` + 其 `getDefinition` 逻辑                                                                                                                                |
| 受限模式下 `fetchTasks` 直接返回 `[]`                                                                                                                         | `src/vs/workbench/contrib/tasks/browser/abstractTaskService.ts:1054-1062`（`if (!(await this._trust())) return []`）                                                                                              |

**过滤规则**（也是唯一需要「猜」的地方，故列为 M0 验证项）：

```ts
const WORKSPACE_TASK_SOURCE = 'Workspace' // VS Code 对 tasks.json 任务的硬编码 source label

function isWorkspaceFileTask(
  task: vscode.Task
): task is vscode.Task & { scope: vscode.WorkspaceFolder } {
  return task.source === WORKSPACE_TASK_SOURCE && isWorkspaceFolder(task.scope)
}
```

### 3.3 为什么 `dependsOn` 交给引擎即可

| 事实                                                                                                                          | 证据                                                                                                                                                                                                                                                |
| ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fetchTasks()` 返回的 `Task` 携带内部 `_id`                                                                                   | `src/vs/workbench/api/common/extHostTask.ts:338-340`（`value._id` 赋给 `result._id`）                                                                                                                                                               |
| `executeTask(task)` 发现 `_id` 后走 `TaskHandleDTO`，主线程按 `(workspaceFolder, id)` 重新取任务，而不是使用 DTO 重建         | `src/vs/workbench/api/node/extHostTask.ts:58-75`；`src/vs/workbench/api/browser/mainThreadTask.ts:675-716`；注释原文：_"Passing in a TaskHandleDTO will cause the task to get re-resolved … since they can have missing configuration properties."_ |
| 重新解析出的 `CustomTask` 带 `configurationProperties.dependsOn`，由任务系统执行依赖                                          | `src/vs/workbench/contrib/tasks/browser/terminalTaskSystem.ts:525-621`（依赖 resolve、循环检测、DependsOnStarted 事件、`DependsOrder.sequence` 分支）                                                                                               |
| 多依赖默认并行；`dependsOrder: "sequence"` 按声明顺序串行，`exitCode !== 0` 时后续依赖与本任务短路                            | 同上 `:571-576`；官方 _Tasks_ 文档                                                                                                                                                                                                                  |
| 循环依赖由引擎记录 `There is a dependency cycle …`，依赖方命令不执行；缺失依赖记录 `Couldn't resolve dependent task …` 后跳过 | 同上 + 官方文档                                                                                                                                                                                                                                     |
| 新建（无 `_id`）的 `Task` 走 DTO 路径，`configurationProperties` 不包含 `dependsOn`，因此自建任务**不会**触发依赖             | `mainThreadTask.ts:345-382`（DTO 仅有 `{name, identifier, group, isBackground, problemMatchers, detail, icon, hide}`）                                                                                                                              |

结论：**只执行 `fetchTasks()` 返回的对象，绝不重建 `ShellExecution`**。这是本设计的关键红线，写入代码注释与评审清单。

### 3.4 不能做的事（API 边界）

- `vscode.Task.definition` 来自主线程 `task.getDefinition(true)`（`mainThreadTask.ts:353`）。对普通 shell/process 任务，`CustomTask.getDefinition` 只返回 `{ type: 'shell' | 'process', _key, id }`；对 contributed type 任务返回 provider 的 `defines`（如 `{ type: 'npm', script: 'compile' }`）。**都不含 `dependsOn`**，因此无法从 API 画依赖边。
- `vscode.tasks.taskExecutions` 只有 `{ task, terminate() }`，没有执行 id、开始时间、退出码。退出码需监听 `onDidEndTaskProcess`（本期不用于树展示）。
- `hide` 只影响 Quick Pick，不影响 `fetchTasks` 结果的可见性；要按 `hide` 过滤必须二次解析文件（P2）。
- `runTask` 命令不返回 `TaskExecution`，无法绑定状态/停止，故不用；一律 `executeTask`。

### 3.5 变量与类型

- 变量替换（`${workspaceFolder}`、`${workspaceRoot}`、`${env:VAR}`、`${file}` 等）由引擎在**执行时**完成；API 返回的 `execution` 保留原始字符串。树内 tooltip 展示**原始值**，避免使用 `${file}` 时随焦点漂移。
- 任务可以是 `ShellExecution`、`ProcessExecution`、`CustomExecution`（无 `execution` 的复合任务）。tooltip 对三种形态分别降级展示，不影响运行。

---

## 4. 方案选型

### 4.1 候选

| 方案 | 数据来源                                     | `dependsOn`          | 新增依赖       | 维护成本 | 结论     |
| ---- | -------------------------------------------- | -------------------- | -------------- | -------- | -------- |
| A    | `fetchTasks()` + `source/scope` 过滤         | 原生引擎，完全一致   | 无             | 低       | **采用** |
| B    | 自行读取并解析 `.vscode/tasks.json`（JSONC） | 自行编排 `dependsOn` | `jsonc-parser` | 高       | 不采用   |
| C    | A + 解析文件仅用于展示依赖/`hide`            | 原生引擎             | `jsonc-parser` | 中       | P2 备选  |

### 4.2 不选 B 的理由

1. **解析复杂度被低估**：JSONC（注释/尾逗号）、`windows/linux/osx` 覆盖、`options.shell`、变量两趟替换、`${workspaceFolder:Name}` 多根，以及 `npm`/`tsc` 等 contributed type 的 provider 解析，全部要复刻；`vscode-taskexplorer` 的 `hide` 过滤就是靠 json5 二次解析绕开 API 的，属于同类成本。
2. **准确性反而下降**：自建 `Task`（无 `_id`）会丢 `dependsOn`；自建依赖编排会与引擎在失败短路、循环、后台依赖 `problemMatcher` 判定上产生分歧。
3. **需求已满足**：`source + scope` 已能精确锁定工作区 tasks.json（§3.2），B 是重复建设。

### 4.3 定位到 `tasks.json` 行：轻量扫描而非引入解析器

| 方案 | 做法                                                               | 新增依赖       | 精度                                              | 结论     |
| ---- | ------------------------------------------------------------------ | -------------- | ------------------------------------------------- | -------- |
| D    | 内置 JSONC 扫描：只识别字符串/注释/转义，找到 `"label"` 键与匹配值 | 无             | 高（tasks.json 单文件；label 为任务唯一标识）     | **采用** |
| E    | `jsonc-parser` 的 `parseTree` + `findNodeAtLocation(['tasks', i])` | `jsonc-parser` | 最高（可处理重复 label 的精确节点、结构化位置）   | 不采用   |
| F    | 正则 `"label"\\s*:\\s*"name"` 直接匹配                             | 无             | 低（命令/注释中的同名文本会误命中，无法处理转义） | 不采用   |

不选 E 的理由：定位是**只读、非关键路径**功能，失败可降级为打开文件顶部；为它引入运行时依赖会突破「依赖仅 serialport」红线并增加包体门禁成本。不选 F 的理由：`tasks.json` 的命令/参数/注释里完全可能出现 `label` 字样，正则误命中会跳到错误行，体验比降级更差。

扫描器约束（`tasksJsonLocator.ts`）：

- 只认双引号字符串、`//` 与 `/* */` 注释、`\` 转义；不构建完整 AST、不校验 JSON 合法性。
- 找到 `"label"` 键后跳过空白与冒号，读取紧随的字符串值；对 `\" \\ \/ \b \f \n \r \t \uXXXX` 解码后与任务名比较。
- 返回 `label` 键的**行号/偏移**；找不到或文件损坏返回 `undefined`，由命令降级打开文件顶部并提示。
- 重复 label（VS Code 本身会报歧义）取第一个匹配；功能文档注明。

### 4.4 P2 演进（按需）

若评审要求「树上可见依赖关系」或「按 `hide` 过滤」：新增 `taskFileIndex.ts`，用 `jsonc-parser` 只读解析每个工作区文件夹的 `.vscode/tasks.json`，产出 `label → dependsOn[]` 映射，仅用于 **tooltip 与「依赖」子节点展示**；运行仍走 A 路径；定位也可顺带升级到 E 方案。该演进需要新增依赖并重跑包体门禁，单独排期，不在 v2.3.0 范围。

---

## 5. 总体架构

### 5.1 分层

```text
┌──────────────── VS Code 宿主（taskService / TaskSystem）────────────────┐
│ fetchTasks()   executeTask(fetchedTask)   taskExecutions                │
│ onDidStartTask / onDidEndTask / onDidGrantWorkspaceTrust                │
└───────▲─────────────────────▲──────────────────────────▲────────────────┘
        │                     │                          │
 WorkspaceTaskSource   TaskExplorerController ───► TaskStatusTracker
 （过滤/排序/分组）      （watcher、信任、去抖、命令编排）   （运行态扫描/终止）
        │                     │
        │               TaskUsageStore（workspaceState：最近运行/收藏）
        │                     │
        └──────► TaskExplorerTreeProvider ──► TreeView extStarter.taskExplorerView
                 （最近运行 / 收藏 / 工作区任务）
```

### 5.2 新增/修改文件

| 文件                                                              | 动作         | 职责                                                                                                     |
| ----------------------------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------- |
| `src/extension/features/taskExplorer/taskSource.ts`               | 新增         | `WorkspaceTaskEntry`、`TaskRef`、`isWorkspaceFileTask`、`taskKey`、`loadWorkspaceTasks`、`groupByFolder` |
| `src/extension/features/taskExplorer/taskUsageStore.ts`           | 新增         | `workspaceState` 持久化：最近运行/收藏的读取校验、去重、上限、排序、变更事件                             |
| `src/extension/features/taskExplorer/tasksJsonLocator.ts`         | 新增         | 轻量 JSONC 扫描：定位 `"label"` 行（只读，不新增依赖）                                                   |
| `src/extension/features/taskExplorer/taskStatusTracker.ts`        | 新增         | 监听开始/结束事件、扫描 `taskExecutions`、`isRunning`、`terminate`、去抖变更事件                         |
| `src/extension/features/taskExplorer/taskExplorerTreeProvider.ts` | 新增         | 三组根节点、folder/file/task/info 节点、运行态与收藏态图标、空态                                         |
| `src/extension/features/taskExplorer/taskExplorerController.ts`   | 新增         | 组装 source/usage/status/provider、watcher、信任、运行/停止/定位/收藏/清空/打开 tasks.json               |
| `src/extension/commands/taskExplorerCommands.ts`                  | 新增         | 8 条命令注册（薄壳，全部委托 controller）                                                                |
| `src/extension/commands/index.ts`                                 | 修改         | `CommandDeps` 增加 `taskExplorer`，调用 `registerTaskExplorerCommands`                                   |
| `src/extension/index.ts`                                          | 修改         | 装配 controller（含 `workspaceState` 注入）+ `createTreeView`，注入命令依赖                              |
| `src/extension/constants.ts`                                      | 修改         | 视图 ID、3 个组 + 4 个任务 contextValue、8 个命令 ID、storage key                                        |
| `package.json`                                                    | 修改         | 视图、8 条命令、菜单、`package.nls` 文案                                                                 |
| `package.nls.json` / `package.nls.zh-cn.json`                     | 修改         | 视图名与命令标题                                                                                         |
| `src/test/unit/stubs/vscode.ts`                                   | 修改         | 增量补 `tasks`、`Position`/`Range`/`Selection`/`TextEditorRevealType`、假文档与假 editor                 |
| `src/test/unit/*.spec.ts`（7 个新文件）                           | 新增         | 单测（§11）                                                                                              |
| `src/test/extension.test.ts`                                      | 修改（可选） | 宿主集成：命令已注册 + 仓库 tasks.json 任务可被过滤                                                      |
| `docs/功能介绍/07-TaskExplorer任务管理器.md` 等文档               | 实施时新增   | 功能说明 / 开发指南 / 索引 / CHANGELOG / 版本号                                                          |

> 新增约 700 行产品代码 + 700 行测试；均为纯 TS，不触碰 Webview 与构建脚本。

### 5.3 关键设计红线（评审用）

1. 任务对象只来自 `fetchTasks()`，禁止 `new vscode.Task(...)` 后交给 `executeTask`。
2. 运行态以 `tasks.taskExecutions` 扫描为准，不以事件计数为准。
3. 所有异步回调（watcher/事件/命令）都必须吞掉异常并写输出通道，避免未捕获拒绝。
4. 新增代码不引入依赖；`package.json` 的 `dependencies` 保持只有 `serialport`。
5. 最近运行/收藏只存 `TaskRef` 到 `workspaceState`，不存 `Task` 对象；恢复时按 key 重新匹配，匹配不到时收藏隐藏但保留、最近运行由上限淘汰。
6. 定位是只读辅助能力：扫描失败必须降级为「打开文件顶部 + 提示」，不阻塞运行/刷新，也不参与任务发现与依赖判断。
7. 最近运行只在「本扩展运行命令成功调用 `executeTask` 之后」记录；依赖任务、命令面板/其他扩展触发的执行不写入。

---

## 6. 数据层设计

### 6.1 类型

```ts
/** 任务身份：存 workspaceState，不存 Task 对象 */
export interface TaskRef {
  readonly scopeUri: string
  readonly source: string
  readonly name: string
}

export interface RecentTaskRef extends TaskRef {
  readonly lastRunAt: number
}

export interface TaskUsage {
  readonly version: 1
  readonly favorites: TaskRef[]
  readonly recent: RecentTaskRef[]
}

export interface WorkspaceTaskEntry {
  readonly task: vscode.Task
  readonly folder: vscode.WorkspaceFolder
  readonly key: string
  readonly label: string // task.name，用于排序
  readonly ref: TaskRef // 与 key 一一对应
}
```

`key` 采用 `scope.uri + '\u0000' + source + '\u0000' + name`，避免多根同名任务串扰（与 vscode-taskexplorer 的 `(name, source, scope, path)` 四元组等价，但更短）。`TaskRef` 是 key 的可持久化拆解，`taskKeyFromRef(ref)` 用同一规则拼回，保证「存储 → 匹配」不依赖对象引用。

### 6.2 加载

```ts
export async function loadWorkspaceTasks(): Promise<WorkspaceTaskEntry[]> {
  const tasks = await vscode.tasks.fetchTasks()
  return tasks
    .filter(isWorkspaceFileTask)
    .map((task) => {
      const folder = task.scope as vscode.WorkspaceFolder
      return { task, folder, key: taskKey(task), label: task.name, ref: taskRef(task) }
    })
    .sort(
      (a, b) =>
        a.folder.name.localeCompare(b.folder.name, 'zh-Hans-CN') ||
        a.label.localeCompare(b.label, 'zh-Hans-CN')
    )
}
```

说明：

- **不去重**：VS Code 保证同一文件夹内任务名唯一；跨文件夹由 key 区分。
- **排序**：文件夹按名称、任务按名称 `localeCompare('zh-Hans-CN')`，与仓库现有树排序风格一致。
- **错误**：`fetchTasks` 抛错时不吞，交给 provider 置错误态并写输出通道。

### 6.3 分组

```ts
export function groupByFolder(
  entries: readonly WorkspaceTaskEntry[]
): ReadonlyMap<vscode.WorkspaceFolder, WorkspaceTaskEntry[]> {
  const groups = new Map<vscode.WorkspaceFolder, WorkspaceTaskEntry[]>()
  for (const entry of entries) {
    const list = groups.get(entry.folder) ?? []
    list.push(entry)
    groups.set(entry.folder, list)
  }
  return groups
}
```

单根时只用第一个分组；多根时按 `workspace.workspaceFolders` 的顺序展示（保持 VS Code 资源管理器顺序），`workspaceFolders` 中无任务的文件夹**不显示**。

### 6.4 最近运行与收藏的持久化（`taskUsageStore.ts`）

存储位置：`context.workspaceState`（按工作区隔离、跨窗口恢复），key 为 `STORAGE.taskExplorerUsageKey = 'extStarter.taskExplorer.usage'`。

```json
{
  "version": 1,
  "favorites": [{ "scopeUri": "file:///e%3A/work", "source": "Workspace", "name": "build" }],
  "recent": [
    {
      "scopeUri": "file:///e%3A/work",
      "source": "Workspace",
      "name": "build",
      "lastRunAt": 1761912345678
    }
  ]
}
```

读取与校验：

- 只接受 `version === 1`；`favorites` / `recent` 必须是数组，元素三个字段均为非空字符串，`lastRunAt` 为有限数字。
- 任一元素结构非法 → 丢弃该条并写输出通道；整体结构非法/版本不符 → 重置为空结构（不删除用户的其他 memento 数据）。
- 读取后按 `taskKeyFromRef` 去重：`favorites` 保留首次出现；`recent` 保留 `lastRunAt` 最大的一条，并按时间倒序。
- `recent` 读取上限 20 条（展示上限 10），`favorites` 不设上限。

接口（便于单测与 controller 复用）：

```ts
export class TaskUsageStore implements vscode.Disposable {
  constructor(memento: vscode.Memento, output: vscode.OutputChannel)

  readonly onDidChange: vscode.Event<void>
  getFavorites(): readonly TaskRef[]
  getRecent(): readonly RecentTaskRef[]
  isFavorite(key: string): boolean
  addFavorite(ref: TaskRef): boolean // 已存在返回 false
  removeFavorite(ref: TaskRef): boolean
  recordRun(ref: TaskRef, at?: number): void // 去重置顶 + 上限 20
  clearRecent(): void
  dispose(): void
}
```

写入策略：

- 全部写操作即时 `memento.update`（数据量小），写失败捕获异常、写输出通道并继续以内存状态提供 UI（下次读取回退到磁盘值）。
- `recordRun` 仅在 controller 的 `run` 命令 `await executeTask()` 成功后调用；依赖任务由引擎启动，不经过该命令，因此不会污染最近列表。
- `clearRecent` 由命令「清空最近运行」调用，先弹一次模态确认（`showWarningMessage(..., { modal: true }, '清空')`），避免误操作。
- 不自动淘汰收藏；最近运行只按 20 条上限淘汰，`favorites`/`recent` 均不因任务暂时不可解析而删除（显示层隐藏，见 §7.7）。

### 6.5 可测试性

`loadWorkspaceTasks` 依赖全局 `vscode.tasks`，测试由 §11.1 的桩提供；`isWorkspaceFileTask` / `taskKey` / `taskKeyFromRef` / `groupByFolder` 为纯函数，直接断言。`TaskUsageStore` 构造时注入 memento（现有 `createMementoStub`）与输出通道，无需真实 `ExtensionContext`。

---

## 7. 树视图设计

### 7.1 节点模型

```ts
export type TaskExplorerGroup = 'recent' | 'favorites' | 'tasks'

export type TaskExplorerNode =
  | { kind: 'group'; group: TaskExplorerGroup; children: TaskExplorerNode[] }
  | { kind: 'folder'; folder: vscode.WorkspaceFolder; entries: WorkspaceTaskEntry[] }
  | { kind: 'file'; folder: vscode.WorkspaceFolder; entries: WorkspaceTaskEntry[] }
  | { kind: 'task'; entry: WorkspaceTaskEntry }
  | { kind: 'info'; text: string; icon: string; tooltip?: string }
```

三个 `group` 节点由 provider 持有**固定实例**（只在刷新时替换 `children`），因此刷新后展开状态不丢；`folder` / `file` / `task` / `info` 每次加载重建。所有变更统一通过 `_onDidChangeTreeData.fire()`。

所有 `TreeItem` 额外设置稳定 `id`（`group:recent` / `folder:${uri}` / `file:${uri}` / `task:${key}`），用于刷新后尽量保持展开与选中状态；`id` 只要求树内唯一，不参与任务匹配。

### 7.2 根分组与层级

三个根分组**始终显示、顺序固定**（用户明确要求「在顶部显示 最近运行、收藏」）：

| 根节点     | 内容                                           | 空态                                           |
| ---------- | ---------------------------------------------- | ---------------------------------------------- |
| 最近运行   | 按 `lastRunAt` 倒序、最多 10 个任务节点        | `info`：暂无最近运行的任务 + tooltip 说明      |
| 收藏       | 匹配到的收藏任务，按任务名排序                 | `info`：暂无收藏的任务 + tooltip 说明          |
| 工作区任务 | 单根为 `tasks.json` 文件节点；多根为文件夹节点 | `info`：未发现任务 / 未打开工作区 / 受限模式等 |

层级：

| 场景     | 根                           | 二级                        | 三级 / 四级                      |
| -------- | ---------------------------- | --------------------------- | -------------------------------- |
| 单根     | 最近运行 / 收藏 / 工作区任务 | 工作区任务 → `tasks.json`   | `tasks.json` → N 个任务          |
| 多根     | 最近运行 / 收藏 / 工作区任务 | 工作区任务 → 有任务的文件夹 | 文件夹 → `tasks.json` → N 个任务 |
| 无任务   | 三组（最近/收藏为空 info）   | 工作区任务 → info           | —                                |
| 加载失败 | 三组；任务组首位 error info  | 旧数据仍展示                | —                                |

展开策略：

- 三个分组默认 `Expanded`（空组也展开，让「暂无」占位可见，用户能发现该能力）；
- `file` 节点 `Expanded`；多根 `folder` 节点 `Collapsed`；`TreeView` 创建时 `showCollapseAll: true`。
- 单根也保留 `tasks.json` 文件节点（与 vscode-taskexplorer 的 File→Task 一致，便于右键打开文件、看到任务来源）；`description` 显示任务数。

### 7.3 TreeItem 规格

| 节点              | label         | description        | iconPath                                       | contextValue                 | command                                       |
| ----------------- | ------------- | ------------------ | ---------------------------------------------- | ---------------------------- | --------------------------------------------- |
| `group.recent`    | `最近运行`    | `${n}` 条          | `history`                                      | `taskExplorerGroupRecent`    | 无                                            |
| `group.favorites` | `收藏`        | `${n}` 条          | `star-full`                                    | `taskExplorerGroupFavorites` | 无                                            |
| `group.tasks`     | `工作区任务`  | `${n}` 个          | `list-tree`                                    | `taskExplorerGroupTasks`     | 无                                            |
| `folder`          | `folder.name` | `${n} 个任务`      | `ThemeIcon('folder')`                          | `taskExplorerFolder`         | `openTasksJson`（参数 `folder`）              |
| `file`            | `tasks.json`  | `${n} 个任务`      | `resourceUri`（`.vscode/tasks.json`）          | `tasksFile`                  | `openTasksJson`（参数 `folder`）              |
| `task`            | `task.name`   | 分组中文名（可空） | 运行中 `sync~spin`；否则 terminal/tools/beaker | 4 种任务态（见下）           | `runWorkspaceTask`（参数 `task`，单击即运行） |
| `info`            | 文案          | —                  | `info` / `warning` / `error` / `shield`        | —                            | 无                                            |

任务 `contextValue` 矩阵（运行态优先决定菜单文案，收藏态决定星标方向）：

| 运行中 | 已收藏 | contextValue                   | 行内按钮               |
| ------ | ------ | ------------------------------ | ---------------------- |
| 否     | 否     | `workspaceTask`                | 运行 / 收藏 / 定位     |
| 是     | 否     | `workspaceTaskRunning`         | 停止 / 收藏 / 定位     |
| 否     | 是     | `workspaceTaskFavorite`        | 运行 / 取消收藏 / 定位 |
| 是     | 是     | `workspaceTaskRunningFavorite` | 停止 / 取消收藏 / 定位 |

- 收藏态**不换主图标**（仍用 terminal / group 图标），避免与运行态 `sync~spin` 冲突；收藏状态由行内星标按钮（`$(star-filled)`）和右键菜单表达。
- 非运行态图标按 `task.group`：`build` → `tools`，`test` → `beaker`，其他/无分组 → `terminal`；运行中统一 `sync~spin`。
- `TreeItem.command.arguments` 传**原始 `vscode.Task`**（不是节点），符合仓库「TreeItem.command 传原始对象」约定；右键菜单收到的是节点，命令内用 `resolveTaskArg` 统一归一化。
- 运行中额外 `ThemeColor('charts.blue')`（可选，与现有串口树运行色一致）。

### 7.4 Tooltip

`task` 节点使用 `MarkdownString`（`isTrusted` 保持默认 false，不拼接用户内容为命令链接）：

```text
**common-down_pack_code**
来源：Workspace（.vscode/tasks.json）
分组：构建
命令：`python down_local_pack_file.py ${workspaceRoot}/Output/ru_local_pack`
工作目录：`${workspaceRoot}/Inner/rusoft/ci/local_pack/`
依赖：由 VS Code 任务引擎自动编排（dependsOn / dependsOrder）
状态：运行中 / 已收藏
```

- `execution` 为 `ShellExecution` → `execution.commandLine`（或 `command + args.join(' ')`）。
- `execution` 为 `ProcessExecution` → `process + args.join(' ')`。
- 无 `execution`（复合任务）→ 显示「复合任务（无直接命令）」。
- `options.cwd` 为 `Uri | string`，统一 `String(cwd)` 展示原始值。
- `isBackground`、`detail`、`group` 有值才展示；收藏/运行中状态行仅在有状态时展示。

### 7.5 空态与异常态

| 条件                     | 位置              | 文案                                                      | 图标      |
| ------------------------ | ----------------- | --------------------------------------------------------- | --------- |
| 最近运行为空             | 最近运行组下      | `暂无最近运行的任务`（tooltip：运行过的任务会出现在这里） | `info`    |
| 收藏为空                 | 收藏组下          | `暂无收藏的任务`（tooltip：点击任务行内的星标收藏）       | `info`    |
| 未打开工作区文件夹       | 工作区任务组下    | `未打开工作区文件夹：无法读取 .vscode/tasks.json`         | `info`    |
| 受限模式（`!isTrusted`） | 工作区任务组下    | `受限模式下不加载任务：信任工作区后自动刷新`              | `shield`  |
| 无任务                   | 工作区任务组下    | `未在 .vscode/tasks.json 中发现任务`                      | `info`    |
| 加载失败                 | 工作区任务组首位  | `任务加载失败：${message}`（tooltip 带完整错误）          | `error`   |
| 存储损坏（最近/收藏）    | 最近运行/收藏组下 | `本地记录已重置`（tooltip：阅读输出通道详情）             | `warning` |

说明：

- 受限模式下 `fetchTasks()` 因信任门禁返回 `[]`（§3.2），必须单独识别 `workspace.isTrusted === false` 才能给出可行动提示；监听 `onDidGrantWorkspaceTrust` 后自动刷新。
- 收藏/最近中**匹配不到当前任务**的条目直接隐藏、不显示 info；`favorites` 保留（防止误删），`recent` 由 20 条上限自然淘汰。若全部失效，对应组显示「暂无…」。

### 7.6 运行态

- `getTreeItem` 时实时查询 `status.isRunning(entry.key)`，决定 `contextValue` 与图标，不缓存布尔值。
- `TaskStatusTracker` 在 `onDidStartTask` / `onDidEndTask` 后 100ms 去抖发一次 `onDidChange`，provider 收到后仅 `fire()`（不重新 `fetchTasks`），保证依赖任务启动/结束时也能刷新。
- 依赖任务的执行同样是 `taskExecutions` 中的条目，若依赖也在视图中，会一并显示转圈；这是期望行为（可观察到「先跑依赖」）。
- 最近运行/收藏中的任务节点与工作区任务中的同 key 节点共享运行态判断，三处显示一致。

### 7.7 收藏与最近运行的显示规则

- provider 加载后维护 `entryByKey: Map<string, WorkspaceTaskEntry>`；两个分组按 `TaskRef` 拼 key，在 map 中查找，**只渲染匹配到的任务**。
- 最近运行：按 `lastRunAt` 倒序，同 key 去重（存储层已去重），最多展示 10 条；每次运行成功后由 store 事件触发 `fire()`，不重新 `fetchTasks`。
- 收藏：按 `entry.label` 排序；任务名变更（key 变化）后旧收藏失配、隐藏保留；用户重新收藏新 key 后两条并存（旧条目不可见，P2 提供清理入口）。
- 组 `description` 用**匹配到的数量**（不是存储条数），避免展示不可操作条目；工具提示说明「有 N 条历史记录暂不可用」可选（P2）。
- 同一任务同时出现在三个分组是**预期行为**，不做跨分区去重；三处的运行/收藏/定位行为完全一致。
- 清空最近运行只清 `recent`，不影响收藏；收藏只能逐条取消（P2 可加「清空收藏」）。

---

## 8. 执行、依赖与停止

### 8.1 运行

```ts
async run(arg: unknown): Promise<void> {
  const entry = resolveEntryArg(arg) // 节点 → entry；原始 Task → 由 taskRef(task) 构造
  if (!entry) {
    void vscode.window.showInformationMessage('请从任务管理器中选择要运行的任务。')
    return
  }
  if (!vscode.workspace.isTrusted) {
    void vscode.window.showWarningMessage('受限模式下不能运行任务，请先信任工作区。')
    return
  }
  try {
    await vscode.tasks.executeTask(entry.task)
    this.usage.recordRun(entry.ref) // executeTask 成功提交后才记入最近运行
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    this.output.appendLine(`[taskExplorer] 运行失败：${message}`)
    void vscode.window.showErrorMessage(`运行任务失败：${message}`)
  }
}
```

- 命令参数可能是 `TreeItem.command` 传入的原始 `vscode.Task`，也可能是右键菜单传入的节点；`resolveEntryArg` 统一归一化：节点取 `entry`，原始 Task 先经 `isWorkspaceFileTask` 校验再重建 entry（拒绝执行非工作区 tasks.json 任务）。
- 不等待任务结束；`executeTask` 成功返回即表示已提交执行，此时记录最近运行；失败（源任务失效、provider 解析失败、受限等）不记录。
- 依赖任务由引擎启动，不经过本命令，因此**不会**进入最近运行（避免依赖污染列表）。
- 不设置 `presentationOptions` 覆盖，沿用用户 tasks.json 的 `presentation`。
- 最近运行写入失败只在输出通道告警，不影响任务执行。

### 8.2 依赖语义（由引擎保证）

| 场景                         | 行为                                                                   |
| ---------------------------- | ---------------------------------------------------------------------- |
| 多个 `dependsOn`             | 默认并行启动，全部完成后执行本任务                                     |
| `"dependsOrder": "sequence"` | 按声明顺序串行；依赖退出码非 0 时后续依赖与本任务均不执行              |
| 依赖本身也有 `dependsOn`     | 文档注明 _not recursive_：仅解析一层（引擎行为）                       |
| 后台依赖（`isBackground`）   | 需 `problemMatcher` 判定「已就绪」，否则可能一直等待；沿用用户配置     |
| 循环依赖                     | 引擎输出 `There is a dependency cycle. See task "…"`，依赖方命令不执行 |
| 依赖找不到                   | 引擎输出 `Couldn't resolve dependent task …`，按引擎策略跳过/继续      |

扩展**不**做任何依赖解析、重试、顺序干预，也不在树里伪造依赖节点。

### 8.3 停止

```ts
terminate(key: string): number {
  const executions = vscode.tasks.taskExecutions.filter((e) => taskKey(e.task) === key);
  for (const execution of executions) {
    try { execution.terminate(); } catch (error) { /* 记录输出通道 */ }
  }
  return executions.length;
}
```

- `terminate()` 找不到活动任务时可能 reject，必须 try/catch（§11.2 用例）。
- 停止只作用于匹配的 `TaskExecution`；运行中的依赖任务是否随之结束由引擎决定（API 无法枚举「某任务的依赖」），若需要可对依赖节点单独停止。这一点写入功能文档的「已知限制」。
- 无匹配时提示 `任务未在运行：${name}`，不弹错误。

### 8.4 定位到 `tasks.json` 对应行

```ts
async locate(arg: unknown): Promise<void> {
  const entry = resolveEntryArg(arg)
  if (!entry) {
    void vscode.window.showInformationMessage('请从任务管理器中选择要定位的任务。')
    return
  }
  const uri = vscode.Uri.joinPath(entry.folder.uri, '.vscode', 'tasks.json')
  let document: vscode.TextDocument
  try {
    document = await vscode.workspace.openTextDocument(uri)
  } catch {
    void vscode.window.showWarningMessage('未找到 .vscode/tasks.json。')
    return
  }
  const offset = locateTaskLabel(document.getText(), entry.task.name)
  if (offset === undefined) {
    await vscode.window.showTextDocument(document, { preview: false })
    void vscode.window.showWarningMessage('未能定位任务行，已打开 tasks.json 顶部。')
    return
  }
  const position = document.positionAt(offset)
  const range = new vscode.Range(position, position)
  const editor = await vscode.window.showTextDocument(document, { preview: false, selection: range })
  editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport)
}
```

- 多根时用 `entry.folder` 精确定位到任务所属文件夹的 `.vscode/tasks.json`；单根同理。
- `locateTaskLabel` 只扫描 `"label"` 键（§4.3）：跳过注释与字符串内文本，按 JSON 转义解码后与 `task.name` 全等比较，返回 `label` 键偏移；未命中返回 `undefined`。
- 重复 label（VS Code 本身会报歧义）取第一个匹配；BOM、尾逗号、注释等 JSONC 特性由扫描器容忍，不抛异常。
- 命中后以 `preview: false` 打开并选中，用 `InCenterIfOutsideViewport` 滚动到可视区；失败路径只提示，不改变树、不阻塞其他功能。
- 只读操作：不修改文件、不写最近运行/收藏；定位不参与任务发现与依赖判断。

### 8.5 信任与失败

- 运行前双保险：`workspace.isTrusted` + 引擎自身在受限模式拒绝执行（官方文档：_VS Code prevents running tasks in Restricted Mode_）。
- `executeTask` 失败（任务已删除、provider 解析失败、终端无法创建等）→ 通知 + 输出通道，不修改树（watcher/刷新会纠正）。
- 受限模式下的「运行」命令若通过命令面板被直接调用，仍会被 `isTrusted` 拦截（§12.2 的 `when` 仅影响菜单展示，不作为安全边界）。

---

## 9. 刷新与生命周期

| 事件                                      | 处理                                                                            |
| ----------------------------------------- | ------------------------------------------------------------------------------- |
| 首次展开 / `getChildren(undefined)`       | `ensureLoaded()` → 一次 `fetchTasks` + 读取 usage；期间 View 自带 loading       |
| `.vscode/tasks.json` create/change/delete | `createFileSystemWatcher('**/.vscode/tasks.json')` → 300ms 去抖 → 重新加载      |
| 手动「刷新任务列表」                      | 清空去抖队列并立即重新加载                                                      |
| `onDidChangeWorkspaceFolders`             | 立即重新加载（多根增删）                                                        |
| `onDidGrantWorkspaceTrust`                | 立即重新加载（受限模式 → 正常）                                                 |
| `onDidStartTask` / `onDidEndTask`         | 只刷新运行态（100ms 去抖），不重新 `fetchTasks`                                 |
| 本扩展运行成功                            | `usage.recordRun(ref)` → usage 事件 → provider `fire()`，不重新 `fetchTasks`    |
| 收藏/取消收藏、清空最近运行               | usage 写 `workspaceState` → usage 事件 → provider `fire()`，不重新 `fetchTasks` |
| `dispose()`                               | 停 watcher、清 timer、dispose tracker/provider/usage emitter、取消进行中的加载  |

实现要点：

- **单飞（in-flight 合并）**：`refresh()` 若已有进行中的 Promise 则复用，避免 watcher 抖动叠加请求；完成后置空。
- **运行态与数据刷新解耦**：`fetchTasks` 只在首次加载、watcher、工作区/信任变化、手动刷新时调用；运行开始/结束、收藏、清空最近只触发 tree fire。
- **usage 读取时机**：首次 `ensureLoaded` 读取一次 `workspaceState`；之后由 `TaskUsageStore.onDidChange` 驱动，不重复读 memento。
- **失败保留旧数据**：加载失败时保留上次成功结果，置 `error` 并显示错误 info 节点；下次成功自动恢复（与 `BuildTasksTreeProvider` 行为一致）。
- **不做轮询**：任务列表是静态配置，watcher 足够；运行态由事件驱动，无 3s 轮询（区别于构建任务视图）。
- **响应时序**：`onDidStartTask` 触发时 `taskExecutions` 可能尚未更新，100ms 去抖后扫描即可稳定；`onDidEndTaskProcess` 先于 `onDidEndTask`，本期只用后者。

---

## 10. 命令与菜单

### 10.1 命令

| 命令 ID                              | 标题                 | 参数                                 | 行为                                                    |
| ------------------------------------ | -------------------- | ------------------------------------ | ------------------------------------------------------- |
| `extStarter.refreshTaskExplorer`     | 刷新任务列表         | —                                    | 清空去抖队列并重新 `fetchTasks`                         |
| `extStarter.runWorkspaceTask`        | 运行任务             | `Task` 或任务节点                    | 信任检查 → `executeTask` → 成功后 `recordRun`；失败通知 |
| `extStarter.stopWorkspaceTask`       | 停止任务             | `Task` 或任务节点                    | 终止匹配的 `TaskExecution`；无匹配给提示                |
| `extStarter.openTasksJson`           | 打开 tasks.json      | `WorkspaceFolder` / 各类节点（可空） | 单根直开；多根 QuickPick；文件不存在给提示              |
| `extStarter.locateTaskInTasksJson`   | 定位到 tasks.json 行 | `Task` 或任务节点                    | JSONC 扫描 `label` → 打开并选中；失败降级打开顶部       |
| `extStarter.addTaskToFavorites`      | 收藏任务             | `Task` 或任务节点                    | 按 key 写入收藏；已存在则无操作                         |
| `extStarter.removeTaskFromFavorites` | 取消收藏             | `Task` 或任务节点                    | 按 key 移除收藏                                         |
| `extStarter.clearRecentTasks`        | 清空最近运行         | —                                    | 模态确认后清空 `recent`，不影响收藏                     |

命令通过 `registerTaskExplorerCommands(register, deps)` 注册，`register` 仍由 `commands/index.ts` 统一提供（满足清单门禁「每个清单命令必须在 `src/extension/commands/*.ts` 出现 `register(COMMAND.xxx`」）。运行/停止/定位/收藏类命令在命令面板被无参调用时给「请从任务管理器中选择任务」的提示，不抛错；运行/停止内部仍做 `workspace.isTrusted` 检查（菜单 `when` 不是安全边界）。

### 10.2 `package.json` 增量

视图：

```json
{
  "id": "extStarter.taskExplorerView",
  "name": "%view.taskExplorer.name%"
}
```

命令：

```json
{ "command": "extStarter.refreshTaskExplorer", "title": "%command.refreshTaskExplorer.title%", "category": "%command.category%", "icon": "$(refresh)" },
{ "command": "extStarter.runWorkspaceTask", "title": "%command.runWorkspaceTask.title%", "category": "%command.category%", "icon": "$(play)" },
{ "command": "extStarter.stopWorkspaceTask", "title": "%command.stopWorkspaceTask.title%", "category": "%command.category%", "icon": "$(debug-stop)" },
{ "command": "extStarter.openTasksJson", "title": "%command.openTasksJson.title%", "category": "%command.category%", "icon": "$(go-to-file)" },
{ "command": "extStarter.locateTaskInTasksJson", "title": "%command.locateTaskInTasksJson.title%", "category": "%command.category%", "icon": "$(list-selection)" },
{ "command": "extStarter.addTaskToFavorites", "title": "%command.addTaskToFavorites.title%", "category": "%command.category%", "icon": "$(star)" },
{ "command": "extStarter.removeTaskFromFavorites", "title": "%command.removeTaskFromFavorites.title%", "category": "%command.category%", "icon": "$(star-filled)" },
{ "command": "extStarter.clearRecentTasks", "title": "%command.clearRecentTasks.title%", "category": "%command.category%", "icon": "$(clear-all)" }
```

菜单（`view/title` 与 `view/item/context` 的 `when` 均含 `view ==`，满足清单门禁）：

```json
{ "command": "extStarter.refreshTaskExplorer", "when": "view == extStarter.taskExplorerView", "group": "navigation@1" },
{ "command": "extStarter.openTasksJson", "when": "view == extStarter.taskExplorerView", "group": "navigation@2" },

{ "command": "extStarter.runWorkspaceTask", "when": "view == extStarter.taskExplorerView && viewItem =~ /^workspaceTask(Favorite)?$/", "group": "inline@1" },
{ "command": "extStarter.stopWorkspaceTask", "when": "view == extStarter.taskExplorerView && viewItem =~ /^workspaceTaskRunning(Favorite)?$/", "group": "inline@1" },
{ "command": "extStarter.addTaskToFavorites", "when": "view == extStarter.taskExplorerView && viewItem =~ /^workspaceTask(Running)?$/", "group": "inline@2" },
{ "command": "extStarter.removeTaskFromFavorites", "when": "view == extStarter.taskExplorerView && viewItem =~ /^workspaceTask(Running)?Favorite$/", "group": "inline@2" },
{ "command": "extStarter.locateTaskInTasksJson", "when": "view == extStarter.taskExplorerView && viewItem =~ /^workspaceTask(Running)?(Favorite)?$/", "group": "inline@3" },

{ "command": "extStarter.runWorkspaceTask", "when": "view == extStarter.taskExplorerView && viewItem =~ /^workspaceTask(Favorite)?$/", "group": "1_task@1" },
{ "command": "extStarter.stopWorkspaceTask", "when": "view == extStarter.taskExplorerView && viewItem =~ /^workspaceTaskRunning(Favorite)?$/", "group": "1_task@1" },
{ "command": "extStarter.addTaskToFavorites", "when": "view == extStarter.taskExplorerView && viewItem =~ /^workspaceTask(Running)?$/", "group": "2_favorite@1" },
{ "command": "extStarter.removeTaskFromFavorites", "when": "view == extStarter.taskExplorerView && viewItem =~ /^workspaceTask(Running)?Favorite$/", "group": "2_favorite@1" },
{ "command": "extStarter.locateTaskInTasksJson", "when": "view == extStarter.taskExplorerView && viewItem =~ /^workspaceTask(Running)?(Favorite)?$/", "group": "3_locate@1" },

{ "command": "extStarter.openTasksJson", "when": "view == extStarter.taskExplorerView && viewItem == tasksFile", "group": "1_task@1" },
{ "command": "extStarter.openTasksJson", "when": "view == extStarter.taskExplorerView && viewItem == taskExplorerFolder", "group": "1_task@1" },
{ "command": "extStarter.clearRecentTasks", "when": "view == extStarter.taskExplorerView && viewItem == taskExplorerGroupRecent", "group": "4_manage@1" }
```

> 依赖 `viewItem` 的四种任务态组合见 §7.3。`when` 表达式里的正则仅用于减少重复行；若评审偏好显式枚举，可展开为 4 条 `||` 条件（行为等价，清单门禁只要求包含 `view ==`）。

### 10.3 常量

```ts
export const VIEW = {
  // …既有
  /** 任务管理器树视图 ID（v2.3） */
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
```

```ts
export const COMMAND = {
  // …既有
  refreshTaskExplorer: 'extStarter.refreshTaskExplorer',
  runWorkspaceTask: 'extStarter.runWorkspaceTask',
  stopWorkspaceTask: 'extStarter.stopWorkspaceTask',
  openTasksJson: 'extStarter.openTasksJson',
  locateTaskInTasksJson: 'extStarter.locateTaskInTasksJson',
  addTaskToFavorites: 'extStarter.addTaskToFavorites',
  removeTaskFromFavorites: 'extStarter.removeTaskFromFavorites',
  clearRecentTasks: 'extStarter.clearRecentTasks',
} as const
```

```ts
export const STORAGE = {
  // …既有
  /** 任务管理器最近运行/收藏（workspaceState） */
  taskExplorerUsageKey: 'extStarter.taskExplorer.usage',
} as const
```

> `manifest` 门禁会校验 `VIEW` 中 `*ViewId` 与 `package.json` 视图双向一致、`COMMAND` 与清单命令双向一致；新增项必须同步，否则 `checkManifestConsistency` 失败。`title` 与 `category` 走 `%key%`，新增 key 见 §12.1。

---

## 11. 测试方案

### 11.1 单测桩增量（`src/test/unit/stubs/vscode.ts`）

只增不删，保持现有导出兼容：

| 桩                                      | 内容                                                                                                      |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `tasks.fetchTasks()`                    | 返回 `__stubs.workspaceTasks`，可注入 reject                                                              |
| `tasks.executeTask()`                   | 记录调用、返回 `FakeTaskExecution`；可注入 reject                                                         |
| `tasks.taskExecutions`                  | getter 读 `__stubs.taskExecutions`                                                                        |
| `tasks.onDidStartTask` / `onDidEndTask` | `EventEmitter`，配 `__fireTaskStart(exec)` / `__fireTaskEnd(exec)`                                        |
| `Task`                                  | 构造签名 `(definition, scope, name, source, execution?, problemMatchers?)`，保留字段                      |
| `ShellExecution`                        | 两套构造：`(commandLine, options?)` 与 `(command, args, options?)`                                        |
| `ProcessExecution`                      | 两套构造：`(process, options?)` 与 `(process, args, options?)`                                            |
| `TaskScope` / `TaskGroup`               | 常量枚举                                                                                                  |
| `Position` / `Range` / `Selection`      | 轻量实现（line/character、contains、isEmpty），供定位断言                                                 |
| `TextEditorRevealType`                  | `InCenterIfOutsideViewport` 等常量                                                                        |
| `FakeTaskExecution`                     | `{ task, terminate: vi.fn() }`（`terminate` 可模拟 reject）                                               |
| `workspace.openTextDocument(uri)`       | 返回假文档 `{ uri, getText(), positionAt(offset) }`，可从 `__stubs.documents` 注入内容                    |
| `window.showTextDocument(...)`          | 记录 `{ uri, selection, preview }`；返回假 editor `{ revealRange: vi.fn() }`                              |
| 辅助                                    | `__setWorkspaceTasks`、`__setTaskExecutions`、`__fireTaskStart`、`__fireTaskEnd`；`__resetStubs` 一并清理 |

`TaskUsageStore` 测试使用现有 `createMementoStub(initial)`：`get/update` 可注入抛错，验证「损坏重置」「写失败继续」；无需真实 `ExtensionContext`。

同时确认 `window.createTreeView` 的录制结构能容纳 `{ treeDataProvider, showCollapseAll }`（现有桩已录制参数，测试断言即可）。

### 11.2 单测矩阵

| 文件                               | 覆盖点                     | 关键用例                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `taskSource.spec.ts`               | 过滤/排序/分组/key         | ① `source='Workspace'` + `WorkspaceFolder` scope → 保留；② 扩展 provider 任务（source='npm'）→ 排除；③ 用户级任务（scope=`TaskScope.Workspace`）→ 排除；④ `.code-workspace` 任务 → 排除；⑤ 同根同名不同任务不互相覆盖；⑥ 多根同名任务 key 不同；⑦ 按文件夹/任务名排序；⑧ `taskRef`/`taskKeyFromRef` 互逆                                                                                                                                                                                                                 |
| `taskUsageStore.spec.ts`           | 持久化/校验/上限/事件      | ① 空 memento → 空结构；② 合法结构读取；③ 版本不符 → 重置并告警；④ 元素字段缺失/类型错误 → 丢弃该条；⑤ favorites 按 key 去重；⑥ recent 按 key 去重保留最新并倒序；⑦ recordRun 置顶 + 同一秒多次；⑧ recent 写入上限 20；⑨ addFavorite 重复返回 false；⑩ removeFavorite 命中/未命中；⑪ clearRecent 不影响 favorites；⑫ update 抛错 → 内存仍生效 + 输出通道；⑬ onDidChange 次数；⑭ dispose 后不再 fire                                                                                                                       |
| `tasksJsonLocator.spec.ts`         | JSONC 扫描定位             | ① 简单 `"label": "build"`；② 前后有注释；③ 命令字符串内含 `label` 字样不误命中；④ 转义引号/反斜杠；⑤ `\uXXXX` 解码；⑥ 重复 label 取第一个；⑦ 缺失 label → undefined；⑧ 截断/非法 JSON 不抛异常；⑨ BOM 开头；⑩ 尾逗号；⑪ label 键与值跨行/多余空白                                                                                                                                                                                                                                                                        |
| `taskStatusTracker.spec.ts`        | 事件/扫描/终止             | ① 开始事件 100ms 后触发一次变更（fake timers）；② 结束事件触发；③ `isRunning` 命中/不命中；④ 同根同名但不同文件夹不误判；⑤ 多个执行全部终止；⑥ `terminate` 抛错被吞并继续；⑦ `dispose` 后不再响应事件；⑧ 重复事件只发一次                                                                                                                                                                                                                                                                                                |
| `taskExplorerTreeProvider.spec.ts` | 三组/节点/空态/运行/收藏态 | ① 根节点顺序 = 最近运行、收藏、工作区任务；② 三组空态 info；③ 最近运行按时间倒序、最多 10 条；④ 收藏按名称排序；⑤ 失效 ref 隐藏且收藏保留；⑥ 单根 file→task；⑦ 多根 folder→file→task；⑧ 四种 contextValue 组合；⑨ 运行态图标；⑩ file/folder 的 openTasksJson 参数；⑪ 加载失败保留旧数据 + error info；⑫ 任务 command 参数为原始 `Task`；⑬ fire 不重新 fetch；⑭ dispose 幂等                                                                                                                                              |
| `taskExplorerController.spec.ts`   | 编排/刷新/运行/定位/收藏   | ① watcher change 300ms 去抖只刷新一次；② 手动刷新清空队列并立即执行；③ workspaceFolders 变化刷新；④ 授予信任刷新；⑤ `run` 未信任 → 警告且不执行；⑥ `run` 成功 → executeTask + recordRun；⑦ `run` 失败 → 通知 + 不 recordRun；⑧ `run` 无参提示；⑨ `stop` 无匹配提示、有匹配 terminate；⑩ 定位命中 → 打开并带 selection/reveal；⑪ 定位未命中 → 打开顶部 + 警告；⑫ 文件不存在提示；⑬ 收藏/取消收藏委托 store；⑭ 清空最近需模态确认（取消不写）；⑮ 单根/多根/文件不存在三种 `openTasksJson`；⑯ `dispose` 释放 watcher 与监听 |
| `taskExplorerCommands.spec.ts`     | 命令注册/委托              | ① 8 个命令均注册；② 刷新/运行/停止/定位/收藏/取消收藏/清空/打开逐条委托；③ 带参命令无参调用给提示                                                                                                                                                                                                                                                                                                                                                                                                                        |

预计新增 ~70 个用例；新增模块行覆盖率目标 ≥ 90%（门禁第 7 步会强制全仓阈值）。

### 11.3 集成与手工验收

- **宿主集成（可选）**：在 `src/test/extension.test.ts` 增加 `suite('Task Explorer')`：断言 8 个命令出现在 `vscode.commands.getCommands()`；调用 `fetchTasks()` 断言仓库自带的 `npm: compile` / `npm: watch` 存在且 `source === 'Workspace'`、`scope` 为工作区文件夹。**不**在宿主机里真正执行 `npm: watch`（长驻）。
- **手工验收（M0/M4）**：用仓库外临时目录建 fixtures，逐项验收：
  1. 用户示例改造为 `echo` + 时间戳写入临时文件，验证 `dependsOn` 先执行、`dependsOrder: "sequence"` 顺序、失败短路；
  2. 循环依赖（A→B→A）不执行命令且给出引擎提示；
  3. 缺依赖（`dependsOn: ["not-exist"]`）行为符合引擎提示；
  4. 受限模式：空态文案 + 运行被拦截；
  5. 多根：两个文件夹各有同名任务，运行/状态互不串扰；
  6. 修改 `.vscode/tasks.json` 后 300ms 内树刷新；删除文件后任务消失；
  7. 后台任务（`isBackground` + `problemMatcher`）状态与停止；
  8. 非 shell 任务（`type: "npm"`）可运行、tooltip 正确；
  9. 运行任务后，该任务出现在「最近运行」顶部；重启窗口后仍在；最近运行最多显示 10 条；
  10. 收藏/取消收藏任务，星标方向正确；重启窗口后仍在；同一任务同时出现在收藏与工作区任务时，两处运行/收藏状态一致；
  11. 定位任务：普通文件、含注释/重复 label/转义字符的 tasks.json 都能跳到正确行；文件被删除时提示且不崩；
  12. 「清空最近运行」必须二次确认，取消不生效，确认后收藏不受影响；
  13. 任务改名后旧收藏隐藏但保留，改回原名后重新出现（key 变化验证）；
  14. 通过命令面板直接运行任务（无参）只提示，不报错；外部（Quick Pick）运行的任务不进入最近运行（已知限制）。

---

## 12. 配置、i18n 与门禁

### 12.1 配置与文案

- **不新增任何 `extStarter.*` 配置项**：任务发现/运行/刷新/定位行为确定；最近运行与收藏用 `workspaceState` 持久化，不给开关（避免状态分叉）；`hide`、分组、收藏夹清理入口等 P2 再议。
- `package.nls.json` / `package.nls.zh-cn.json` 新增：

| key                                     | en                        | zh-CN                  |
| --------------------------------------- | ------------------------- | ---------------------- |
| `view.taskExplorer.name`                | `Tasks`                   | `任务管理器`           |
| `command.refreshTaskExplorer.title`     | `Refresh Workspace Tasks` | `刷新任务列表`         |
| `command.runWorkspaceTask.title`        | `Run Workspace Task`      | `运行任务`             |
| `command.stopWorkspaceTask.title`       | `Stop Workspace Task`     | `停止任务`             |
| `command.openTasksJson.title`           | `Open .vscode/tasks.json` | `打开 tasks.json`      |
| `command.locateTaskInTasksJson.title`   | `Locate in tasks.json`    | `定位到 tasks.json 行` |
| `command.addTaskToFavorites.title`      | `Add to Favorites`        | `收藏任务`             |
| `command.removeTaskFromFavorites.title` | `Remove from Favorites`   | `取消收藏`             |
| `command.clearRecentTasks.title`        | `Clear Recent Tasks`      | `清空最近运行`         |

运行时提示（中文）沿用仓库现有风格硬编码，不进 nls（nls 只覆盖清单可见文案）。

### 12.2 信任与 when

- `capabilities.untrustedWorkspaces.supported` 已是 `"limited"`，无需改动。
- 可选增强：菜单 `when` 加 `&& isWorkspaceTrusted` 隐藏运行按钮；**不作为安全边界**，命令内部仍检查 `workspace.isTrusted`。

### 12.3 门禁影响

| 门禁步骤                | 影响与对策                                                                                    |
| ----------------------- | --------------------------------------------------------------------------------------------- |
| `eslint` / `prettier`   | 新增文件按仓库格式；提交前 `npm run format:check`                                             |
| `tsc` / `vue-tsc`       | 新增类型无 `any` 扩散；`unknown` + 归一化                                                     |
| `build-extension`       | 无新增依赖，bundle 预计 +3~5KB（预算 150KB）                                                  |
| `vite build`            | 不涉及 Webview                                                                                |
| `manifest` 一致性       | 同步 `constants.ts` ↔ `package.json`；命令注册；`when` 含 `view ==`；视图 ID 以 `ViewId` 结尾 |
| `vitest --coverage`     | 新增模块测试先行，覆盖率达标                                                                  |
| `@vscode/test-electron` | 现有集成测试不回归；新增可选 suite 不执行长驻任务                                             |
| `vsce ls`               | 新文件在 `src/`（已被 `.vscodeignore` 排除），无需改白名单                                    |

---

## 13. 实施计划

| 阶段 | 内容                                                                                                                             | 产出                   | 工期                      |
| ---- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ------------------------- |
| M0   | API 行为验证（真实窗口）：用 fixtures 核对 `source/scope`，确认 `executeTask` 触发依赖、受限模式空数组、多根 scope；记录到附录 A | 验证记录（并入本文档） | 0.5 人日                  |
| M1   | `constants` / `package.json` / nls / `taskSource.ts`（含 `TaskRef`、key、排序、分组）+ 单测                                      | 数据层可测             | 0.5 人日                  |
| M2   | `taskStatusTracker.ts` + `taskUsageStore.ts` + `tasksJsonLocator.ts` + 单测                                                      | 状态/持久化/定位可测   | 1.0 人日                  |
| M3   | `taskExplorerTreeProvider.ts`（三组、四种 contextValue、空态、跨分区一致）+ 单测                                                 | 树可用                 | 1.0 人日                  |
| M4   | `taskExplorerController.ts` + `taskExplorerCommands.ts` + 菜单/装配 + 单测                                                       | 功能闭环               | 1.0 人日                  |
| M5   | 集成/手工验收 + 文档（功能介绍 07、开发指南 09、索引、根 README 功能表）+ CHANGELOG + v2.3.0                                     | 可发布                 | 0.75 人日                 |
| 合计 |                                                                                                                                  |                        | ~5.5 人日（含 0.75 缓冲） |

依赖顺序：M0 → M1 → M2 → M3 → M4 → M5；M2 的定位/存储可并行，M3 依赖 M2 的接口。

---

## 14. 风险与缓解

| 编号 | 风险                                                                          | 影响                              | 缓解                                                                                                |
| ---- | ----------------------------------------------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------- |
| R1   | `source/scope` 过滤依赖 VS Code 内部约定（非公开 API 语义），版本升级可能变化 | 任务不显示/误显示                 | M0 实测（1.85 与最新稳定版）；集成断言；失败时输出诊断日志；降级方案：解析文件补 `label` 集合（P2） |
| R2   | `tasks.json` 中无法解析的任务（缺 provider、语法错误）不会出现在 `fetchTasks` | 用户以为「功能没加载」            | 功能文档写明；打开文件时依赖 VS Code 自身错误提示；P2 可加「解析失败」占位                          |
| R3   | `hide: true` 任务仍显示                                                       | 与 Quick Pick 不一致              | 文档说明；P2 解析文件过滤                                                                           |
| R4   | 依赖关系不可见                                                                | 用户无法在树上看到 `dependsOn` 边 | 执行正确；tooltip 说明由引擎编排；P2 展示                                                           |
| R5   | 事件风暴（一次执行多次 start/end）                                            | 树频繁刷新                        | 100ms 去抖 + 扫描 `taskExecutions`，不计数                                                          |
| R6   | 停止语义与用户预期不一致（依赖/并行任务）                                     | 误以为「停父即停全部」            | 文档「已知限制」；依赖节点可单独停止                                                                |
| R7   | 复合任务（无 `execution`）tooltip 信息少                                      | 体验差                            | 降级文案 + 仍可运行                                                                                 |
| R8   | 多根同名任务串扰                                                              | 运行/停止错任务                   | key 含 `folder.uri`；单测覆盖                                                                       |
| R9   | 受限模式空列表被误判为 bug                                                    | 差评                              | 专门空态文案 + 信任后自动刷新                                                                       |
| R10  | 包体/白名单变化                                                               | 门禁失败                          | 不新增依赖；新增源码在 `src/`（已被忽略）；跑 `--fast` 与完整 gate                                  |
| R11  | 命令面板直接调用无参命令                                                      | 无反馈                            | 无参给提示；运行/停止命令均做参数归一化                                                             |
| R12  | 轻量 JSONC 扫描误判（命令/注释里的 `label` 字样、转义、重复 label）           | 定位跳错行                        | 只认键名 `"label"` 且值精确匹配；未命中降级打开顶部并提示；`tasksJsonLocator.spec.ts` 覆盖边界      |
| R13  | `workspaceState` 损坏或写入失败                                               | 收藏/最近丢失、异常               | 读取校验失败 → 重置并输出告警；写入失败 → 内存继续生效 + 告警；单测覆盖                             |
| R14  | 失效收藏（任务改名/文件夹移除）只能在存储中保留，不能直接取消                 | 用户无法清理「看不见的收藏」      | 文档说明；恢复后自动出现；P2 增加收藏管理入口（清空全部/清理失效）                                  |
| R15  | 外部（Quick Pick/命令面板）运行不进入最近运行                                 | 与 VS Code 自身行为不一致         | 文档「已知限制」；P2 可监听 `onDidStartTask` 但需过滤依赖任务，避免污染                             |
| R16  | 窄视图下行内 4 个图标偏挤                                                     | 可发现性下降                      | 运行/停止、收藏、定位均同时提供右键与命令面板入口；P2 按用户反馈调整 inline 数量                    |
| R17  | 同一任务同时出现在最近运行、收藏、工作区任务                                  | 视觉重复                          | 预期设计；三处按 key 引用同一任务，运行/收藏状态一致；README 与功能文档说明                         |

---

## 15. 验收标准（DoD）

- [ ] 根节点固定三组且顺序为「最近运行 → 收藏 → 工作区任务」；空组显示「暂无」占位，不隐藏。
- [ ] 单根工作区：工作区任务 → `tasks.json` → 全部任务；多根工作区：工作区任务 → 文件夹 → `tasks.json` → 任务；任务名与文件一致。
- [ ] 用户级 `tasks.json`、`.code-workspace` 级任务、扩展 provider 任务**不出现**；仓库自带的 `npm: compile` / `npm: watch` 可见（contributed type 场景）。
- [ ] 单击/行内/右键可运行、停止、收藏/取消收藏、定位；运行中节点显示 `sync~spin`，停止按钮出现。
- [ ] `dependsOn` 先于本任务；`dependsOrder: "sequence"` 顺序正确；失败短路由引擎表现；依赖任务不进入最近运行。
- [ ] 同一任务在最近运行/收藏/工作区任务三处运行态与收藏态一致；星标方向正确。
- [ ] 运行成功后进入最近运行顶部，最多展示 10 条，重启窗口仍在；「清空最近运行」需模态确认，收藏不受影响。
- [ ] 收藏/取消收藏持久化到 `workspaceState`，重启窗口仍在；失效收藏隐藏但保留，任务恢复后自动出现。
- [ ] 定位能跳转到正确的 `label` 行（含注释、重复 label、转义字符），未命中降级打开顶部并提示；文件不存在给提示。
- [ ] 修改/删除 `.vscode/tasks.json` 后树自动刷新（≤ 1s 内可见）；标题栏刷新按钮立即生效；受限模式空态 + 运行被拦截，授予信任后自动加载。
- [ ] 8 条命令全部注册；带参命令无参调用有提示不报错。
- [ ] `npm run test:unit` 全绿；新增模块覆盖率 ≥ 90%；`npm run gate -- --fast` 与完整 `npm run gate` 全绿（宿主集成受网络限制时需在交付说明中注明）。
- [ ] 文档：功能介绍 07、开发指南 09、docs 索引、根 README 功能表、CHANGELOG、版本号 2.3.0（实施轮完成）。

---

## 附录 A：用户示例的验收脚本（M0 用）

在仓库外新建临时工作区，替换为可观测命令（避免真实 rsync/python）：

```json
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "dep-first",
      "type": "shell",
      "command": "echo dep >> \"${workspaceFolder}/.task-order.log\"",
      "options": { "cwd": "${workspaceFolder}" }
    },
    {
      "label": "main-second",
      "type": "shell",
      "command": "echo main >> \"${workspaceFolder}/.task-order.log\"",
      "dependsOn": ["dep-first"],
      "options": { "cwd": "${workspaceFolder}" }
    }
  ]
}
```

断言：运行 `main-second` 后 `.task-order.log` 中 `dep` 在 `main` 之前；把 `dependsOn` 改成 `["dep-first", "dep-second"]` 且 `dependsOrder: "sequence"` 时顺序与声明一致；`dep-first` 返回非 0 时 `main` 不执行。

## 附录 B：关键源码依据索引

| 主题                             | 路径:行                                                                                                        |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `fetchTasks` API → 主线程        | `src/vs/workbench/api/common/extHostTask.ts:489-500`；`src/vs/workbench/api/browser/mainThreadTask.ts:620-631` |
| `Task` 还原（scope/source/_id）  | `src/vs/workbench/api/common/extHostTask.ts:265-266, 291-345`                                                  |
| `executeTask` 的 TaskHandle 分支 | `src/vs/workbench/api/node/extHostTask.ts:58-75`；`src/vs/workbench/api/browser/mainThreadTask.ts:673-716`     |
| `TaskDTO` 字段（不含 dependsOn） | `src/vs/workbench/api/browser/mainThreadTask.ts:345-382`                                                       |
| tasks.json source label          | `src/vs/workbench/contrib/tasks/common/taskConfiguration.ts:1446, 1590-1602`                                   |
| custom vs configured 解析        | `src/vs/workbench/contrib/tasks/common/taskConfiguration.ts:1567-1646, 1677-1726, 1747-1824`                   |
| 受限模式 `fetchTasks` 返回空     | `src/vs/workbench/contrib/tasks/browser/abstractTaskService.ts:1054-1062`                                      |
| `dependsOn` 执行与顺序           | `src/vs/workbench/contrib/tasks/browser/terminalTaskSystem.ts:525-621`                                         |
| `Task.definition` 内容           | `src/vs/workbench/contrib/tasks/common/tasks.ts:777-812`；`src/vs/workbench/api/browser/mainThreadTask.ts:353` |

## 附录 C：与 vscode-taskexplorer 的差异

| 维度              | vscode-taskexplorer                      | 本方案                                                                                               |
| ----------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 任务源            | 10+ provider + tasks.json，白名单配置    | **仅**工作区 `.vscode/tasks.json`                                                                    |
| 树层级            | Folder → File → Task（可再按分隔符分组） | 顶部固定「最近运行 → 收藏 → 工作区任务」；工作区任务：单根 File → Task，多根 Folder → File → Task    |
| 最近运行 / 收藏   | 有（LastTasks、Favorites、状态栏）       | 有：最近运行（仅本扩展运行记录，展示 10/存储 20）+ 收藏（无上限）；`workspaceState` 持久化，三处一致 |
| 依赖              | 不处理（交引擎）                         | 不处理（交引擎），并在 tooltip 说明                                                                  |
| 定位到 tasks.json | 无                                       | 内置轻量 JSONC 扫描 `label` 行；行内/右键定位，未命中降级打开顶部                                    |
| 运行态            | `taskExecutions` 四元组匹配              | key（folder+source+name）+ `taskExecutions` 扫描                                                     |
| 刷新              | watcher 无去抖（已知事件风暴问题）       | 300ms 去抖 + 单飞 + 标题刷新 + usage 事件（只 fire 不 fetch）                                        |
| 状态栏            | 有                                       | 一期无                                                                                               |
| 命令数            | 47                                       | 8                                                                                                    |
| 配置项            | 10 组                                    | 0                                                                                                    |
| 执行历史/统计     | 有（状态栏、历史视图）                   | 无（P2）                                                                                             |
| 新依赖            | json5 等                                 | 无                                                                                                   |

## 附录 D：参考链接

- 需求参考项目：[spmeesseman/vscode-taskexplorer](https://github.com/spmeesseman/vscode-taskexplorer)（源码基线提交 [`ebe6de92`](https://github.com/spmeesseman/vscode-taskexplorer/tree/ebe6de92fa8040175c8ad6a702e5057ca71446f2)）
- VS Code 任务文档：<https://code.visualstudio.com/docs/editor/tasks>
- Task API：<https://code.visualstudio.com/api/references/vscode-api#tasks>
- 变量参考：<https://code.visualstudio.com/docs/editor/variables-reference>
- 工作区信任：<https://code.visualstudio.com/api/extension-guides/workspace-trust>
- 本仓库实现基线：`docs/开发指南/07-命令视图与i18n.md`（命令/视图/清单门禁）、`docs/开发指南/08-测试门禁与打包.md`（测试与门禁）
