# 代码书签 + 收藏夹数据可迁移 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 14/15 号方案——行级代码书签（Ctrl+Alt+K / 树视图 / QuickPick / 循环跳转）+ 收藏数据全面明文 JSON 化（激活期迁移 + 打开数据文件入口），发布 v3.5.0。

**Architecture:** 先做 15 号存储基座（收藏夹 store 双实现改造 + 激活期迁移），再做 14 号书签特性（service / tree / commands / manifest 四件套，完全镜像收藏夹样板）；文档同步与版本 bump 收尾。

**Tech Stack:** TypeScript + VSCode Extension API ^1.85；Vitest 单测（stubs/vscode 假宿主）；宿主集成冒烟（@vscode/test-electron）；门禁 `npm run gate`。

**Spec:**

- `docs/需求与优化方案/14-代码书签设计方案.md`
- `docs/需求与优化方案/15-收藏夹数据可迁移增强方案.md`

> **⚠ 恢复指引（2026-11-10 暂停）**：因并行会话实施 quick-commands 且已占用 v3.5.0，本计划暂停，恢复前必读 `.superpowers/sdd/2026-11-10-bookmarks-and-favorites-portability/progress.md` 的 Rulings 与恢复指引。要点：目标版本改为 **v3.6.0**（文中 v3.5.0 字样按此理解）；Task 7/8 的视图数/命令数以恢复时实际 HEAD 重算（quick-commands 落地后为 7 视图 / 47 命令基线，书签是第 8 视图、终态 56 命令）。

## Global Constraints

- 命令 / 视图 / 存储 ID 单一来源 `src/extension/constants.ts`，package.json contributes 必须与之同步（门禁第 ⑥ 步双向闭合校验，含 keybindings）。
- 存储契约照抄收藏夹现状：信封 `{ schemaVersion, items }` + `writeJsonAtomic`（自带 createDirectory）+ 损坏复制 `.corrupt-*.bak` 后按空数据继续 + 顶层数组宽容读取 + 归一化守卫逐条丢弃并警告。
- nls 双语（`package.nls.json` 英 / `package.nls.zh-cn.json` 中）新增键必须成对。
- 带参命令无参调用给出可操作提示，不抛错（`showError` 统一接错，见 `commands/shared.ts`）。
- 覆盖率阈值（vitest.config.ts）：全局 lines 91.5 / functions 90 / statements 91 / branches 84.5——新模块必须达标。
- `agent.md` 协议：新增代码测试先行；每轮提交前 `npm run test:unit` 必须通过。
- 计划对设计文档的两处实施期修正（实现时同步回写设计文档）：① 树条目单击需要带参跳转命令，新增第 8 条命令 `extStarter.jumpToBookmark`（镜像收藏夹 `openFavorite` 的树路由模式），终态命令数 43→44；② `writeJsonAtomic` 已内置 createDirectory，global JSON store 无需额外建目录逻辑。

## Review Focus

- **文件被改短后书签 line 越界**：跳转应钳制到最后一行并如实提示，而非抛异常或静默——Task 4 测试钉住。
- **行文本含空白 / 超长**：打点快照 trim、超 100 字符截断、空行存「(空行)」——Task 3 测试钉住。
- **书签数据文件损坏（手改坏 JSON）**：复制 `.corrupt-*.bak` 后按空数据继续，绝不静默清空原文件——Task 3 测试钉住。
- **旧版无工作区收藏数据（globalState）**：激活期迁移四分支（无数据静默 / 文件已存在清旧键 / 迁移+清键+提示 / 写失败保留旧键报错），幂等——Task 1 测试钉住。
- **非 file: 协议（untitled）编辑器按 Ctrl+Alt+K**：如实提示「仅支持本地文件」，不产生脏数据——Task 5 测试钉住。

---

### Task 1: 收藏夹 store 明文 JSON 化 + 激活期迁移（15 §3）

**Files:**

- Modify: `src/extension/features/favorites/favoritesService.ts`
- Modify: `src/extension/constants.ts`（STORAGE 增加 `favoritesGlobalFileName: 'favorites.json'`；`favoritesMementoKey` 注释改为「仅供激活期迁移读取旧数据」）
- Modify: `src/extension/index.ts`（装配段调用迁移）
- Test: `src/test/unit/favorites/favoritesService.spec.ts`（追加用例）

