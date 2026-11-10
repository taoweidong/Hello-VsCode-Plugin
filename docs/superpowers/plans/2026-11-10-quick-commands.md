# 快捷命令（Quick Commands）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 v3.5.0「快捷命令」特性：终端选区/手动收藏命令 + 别名 + 显式分组 + 任务模式树视图 + 单击在终端执行 + QuickPick 快速执行。

**Architecture:** 照抄 favorites 三件套（service 双存储 + TreeProvider + 薄壳命令），新增 `features/quickCommands/`；终端执行走专用复用终端 `QuickCommand` + `sendText`；选区捕获走剪贴板桥接（内部命令 `workbench.action.terminal.copySelection` + `env.clipboard` 备份/恢复）。

**Tech Stack:** TypeScript + esbuild 宿主构建；vitest 单测（vscode 模块桩）；@vscode/test-electron 集成冒烟；门禁 `npm run gate`。

**Spec:** `docs/需求与优化方案/16-快捷命令设计方案.md`（执行前先读；本文与其冲突时以 spec 为准并回报）。

## Global Constraints

- `engines.vscode` 保持 `^1.85.0`，**禁止抬升**；`Terminal.selection` 是 proposed API，一律不用。
- 命令文本原样存取，仅 trim 首尾空白（A3）；不做转义/改写。
- 上限：命令 200 / 分组 50，硬编码常量；超限拒绝新增。
- 去重：`command` trim 后全文精确匹配，重复仅提示不覆盖。
- 树序：分组按数组序在前，「未分组」固定末位且无内容不显示。
- 全部命令/视图/存储/配置键走 `src/extension/constants.ts` 单一来源，`quickCommand` 前缀；门禁第⑥步校验 constants ↔ package.json ↔ 注册三层闭合。
- 文案与注释中文（与仓库现状一致）；i18n 双文件 `package.nls.json` + `package.nls.zh-cn.json`。
- 新增代码不得拉低覆盖率阈值（vitest 全局 lines 91.5 等）。
- 设计文档编号更正（执行期裁定）：14/15 已被「代码书签」「收藏夹数据可迁移增强」占用（同日会话外新增，已独立提交收编），本特性文档为 `16-快捷命令设计方案.md`（已重命名并改标题）；14/15 的索引行版本标注在 T11 改为「待实施（v3.6.0+）」，快捷命令独占 v3.5.0。

## Review Focus

1. **损坏 JSON**：`.vscode/quick-commands.json` 损坏 → 复制 `.corrupt-*.bak` 备份后按空数据继续，原文件不动。（T2 用例 `损坏 JSON 复制备份后按空数据继续`）
2. **悬空 groupId**：数据文件被手工编辑后 groupId 指向不存在的分组 → 该命令回落未分组 + onWarning。（T1 用例 `悬空 groupId 回落未分组`）
3. **无活动终端 / copySelection 抛错**：捕获命令不抛错给用户，降级 InputBox 粘贴。（T7 用例）
4. **终端被用户关闭后再执行**：`exitStatus !== undefined` 时自动重建新终端。（T4 用例）
5. **重复命令文本**：重复收藏仅提示，既有条目的别名/分组/计数不受影响。（T3 用例）

---

## File Structure

```
src/extension/features/quickCommands/
├── quickCommandsService.ts        # 模型 + 守卫 + 双存储 + 工厂 + QuickCommandsService（含 execute）
├── quickCommandsTreeProvider.ts   # 两级树：group/command/info 节点
└── terminalSelection.ts           # 剪贴板桥接（选区读取）
src/extension/commands/quickCommandsCommands.ts   # 12 条命令薄壳
src/extension/constants.ts                        # +VIEW/COMMAND/STORAGE/CONFIG
src/extension/commands/index.ts                   # CommandDeps + 注册行
src/extension/index.ts                            # 装配（照抄 favorites :140-152）
src/test/unit/quickCommands/*.spec.ts             # 4 个单测文件
src/test/unit/stubs/vscode.ts                     # +Terminal 桩
src/test/extension.test.ts                        # +集成冒烟 suite
package.json / package.nls*.json / .gitignore     # 清单/文案/忽略
docs/**（三件套 + 口径一致性）+ CHANGELOG.md
```

