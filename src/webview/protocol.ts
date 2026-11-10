/**
 * Webview 与扩展宿主之间的消息协议（docs/需求与优化方案/03 §5.5）。
 *
 * - 宿主侧 `panel.webview.onDidReceiveMessage` / 页面侧 `window.addEventListener('message')`
 *   收到任何消息都必须先过 `isWebviewMessage` / `isHostMessage` 运行时守卫（修复 W7）；
 * - 宿主与 Webview 共享本文件：禁止 import vscode / DOM / Node 专属 API；
 * - 守卫逐字段窄化：null、缺字段、未知 type 一律拒绝，未知消息只记日志不抛错；
 * - 向后兼容地扩展：新增消息只追加联合分支与守卫 case，不改既有分支形状。
 * - 第五轮清理（2026-11）：删除六条从未接线 / 随功能退场的消息（dirty / cancel /
 *   serialServersRequest / commandHistoryRequest / taskCreate / taskUpdate），
 *   当前 21 条 = 宿主→页面 9 + 页面→宿主 12。
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

/** 任务状态（与 features/taskManager/taskApiClient 的 TaskStatus 对齐）。 */
export type TaskItemStatusWire = 'queued' | 'running' | 'success' | 'failed'

/** 任务构建类型（与 taskApiClient 的 TaskBuildType 对齐）。 */
export type TaskBuildTypeWire = 'full' | 'incremental'

/** 任务查询参数（页面上部查询区 → 宿主分页列表接口）。 */
export interface TaskQueryWire {
  keyword?: string
  status?: TaskItemStatusWire | 'all'
  buildType?: TaskBuildTypeWire | 'all'
  page: number
  pageSize: number
  /** 允许透传扩展字段 */
  [extra: string]: unknown
}

/** 任务分页结果（表格展示 + 分页控件）。 */
export interface TaskPageWire {
  items: TaskItemWire[]
  total: number
  page: number
  pageSize: number
  /** 允许透传扩展字段 */
  [extra: string]: unknown
}

