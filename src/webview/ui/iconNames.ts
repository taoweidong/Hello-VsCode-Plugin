/**
 * 语义图标名 → codicon 类名映射（docs/需求与优化方案/04 §6，ADR-13）。
 *
 * - Webview 侧组件与页面只使用本映射的语义名（iconClass 返回完整 codicon 类），
 *   禁止在组件内手写 codicon-xxx 字面量或引入其他图标库；
 * - 语义名 → codicon 类名的单一来源（同一概念全插件同图标，修复 E8）。
 */
export const ICON_NAMES = {
  add: 'add',
  edit: 'edit',
  copy: 'copy',
  delete: 'trash',
  refresh: 'refresh',
  search: 'search',
  check: 'check',
  close: 'close',
  warning: 'warning',
  error: 'error',
  info: 'info',
  loading: 'sync',
  save: 'save',
  chevronDown: 'chevron-down',
  arrowUp: 'arrow-up',
  arrowDown: 'arrow-down',
  dash: 'dash',
  server: 'server',
  plug: 'plug',
  terminal: 'terminal',
  send: 'send',
  history: 'history',
  clearAll: 'clear-all',
  eye: 'eye',
  eyeClosed: 'eye-closed',
} as const

export type IconName = keyof typeof ICON_NAMES

/** 语义名 → 完整 codicon 类名（含基类 codicon）。 */
export function iconClass(name: IconName): string {
  return `codicon codicon-${ICON_NAMES[name]}`
}
