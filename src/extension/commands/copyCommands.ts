import * as vscode from 'vscode'
import { COMMAND } from '../constants'
import { reasonOf } from '../services/errors'
import { notifySuccess, showError } from './shared'
import type { CommandRegistrar } from './shared'

/**
 * 拷贝示例命令分组（v2.2）：右键把内容「拷贝出来」到剪贴板——
 * 与草稿箱（写工作区文件）形成对照的最基础示例：上下文采集 + 剪贴板写入。
 *
 * - 编辑器右键「复制选中文本」：精确复制选区（不 trim）；
 * - 资源管理器右键「复制文件内容」：读文件进剪贴板，支持多选批量
 *   （多文件以「=== 路径 ===」分隔）；带大小上限与二进制防护；
 * - 资源管理器右键「复制文件路径」：绝对路径（多选每行一个）。
 */

/** 单文件复制的内容上限（1MB）：超过则拒绝，防止把巨型文件灌进剪贴板。 */
const MAX_COPY_FILE_BYTES = 1024 * 1024

/** 二进制探测：首 8KB 出现 NUL 字节即视为二进制（文本文件不会有 NUL）。 */
function looksBinary(buffer: Uint8Array): boolean {
  const head = buffer.subarray(0, 8000)
  return head.some((byte) => byte === 0)
}

/** 剪贴板写入：失败如实呈现（命令不裸 reject / 不静默——v2.2.1 草稿命令的同类修复）。 */
async function writeClipboard(text: string): Promise<boolean> {
  try {
    await vscode.env.clipboard.writeText(text)
    return true
  } catch (err) {
    showError(err)
    return false
  }
}

/** 入参归一化：explorer/context 传 (uri, uris[])，单选时 uris 可能缺省。 */
function resolveTargets(uri: unknown, uris: unknown[]): vscode.Uri[] {
  const batch = Array.isArray(uris)
    ? uris.filter((candidate): candidate is vscode.Uri => candidate instanceof vscode.Uri)
    : []
  if (batch.length > 0) {
    return batch
  }
  return uri instanceof vscode.Uri ? [uri] : []
}

/** 读一个文本文件（大小 / 二进制防护）；不可复制时返回错误信息。 */
async function readTextFile(
  uri: vscode.Uri
): Promise<{ ok: true; text: string } | { ok: false; reason: string }> {
  const stat = await vscode.workspace.fs.stat(uri)
  if (stat.size > MAX_COPY_FILE_BYTES) {
    return { ok: false, reason: `超过 1MB 大小上限（${(stat.size / 1024 / 1024).toFixed(1)}MB）` }
  }
  const buffer = await vscode.workspace.fs.readFile(uri)
  if (looksBinary(buffer)) {
    return { ok: false, reason: '二进制文件不支持按文本复制' }
  }
  return { ok: true, text: Buffer.from(buffer).toString('utf8') }
}

export function registerCopyCommands(register: CommandRegistrar): void {
  /* ---------- 编辑器右键：复制选中文本（最基础的剪贴板示例） ---------- */
  register(COMMAND.copySelection, () => {
    const editor = vscode.window.activeTextEditor
    const text = editor ? editor.document.getText(editor.selection) : ''
    if (!text) {
      void vscode.window.showInformationMessage('编辑器中没有选中文本。')
      return
    }
    void writeClipboard(text).then((ok) => {
      if (ok) {
        notifySuccess(`已复制选中文本（${text.length} 字符）。`)
      }
    })
  })

  /* ---------- 资源管理器右键：复制文件内容（支持多选批量） ---------- */
  register(COMMAND.copyFileContent, async (uri?: unknown, uris: unknown[] = []) => {
    const targets = resolveTargets(uri, uris)
    if (targets.length === 0) {
      void vscode.window.showInformationMessage('没有可复制的文件。')
      return
    }
    const parts: string[] = []
    const failures: string[] = []
    for (const target of targets) {
      try {
        const result = await readTextFile(target)
        if (result.ok) {
          // 多文件时带路径分隔头，粘贴后可分辨来源；单文件保持纯内容
          parts.push(targets.length > 1 ? `=== ${target.fsPath} ===\n${result.text}` : result.text)
        } else {
          failures.push(`${target.path.split('/').pop() ?? target.fsPath}（${result.reason}）`)
        }
      } catch (err) {
        const reason = reasonOf(err)
        failures.push(`${target.path.split('/').pop() ?? target.fsPath}（${reason}）`)
      }
    }
    if (parts.length === 0) {
      void vscode.window.showWarningMessage(`未复制任何文件：${failures.join('、')}`)
      return
    }
    if (!(await writeClipboard(parts.join('\n\n')))) {
      return
    }
    if (failures.length > 0) {
      void vscode.window.showWarningMessage(
        `已复制 ${parts.length} 个文件，跳过：${failures.join('、')}`
      )
      return
    }
    notifySuccess(targets.length > 1 ? `已复制 ${parts.length} 个文件的内容。` : '已复制文件内容。')
  })

  /* ---------- 资源管理器右键：复制文件路径 ---------- */
  register(COMMAND.copyFilePath, async (uri?: unknown, uris: unknown[] = []) => {
    const targets = resolveTargets(uri, uris)
    if (targets.length === 0) {
      void vscode.window.showInformationMessage('没有可复制的文件。')
      return
    }
    if (!(await writeClipboard(targets.map((target) => target.fsPath).join('\n')))) {
      return
    }
    notifySuccess(targets.length > 1 ? `已复制 ${targets.length} 个文件路径。` : '已复制文件路径。')
  })
}
