/**
 * 串口服务器核心数据模型（docs/superpowers/specs/2026-10-24-serial-command-console-design.md §5.1）。
 *
 * 密码绝不入本模型：登录口令只存 VSCode SecretStorage
 * （key 见 serialConsoleController），数据文件 / 日志 / 输出通道零明文。
 */

import { STORAGE } from '../../constants'

/** 命令下发换行符。 */
export type LineEnding = 'lf' | 'crlf' | 'cr'

/** 表单下拉顺序。 */
export const LINE_ENDINGS: readonly LineEnding[] = ['lf', 'crlf', 'cr']

/** 换行符 → 实际写入字符。 */
export const LINE_ENDING_CHARS: Record<LineEnding, string> = {
  lf: '\n',
  crlf: '\r\n',
  cr: '\r',
}

/** 常用波特率（表单下拉顺序）。 */
export const BAUD_RATES: readonly number[] = [
  9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600,
]

export type Parity = 'none' | 'even' | 'odd'
export type FlowControl = 'none' | 'hardware'

export interface SerialServer {
  id: string
  name: string
  /** 串口路径，如 COM3 / /dev/ttyUSB0 */
  serialPath: string
  baudRate: number
  dataBits: 8 | 7 | 6 | 5
  stopBits: 1 | 2
  parity: Parity
  flowControl: FlowControl
  lineEnding: LineEnding
  /** 连接后自动发送登录凭据（用户名在此，密码在 SecretStorage） */
  autoLogin: boolean
  username: string
  description: string
  createdAt: number
  updatedAt: number
}

/**
 * 新增 / 编辑时的可写字段（id 与时间戳由服务层生成；密码经面板剥离后进 SecretStorage）。
 * 与 ItemDraft 同理保持开放扩展：未知 string / number / boolean 字段透传保留。
 */
export type SerialServerDraft = {
  name: string
  serialPath: string
  baudRate: number
  dataBits: 8 | 7 | 6 | 5
  stopBits: 1 | 2
  parity: Parity
  flowControl: FlowControl
  lineEnding: LineEnding
  autoLogin: boolean
  username: string
  description: string
} & Record<string, unknown>

/** 串口参数默认值：表单初始值与加载守卫补齐共用（115200 8N1 无流控）。 */
export const DEFAULT_SERIAL_PARAMS = {
  baudRate: 115200,
  dataBits: 8 as const,
  stopBits: 1 as const,
  parity: 'none' as Parity,
  flowControl: 'none' as FlowControl,
  lineEnding: 'lf' as LineEnding,
  autoLogin: false,
  username: '',
  description: '',
}

/**
 * 生成服务器 ID。
 *
 * 经 globalThis.crypto 生成 id：避免把 Node 内建模块
 * 依赖引入可能被共享类型程序追溯的链路。
 */
export function createServerId(): string {
  return globalThis.crypto.randomUUID()
}

export function isLineEnding(value: unknown): value is LineEnding {
  return value === 'lf' || value === 'crlf' || value === 'cr'
}

export function isParity(value: unknown): value is Parity {
  return value === 'none' || value === 'even' || value === 'odd'
}

export function isFlowControl(value: unknown): value is FlowControl {
  return value === 'none' || value === 'hardware'
}

export function isDataBits(value: unknown): value is 8 | 7 | 6 | 5 {
  return value === 8 || value === 7 || value === 6 || value === 5
}

export function isStopBits(value: unknown): value is 1 | 2 {
  return value === 1 || value === 2
}

/* ---------------- SecretStorage 键 ---------------- */

/** SecretStorage 密码键的后缀（passwordKey 拼接用）。 */
const PASSWORD_KEY_SUFFIX = '.password'

/**
 * 服务器登录密码在 SecretStorage 中的键（v3.6.1 自 serialConsolePanel 迁入：
 * 控制器与面板两条删除路径共享 serverRemoval 时需要同一来源，避免环依赖）。
 * 密码绝不入数据文件 / 日志（文件头契约）。
 */
export function passwordKey(serverId: string): string {
  return `${STORAGE.serialServerSecretPrefix}${serverId}${PASSWORD_KEY_SUFFIX}`
}
