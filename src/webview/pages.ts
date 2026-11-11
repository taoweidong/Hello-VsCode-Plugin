/**
 * Webview 页面注册表（docs/需求与优化方案/03 §5.1，单一来源）。
 *
 * - Vite 构建（vite.config.ts）从本表生成 rollupOptions.input；
 * - 宿主（webviewController.ts）从本表取标题与入口；
 * - 本文件必须保持纯数据：不 import vscode / DOM / Vue，两侧共用。
 *
 * 新增页面 = 本表一项 + apps/<pageId>/ 目录（FR-16-AC2）。
 */
/**
 * 页面注册表（单一来源）：retainContextWhenHidden 一律 false（见 03 §5.1 / 05 S5），
 * 页面状态由页面侧经 webview getState/setState 自行持久化。
 * `as const` 让 WebviewPageId 由本表派生——新增页面只改一处，id 联合类型自动跟进。
 */
export const WEBVIEW_PAGES = [
  { id: 'gallery', title: '组件画廊（开发）', entry: 'src/webview/apps/gallery/main.ts' },
  { id: 'taskManager', title: '任务管理', entry: 'src/webview/apps/taskManager/main.ts' },
] as const

/** 页面 id 联合类型（由注册表派生，禁止手工维护第二份）。 */
export type WebviewPageId = (typeof WEBVIEW_PAGES)[number]['id']

/** 页面定义结构（文档用；运行时真值源是 WEBVIEW_PAGES，形状由 findWebviewPage 返回类型约束）。 */
export interface WebviewPageDef {
  /** 页面唯一 id，同时是 Vite 入口名与宿主 viewType 后缀 */
  id: WebviewPageId
  /** 面板标题（中文） */
  title: string
  /** Vite 入口（相对仓库根路径），构建与宿主 manifest 解析共用 */
  entry: string
}

/** 按 id 查页面定义；不存在返回 undefined（调用方需给出清晰错误）。 */
export function findWebviewPage(id: string): WebviewPageDef | undefined {
  return WEBVIEW_PAGES.find((page) => page.id === id)
}