**Interfaces:**

- Produces: `IFavoritesStore.dataFileUri(): vscode.Uri`；`class GlobalJsonFavoritesStore extends JsonFavoritesStore`（仅构造转发 fileUri=globalStorageUri/favorites.json）；`createFavoritesStore(context, options)` 无工作区分支返回 `GlobalJsonFavoritesStore`；`async function migrateFavoritesMementoToFile(context, options?: { onWarning?: (m: string) => void; onMigrated?: (fileUri: vscode.Uri) => void }): Promise<boolean>`；`FavoritesService.dataFileUri(): vscode.Uri` 与 `FavoritesService.ensureDataFile(): Promise<void>`（stat FileNotFound → `store.save([])` 写空信封；其他错误原样抛）。
- 删除：`MementoFavoritesStore` 类与 `IFavoritesStore` 之外的 Memento 依赖（迁移函数除外）。

- [ ] **Step 1: 写失败测试**（追加到 favoritesService.spec.ts，复用现有 fake fs / 临时目录样板）

```ts
// 1) createFavoritesStore 无工作区 → instanceof GlobalJsonFavoritesStore，dataFileUri 以 favorites.json 结尾
// 2) GlobalJsonFavoritesStore 往返：save(items) → load() 深等价；dataFileUri() === 传入 uri
// 3) GlobalJsonFavoritesStore 损坏：写入 'not json' → load() 返回 [] 且目录出现 .corrupt-*.bak
// 4) migrateFavoritesMementoToFile 四分支：
//    a. globalState 无数据 → 返回 false，不写文件不提示
//    b. 有数据且全局文件已存在 → 返回 false，旧键被清除（globalState.update(key, undefined) 被调），文件内容不变
//    c. 有数据且文件不存在 → 返回 true，文件为信封 {schemaVersion:1, items 归一化后}，旧键清除，onMigrated 收到 fileUri
//    d. 有数据、写入失败（stub writeFile 抛错）→ 抛错且旧键保留
// 5) 幂等：分支 c 执行后再跑一次 → 分支 a 行为（旧键已清）
// 6) FavoritesService.ensureDataFile：文件不存在 → store.save([]) 后文件存在且为空信封；已存在 → 不改写（mtime/内容不变）
```

- [ ] **Step 2: 跑测试确认失败** — `npm run test:unit -- favorites`（vitest 过滤 favorites）。Expected: FAIL（GlobalJsonFavoritesStore / migrateFavoritesMementoToFile 未定义）。
- [ ] **Step 3: 实现** — 按 Interfaces 逐项落地；`migrateFavoritesMementoToFile` 主体：读 `STORAGE.favoritesMementoKey` → 无数据 return false；stat 全局文件 → 存在则 `globalState.update(key, undefined)` 后 return false；不存在则 `normalizeFavoriteList(legacy, onWarning)` → `writeJsonAtomic(fileUri, { schemaVersion: FAVORITES_SCHEMA_VERSION, items })` → 清旧键 → `onMigrated?.(fileUri)` → return true；全程 try/catch：写失败**先于**清键，错误向上抛。
- [ ] **Step 4: index.ts 装配** — `migrateLegacyKeys` 调用旁新增：`void migrateFavoritesMementoToFile(context, { onWarning: (m) => outputChannel.appendLine(`[收藏夹] ${m}`), onMigrated: (fileUri) => { outputChannel.appendLine(...); void vscode.window.showInformationMessage(\`无工作区收藏数据已迁移到文件：${fileUri.fsPath}\`) } }).catch(...)`——catch 内`showErrorMessage`（如实报错，旧数据保留）+ outputChannel 记录。
- [ ] **Step 5: 全量单测 + lint** — `npm run test:unit` && `npm run lint`。Expected: PASS（现有 favorites 用例不回归）。
- [ ] **Step 6: Commit** — `feat(favorites): 无工作区收藏数据落明文 JSON（globalStorage）+ 激活期一次性迁移`

### Task 2: `openFavoritesDataFile` 命令（15 §4 前半）

**Files:**