### Task 1: 数据模型与归一化守卫

**Files:**
- Create: `src/extension/features/quickCommands/quickCommandsService.ts`（仅模型/常量/守卫部分）
- Test: `src/test/unit/quickCommands/quickCommandsService.spec.ts`

**Interfaces (Produces):**
```ts
export interface QuickCommandGroup { id: string; name: string; createdAt: string }
export interface QuickCommandItem {
  id: string; name: string; command: string; groupId: string | null
  addedAt: string; lastUsedAt?: string; useCount?: number
}
export interface QuickCommandsData { groups: QuickCommandGroup[]; commands: QuickCommandItem[] }
export const QUICK_COMMANDS_SCHEMA_VERSION = 1
export const MAX_QUICK_COMMANDS = 200
export const MAX_QUICK_COMMAND_GROUPS = 50
export function normalizeQuickCommandData(raw: unknown, onWarning?: (m: string) => void): QuickCommandsData
export function defaultAlias(command: string): string   // trim 后首词，截 20 字符
```
- 守卫规则：非信封对象 → 警告 + 空；条目缺 `command`（trim 后空）整条丢弃；`name` 缺省 `defaultAlias(command)`；`groupId` 非存在分组的 id → `null` + 警告（合并为一条汇总警告）；分组名 trim 后空整条丢弃；分组重名保留首个 + 警告；命令 >200 保留前 200、分组 >50 保留前 50 + 警告（对齐 favorites 的 normalize 口径）。

- [ ] 写失败测试（信封读入 / 非信封告警 / 条目守卫丢命令缺项 / 悬空 groupId 回落 / 分组重名留首 / 双上限裁剪 / defaultAlias：首词+20 字符截断+多空白）
- [ ] `npx vitest run src/test/unit/quickCommands/quickCommandsService.spec.ts` → FAIL（模块不存在）
- [ ] 实现（照抄 `favoritesService.ts:36-83` 的 normalize 风格）
- [ ] 同命令 → PASS
- [ ] `git add ... && git commit -m "feat(quick-commands): 数据模型与归一化守卫"`

### Task 2: 双存储与装配工厂

**Files:**
- Modify: `src/extension/features/quickCommands/quickCommandsService.ts`
- Test: 同 T1 spec 文件追加 describe

**Interfaces (Produces):**
```ts
export interface IQuickCommandsStore {
  load(): Promise<QuickCommandsData>
  save(data: QuickCommandsData): Promise<void>
}
export class JsonQuickCommandsStore implements IQuickCommandsStore   // fileUri + onWarning
export class MementoQuickCommandsStore implements IQuickCommandsStore // (memento, key, onWarning)
export function createQuickCommandsStore(context: vscode.ExtensionContext, options?: { onWarning? }): IQuickCommandsStore
// STORAGE 键在 T8 落 constants；本任务先在文件内 const QUICK_COMMANDS_FILE = '.vscode/quick-commands.json'、MEMENTO_KEY = 'extStarter.quickCommands'，T8 收敛
```
- JSON 信封 `{ schemaVersion, groups, commands }` 经 `writeJsonAtomic`；FileNotFound → 空数据；parse 失败/根节点形状不符 → 复制 `.corrupt-*.bak`（文件名模式照抄 favoritesService:152-171）→ 警告 → 空数据。
- 工厂：有 workspaceFolders[0] → JSON，否则 Memento（照抄 createFavoritesStore:192-204）。

- [ ] 失败测试：save→load 往返；FileNotFound 空数据；损坏 JSON 复制备份后空继续（Review Focus 1）；Memento 往返；工厂两分支
- [ ] FAIL → 实现 → PASS
- [ ] commit `feat(quick-commands): 双存储与装配工厂`

### Task 3: QuickCommandsService 业务方法

**Files:**
- Modify: `src/extension/features/quickCommands/quickCommandsService.ts`
- Test: 同 spec 追加

