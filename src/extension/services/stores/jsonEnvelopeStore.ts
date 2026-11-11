import { randomUUID } from 'node:crypto'
import * as path from 'path'
import * as vscode from 'vscode'
import { writeJsonAtomic } from './atomicWrite'
import { reasonOf } from '../errors'

/**
 * JSON 信封文件存储（17 方案阶段 2：收藏夹 / 书签 / 快捷命令 / 串口服务器四份
 * 逐行复制的 store 收敛为单一实现；书签与串口服务器已分别于 v5.0.0 / v4.0.0
 * 功能下线，现存消费方为收藏夹与快捷命令；行为契约与既有 store 逐字一致，
 * 由各自 spec 锁定——既有断言零改动即绿是本重构的验收标准）。
 *
 * 契约：
 * - load：FileNotFound → 空数据（首次使用）；其余 IO 错误 → onWarning 留痕后上抛
 *   （调用方决定呈现）；BOM 剥离；JSON.parse 失败 / 根节点形态不符 → 复制
 *   `.corrupt-<ts>-<rand>.bak` 备份（原文件不动）后按空数据继续，备份失败抛错
 *   （「绝无备份不覆盖」）；
 * - save：writeJsonAtomic 原子写（信封由 serialize 回调构造）；
 * - 顶层数组宽容读取 / schemaVersion 不一致警告等各 feature 口径由 parse 回调决定。
 */

/** 内容解析结果：ok=false 的 reason 用于损坏警告文案（保持各 store 原文案）。 */
export type EnvelopeParseResult<T> = { ok: true; value: T } | { ok: false; reason: string }

export interface JsonEnvelopeFileStoreOptions<T> {
  /** 实体名（警告与错误文案，如「收藏」「快捷命令」）。 */
  label: string
  /** 空数据（FileNotFound 与损坏恢复时返回）。 */
  empty: () => T
  /**
   * 内容解析：data 为 JSON.parse 结果（BOM 已剥离）。
   * 返回 ok=false 视为损坏（走复制备份 + 按空数据继续）。
   */
  parse: (data: unknown, warn: (message: string) => void) => EnvelopeParseResult<T>
  /** 落盘信封（save 时构造；如 { schemaVersion, items }）。 */
  serialize: (value: T) => Record<string, unknown>
  /** 数据修复 / 损坏警告上报（extension.ts 接 outputChannel 或树视图）。 */
  onWarning?: (message: string) => void
}

export class JsonEnvelopeFileStore<T> {
  constructor(
    public readonly fileUri: vscode.Uri,
    private readonly options: JsonEnvelopeFileStoreOptions<T>
  ) {}

  async load(): Promise<T> {
    let text: string
    try {
      const raw = await vscode.workspace.fs.readFile(this.fileUri)
      text = Buffer.from(raw).toString('utf8')
    } catch (err) {
      if (err instanceof vscode.FileSystemError && err.code === 'FileNotFound') {
        return this.options.empty() // 首次使用：视为空数据
      }
      // IO 错误（无权限 / 文件被占用等）不是损坏：留痕输出通道后上抛，
      // 调用方静默降级时用户仍可在输出通道看到原因
      this.options.onWarning?.(
        `读取${this.options.label}数据失败（${this.fileUri.fsPath}）：${reasonOf(err)}`
      )
      throw err
    }
    if (text.charCodeAt(0) === 0xfeff) {
      text = text.slice(1) // 剥离 BOM，避免 JSON.parse 失败被误判为损坏
    }
    let data: unknown
    try {
      data = JSON.parse(text)
    } catch (err) {
      return this.recoverFromCorruption(reasonOf(err))
    }
    const parsed = this.options.parse(data, this.warn)
    if (parsed.ok) {
      return parsed.value
    }
    return this.recoverFromCorruption(parsed.reason)
  }

  async save(value: T): Promise<void> {
    await writeJsonAtomic(this.fileUri, this.options.serialize(value))
  }

  private warn = (message: string): void => {
    this.options.onWarning?.(message)
  }

  /** 损坏恢复：复制备份（原文件不动）→ 警告上报 → 按空数据继续；备份失败抛错。 */
  private async recoverFromCorruption(reason: string): Promise<T> {
    const backupUri = await copyCorruptBackup(this.fileUri, this.options.label)
    this.warn(
      `${this.options.label}数据文件损坏（${reason}）。原文件保留在原位，已复制备份到 ${path.basename(backupUri.fsPath)}，本次按空数据继续。`
    )
    return this.options.empty()
  }
}

/**
 * 损坏备份（草稿箱与信封存储共用，17 方案阶段 2 统一备份机制）：
 * 原文件复制为同目录 `.corrupt-<ts>-<rand>.bak`（原文件保留不动）。
 * 备份失败抛错——调用方绝不在没有备份的情况下把损坏文件当空数据覆盖。
 */
export async function copyCorruptBackup(fileUri: vscode.Uri, label: string): Promise<vscode.Uri> {
  const dirUri = vscode.Uri.joinPath(fileUri, '..')
  const backupUri = vscode.Uri.joinPath(
    dirUri,
    `${path.basename(fileUri.fsPath)}.corrupt-${Date.now()}-${randomUUID().slice(0, 8)}.bak`
  )
  try {
    await vscode.workspace.fs.copy(fileUri, backupUri)
  } catch (err) {
    throw new Error(
      `${label}数据文件损坏且备份失败：无法将 ${fileUri.fsPath} 复制为 ${backupUri.fsPath}` +
        `（${reasonOf(err)}）。原文件保留在原位，请手动处理。`,
      { cause: err }
    )
  }
  return backupUri
}