- Modify: `src/extension/constants.ts`（COMMAND.openFavoritesDataFile）
- Modify: `src/extension/commands/favoritesCommands.ts`（新增 register 分支）
- Modify: `package.json`（commands + menus view/title favoritesView navigation@2）、`package.nls.json` / `package.nls.zh-cn.json`（`command.openFavoritesDataFile.title`，en "Open Favorites Data File" / zh「打开收藏数据文件」）
- Test: `src/test/unit/favorites/favoritesCommands.spec.ts`、`src/test/extension.test.ts`（收藏夹冒烟套件命令清单追加）

**Interfaces:**

- Consumes: Task 1 的 `favorites.ensureDataFile()` / `favorites.dataFileUri()`。
- Produces: 命令 `extStarter.openFavoritesDataFile`（无参；图标 `$(json)`）。

- [ ] **Step 1: 写失败测试** — 命令壳 spec：注册断言；执行后 `executeCommand` 录制含 `('vscode.open', dataFileUri)`；文件缺失时先触发一次 store 写入（空信封落盘）。extension.test.ts：收藏夹冒烟清单（`extension.test.ts:1024` 起）追加该 id。
- [ ] **Step 2: 跑测试确认失败** — `npm run test:unit -- favorites`。Expected: FAIL。
- [ ] **Step 3: 实现命令壳** —

```ts
register(COMMAND.openFavoritesDataFile, async () => {
  try {
    await favorites.ensureDataFile()
    await vscode.commands.executeCommand('vscode.open', favorites.dataFileUri())
  } catch (err) {
    showError(err)
  }
})
```

- [ ] **Step 4: 清单与 nls** — package.json commands 区追加（category `%command.category%`、icon `$(json)`）；menus `view/title` 追加 `{ command, when: view == extStarter.favoritesView, group: navigation@2 }`；两个 nls 文件成对补键。
- [ ] **Step 5: 验证** — `npm run gate`。Expected: 全绿（manifest 闭合校验通过）。
- [ ] **Step 6: Commit** — `feat(favorites): 新增「打开收藏数据文件」入口——手动备份不用记路径`

### Task 3: 书签领域模型 + store + 服务核心（14 §3，纯数据层）

**Files:**

- Create: `src/extension/features/bookmarks/bookmarksService.ts`（本任务只含模型/存储/核心方法）
- Modify: `src/extension/constants.ts`（STORAGE：`bookmarksFileName: '.vscode/bookmarks.json'`、`bookmarksGlobalFileName: 'bookmarks.json'`）
- Modify: `src/extension/index.ts`（装配 BookmarksService：`createBookmarksStore` + `void bookmarks.load()` + subscriptions.push）
- Test: `src/test/unit/bookmarks/bookmarksService.spec.ts`（新建）

**Interfaces:**

- Produces（后续任务依赖的确切签名）:

```ts
export interface BookmarkItem { id: string; path: string; line: number; text: string; addedAt: string }
export const BOOKMARKS_SCHEMA_VERSION = 1
export const MAX_BOOKMARKS = 500
export const BOOKMARK_TEXT_MAX_LENGTH = 100
export const EMPTY_LINE_TEXT = '(空行)'
export function normalizeBookmarkList(raw: unknown, onWarning?: (m: string) => void): BookmarkItem[]
export function toPosix(value: string): string
export interface IBookmarksStore { load(): Promise<BookmarkItem[]>; save(items: BookmarkItem[]): Promise<void>; dataFileUri(): vscode.Uri }
export class JsonBookmarksStore       // 契约照抄 JsonFavoritesStore（含 recoverFromCorruption），守卫换 normalizeBookmarkList
export class GlobalJsonBookmarksStore extends JsonBookmarksStore {}
export function createBookmarksStore(context: vscode.ExtensionContext, options?): IBookmarksStore
export class BookmarksService implements vscode.Disposable {
  async load(): Promise<void>            // 失败置 loadError，不清数据
  list(): BookmarkItem[]
  readonly loadError: string | undefined
  readonly onDidChange: vscode.Event<void>
  storagePathFor(uri: vscode.Uri): string // getWorkspaceFolder 命中 → toPosix(relative)，否则 uri.fsPath
  snapshotText(text: string): string      // trim → 空串存 EMPTY_LINE_TEXT → 超 100 截 slice(0,100)
  async toggle(uri: vscode.Uri, line: number, text: string): Promise<{ added?: BookmarkItem; removed?: BookmarkItem }>
  async remove(id: string): Promise<boolean>
  async clear(): Promise<number>          // 返回清除条数
  ordered(): BookmarkItem[]               // (toPosix(path) 升序, line 升序) 排序副本
  next(uri: vscode.Uri | undefined, line: number | undefined, direction: 'next' | 'prev'): BookmarkItem | undefined
}
```