/** 任务行类型（HTTP 接口返回的任务快照，打桩模拟 / 真实接口同形）。 */
export interface TaskItemWire {
  id: string
  /** 任务名称（列表主显示字段） */
  name: string
  branch: string
  buildType: TaskBuildTypeWire
  status: TaskItemStatusWire
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

/**
 * serialConsole 页面 init.extra 的约定键（17 方案阶段 3 协议化，P1-5：
 * 键名唯一来源，消除 useConsolePage / webviewController / panel 三处字面量散落；
 * 拼错键名从此过不了类型检查）。
 */
export interface SerialConsoleInitExtra {
  /** 服务器列表初装（畸形元素由消费方经 sanitizeWireList 过滤） */
  servers: SerialServerWire[]
  /** 命令历史初装（MRU 序，已去重） */
  history: CommandHistoryWire[]
  /** 打开面板时自动连接的目标（命令预选 / 序列化恢复；null = 不自动连） */
  initialServerId: string | null
  /**
   * webview state 持久化的页面草稿（webviewController 统一注入，键名 'persisted'；
   * 页面自产自销，协议层不校验内部形态）。
   */
  persisted?: unknown
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
  /** 任务分页列表（页面查询 / 轮询 / 增删改后的刷新应答） */
  | { type: 'taskList'; page: TaskPageWire }

/** Webview → 宿主 */
export type WebviewMessage =
  | { type: 'ready' }
  /**
   * 通用表单提交（taskManager 页面）。draft.id 约定（17 方案阶段 1 登记入协议）：
   * string = 编辑该 id（宿主走 update）；undefined = 新建（宿主走 create）。
   */
  | { type: 'submit'; draft: Record<string, unknown> }
  /** 请求枚举本机串口 */
  | { type: 'serialPortsRequest' }
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
  /** 删除单条历史 */
  | { type: 'commandHistoryRemove'; id: string }
  /** 清空历史 */
  | { type: 'commandHistoryClear' }
  /** 查询任务列表（按关键字 / 状态 / 构建类型过滤 + 分页） */
  | { type: 'taskListRequest'; query: TaskQueryWire }
  /** 删除任务（按 id → 后端 delete） */
  | { type: 'taskDelete'; id: string }

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

export function isSerialPortBrief(v: unknown): v is SerialPortBrief {
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

export function isTaskItemWire(v: unknown): v is TaskItemWire {
  return (
    isPlainObject(v) &&
    typeof v.id === 'string' &&
    typeof v.name === 'string' &&
    typeof v.branch === 'string' &&
    (v.buildType === 'full' || v.buildType === 'incremental') &&
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

function isTaskQueryWire(v: unknown): v is TaskQueryWire {
  return (
    isPlainObject(v) &&
    typeof v.page === 'number' &&
    typeof v.pageSize === 'number' &&
    (v.keyword === undefined || typeof v.keyword === 'string') &&
    (v.status === undefined ||
      v.status === 'all' ||
      v.status === 'queued' ||
      v.status === 'running' ||
      v.status === 'success' ||
      v.status === 'failed') &&
    (v.buildType === undefined || v.buildType === 'all' || isTaskBuildType(v.buildType))
  )
}

function isTaskBuildType(v: unknown): v is TaskBuildTypeWire {
  return v === 'full' || v === 'incremental'
}

function isTaskPageWire(v: unknown): v is TaskPageWire {
  return (
    isPlainObject(v) &&
    Array.isArray(v.items) &&
    typeof v.total === 'number' &&
    typeof v.page === 'number' &&
    typeof v.pageSize === 'number'
  )
}

/**
 * 元素级清洗（17 方案阶段 3，P2-F3 前向兼容）：列表类消息的守卫只验容器形态，
 * 元素合法性由消费方经本函数过滤——宿主新增枚举值 / 字段时，旧页面丢弃坏元素
 * 并告警，而不是整条拒绝导致列表全空（「向后兼容地扩展」的落地口径）。
 */
export function sanitizeWireList<T>(
  list: readonly unknown[],
  guard: (value: unknown) => value is T,
  label: string
): T[] {
  const clean: T[] = []
  let dropped = 0
  for (const entry of list) {
    if (guard(entry)) {
      clean.push(entry)
    } else {
      dropped += 1
    }
  }
  if (dropped > 0) {
    console.warn(`[protocol] ${label}中 ${dropped} 条畸形元素已丢弃（可能是宿主新增了枚举值）`)
  }
  return clean
}

/** 宿主收到消息时先过本守卫，再按 type 分发。 */
export function isWebviewMessage(v: unknown): v is WebviewMessage {
  if (!isPlainObject(v)) {
    return false
  }
  switch (v.type) {
    case 'ready':
      return true
    case 'submit':
      return isPlainObject(v.draft)
    case 'serialPortsRequest':
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
    case 'commandHistoryRemove':
      return typeof v.id === 'string'
    case 'commandHistoryClear':
      return true
    case 'taskListRequest':
      return isTaskQueryWire(v.query)
    case 'taskDelete':
      return typeof v.id === 'string'
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
      // 容器形态校验；元素合法性由消费方 sanitizeWireList 过滤（P2-F3 前向兼容）
      return Array.isArray(v.ports)
    case 'serialServers':
      return Array.isArray(v.servers)
    case 'serialState':
      return (
        (typeof v.serverId === 'string' || v.serverId === null) &&
        isSerialLinkStateWire(v.state) &&
        (v.error === undefined || typeof v.error === 'string')
      )
    case 'serialData':
      return typeof v.seq === 'number' && typeof v.text === 'string'
    case 'commandHistory':
      return Array.isArray(v.entries)
    case 'taskList':
      return isTaskPageWire(v.page)
    default:
      return false
  }
}
