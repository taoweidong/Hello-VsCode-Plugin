import type { SchemaFieldDef } from '../../../webview/formSchema'
import {
  BAUD_RATES,
  LINE_ENDINGS,
  type FlowControl,
  type LineEnding,
  type Parity,
  type SerialServerDraft,
} from './models'
import { isSecretLikeKey } from './serverGuard'

/**
 * 串口服务器领域 Schema（参数化字段表，经 deriveFormSchema 派生表单）：
 * SERVER_FIELD_DEFS 是表单字段的单一来源，校验 / 清洗由 coerceServerDraft 按表处理。
 *
 * 密码字段仅用于表单渲染与传输（经协议 serialServerSave.password 单独携带 →
 * SecretStorage），coerceServerDraft 的输出不含 password，持久化链路零明文。
 */
export const SERVER_FIELD_DEFS: SchemaFieldDef[] = [
  {
    key: 'name',
    type: 'text',
    label: '名称',
    required: true,
    maxLength: 100,
    placeholder: '如：服务器甲',
  },
  {
    key: 'serialPath',
    type: 'text',
    label: '串口',
    required: true,
    maxLength: 100,
    placeholder: '如 COM3 / /dev/ttyUSB0',
    hint: '可点击「检测串口」后选择自动识别的串口',
  },
  {
    key: 'baudRate',
    type: 'select',
    label: '波特率',
    defaultValue: '115200',
    options: BAUD_RATES.map((rate) => ({ value: String(rate), label: String(rate) })),
  },
  {
    key: 'dataBits',
    type: 'select',
    label: '数据位',
    defaultValue: '8',
    options: [8, 7, 6, 5].map((bits) => ({ value: String(bits), label: String(bits) })),
  },
  {
    key: 'stopBits',
    type: 'select',
    label: '停止位',
    defaultValue: '1',
    options: [1, 2].map((bits) => ({ value: String(bits), label: String(bits) })),
  },
  {
    key: 'parity',
    type: 'select',
    label: '校验位',
    defaultValue: 'none',
    options: [
      { value: 'none', label: '无' },
      { value: 'even', label: '偶校验' },
      { value: 'odd', label: '奇校验' },
    ],
  },
  {
    key: 'flowControl',
    type: 'select',
    label: '流控',
    defaultValue: 'none',
    options: [
      { value: 'none', label: '无' },
      { value: 'hardware', label: '硬件（RTS/CTS）' },
    ],
  },
  {
    key: 'lineEnding',
    type: 'select',
    label: '命令换行符',
    defaultValue: 'lf',
    options: [
      { value: 'lf', label: 'LF（\\n）' },
      { value: 'crlf', label: 'CRLF（\\r\\n）' },
      { value: 'cr', label: 'CR（\\r）' },
    ],
  },
  {
    key: 'autoLogin',
    type: 'boolean',
    label: '自动登录',
    defaultValue: 'false',
    hint: '连接后自动发送用户名与密码',
  },
  {
    key: 'username',
    type: 'text',
    label: '登录用户名',
    maxLength: 100,
    placeholder: '自动登录时必填',
  },
  {
    key: 'password',
    type: 'password',
    label: '登录密码',
    maxLength: 200,
    placeholder: '选填',
    hint: '仅自动登录使用，加密存储且不写入数据文件；编辑时留空表示保持不变',
  },
  { key: 'description', type: 'textarea', label: '备注', placeholder: '选填' },
]

/** 校验失败结果：field 定位字段（供表单错误锚定），message 已含字段中文名。 */
export type CoerceServerDraftResult =
  { ok: true; draft: SerialServerDraft } | { ok: false; field: string; message: string }

const DATA_BITS = [8, 7, 6, 5] as const
const STOP_BITS = [1, 2] as const
const PARITIES: Parity[] = ['none', 'even', 'odd']
const FLOW_CONTROLS: FlowControl[] = ['none', 'hardware']
const LINE_ENDING_SET = new Set<LineEnding>(LINE_ENDINGS)

/**
 * 领域校验与清洗：
 * - name / serialPath 必填（trim 后非空，超长报错）；
 * - select 值转回领域类型（baudRate/dataBits/stopBits → number，其余枚举），
 *   非法值直接报错（不静默回退——保存路径宁严勿宽）；
 * - 开启自动登录时 username 必填；password 不经本函数（页面单独携带）；
 * - 未知 key 且值为 string / number / boolean 时原样透传（与条目语义一致）。
 */
