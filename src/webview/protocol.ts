/**
 * Webview 与扩展宿主之间的消息协议（docs/需求与优化方案/03 §5.5）。
 *
 * - 宿主侧 `panel.webview.onDidReceiveMessage` / 页面侧 `window.addEventListener('message')`
 *   收到任何消息都必须先过 `isWebviewMessage` / `isHostMessage` 运行时守卫（修复 W7）；
 * - 宿主与 Webview 共享本文件：禁止 import vscode / DOM / Node 专属 API；
 * - 守卫逐字段窄化：null、缺字段、未知 type 一律拒绝，未知消息只记日志不抛错；
 * - 向后兼容地扩展：新增消息只追加联合分支与守卫 case，不改既有分支形状。
 * - 09 方案阶段 2：importWizard 的 8 条分支（selectFolder / importPreview /
 *   importProgress / importDone / browseFolder / requestPreview / executeImport /
 *   cancelImport）随条目领域删除，当前 22 条 = 通用 7 + 串口 15。
 */

/** init 消息携带的表单字段描述（结构最小集；完整 Schema 由领域层提供，M5-T5.1 接入）。 */
export interface FieldDef {
  key: string
  label: string
  type: string
  /** 允许附加上位置元数据（placeholder / hint / options 等） */
  [extra: string]: unknown
}

/* ============ 串口命令控制台：协议层线类型（完整模型见 features/serialConsole） ============ */

/** 检测到的本机串口（serialport list() 的最小结构面）。 */
export interface SerialPortBrief {
  path: string
  manufacturer?: string
}

/** 串口服务器在协议层的最小结构面（与 features/serialConsole/models.ts 的 SerialServer 对齐）。 */
export interface SerialServerWire {
  id: string
  name: string
  serialPath: string
  baudRate: number
  dataBits: number
  stopBits: number
  parity: string
  flowControl: string
  lineEnding: string
  autoLogin: boolean
  username: string
  description: string
  createdAt: number
  updatedAt: number
  /** 允许附加上位置元数据（与 FieldDef 同理，透传扩展字段） */
  [extra: string]: unknown
}

/** 串口连接状态（与 features/serialConsole/serialLinkService.ts 的 LinkState 对齐）。 */
export type SerialLinkStateWire = 'connecting' | 'connected' | 'disconnected' | 'error'

/** 命令历史条目（MRU 序，已去重）。 */
export interface CommandHistoryWire {
  id: string
  command: string
  lastUsedAt: number
  useCount: number
}

/** 构建任务状态（与 features/build/buildApiClient 的 BuildTaskStatus 对齐）。 */
export type BuildTaskStatusWire = 'queued' | 'running' | 'success' | 'failed'

/** 构建任务在协议层的最小结构面（HTTP 接口返回的任务快照，打桩模拟 / 真实接口同形）。 */
export interface BuildTaskWire {
  id: string
  branch: string
  buildType: string
  status: BuildTaskStatusWire
  /** 进度 0-100（queued 为 0） */
  progress: number
  notes?: string
  /** 失败原因 / 完成摘要 */
  message?: string
  /** ISO 时间 */
  createdAt: string
  finishedAt?: string
  /** 允许附加上位置元数据（与 FieldDef 同理，透传扩展字段） */
  [extra: string]: unknown
}

/** 宿主 → Webview */
export type HostMessage =
  | {
      type: 'init'
      page: string
      schema: FieldDef[]
      value: unknown
      extra?: Record<string, unknown>
    }
  | { type: 'submitAck'; ok: true }
  | { type: 'error'; message: string; field?: string }
  /** 检测到的本机串口（页面「检测串口」应答） */
  | { type: 'serialPorts'; ports: SerialPortBrief[] }
  /** 服务器列表全量（init 后增删改均推送最新列表） */
  | { type: 'serialServers'; servers: SerialServerWire[] }
  /** 串口连接状态变化；serverId 为 null 表示无活动连接（如已断开） */
  | { type: 'serialState'; serverId: string | null; state: SerialLinkStateWire; error?: string }
  /** 串口输出批（seq 单调递增；text 为 UTF-8 文本） */
  | { type: 'serialData'; seq: number; text: string }
  /** 命令历史（MRU 序，已去重） */
  | { type: 'commandHistory'; entries: CommandHistoryWire[] }
  /** 构建任务列表全量（页面轮询 / 提交后刷新的应答） */
  | { type: 'buildList'; tasks: BuildTaskWire[] }

/** Webview → 宿主 */
export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'dirty'; dirty: boolean }
  | { type: 'submit'; draft: Record<string, unknown> }
  | { type: 'cancel' }
  /** 请求枚举本机串口 */
  | { type: 'serialPortsRequest' }
  /** 请求服务器列表全量 */
  | { type: 'serialServersRequest' }
  /** 保存服务器（新增或编辑；password 单独走 SecretStorage，不进 draft 持久化） */
  | { type: 'serialServerSave'; draft: Record<string, unknown>; password?: string }
  /** 删除服务器（同时清理其 SecretStorage 密码） */
  | { type: 'serialServerDelete'; id: string }
  /** 连接指定服务器 */
  | { type: 'serialConnect'; serverId: string }
  /** 断开当前连接 */
  | { type: 'serialDisconnect' }
  /** 下发命令（宿主追加换行符写入串口） */
  | { type: 'serialSend'; command: string }
  /** 请求命令历史 */
  | { type: 'commandHistoryRequest' }
  /** 删除单条历史 */
  | { type: 'commandHistoryRemove'; id: string }
  /** 清空历史 */
  | { type: 'commandHistoryClear' }
  /** 请求构建任务列表全量（页面轮询） */
  | { type: 'buildListRequest' }

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isFieldDef(v: unknown): v is FieldDef {
  return (
    isPlainObject(v) &&
    typeof v.key === 'string' &&
    typeof v.label === 'string' &&
    typeof v.type === 'string'
  )
}

