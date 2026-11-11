import * as vscode from 'vscode'
import { reasonOf } from './errors'

/**
 * 树视图注册助手（v5.0.1）：单视图注册失败降级，不拖垮整个扩展激活。
 *
 * 背景：视图容器 / 视图 ID 与其他扩展冲突时（典型场景：同时安装旧包
 * `vscode-starter-template` ≤ 2.5.0——它与本扩展共享 `extStarter` 命名空间
 * 的容器、视图与 webview ID），`window.createTreeView` 会抛
 * `No view is registered with id: …`；此前直接调用会让整个 `activate` 失败，
 * 所有功能（含 webview 页面、命令）都不可用。
 *
 * 现在按视图隔离失败：记录输出通道 + 一次可操作告警（提示卸载旧扩展并重载），
 * 其余视图与功能继续装配。
 */
export function registerTreeView<T>(
  context: vscode.ExtensionContext,
  outputChannel: vscode.OutputChannel,
  viewId: string,
  provider: vscode.TreeDataProvider<T>,
  options: Omit<vscode.TreeViewOptions<T>, 'treeDataProvider'> = {}
): vscode.TreeView<T> | undefined {
  try {
    const view = vscode.window.createTreeView(viewId, { treeDataProvider: provider, ...options })
    context.subscriptions.push(view)
    return view
  } catch (err) {
    const message = reasonOf(err)
    outputChannel.appendLine(`[视图] ${viewId} 注册失败：${message}`)
    void vscode.window.showWarningMessage(
      `视图「${viewId}」注册失败：可能与其他扩展的视图 ID 冲突。` +
        `若安装过旧版模板扩展（vscode-starter-template ≤ 2.5.0），请卸载后重载窗口。`
    )
    return undefined
  }
}