- `next` 语义（14 §5 定死口径）：`ordered()` 为空 → undefined；`uri/line` 缺省 → next=首条 / prev=末条；否则以 `(toPosix(storagePathFor(uri)), line)` 为当前键做元组序严格比较，next=严格晚于的第一条（尾后回绕到首）、prev=严格早于的第一条倒序扫描（首前回绕到尾）。路径比较用普通字符串 `<`/`>`（不用 localeCompare，保证确定性）。

- [ ] **Step 1: 写失败测试** —
  1. store 往返 / 信封 schemaVersion 不匹配警告 / 顶层数组宽容读取 / 损坏 `.corrupt-*.bak` 备份 + 空数据继续（照 favoritesService.spec 对应用例改名复刻）；
  2. `normalizeBookmarkList`：缺 path / line 非整数 / line<0 逐条丢弃并警告；上限 500 裁剪保留头部（新插头部语义）；
  3. `snapshotText`：`'  '`→EMPTY_LINE_TEXT、`' a b '`→`'a b'`、101 字符截到 100；
  4. `storagePathFor`：工作区内 → 相对 POSIX；工作区外 → fsPath；
  5. `toggle`：新增插头部 + `{added}`；同行再 toggle → `{removed}` 且条目消失；第 501 条 → 最旧被丢；
  6. `ordered` / `next`：同文件跨行、跨文件、回绕（next 从最后一条回首条）、无编辑器兜底、严格性（当前位置是书签时 next 跳过它）；
  7. `remove` / `clear` 返回值与 onDidChange 触发断言。
- [ ] **Step 2: 跑测试确认失败** — `npm run test:unit -- bookmarks`。Expected: FAIL（模块不存在）。
- [ ] **Step 3: 实现** — 照 Interfaces；`JsonBookmarksStore` 从 `JsonFavoritesStore` 复刻（仅守卫函数与信封常量不同，这是 14 §0 拍板的「第三套同构实现」）；`index.ts` 装配段加在收藏夹之后，`onWarning` 前缀 `[书签]`。
- [ ] **Step 4: 跑测试确认通过** — `npm run test:unit`。Expected: PASS。
- [ ] **Step 5: Commit** — `feat(bookmarks): 书签领域模型与存储——信封契约复刻 + toggle/循环序/守卫`

### Task 4: 书签解析与跳转（14 §4）

**Files:**

- Modify: `src/extension/features/bookmarks/bookmarksService.ts`
- Test: `src/test/unit/bookmarks/bookmarksService.spec.ts`（追加）

**Interfaces:**

- Consumes: Task 3 全部。
- Produces:

```ts
// BookmarksService 追加：
async resolveBookmarkUri(item: BookmarkItem): Promise<vscode.Uri>
  // 语义照抄 FavoritesService.resolveFavoriteUri：绝对 → Uri.file；相对 → 逐工作区文件夹 stat 尝试，全未命中回退第一个文件夹（无文件夹回退 getWorkspaceFolder，再回退 Uri.file(path.sep)）
async jump(item: BookmarkItem): Promise<vscode.Uri>
  // resolveBookmarkUri → workspace.openTextDocument → window.showTextDocument
  // line 钳制：doc.lineCount > 0 时 line = Math.min(item.line, doc.lineCount - 1)；
  // item.line > doc.lineCount - 1 且 lineCount > 0 → showInformationMessage(`书签行号越界（L${item.line + 1}），已定位到文件末尾。`)
  // lineCount === 0 → 定位 Position(0,0)，不提示
  // selection 置行首 + revealRange(InCenterIfOutsideViewport)；返回 uri
dataFileUri(): vscode.Uri       // 透传 store
async ensureDataFile(): Promise<void>  // 与 FavoritesService 同语义
```

