import { randomUUID } from 'node:crypto'
import * as path from 'path'
import * as vscode from 'vscode'
import { STORAGE } from '../../constants'
import { writeJsonAtomic } from '../../services/stores/atomicWrite'
import type { SerialServer } from './models'
import { normalizeSerialServerList } from './serverGuard'

/**
 * 串口服务器数据源抽象（双实现：工作区文件 + Memento）：
 * load 空数据不抛错；save 原子（要么完整写入，要么失败且原文件不变）。
 */
export interface IServerStore {
  load(): Promise<SerialServer[]>
  save(servers: SerialServer[]): Promise<void>
}

/** 当前存储格式版本（信封 {schemaVersion, servers}）。 */
export const SERVERS_SCHEMA_VERSION = 1

/** 服务器数据文件（相对工作区根，固定路径；条目数据文件走 storagePath 配置，两者互不影响）。 */
export const SERVERS_FILE_RELATIVE_PATH = '.vscode/serial-servers.json'

export interface ServerStoreOptions {
  /** 数据修复 / 损坏警告上报（extension.ts 接 outputChannel）。 */
  onWarning?: (message: string) => void
}

/**
 * 默认数据源：工作区内 JSON 文件（.vscode/serial-servers.json）。
 *
 * 损坏契约（比条目数据文件轻量，无三选一恢复模态）：
 * 解析失败 / 根节点形态不对时，**复制**备份（原文件留在原位）后按空数据继续；
 * 备份失败则抛错——绝不在没有备份的情况下把损坏文件静默当空数据覆盖。
 */
export class JsonServerStore implements IServerStore {
  constructor(
    public readonly fileUri: vscode.Uri,
    private readonly options: ServerStoreOptions = {}
  ) {}

  async load(): Promise<SerialServer[]> {
    let text: string
    try {
      const raw = await vscode.workspace.fs.readFile(this.fileUri)
      text = Buffer.from(raw).toString('utf8')
    } catch (err) {
      if (err instanceof vscode.FileSystemError && err.code === 'FileNotFound') {
        return [] // 首次使用：文件尚不存在，视为空数据
      }
      // IO 错误（无权限 / 文件被占用等）不是损坏：留痕输出通道后上抛，
      // 调用方（树视图 getChildren 等）静默降级时用户仍可在输出通道看到原因
      this.options.onWarning?.(
        `读取服务器数据失败（${this.fileUri.fsPath}）：${err instanceof Error ? err.message : String(err)}`
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
      return this.recoverFromCorruption(err instanceof Error ? err.message : String(err))
    }

    if (Array.isArray(data)) {
      // 顶层数组：宽容读取（手写编辑常见形态），下次保存自动迁移为信封
      this.options.onWarning?.(
        '服务器数据文件为顶层数组格式，已兼容读取，下次保存自动迁移为信封格式。'
      )
      return normalizeSerialServerList(data, this.options.onWarning)
    }
    if (isEnvelopeLike(data)) {
      const envelope = data as { schemaVersion?: unknown; servers: unknown[] }
      if (
        envelope.schemaVersion !== undefined &&
        envelope.schemaVersion !== SERVERS_SCHEMA_VERSION
      ) {
        this.options.onWarning?.(
          `服务器数据文件 schemaVersion=${String(envelope.schemaVersion)} 与当前版本 ${SERVERS_SCHEMA_VERSION} 不一致，已尽力按 servers 读取。`
        )
      }
      return normalizeSerialServerList(envelope.servers, this.options.onWarning)
    }
    return this.recoverFromCorruption('根节点既不是数组，也不是含 servers 数组的对象')
  }

  async save(servers: SerialServer[]): Promise<void> {
    await writeJsonAtomic(this.fileUri, { schemaVersion: SERVERS_SCHEMA_VERSION, servers })
  }

  /** 损坏恢复：复制备份（原文件不动）→ 警告上报 → 按空数据继续；备份失败抛错。 */
  private async recoverFromCorruption(reason: string): Promise<SerialServer[]> {
    const dirUri = vscode.Uri.joinPath(this.fileUri, '..')
    const now = Date.now()
    const backupUri = vscode.Uri.joinPath(
      dirUri,
      `${path.basename(this.fileUri.fsPath)}.corrupt-${now}-${randomUUID().slice(0, 8)}.bak`
    )
    try {
      await vscode.workspace.fs.copy(this.fileUri, backupUri)
    } catch (err) {
      throw new Error(
        `服务器数据文件损坏且备份失败：无法将 ${this.fileUri.fsPath} 复制为 ${backupUri.fsPath}` +
          `（${err instanceof Error ? err.message : String(err)}）。原文件保留在原位，请手动处理。`,
        { cause: err }
      )
    }
    this.options.onWarning?.(
      `服务器数据文件损坏（${reason}）。原文件保留在原位，已复制备份到 ${path.basename(backupUri.fsPath)}，本次按空数据继续。`
    )
    return []
  }
}

/** 形态判定：对象且带 servers 数组（schemaVersion 可缺省，兼容手工编辑）。 */
function isEnvelopeLike(data: unknown): data is { servers: unknown[] } {
  return (
    typeof data === 'object' &&
    data !== null &&
    Array.isArray((data as { servers?: unknown }).servers)
  )
}

/** 备用数据源：无工作区时经 globalState 持久化，保证空窗口也能用。 */
export class MementoServerStore implements IServerStore {
  constructor(
    private readonly memento: vscode.Memento,
    private readonly key: string,
    private readonly options: ServerStoreOptions = {}
  ) {}

  async load(): Promise<SerialServer[]> {
    const raw = this.memento.get<unknown>(this.key, [])
    if (!Array.isArray(raw)) {
      this.options.onWarning?.('全局存储中的服务器数据不是数组，已按空数据处理。')
      return []
    }
    return normalizeSerialServerList(raw, this.options.onWarning)
  }

  async save(servers: SerialServer[]): Promise<void> {
    await this.memento.update(this.key, servers)
  }
}

/**
 * 装配：有工作区 → JsonServerStore（.vscode/serial-servers.json）；
 * 无工作区 → MementoServerStore（globalState）。
 * 简化说明：不做外部文件 watcher，
 * 服务器列表变更由面板 / 命令显式刷新树视图。
 */
export function createServerStore(
  context: vscode.ExtensionContext,
  options: ServerStoreOptions = {}
): IServerStore {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri
  if (root) {
    return new JsonServerStore(
      vscode.Uri.joinPath(root, ...SERVERS_FILE_RELATIVE_PATH.split('/')),
      options
    )
  }
  return new MementoServerStore(context.globalState, STORAGE.serialServersMementoKey, options)
}