export function coerceServerDraft(raw: Record<string, unknown>): CoerceServerDraftResult {
  const source = raw ?? {}

  const name = coerceText('名称', source.name, { required: true, maxLength: 100 })
  if (!name.ok) return { ok: false, field: 'name', message: name.message }
  const serialPath = coerceText('串口', source.serialPath, { required: true, maxLength: 100 })
  if (!serialPath.ok) return { ok: false, field: 'serialPath', message: serialPath.message }
  const username = coerceText('登录用户名', source.username, { maxLength: 100 })
  if (!username.ok) return { ok: false, field: 'username', message: username.message }
  const description = coerceText('备注', source.description, {})
  if (!description.ok) return { ok: false, field: 'description', message: description.message }

  const autoLogin = source.autoLogin === true || source.autoLogin === 'true'
  if (autoLogin && username.value.length === 0) {
    return { ok: false, field: 'username', message: '开启自动登录时必须填写登录用户名。' }
  }

  const baudRate = coerceNumberFromSelect(
    '波特率',
    source.baudRate,
    BAUD_RATES as readonly number[]
  )
  if (typeof baudRate !== 'number') return { ok: false, field: 'baudRate', message: baudRate }
  const dataBits = coerceNumberFromSelect('数据位', source.dataBits, DATA_BITS)
  if (typeof dataBits !== 'number') return { ok: false, field: 'dataBits', message: dataBits }
  const stopBits = coerceNumberFromSelect('停止位', source.stopBits, STOP_BITS)
  if (typeof stopBits !== 'number') return { ok: false, field: 'stopBits', message: stopBits }

  const parity = source.parity
  if (typeof parity !== 'string' || !PARITIES.includes(parity as Parity)) {
    return { ok: false, field: 'parity', message: `校验位的值「${String(parity)}」不在可选项内。` }
  }
  const flowControl = source.flowControl
  if (typeof flowControl !== 'string' || !FLOW_CONTROLS.includes(flowControl as FlowControl)) {
    return {
      ok: false,
      field: 'flowControl',
      message: `流控的值「${String(flowControl)}」不在可选项内。`,
    }
  }
  const lineEnding = source.lineEnding
  if (typeof lineEnding !== 'string' || !LINE_ENDING_SET.has(lineEnding as LineEnding)) {
    return {
      ok: false,
      field: 'lineEnding',
      message: `命令换行符的值「${String(lineEnding)}」不在可选项内。`,
    }
  }

  const draft: SerialServerDraft = {
    name: name.value,
    serialPath: serialPath.value,
    baudRate,
    dataBits,
    stopBits,
    parity: parity as Parity,
    flowControl: flowControl as FlowControl,
    lineEnding: lineEnding as LineEnding,
    autoLogin,
    username: username.value,
    description: description.value,
  }

  for (const [key, value] of Object.entries(source)) {
    // 未知键透传，但 secret-like 键（adminPassword / userPassword 等变体）一律剔除：
    // webview 消息是运行时不可信输入，与加载侧 serverGuard 同一防线（数据文件零明文）
    if (key in draft || isSecretLikeKey(key)) continue
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      draft[key] = value
    }
  }
  return { ok: true, draft }
}

/** 单个文本字段清洗：trim / 必填 / 超长。 */
function coerceText(
  label: string,
  raw: unknown,
  options: { required?: boolean; maxLength?: number }
): { ok: true; value: string } | { ok: false; message: string } {
  const text = typeof raw === 'string' ? raw.trim() : raw === undefined || raw === null ? '' : null
  if (text === null) return { ok: false, message: `${label}必须是文本。` }
  if (options.required && !text) return { ok: false, message: `${label}不能为空。` }
  if (options.maxLength !== undefined && text.length > options.maxLength) {
    return { ok: false, message: `${label}长度不能超过 ${options.maxLength} 字。` }
  }
  return { ok: true, value: text }
}

/** select 字符串值 → 受限数字（必须命中 allowed 列表；返回错误消息或窄化后的数字）。 */
function coerceNumberFromSelect<T extends number>(
  label: string,
  raw: unknown,
  allowed: readonly T[]
): T | string {
  const candidates = allowed as readonly number[]
  if (typeof raw === 'number' && candidates.includes(raw)) return raw as T
  if (typeof raw === 'string' && candidates.includes(Number(raw))) return Number(raw) as T
  return `${label}的值「${String(raw)}」不在可选项内。`
}