- [ ] **Step 1: 写失败测试** —
  1. 相对路径多根解析命中第二文件夹（stub `workspace.fs.stat` 布阵）；全未命中回退第一文件夹；绝对路径直接 `Uri.file`；
  2. `jump`：stub 假文档（stubs `openTextDocument` 按 uri 内容匹配）→ 录制断言 `showTextDocument` 被调、selection 行号正确；
  3. 越界钳制：item.line=99、文档 10 行 → 定位第 10 行（index 9）且 `showInformationMessage` 记录含「越界」；
  4. 文件不存在 → openTextDocument 抛错向上传播（命令壳负责呈现）。
- [ ] **Step 2: 跑测试确认失败** — `npm run test:unit -- bookmarks`。Expected: FAIL。
- [ ] **Step 3: 实现** — 按 Interfaces。
- [ ] **Step 4: 跑测试确认通过** — `npm run test:unit`。Expected: PASS。
- [ ] **Step 5: Commit** — `feat(bookmarks): 书签路径解析与跳转——多根回退 / 行号越界钳制如实提示`

### Task 5: 书签命令薄壳（14 §5 + 实施期修正 jumpToBookmark）

**Files:**

- Modify: `src/extension/constants.ts`（COMMAND 新增 8 条：`toggleBookmark` / `jumpToNextBookmark` / `jumpToPreviousBookmark` / `quickOpenBookmarks` / `jumpToBookmark` / `removeBookmark` / `clearBookmarks` / `openBookmarksDataFile`）
- Create: `src/extension/commands/bookmarksCommands.ts`
- Modify: `src/extension/commands/index.ts`（CommandDeps 加 `bookmarks: BookmarksService`；`registerBookmarksCommands(register, { bookmarks: deps.bookmarks })`）
- Modify: `src/extension/index.ts`（registerCommands 调用处 deps 传 bookmarks）
- Test: `src/test/unit/bookmarks/bookmarksCommands.spec.ts`（新建）

**Interfaces:**

- Consumes: Task 3/4 的 BookmarksService 全部方法、`commands/shared.ts` 的 `CommandRegistrar` / `showError`。
- Produces: `registerBookmarksCommands(register: CommandRegistrar, deps: { bookmarks: BookmarksService }): void`，8 条命令行为：

```ts
toggleBookmark:        // 无活动编辑器 → info '没有活动的编辑器。'；
                       // document.uri.scheme !== 'file' → info '代码书签仅支持本地文件。'；
                       // line = selection.active.line，text = document.lineAt(line).text
                       // toggle 后 info：added ? `已添加书签（第 ${line + 1} 行）。` : `已移除书签（第 ${line + 1} 行）。`
jumpToNextBookmark / jumpToPreviousBookmark:
                       // list() 空 → info '暂无书签：在编辑器中按 Ctrl+Alt+K 给当前行添加书签。'
                       // editor = activeTextEditor；uri/line 缺省传 undefined
                       // target = bookmarks.next(editor?.document.uri, editor ? editor.selection.active.line : undefined, direction)
                       // target 存在 → jump(target)，showError 接错
quickOpenBookmarks:    // 空 → 同上提示；QuickPick 条目 { label: `${basename}:${item.line + 1}`, description: item.text, detail: item.path, item }
                       // picked → jump(picked.item)
jumpToBookmark:        // requireItem 守卫（id+path+line 形状守卫，isBookmarkItem）→ jump；无参 → info `请从「书签」视图调用跳转。`
removeBookmark:        // requireItem → remove → info `已移除书签（${item.path}:L${item.line + 1}）。`
clearBookmarks:        // showWarningMessage('确定清空全部书签？此操作不可撤销。', { modal: true }, '清空') === '清空'
                       // → n = clear() → info `已清空 ${n} 条书签。`（对齐 clearRecentTasks 模态惯例）
openBookmarksDataFile: // 与 Task 2 openFavoritesDataFile 同构（ensureDataFile + vscode.open + showError）
```