**Interfaces (Produces):**
```ts
export type AddCommandStatus =
  | { status: 'added'; item: QuickCommandItem }
  | { status: 'duplicate'; existing: QuickCommandItem }
  | { status: 'cap' } | { status: 'invalid' }
export type UpdateTextStatus = 'updated' | 'duplicate' | 'notfound' | 'empty'
export type GroupOp = { status: 'created'; group: QuickCommandGroup } | { status: 'duplicate'; existing: QuickCommandGroup } | { status: 'cap' }
export type RenameGroupStatus = 'renamed' | 'duplicate' | 'notfound'
export class QuickCommandsService implements vscode.Disposable {
  readonly onDidChange: vscode.Event<void>
  loadError: string | undefined
  constructor(store: IQuickCommandsStore)
  load(): Promise<void>                       // 失败置 loadError，不清空旧数据（favorites 同款）
  listCommands(): QuickCommandItem[]; listGroups(): QuickCommandGroup[]
  get(id: string): QuickCommandItem | undefined
  addCommand(input: { command: string; name?: string; groupId: string | null }): Promise<AddCommandStatus>
  renameCommand(id: string, name: string): Promise<boolean>
  updateCommandText(id: string, command: string): Promise<UpdateTextStatus>
  removeCommand(id: string): Promise<boolean>
  moveCommandToGroup(id: string, groupId: string | null): Promise<boolean>  // groupId 非存在分组 → false
  createGroup(name: string): Promise<GroupOp>
  renameGroup(id: string, name: string): Promise<RenameGroupStatus>
  removeGroup(id: string): Promise<boolean>   // 组内命令 groupId → null；无命令也允许删
  recordExecution(id: string): Promise<void>  // lastUsedAt=now, useCount+1
  dispose(): void
}
```
- 新命令插入**所在分组顶部**（同 groupId 首个条目之前；null 组同理）；onDidChange 每次 persist 后 fire。
- [ ] 失败测试：load 成功/失败；addCommand 增/重(Review Focus 5：既有条目字段不变)/上限/空命令 invalid；插入分组顶部；rename/update/remove；move（含非法 groupId false）；createGroup 增/重/上限；renameGroup 三态；removeGroup 回落；recordExecution 回写并持久化
- [ ] FAIL → 实现 → PASS
- [ ] commit `feat(quick-commands): 业务服务（增删改查/分组/使用记录）`

### Task 4: 测试桩扩展（Terminal）+ execute 终端执行

**Files:**
- Modify: `src/test/unit/stubs/vscode.ts`、`src/extension/features/quickCommands/quickCommandsService.ts`
- Test: 同 spec 追加

**Interfaces (Produces):**
- 桩：`export class Terminal { name: string; exitStatus?: { reason: string } | undefined; show(preserveFocus?: boolean): void; sendText(text: string, shouldExecute?: boolean): void }`（show/sendText 走 `__record('terminalShow' | 'terminalSendText', …)`；实例入 `__stubs.terminals`）；`window.createTerminal(options)` → `__record('createTerminal', options)` 并返回新桩；`window.activeTerminal` getter 读 `__stubs.activeTerminal`（可注入）；`__resetStubs` 清空两者。`TerminalExitStatus` 不建模，`exitStatus` 直接公开可变字段。
- 服务：`constructor(store, options?: { getWorkspaceRoot?: () => vscode.Uri | undefined; getReuseTerminal?: () => boolean })`，默认实现分别读 `workspaceFolders?.[0]?.uri` 与 `getConfiguration(CONFIG.section).get(CONFIG.quickCommandReuseTerminal, true)`（CONFIG 键 T8 落 constants，本任务文件内 const 过渡，值为 `'extStarter'` / `'quickCommandReuseTerminal'`）。
```ts
execute(item: QuickCommandItem): Promise<void>
// 无注入时：reuse && (!terminal || terminal.exitStatus !== undefined) → createTerminal({ name: 'QuickCommand', cwd: root })
// 之后 terminal.show(); terminal.sendText(item.command, true); await recordExecution(item.id)
export const QUICK_COMMAND_TERMINAL_NAME = 'QuickCommand'
```
- [ ] 桩先行：扩展 vscode.ts（无测试；以现有测试全绿为回归线）
- [ ] 失败测试：首次执行 createTerminal(name/cwd) + show + sendText(原文, true) + useCount 回写；二次执行复用（仅一条 createTerminal 记录）；exitStatus 置值后重建（Review Focus 4）；getReuseTerminal=false 每次新建；无工作区 cwd undefined
- [ ] FAIL → 实现 → PASS；全量 `npx vitest run` 回归
- [ ] commit `feat(quick-commands): 专用终端执行 + vscode 桩 Terminal`

