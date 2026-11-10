import * as vscode from 'vscode'
import { STORAGE } from '../../constants'
import {
  JsonEnvelopeFileStore,
  type EnvelopeParseResult,
} from '../../services/stores/jsonEnvelopeStore'
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

/** 服务器数据内容解析（信封 + 顶层宽容读取，17 方案阶段 2 收敛到共享信封存储）。 */
function parseServersContent(
  data: unknown,
  warn: (message: string) => void
): EnvelopeParseResult<SerialServer[]> {
  if (Array.isArray(data)) {
    // 顶层数组：宽容读取（手写编辑常见形态），下次保存自动迁移为信封
    warn('服务器数据文件为顶层数组格式，已兼容读取，下次保存自动迁移为信封格式。')
    return { ok: true, value: normalizeSerialServerList(data, warn) }
  }
  if (isEnvelopeLike(data)) {
    const envelope = data as { schemaVersion?: unknown; servers: unknown[] }
    if (envelope.schemaVersion !== undefined && envelope.schemaVersion !== SERVERS_SCHEMA_VERSION) {
      warn(
        `服务器数据文件 schemaVersion=${String(envelope.schemaVersion)} 与当前版本 ${SERVERS_SCHEMA_VERSION} 不一致，已尽力按 servers 读取。`
      )
    }
    return { ok: true, value: normalizeSerialServerList(envelope.servers, warn) }
  }
  return { ok: false, reason: '根节点既不是数组，也不是含 servers 数组的对象' }
}

/** 形态判定：对象且带 servers 数组（schemaVersion 可缺省，兼容手工编辑）。 */
function isEnvelopeLike(data: unknown): data is { servers: unknown[] } {
  return (
    typeof data === 'object' &&
    data !== null &&
    Array.isArray((data as { servers?: unknown }).servers)
  )
}

/**
 * 默认数据源：工作区内 JSON 文件（.vscode/serial-servers.json）。
 *
 * 损坏契约（比条目数据文件轻量，无三选一恢复模态，机制与收藏夹等一致）：
 * 解析失败 / 根节点形态不对时，**复制**备份（原文件留在原位）后按空数据继续；
 * 备份失败则抛错——绝不在没有备份的情况下把损坏文件静默当空数据覆盖。
 */
export class JsonServerStore implements IServerStore {
  private readonly inner: JsonEnvelopeFileStore<SerialServer[]>

  constructor(
    public readonly fileUri: vscode.Uri,
    options: ServerStoreOptions = {}
  ) {
    this.inner = new JsonEnvelopeFileStore<SerialServer[]>(fileUri, {
      label: '服务器',
      empty: () => [],
      parse: parseServersContent,
      serialize: (servers) => ({ schemaVersion: SERVERS_SCHEMA_VERSION, servers }),
      onWarning: options.onWarning,
    })
  }

  load(): Promise<SerialServer[]> {
    return this.inner.load()
  }

  async save(servers: SerialServer[]): Promise<void> {
    await this.inner.save(servers)
  }
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