function isSerialPortBrief(v: unknown): v is SerialPortBrief {
  return (
    isPlainObject(v) &&
    typeof v.path === 'string' &&
    (v.manufacturer === undefined || typeof v.manufacturer === 'string')
  )
}

/** 串口服务器线类型元素守卫（init.extra.servers / serialServers 列表共用）。 */
export function isSerialServerWire(v: unknown): v is SerialServerWire {
  return (
    isPlainObject(v) &&
    typeof v.id === 'string' &&
    typeof v.name === 'string' &&
    typeof v.serialPath === 'string' &&
    typeof v.baudRate === 'number' &&
    typeof v.dataBits === 'number' &&
    typeof v.stopBits === 'number' &&
    typeof v.parity === 'string' &&
    typeof v.flowControl === 'string' &&
    typeof v.lineEnding === 'string' &&
    typeof v.autoLogin === 'boolean' &&
    typeof v.username === 'string' &&
    typeof v.description === 'string' &&
    typeof v.createdAt === 'number' &&
    typeof v.updatedAt === 'number'
  )
}

function isSerialLinkStateWire(v: unknown): v is SerialLinkStateWire {
  return v === 'connecting' || v === 'connected' || v === 'disconnected' || v === 'error'
}

/** 命令历史线类型元素守卫（init.extra.history / commandHistory 列表共用）。 */
export function isCommandHistoryWire(v: unknown): v is CommandHistoryWire {
  return (
    isPlainObject(v) &&
    typeof v.id === 'string' &&
    typeof v.command === 'string' &&
    typeof v.lastUsedAt === 'number' &&
    typeof v.useCount === 'number'
  )
}

function isBuildTaskWire(v: unknown): v is BuildTaskWire {
  return (
    isPlainObject(v) &&
    typeof v.id === 'string' &&
    typeof v.branch === 'string' &&
    typeof v.buildType === 'string' &&
    (v.status === 'queued' ||
      v.status === 'running' ||
      v.status === 'success' ||
      v.status === 'failed') &&
    typeof v.progress === 'number' &&
    typeof v.createdAt === 'string' &&
    (v.notes === undefined || typeof v.notes === 'string') &&
    (v.message === undefined || typeof v.message === 'string') &&
    (v.finishedAt === undefined || typeof v.finishedAt === 'string')
  )
}

/** 宿主收到消息时先过本守卫，再按 type 分发。 */
export function isWebviewMessage(v: unknown): v is WebviewMessage {
  if (!isPlainObject(v)) {
    return false
  }
  switch (v.type) {
    case 'ready':
      return true
    case 'dirty':
      return typeof v.dirty === 'boolean'
    case 'submit':
      return isPlainObject(v.draft)
    case 'cancel':
      return true
    case 'serialPortsRequest':
      return true
    case 'serialServersRequest':
      return true
    case 'serialServerSave':
      return isPlainObject(v.draft) && (v.password === undefined || typeof v.password === 'string')
    case 'serialServerDelete':
      return typeof v.id === 'string'
    case 'serialConnect':
      return typeof v.serverId === 'string'
    case 'serialDisconnect':
      return true
    case 'serialSend':
      return typeof v.command === 'string'
    case 'commandHistoryRequest':
      return true
    case 'commandHistoryRemove':
      return typeof v.id === 'string'
    case 'commandHistoryClear':
      return true
    case 'buildListRequest':
      return true
    default:
      return false
  }
}

/** 页面侧收到消息时先过本守卫，再按 type 分发。 */
export function isHostMessage(v: unknown): v is HostMessage {
  if (!isPlainObject(v)) {
    return false
  }
  switch (v.type) {
    case 'init':
      return (
        typeof v.page === 'string' &&
        Array.isArray(v.schema) &&
        v.schema.every(isFieldDef) &&
        v.value !== undefined &&
        (v.extra === undefined || isPlainObject(v.extra))
      )
    case 'submitAck':
      return v.ok === true
    case 'error':
      return typeof v.message === 'string' && (v.field === undefined || typeof v.field === 'string')
    case 'serialPorts':
      return Array.isArray(v.ports) && v.ports.every(isSerialPortBrief)
    case 'serialServers':
      return Array.isArray(v.servers) && v.servers.every(isSerialServerWire)
    case 'serialState':
      return (
        (typeof v.serverId === 'string' || v.serverId === null) &&
        isSerialLinkStateWire(v.state) &&
        (v.error === undefined || typeof v.error === 'string')
      )
    case 'serialData':
      return typeof v.seq === 'number' && typeof v.text === 'string'
    case 'commandHistory':
      return Array.isArray(v.entries) && v.entries.every(isCommandHistoryWire)
    case 'buildList':
      return Array.isArray(v.tasks) && v.tasks.every(isBuildTaskWire)
    default:
      return false
  }
}