### Task 5: 树视图 Provider

**Files:**
- Create: `src/extension/features/quickCommands/quickCommandsTreeProvider.ts`
- Test: `src/test/unit/quickCommands/quickCommandsTreeProvider.spec.ts`

**Interfaces (Consumes):** `QuickCommandsService`（onDidChange/listCommands/listGroups/loadError）、`COMMAND.executeQuickCommand`（本任务先用字面量 `'extStarter.executeQuickCommand'`，T8 收敛——直接 import constants 会连带全量改动，故 T5 自持常量、T8 统一）。
**Interfaces (Produces):**
```ts
export type QuickCommandTreeNode =
  | { kind: 'group'; group: QuickCommandGroup | null; children: QuickCommandItem[] }
  | { kind: 'command'; item: QuickCommandItem; group: QuickCommandGroup | null }
  | { kind: 'info'; text: string; icon: string }
export class QuickCommandsTreeProvider implements vscode.TreeDataProvider<QuickCommandTreeNode>, vscode.Disposable
```
- 根：loadError → info('error')；全空 → info 空态（icon 'star-empty' 同 favorites 口径可自选）；否则分组节点按 listGroups 序 + 未分组（有内容才出现，末位）。
- group 节点：label `${name} (${N})` / 未分组 label `未分组 (${N})`，icon 'folder'/'inbox'，Collapsed，contextValue 'quickCommandGroup'；command 节点：label=别名，description=命令单行截断 60（`\s+`→空格），icon 'terminal'，tooltip MarkdownString（命令/分组/已执行 N 次/收藏于），contextValue 'quickCommand'，`treeItem.command = { command: 'extStarter.executeQuickCommand', title: '执行快捷命令', arguments: [item] }`。
- [ ] 失败测试：空态/错误态 info；分组序与未分组末位/隐藏；group 节点各字段；command 节点各字段（含单击路由与 contextValue）；getChildren(group) 返回其命令
- [ ] FAIL → 实现 → PASS
- [ ] commit `feat(quick-commands): 两级树视图（分组→命令）`

### Task 6: 剪贴板桥接

**Files:**
- Create: `src/extension/features/quickCommands/terminalSelection.ts`
- Test: `src/test/unit/quickCommands/terminalSelection.spec.ts`

**Interfaces (Produces):**
```ts
export const TERMINAL_COPY_SELECTION_COMMAND = 'workbench.action.terminal.copySelection'
export async function readTerminalSelectionViaClipboard(): Promise<string | undefined>
// 流程（spec §4.2 逐行照办）：备份 readText → executeCommand(copySelection) → readText
// → finally writeText(backup) 恢复；返回 text.trim() && text !== backup ? text : undefined
// executeCommand 抛错 → 捕获 → 恢复剪贴板 → 返回 undefined（不抛出）
```
- 测试驱动方式：`__stubs.clipboard` 假剪贴板 + `__stubs.registeredCommands.set(TERMINAL_COPY_SELECTION_COMMAND, handler)` 模拟复制（handler 里改写 `__stubs.clipboard`）；抛错用例注册一个 throw 的 handler。
- [ ] 失败测试：正常读取（备份被恢复、命令被调用）；无选区（handler 不改剪贴板）→ undefined；选区==备份 → undefined；空白选区 → undefined；handler 抛错 → undefined 且剪贴板已恢复（Review Focus 3 前置）
- [ ] FAIL → 实现 → PASS
- [ ] commit `feat(quick-commands): 终端选区剪贴板桥接`

### Task 7: 命令壳（12 条）

**Files:**
- Create: `src/extension/commands/quickCommandsCommands.ts`
- Test: `src/test/unit/quickCommands/quickCommandsCommands.spec.ts`

