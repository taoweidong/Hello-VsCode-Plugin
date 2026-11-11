import * as vscode from 'vscode'
import { reasonOf } from './errors'

/**
 * 下线功能的遗留数据清理（v4.0.0 串口 / v5.0.0 书签）。
 *
 * 清理面（均为串口功能独占的数据，不涉及其他功能）：
 * - 工作区 `.vscode/serial-servers.json`：读取服务器 id 后删除数据文件；
 * - SecretStorage 密码：按数据文件中的 id 删除 `<前缀><id>.password`
 *   （新前缀 `extStarter.serialServer.` + 旧前缀 `crudStarter.serialServer.`；
 *   SecretStorage 无法枚举，只能据数据文件推断 id；文件缺失/损坏时跳过密码清理）；
 * - globalState：旧键 `extStarter.serialServers`（Memento 回退）与
 *   `extStarter.serialCommandHistory`（命令历史）置空。
 *
 * 幂等：清理完成后无残留，后续激活为 no-op；单步失败不阻断激活（log 留痕）。
 * 旧键字面量保留在本文件而非 constants：功能已下线，常量表不再承载死键。
 */

const LEGACY_SERIAL_FILE = '.vscode/serial-servers.json'
const SERIAL_SECRET_PREFIX = 'extStarter.serialServer.'
/** v0.7.0 前的 SecretStorage 键前缀（09 方案阶段 5 改名；清理需一并删除）。 */
const LEGACY_SERIAL_SECRET_PREFIX = 'crudStarter.serialServer.'
const SERIAL_MEMENTO_KEY = 'extStarter.serialServers'
const SERIAL_HISTORY_KEY = 'extStarter.serialCommandHistory'

/** 书签数据文件（v3.6~v4.0 存在；v5.0.0 功能下线后清理）。 */
const LEGACY_BOOKMARKS_FILE = '.vscode/bookmarks.json'
/** 书签：无工作区时 globalStorage 目录下的明文 JSON 文件名。 */
const LEGACY_BOOKMARKS_GLOBAL_FILE = 'bookmarks.json'

/** 从数据文件内容中提取服务器 id（宽容形态：顶层数组或 { servers: [...] }）。 */
function extractServerIds(raw: string): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  const list = Array.isArray(parsed)
    ? parsed
    : typeof parsed === 'object' &&
        parsed !== null &&
        Array.isArray((parsed as { servers?: unknown }).servers)
      ? (parsed as { servers: unknown[] }).servers
      : []
  const ids: string[] = []
  for (const entry of list) {
    if (typeof entry === 'object' && entry !== null) {
      const id = (entry as { id?: unknown }).id
      if (typeof id === 'string' && id.length > 0) {
        ids.push(id)
      }
    }
  }
  return ids
}

/**
 * 执行清理；返回清理摘要（数据文件是否删除、清理的密码条数），供日志断言。
 * 所有异常在内部消化（log 留痕），不向调用方抛错。
 */
export async function cleanupSerialLegacyData(
  context: vscode.ExtensionContext,
  log?: (message: string) => void
): Promise<{ removedDataFile: boolean; removedSecrets: number }> {
  const summary = { removedDataFile: false, removedSecrets: 0 }

  // 1) 读取服务器 id（清理密码的唯一依据）
  const root = vscode.workspace.workspaceFolders?.[0]?.uri
  let serverIds: string[] = []
  let fileUri: vscode.Uri | undefined
  if (root) {
    fileUri = vscode.Uri.joinPath(root, ...LEGACY_SERIAL_FILE.split('/'))
    try {
      const raw = Buffer.from(await vscode.workspace.fs.readFile(fileUri)).toString('utf8')
      serverIds = extractServerIds(raw)
    } catch (err) {
      if (!(err instanceof vscode.FileSystemError && err.code === 'FileNotFound')) {
        log?.(`读取遗留串口数据失败（将跳过密码清理）：${reasonOf(err)}`)
      }
    }
  }

  // 2) 删除 SecretStorage 密码（新旧前缀）
  for (const id of serverIds) {
    for (const prefix of [SERIAL_SECRET_PREFIX, LEGACY_SERIAL_SECRET_PREFIX]) {
      try {
        await context.secrets.delete(`${prefix}${id}.password`)
        summary.removedSecrets += 1
      } catch (err) {
        log?.(`清理遗留串口密码失败（${id}）：${reasonOf(err)}`)
      }
    }
  }

  // 3) 删除工作区数据文件
  if (fileUri) {
    try {
      await vscode.workspace.fs.delete(fileUri, { useTrash: false })
      summary.removedDataFile = true
    } catch (err) {
      if (!(err instanceof vscode.FileSystemError && err.code === 'FileNotFound')) {
        log?.(`删除遗留串口数据文件失败：${reasonOf(err)}`)
      }
    }
  }

  // 4) 清理 globalState 旧键（Memento 回退数据 / 命令历史）
  for (const key of [SERIAL_MEMENTO_KEY, SERIAL_HISTORY_KEY]) {
    try {
      await context.globalState.update(key, undefined)
    } catch (err) {
      log?.(`清理遗留串口全局存储失败（${key}）：${reasonOf(err)}`)
    }
  }

  if (summary.removedDataFile || summary.removedSecrets > 0) {
    log?.(
      `串口功能已下线：已清理遗留数据（数据文件${summary.removedDataFile ? '已删除' : '不存在'}，密码 ${summary.removedSecrets} 条）`
    )
  }
  return summary
}

/**
 * 书签功能下线（v5.0.0）的一次性遗留数据清理：
 * - 工作区 `.vscode/bookmarks.json` 删除；
 * - globalStorage 目录下 `bookmarks.json`（无工作区回退文件）删除；
 * - 无 SecretStorage / globalState 键（书签功能从未使用）。
 * 幂等；单步失败仅 log 留痕，不向调用方抛错。
 */
export async function cleanupBookmarksLegacyData(
  context: vscode.ExtensionContext,
  log?: (message: string) => void
): Promise<{ removedWorkspaceFile: boolean; removedGlobalFile: boolean }> {
  const summary = { removedWorkspaceFile: false, removedGlobalFile: false }
  const targets: [vscode.Uri, keyof typeof summary, string][] = [
    [
      vscode.Uri.joinPath(context.globalStorageUri, LEGACY_BOOKMARKS_GLOBAL_FILE),
      'removedGlobalFile',
      '全局存储',
    ],
  ]
  const root = vscode.workspace.workspaceFolders?.[0]?.uri
  if (root) {
    targets.unshift([
      vscode.Uri.joinPath(root, ...LEGACY_BOOKMARKS_FILE.split('/')),
      'removedWorkspaceFile',
      '工作区数据文件',
    ])
  }
  for (const [fileUri, key, label] of targets) {
    try {
      await vscode.workspace.fs.delete(fileUri, { useTrash: false })
      summary[key] = true
    } catch (err) {
      if (!(err instanceof vscode.FileSystemError && err.code === 'FileNotFound')) {
        log?.(`删除遗留书签${label}失败：${reasonOf(err)}`)
      }
    }
  }
  if (summary.removedWorkspaceFile || summary.removedGlobalFile) {
    log?.(
      `书签功能已下线：已清理遗留数据（工作区文件${summary.removedWorkspaceFile ? '已删除' : '不存在'}，全局文件${summary.removedGlobalFile ? '已删除' : '不存在'}）`
    )
  }
  return summary
}