- [ ] **Step 1: 写失败测试** — 每条命令：注册断言 + 无参/空态提示录制断言 + 正常路径 `executeCommand`/服务方法调用录制断言；toggle 的 scheme 守卫、clearBookmarks 模态取消不执行 clear。
- [ ] **Step 2: 跑测试确认失败** — `npm run test:unit -- bookmarks`。Expected: FAIL。
- [ ] **Step 3: 实现命令壳 + 常量 + 接线** — 照 Interfaces；`commands/index.ts` 依赖接口补 `bookmarks` 字段（import type）。
- [ ] **Step 4: 跑测试确认通过** — `npm run test:unit` && `npm run lint`。Expected: PASS。
- [ ] **Step 5: Commit** — `feat(bookmarks): 8 条命令薄壳——toggle/循环跳转/QuickPick/清空模态/数据文件入口`

### Task 6: 书签树视图（14 §6）

**Files:**

- Modify: `src/extension/constants.ts`（VIEW：`bookmarksViewId: 'extStarter.bookmarksView'`、`bookmarkContextValue: 'bookmark'`、`bookmarkFileContextValue: 'bookmarkFile'`）
- Create: `src/extension/features/bookmarks/bookmarksTreeProvider.ts`
- Modify: `src/extension/index.ts`（装配 `BookmarksTreeProvider` + `createTreeView(VIEW.bookmarksViewId, ...)`）
- Test: `src/test/unit/bookmarks/bookmarksTreeProvider.spec.ts`（新建）

**Interfaces:**

- Consumes: BookmarksService（Task 3/4）、`COMMAND.jumpToBookmark`。
- Produces:

```ts
export type BookmarkTreeNode =
  | { kind: 'file'; path: string; children: BookmarkItem[] }
  | { kind: 'bookmark'; item: BookmarkItem }
  | { kind: 'info'; text: string; icon: string }
export class BookmarksTreeProvider implements vscode.TreeDataProvider<BookmarkTreeNode>, vscode.Disposable
// getChildren(根)：loadError → info('error')；空 → info('暂无书签：在编辑器中按 Ctrl+Alt+K 给当前行添加书签', 'bookmark')；
//   否则 ordered() 按 toPosix(path) 分组（保序）→ file 节点（children 组内按 line 升序）
// getChildren(file 节点)：children → bookmark 节点
// getTreeItem(file)：label = basename(path)（path 库），description = POSIX dirname（'' 则 undefined），
//   icon 'file'，contextValue 'bookmarkFile'，collapsibleState.Expanded，
//   command = { command: COMMAND.jumpToBookmark, title: '跳转到书签', arguments: [children[0]] }
//   tooltip：路径 + `共 ${n} 条书签`
// getTreeItem(bookmark)：label = item.text，description = `L${item.line + 1}`，icon 'bookmark'，
//   contextValue 'bookmark'，command 同上 arguments [item]，
//   tooltip Markdown：路径 / 行号 / 收藏于 / 「行文本为打点时快照，可能已过期」
// onDidChangeTreeData 由 service.onDidChange 驱动（构造订阅，dispose 释放——照 FavoritesTreeProvider）
```

- [ ] **Step 1: 写失败测试** — 分组保序（两文件交错添加 → 按 path 升序分组）；file 节点 label/description/command.arguments[0] = 组内第一条；bookmark 节点 label/description/contextValue/command；空态与 loadError info 节点；service.onDidChange 触发刷新。
- [ ] **Step 2: 跑测试确认失败** — `npm run test:unit -- bookmarks`。Expected: FAIL。
- [ ] **Step 3: 实现 + index.ts 装配** — 照 Interfaces；视图注册在收藏夹 treeView 之后。
- [ ] **Step 4: 跑测试确认通过** — `npm run test:unit` && `npm run lint`。Expected: PASS。
- [ ] **Step 5: Commit** — `feat(bookmarks): 「书签」树视图——文件分组两级树 / 空态引导 / 单击跳转路由`

### Task 7: manifest / 快捷键 / 集成冒烟 / 设计文档回写

**Files:**

- Modify: `package.json`（见下）、`.gitignore`（追加 `.vscode/bookmarks.json`，注释「书签数据文件（v3.5，14 方案：行级代码书签）」）
- Modify: `package.nls.json` / `package.nls.zh-cn.json`
- Modify: `src/test/extension.test.ts`（新增书签冒烟套件）
- Modify: `docs/需求与优化方案/14-代码书签设计方案.md`（§5 表格加 `jumpToBookmark` 行、合计改「新增 8 命令 … 7 视图 / 44 命令」、状态行改「已实施（v3.5.0）」；§3 存储 bullet 补「writeJsonAtomic 自带 createDirectory，global store 无需额外建目录」）