**Interfaces (Consumes):** T1-T6 全部符号、`COMMAND.*`（本任务用字面量映射表 `const CMD = { addQuickCommand: 'extStarter.addQuickCommand', ... }`，T8 收敛为 constants 导入）、`CommandRegistrar`/`showError`（commands/shared）。
**Interfaces (Produces):**
```ts
export interface QuickCommandsCommandDeps { quickCommands: QuickCommandsService }
export function registerQuickCommandsCommands(register: CommandRegistrar, deps: QuickCommandsCommandDeps): void
```
12 条命令行为（守卫风格照抄 favoritesCommands 的 requireItem）：
1. `addQuickCommand`（无参）：InputBox 命令文本（validate 非空 trim）→ InputBox 别名（value=defaultAlias，可空=用默认）→ pickGroup QuickPick（分组列表 + `未分组` Separator 分节 + `$(add) 新建分组…`；新建→InputBox→createGroup，duplicate 复用 existing 并提示）→ addCommand；提示：已收藏「别名」/ 已存在相同命令「既有别名」/ 已达上限 / 无效输入。
2. `captureTerminalSelection`（无参）：`window.activeTerminal` 无 → 提示"没有活动的终端"并 return；桥接 undefined → InputBox（placeholder：请在终端选中命令后重试，或直接粘贴命令）→ 有值走与 1 相同的别名/分组/入库；桥接成功直接走别名/分组/入库。
3. `quickRunCommands`：空列表提示 return；QuickPick（Separator 按组分节 + 未分组节；item {label: 别名, description: 命令单行, detail: `分组名 · 已执行 N 次`}，matchOnDescription: true，placeHolder '执行快捷命令…'）→ `quickCommands.execute(picked.item)`，错误 showError。
4. `executeQuickCommand(arg?)`：requireItem 守卫（无参提示"请从「快捷命令」视图执行"）→ execute。
5. `editQuickCommand(arg?)`：InputBox 预填现文本 → updateCommandText（'updated' 静默成功、'duplicate' 提示已存在、'notfound'/'empty' 提示）。
6. `renameQuickCommand(arg?)`：InputBox 预填别名 → renameCommand，false 提示。
7. `moveQuickCommandToGroup(arg?)`：pickGroup（复用，无"新建分组…"项可保留亦可，保留）→ moveCommandToGroup。
8. `copyQuickCommand(arg?)`：`env.clipboard.writeText(item.command)` + 提示已复制。
9. `removeQuickCommand(arg?)`：removeCommand + 提示已删除「别名」。
10. `createQuickCommandGroup`：InputBox 分组名 → createGroup（duplicate 提示已存在）。
11. `renameQuickCommandGroup(arg?)`：requireGroup 守卫（item 形状含 id/name 无 command）→ InputBox → renameGroup 三态提示。
12. `removeQuickCommandGroup(arg?)`：requireGroup → `showWarningMessage(组内 N 条命令将回落到未分组，确定删除？, { modal: true }, '删除')`；取消 return → removeGroup。
- pickGroup 实现为文件内私有函数 `pickGroup(quickCommands, options: { allowCreate: boolean }): Promise<{ groupId: string | null } | undefined>`（undefined = 用户取消）。
- [ ] 失败测试（dialogQueue 应答驱动）：流程 1 全链路 + 各取消点；流程 2 的三分支（无终端 / 桥接 undefined → InputBox / 桥接成功）；流程 3 空态 + 回车执行；4-12 各主路径与守卫无参不抛错；Review Focus 3 断言
- [ ] FAIL → 实现 → PASS
- [ ] commit `feat(quick-commands): 12 条命令薄壳（新增/捕获/执行/分组管理）`

### Task 8: constants 收敛 + 装配

**Files:**
- Modify: `src/extension/constants.ts`、`src/extension/commands/index.ts:17-60`、`src/extension/index.ts:140-152` 后追加、`quickCommandsService.ts`/`quickCommandsTreeProvider.ts`/`quickCommandsCommands.ts`（字面量改 import）

