# 06 · Webview 页面与表单基座

> Vue 3 页面框架 + 自研 VSCode 原生设计系统。基座承诺：**新增页面只碰两个文件、
> 加表单字段只改一处**。跨侧通信唯一契约是 `protocol.ts`。

## 代码地图

| 职责                                           | 文件                                    | 关键符号                                                                |
| ---------------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------- |
| ★ 页面注册表（扩展点）                         | `src/webview/pages.ts`                  | `WEBVIEW_PAGES`（当前 gallery / taskManager）                           |
| 消息协议 + 运行时守卫（唯一跨侧契约）          | `src/webview/protocol.ts`               | `HostMessage` / `WebviewMessage` / `isHostMessage` / `isWebviewMessage` |
| 表单字段派生（领域无关）                       | `src/webview/formSchema.ts`             | `deriveFormSchema` `toFieldDefs` `SchemaFieldDef`                       |
| 宿主控制器（生命周期 / 提交幂等 / serializer） | `src/webview/host/webviewController.ts` | `WebviewController`                                                     |
| HTML 外壳（CSP 矩阵，纯函数可单测）            | `src/webview/host/webviewHtml.ts`       | `renderWebviewHtml`                                                     |
| 资源解析（manifest 递归收集 CSS）              | `src/webview/host/assetResolver.ts`     | `resolveEntryAssets`                                                    |
| SchemaForm + 字段组件                          | `src/webview/components/`               | `SchemaForm.vue` + `fields/` 5 组件 + `fieldAdapter.ts`                 |
| 设计系统（12 组件 + 令牌）                     | `src/webview/ui/`                       | `AppShell` / `VButton` / `tokens.css` / `iconNames.ts`                  |

## 核心机制

```
新增页面 N 步全自动链：
pages.ts 登记 → vite rollupOptions.input 自动纳入 → 构建出 .vite/manifest.json
  → 宿主 assetResolver 反查入口 chunk + 递归收集 import 链 CSS
  → webviewHtml 拼 HTML（nonce CSP：default-src 'none' / 无 unsafe-* / base-uri 'none'）
  → e2e harness 镜像 PAGE_ENTRY_PATHS 自动可测
```

- **面板生命周期**：`createOrShow` 单例、提交幂等（在途 submit 不重复受理，无关闭前
  确认模态——v3.3.0 起移除 dirty 守卫）、`registerWebviewPanelSerializer` 窗口重载恢复；
- **消息守卫**：两侧收到消息先过 `isWebviewMessage` / `isHostMessage`，未知消息只记日志；
- **表单基座**：领域声明 `SchemaFieldDef[]` → `deriveFormSchema` 派生 → `toFieldDefs`
  组装 init 载荷 → `SchemaForm` 渲染 / 校验 / 回填（字段类型 text / textarea / select /
  tags / boolean / password，缺控件在 `fields/` 加组件并在 SchemaForm 注册分发）；
- **样式门禁**（构建期红线）：颜色只用 `--vscode-*` 令牌；尺寸只用 `--ui-*`（禁 px 字面量）；
  禁 `v-html` / `innerHTML` / 模板静态 style 属性 / 白名单外 import；产物 CSS 禁止
  `url(/…)`（vite `base: './'` 的配套红线——违反即字体 404、图标全灭）。

## 扩展实操

### A. 新增一个页面（两个文件 + 一行注册）

1. 复制 `src/webview/apps/gallery/` → `apps/myPage/`（`main.ts` + `App.vue`）；
2. `pages.ts` 加一行：`{ id: 'myPage', title: '我的页面', entry: 'src/webview/apps/myPage/main.ts' }`；
3. 需要命令入口时按 [07 · 命令视图与 i18n](07-命令视图与i18n.md) 加命令，
   `WebviewController.createOrShow('myPage', context)` 打开；
4. 需要窗口重载恢复时，在 `extension.ts` 的 `registerSerializer` switch 加分支返回依赖。

### B. 加一条消息（三处）

1. `protocol.ts` 联合类型 + 守卫 case（逐字段窄化，禁止 any 直收）；
2. 宿主侧 `webviewController` / 各面板的消息分发；
3. 页面侧 `window.addEventListener('message')` 分支（先过 `isHostMessage`）。

### C. 用设计系统搭页面

组件清单见 `src/webview/ui/`（AppShell / VToolbar / VButton / VInput / VSelect /
VCheckbox / VFormField / VBadge / VEmptyState / VLoading / VTextarea…），
视觉规格与状态矩阵见
[`../需求与优化方案/04-VSCode原生设计系统.md`](../需求与优化方案/04-VSCode原生设计系统.md)；
`apps/gallery/` 就是活的设计系统验收基准——抄它。

## 测试

| 内容                                             | 文件                                       |
| ------------------------------------------------ | ------------------------------------------ |
| 协议守卫（8 分支全覆盖，100% 阈值）              | `src/test/unit/webview/protocol.spec.ts`   |
| 表单派生                                         | `src/test/unit/webview/formSchema.spec.ts` |
| 控制器 / HTML / 资源解析 / SchemaForm / 字段组件 | `src/test/unit/webview/` 各 spec           |
| 真实浏览器 e2e（含 codicon 字体断言）            | `tests/e2e/{gallery,taskManager}.spec.ts`  |

## 常见坑

- 页面**禁止** `import vscode`；宿主侧页面代码才允许（`host/` 目录豁免 import 白名单）；
- CSP 无 `unsafe-inline`：静态 `style=""` 属性会被静默拦截（样式门禁直接红），
  动态样式用 `:style` 绑定（CSSOM setProperty）；
- `document.fonts.load('16px codicon', '\uE900')` 第二参是取样文本，空串不加载任何字形
  （e2e 字体断言的教训）；
- e2e harness 静态产物只走 `/webview/**` 前缀（模拟宿主 asWebviewUri），CSS 内站点根
  绝对 url(/…) 会 404——这是设计好的假绿防线，别「修」回去。
