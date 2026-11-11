import * as vscode from 'vscode'
import type { StepStatus } from '../features/init/initService'
import { reasonOf } from '../services/errors'

/**
 * 命令层共享工具：被各场景分组（页面 / 收藏夹 / 书签 / 快捷命令 / 草稿箱 / 任务）
 * 复用的纯函数与用户反馈入口。
 * 09 方案阶段 2：条目相关的 10 个符号（buildMoreActions / toMarkdown / toItem /
 * collectTargets / summarize / names / openFileForm / pickItem / MoreActionPick /
 * PREVIEW_MAX_BYTES）已随条目领域删除。
 */

// VSCode 命令参数类型在注册期未知（与官方 API 签名一致使用 any[]）
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyArgs = any[]

/**
 * 命令注册闭包契约：由 index.ts 持有 ExtensionContext 创建
 * （context.subscriptions.push(registerCommand(...))），以参数形式分发给各分组。
 */
export type CommandRegistrar = (commandId: string, callback: (...args: AnyArgs) => unknown) => void

/** 初始化步骤状态的 QuickPick 图标。 */
export function statusIcon(status: StepStatus): string {
  switch (status) {
    case 'done':
      return '$(check)'
    case 'failed':
      return '$(error)'
    case 'running':
      return '$(sync)'
    default:
      return '$(circle-outline)'
  }
}

/**
 * 成功通知统一入口（09 §3.4：successNotifications 特性开关随体系退场，
 * S 列表定论——成功操作一律提示）。
 */
export function notifySuccess(message: string): void {
  void vscode.window.showInformationMessage(message)
}

/** 错误统一呈现：Error 取 message，其他值加「操作失败：」前缀（提取语义统一走 reasonOf）。 */
export function showError(err: unknown): void {
  const message = err instanceof Error ? reasonOf(err) : `操作失败：${reasonOf(err)}`
  void vscode.window.showErrorMessage(message)
}

/** 入参归一化为 Uri（资源管理器右键传入；其他来源可能传任意值）。 */
export function toUri(value: unknown): vscode.Uri | undefined {
  return value instanceof vscode.Uri ? value : undefined
}

/** 当前编辑器文件 URI（未打开文件时 undefined）。 */
export function currentFileUri(): vscode.Uri | undefined {
  return vscode.window.activeTextEditor?.document.uri
}

/**
 * 资源管理器批量目标归一化（17 方案阶段 2 收敛，先例 favoritesCommands.add）：
 * 多选批量（explorer/context 传入 (uri, uris[])）优先；无多选时回退单 uri 或
 * 当前编辑器文件；无可用目标返回 []（调用方给出可操作提示）。
 */
export function resolveExplorerTargets(uri: unknown, uris: unknown): vscode.Uri[] {
  const batch = Array.isArray(uris) ? uris.map(toUri).filter((u): u is vscode.Uri => !!u) : []
  if (batch.length > 0) {
    return batch
  }
  const single = toUri(uri) ?? currentFileUri()
  return single ? [single] : []
}

/**
 * 树节点入参守卫（17 方案阶段 2 收敛 favorites/bookmarks/quickCommands 三份
 * requireItem 复制）：树右键命令的第一个参数是树节点元素——形状不符时以
 * info 提示（调用方传入完整文案，保持各组原提示语）并返回 undefined。
 */
export function requireTreeItem<T>(
  value: unknown,
  guard: (item: unknown) => item is T,
  hint: string
): T | undefined {
  if (guard(value)) {
    return value
  }
  void vscode.window.showInformationMessage(hint)
  return undefined
}