**Interfaces (Produces):**
- `VIEW`: `quickCommandsViewId: 'extStarter.quickCommandsView'`、`quickCommandContextValue: 'quickCommand'`、`quickCommandGroupContextValue: 'quickCommandGroup'`；`COMMAND`: `addQuickCommand / captureTerminalSelection / quickRunCommands / executeQuickCommand / editQuickCommand / renameQuickCommand / moveQuickCommandToGroup / copyQuickCommand / removeQuickCommand / createQuickCommandGroup / renameQuickCommandGroup / removeQuickCommandGroup`（值 `extStarter.<同名>`）；`STORAGE`: `quickCommandsFileName: '.vscode/quick-commands.json'`、`quickCommandsMementoKey: 'extStarter.quickCommands'`；`CONFIG`: `quickCommandReuseTerminal: 'quickCommandReuseTerminal'`。
- `CommandDeps` + `quickCommands: QuickCommandsService`；`registerCommands` 尾部加 `registerQuickCommandsCommands(register, { quickCommands: deps.quickCommands })`。
- `index.ts` 在 favorites 装配块后照抄：`new QuickCommandsService(createQuickCommandsStore(context, { onWarning: m => outputChannel.appendLine(`[快捷命令] ${m}`) }))` → push/load → `new QuickCommandsTreeProvider(service)` → `createTreeView(VIEW.quickCommandsViewId, …)`；`registerCommands` deps 加 `quickCommands`。
- [ ] 三处字面量全部替换为 constants 导入（grep 校验无残留 `extStarter.quickCommand`/`extStarter.executeQuickCommand` 字面量于 features/commands 层）
- [ ] `npx vitest run` 全绿（现有 quickCommands spec 仍 PASS）
- [ ] commit `feat(quick-commands): constants 单一来源 + 激活装配`

### Task 9: package.json 清单 + nls + gitignore + 版本号

**Files:**
- Modify: `package.json`、`package.nls.json`、`package.nls.zh-cn.json`、`.gitignore`

**Interfaces:** 全部键值以 T8 constants 为准（见 spec §6.1 表格，title 用 nls 占位）。
- views.extStarter 数组：favoritesView 块后插入 `{"id":"extStarter.quickCommandsView","name":"%view.quickCommands.name%"}`。
- commands 数组追加 12 条（icon：add `$(add)`、capture `$(terminal)`、quickRun `$(play)`、execute `$(play)`、edit `$(pencil)`、rename `$(edit)`、move `$(folder)`、copy `$(copy)`、remove `$(close)`、createGroup `$(new-folder)`、renameGroup `$(edit)`、removeGroup `$(close)`）。
- menus：
  - `view/title`：addQuickCommand navigation@1、quickRunCommands navigation@2、createQuickCommandGroup navigation@3（when `view == extStarter.quickCommandsView`）。
  - `view/item/context`：命令节点（viewItem==quickCommand）inline@1 execute `$(play)`、inline@2 rename、inline@3 remove；右键 1_run@1 execute、2_manage@1 edit、@2 rename、@3 move、@4 copy、@5 remove。分组节点（viewItem==quickCommandGroup）2_manage@1 rename、@2 remove。
  - 新增菜单键 `terminal/context`：captureTerminalSelection，group `9_starter@1`。
- configuration.properties 追加 `extStarter.quickCommandReuseTerminal`（boolean，default true，%configuration.quickCommandReuseTerminal.description%）。
- nls 双文件各 +15 键（view.quickCommands.name / 12 条 command.*.title / configuration.quickCommandReuseTerminal.description；英文直译、中文按 spec §6.1）。
- `.gitignore` 追加 `.vscode/quick-commands.json`（favorites 行后）；`package.json` `version` `3.4.0` → `3.5.0`。
- [ ] 快速校验：`npx tsx -e "import('./scripts/checks/manifest').then(m => { const r = m.checkManifestConsistency(); console.log(r.ok ? 'MANIFEST OK' : r.errors.join('\n')); process.exit(r.ok ? 0 : 1) })"` → MANIFEST OK（若该模块导出形态不同，读 scripts/checks/manifest.ts 的实际导出后适配）
- [ ] `npm run check-types` 通过
- [ ] commit `feat(quick-commands): 清单/菜单/i18n/配置贡献点（v3.5.0）`

### Task 10: 集成冒烟套件

**Files:**
- Modify: `src/test/extension.test.ts`（文件尾追加 suite，照抄 1024-1049 favorites 套件形态）