**package.json 改动（精确值）：**

- `views.extStarter` 在 favoritesView 之后插入 `{ "id": "extStarter.bookmarksView", "name": "%view.bookmarks.name%" }`（不加 visibility，默认展开）；
- `commands` 追加 8 条（category 均 `%command.category%`）：

| 命令                                | title                                    | icon                |
| ----------------------------------- | ---------------------------------------- | ------------------- |
| `extStarter.toggleBookmark`         | `%command.toggleBookmark.title%`         | `$(bookmark)`       |
| `extStarter.jumpToNextBookmark`     | `%command.jumpToNextBookmark.title%`     | `$(arrow-down)`     |
| `extStarter.jumpToPreviousBookmark` | `%command.jumpToPreviousBookmark.title%` | `$(arrow-up)`       |
| `extStarter.quickOpenBookmarks`     | `%command.quickOpenBookmarks.title%`     | `$(list-unordered)` |
| `extStarter.jumpToBookmark`         | `%command.jumpToBookmark.title%`         | `$(go-to-file)`     |
| `extStarter.removeBookmark`         | `%command.removeBookmark.title%`         | `$(close)`          |
| `extStarter.clearBookmarks`         | `%command.clearBookmarks.title%`         | `$(clear-all)`      |
| `extStarter.openBookmarksDataFile`  | `%command.openBookmarksDataFile.title%`  | `$(json)`           |

- `keybindings`（**顶层新增字段，位置在 menus 之后 configuration 之前**）：

```json
"keybindings": [
  { "command": "extStarter.toggleBookmark", "key": "ctrl+alt+k", "mac": "cmd+alt+k", "when": "editorTextFocus" },
  { "command": "extStarter.jumpToNextBookmark", "key": "ctrl+alt+l", "mac": "cmd+alt+l", "when": "editorTextFocus" },
  { "command": "extStarter.jumpToPreviousBookmark", "key": "ctrl+alt+j", "mac": "cmd+alt+j", "when": "editorTextFocus" }
]
```

- `menus.view/title`（bookmarksView）：quickOpenBookmarks navigation@1、clearBookmarks navigation@2、openBookmarksDataFile navigation@3；
- `menus.view/item/context`：`viewItem == bookmark` → jumpToBookmark `1_open@1`、removeBookmark `2_manage@1` + `inline@1`；`viewItem == bookmarkFile` → jumpToBookmark `1_open@1`；
- `menus.editor/context`：toggleBookmark `9_starter@7`（`when: editorTextFocus`）；
- nls 补键（成对）：`view.bookmarks.name`（en "Bookmarks" / zh「书签」）；8 条 `command.*.title`（en：Toggle Bookmark / Jump to Next Bookmark / Jump to Previous Bookmark / Quick Open Bookmarks / Jump to Bookmark / Remove Bookmark / Clear All Bookmarks / Open Bookmarks Data File；zh：切换书签 / 跳到下一个书签 / 跳到上一个书签 / 快速打开书签 / 跳转到书签 / 移除书签 / 清空全部书签 / 打开书签数据文件）。

- [ ] **Step 1: 写失败测试** — extension.test.ts 新增套件（照 `收藏夹（v3.4 集成冒烟）` 样式，`extension.test.ts:1024` 起）：

```ts
suite('书签（v3.5 集成冒烟）', () => {
  test('8 条书签命令全部注册', async () => {
    /* Set(getCommands()) 逐一 has 断言 8 个 id */
  })
  test('toggle 与 quickOpen 可执行（命令 → 服务接线成功）', async () => {
    /* doesNotReject executeCommand 两条 */
  })
})
```

- [ ] **Step 2: 跑集成测试确认失败** — `npm test`（宿主集成；若本机无 VSCode 二进制缓存则记录跳过原因，以 `npm run test:unit` + gate 为准）。Expected: FAIL（命令未注册）。
- [ ] **Step 3: 落 manifest / nls / .gitignore** — 按上方精确值。
- [ ] **Step 4: 回写设计文档 14** — §5 表格与计数、状态行、§3 注记。
- [ ] **Step 5: 验证** — `npm run gate`。Expected: 全绿（manifest 双向闭合含 keybindings、覆盖率、lint、打包内容校验）。
- [ ] **Step 6: Commit** — `feat(bookmarks): 书签公开面——第 7 视图 + 8 命令 + Ctrl+Alt+K/J/L 快捷键（首个 keybindings 贡献）`

