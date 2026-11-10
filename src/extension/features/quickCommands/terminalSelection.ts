import * as vscode from 'vscode'

/**
 * 终端选区读取：剪贴板桥接（v3.5，16 方案 §4.2）。
 *
 * 背景：`Terminal.selection` 至今为 proposed API（Marketplace 扩展不可用），
 * 稳定版读取终端选区的唯一途径是借道内部命令 copySelection + env.clipboard。
 *
 * 契约：任何环节失败一律返回 undefined（不抛错给用户，壳层降级 InputBox 粘贴）；
 * 剪贴板先备份后恢复（含恢复环节自身失败也不外溢）。
 *
 * 升级路径：微软转正 Terminal.selection 后，本函数改为直读属性即可，
 * 调用方（命令壳）与存储完全不受影响。
 */

/** VSCode 内部命令：把当前终端选区复制到剪贴板（存在多年，社区扩展广泛使用）。 */
export const TERMINAL_COPY_SELECTION_COMMAND = 'workbench.action.terminal.copySelection'

export async function readTerminalSelectionViaClipboard(): Promise<string | undefined> {
  const backup = await vscode.env.clipboard.readText()
  try {
    await vscode.commands.executeCommand(TERMINAL_COPY_SELECTION_COMMAND)
    const text = await vscode.env.clipboard.readText()
    // 空/纯空白 = 无选区；与备份相同 = 无法区分「复制成功」与「无选区」，
    // 两种情况按 16 方案 §4.2 均返回 undefined（后者无害：进粘贴框兜底）。
    return text.trim().length > 0 && text !== backup ? text : undefined
  } catch {
    return undefined
  } finally {
    try {
      await vscode.env.clipboard.writeText(backup)
    } catch {
      // 恢复失败不外溢：宁失剪贴板，不砸命令
    }
  }
}