- [ ] 追加 `suite('快捷命令（v3.5 集成冒烟）')`：① 12 条命令全部注册（`vscode.commands.getCommands()`）；② `quickRunCommands` 与 `captureTerminalSelection` 无参可执行（两者空态均为信息提示安全路径，**不执行 addQuickCommand**——其会在真实宿主阻塞等待输入）
- [ ] `npm run compile-tests && npm test`（首次会下载 VSCode，走 .vscode-test 缓存）→ 套件 PASS
- [ ] commit `test(quick-commands): 宿主集成冒烟（12 命令注册 + 安全可执行）`

### Task 11: 文档三件套 + 口径一致性 + CHANGELOG

**Files:**
- Rename（已在执行期完成）: 设计文档现为 `docs/需求与优化方案/16-快捷命令设计方案.md`（标题与 §10 自引用已同步），本任务提交该文件
- Create: `docs/功能介绍/09-快捷命令.md`（用户视角：新增/捕获/分组/执行/QuickPick，含视图树示意 ASCII）、`docs/开发指南/12-快捷命令.md`（三件套结构、剪贴板桥接原理与风险、桩扩展、门禁注意）
- Modify（口径 6 视图/35 命令 → 7 视图/47 命令）:
  - `README.md`：视图表头 (6)→(7) + 快捷命令行、"35 条命令"→"47 条命令"（两处）、"6 个视图"→"7 个视图"、扩展速查表加快捷命令行（指向指南 12）
  - `agent.md:9`：6 视图 → 7 视图（列表加快捷命令）
  - `docs/README.md:84`：`7 视图 / 47 命令 / …`
  - `docs/基础系统介绍/02-公开接口总表.md`：视图表 +1 行、命令表 +12 行、"35 条"→"47 条"
  - `docs/功能介绍/README.md`：总表 v3.5 · 7 视图 / 3 页面 / 47 命令 + 快捷命令行 + 菜单速查补充
  - `docs/开发指南/README.md`：+12 行
  - `docs/操作指导/02-开发与调试步骤.md`："6 个视图"→"7 个视图" + 视图列表补一行
  - `docs/操作指导/images/04-sidebar-views.svg`：标题文本 6→7、视图行追加快捷命令（保持 SVG 可渲染，间距顺延）
  - `docs/需求与优化方案/README.md`：+16 行（已实施 v3.5.0）；状态头部 01~15 → 01~16 并补一句快捷命令随 v3.5.0 落地；14/15 行的"待实施（v3.5.0）"改为"待实施（v3.6.0+）"（v3.5.0 已被快捷命令占用）
  - `CHANGELOG.md`：`## [3.5.0] - 2026-11-10` 新增段（照 3.4.0 风格：视图/捕获剪贴板桥接/分组/执行/12 命令/测试桩增量/文档三件套）
- [ ] 逐文件更新（每完成一组跑 `npx prettier --check <file>` / `npx eslint <file>`）
- [ ] commit `docs: 快捷命令三件套 + 全库口径 7 视图/47 命令（v3.5.0）`

### Task 12: 全量门禁

- [ ] `npm run gate`（含第⑧步宿主集成测试）→ 全步骤绿；红灯逐个修复（修复若涉及代码回到对应任务口径，不改变接口）
- [ ] 如有修复：commit `fix(quick-commands): 门禁修复（…）`

### Task 13: 推送

- [ ] `git log --oneline -5` 复核提交序列干净
- [ ] `git push origin main`（仓库惯例：特性直提 main，见 3b34d2a 等；如远端拒绝再改走特性分支并回报）
- [ ] 复核 `git status` 干净、远端可见新提交

## Self-Review 记录

- Spec 覆盖：§3 模型/存储→T1-T3；§4 捕获→T6/T7；§5 执行→T4；§6 公开面→T7-T9；§7 分组→T3/T5；§9 测试→T1-T7/T10；§10 文档→T11。§3.3 的 `captureFromText` 未单列服务方法——壳层复用 `addCommand` 入口，行为与 spec 一致（更少冗余接口），已在本行记录。
- 类型一致性：`AddCommandStatus`/`GroupOp` 等联合类型 T3 定义、T7 消费一致；`execute(item)` T4 定义、T5 路由参数与 T7 调用一致。
- 步骤可执行性：每步一个动作；测试以用例名+断言要点表达，不誊写实现体。
- 长度比例：计划 ≈ spec 的 1/3，代码块均为签名/断言，无实现转录。