### Task 8: 文档同步 + 版本 v3.5.0 + CHANGELOG + 收尾门禁

**Files:**

- Modify: `package.json`（version 3.4.0 → 3.5.0）、`CHANGELOG.md`（新增 `## [3.5.0] - 2026-11-10`：`### 新增（代码书签）` 与 `### 变更（收藏夹数据可迁移）` 两节，行文对照 3.4.0 条目风格）
- Modify: `docs/需求与优化方案/15-收藏夹数据可迁移增强方案.md`（状态行改「已实施（v3.5.0）」；§4 命令合计 43→44，注明 jumpToBookmark 随 14 落地；§3 补 writeJsonAtomic createDirectory 注记）
- Modify: `docs/需求与优化方案/README.md`（状态行 14/15 改「随 v3.5.0 落地」；14/15 行「待实施」→「已实施（v3.5.0）」）
- Modify: `agent.md`（第 9 行视图清单 6→7，加「书签」）、根 `README.md`（44 行附近 6 个视图 → 7 个）
- Modify: `docs/README.md`（公开接口总表：6 视图 / 35 命令 → 7 视图 / 44 命令；数据落点补 `.vscode/bookmarks.json` 与 globalStorage `favorites.json` / `bookmarks.json`）
- Modify: `docs/功能介绍/README.md`（总表头 v3.4 → v3.5 · 7 视图 / 44 命令；新增 09 行）+ Create `docs/功能介绍/09-代码书签.md`（三入口 + 快捷键表 + 简单版口径与漂移说明）
- Modify: `docs/功能介绍/08-收藏夹.md`（新增「备份与迁移」节：手拷两文件路径 + globalStorage 真实路径 + 旧 globalState 自动迁移说明）
- Modify: `docs/开发指南/README.md`（路由表加 12）+ Create `docs/开发指南/12-代码书签.md`（代码地图 / 存储 / 测试，对照 11-收藏夹.md 结构）；`docs/开发指南/11-收藏夹.md`（补 GlobalJson store 与迁移小节）
- Modify: `docs/操作指导/02-开发与调试步骤.md`（「六个视图」→「七个视图」两处 + 列表加书签）、`docs/操作指导/README.md`（02 行描述）、`docs/操作指导/images/04-sidebar-views.svg`（重绘为 7 视图，照现 SVG 结构追加一个视图块）

- [ ] **Step 1: 全仓一致性自查** — `grep -rn "六个视图\|6 视图\|35 命令\|6 个视图" docs README.md agent.md`，逐一改齐为 7 视图 / 44 命令（设计历史文档 13 号等中的历史计数**不改**，只改「现状描述」类文本）。
- [ ] **Step 2: 版本与 CHANGELOG** — package.json version、CHANGELOG 新条目（含设计文档链接，对照 3.4.0 条目结构）。
- [ ] **Step 3: 文档落地** — 按清单逐文件修改 / 新建；功能介绍 09 与开发指南 12 的命令/键位/存储值以本文档 Task 5/7 为准。
- [ ] **Step 4: 终验** — `npm run gate` 全绿；`npm run package:vsix` 产出 .vsix（发布物冒烟）。
- [ ] **Step 5: Commit** — `docs+chore(v3.5.0): 代码书签与收藏夹数据可迁移——文档同步、视图数 6→7、命令数 35→44、CHANGELOG`

## Self-Review 结论

- 规格覆盖：14 号 §2–§9 → Task 3–7；15 号 §3–§5 → Task 1–2；§5 文档口径与版本 → Task 7–8。两处实施期修正（jumpToBookmark、createDirectory）已在 Global Constraints 声明并回写设计文档。
- 类型一致性：`BookmarkItem`/`next`/`jump`/`dataFileUri`/`ensureDataFile` 各任务签名一致；命令 id 与 constants/manifest 逐字对照。
- Review Focus 五项均已钉入对应任务测试步骤。
