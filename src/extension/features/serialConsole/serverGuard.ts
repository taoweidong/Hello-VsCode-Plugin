import {
  DEFAULT_SERIAL_PARAMS,
  isDataBits,
  isFlowControl,
  isLineEnding,
  isParity,
  isStopBits,
  type SerialServer,
} from './models'

/**
 * 加载守卫（逐字段窄化，非法样例拒绝）：
 * - 坏条目（非对象 / 缺 id / name 或 serialPath 非字符串）跳过并经 onWarning 上报；
 * - 缺失或非法的串口参数补 DEFAULT_SERIAL_PARAMS 默认值；
 * - 重复 id 保留首个；
 * - 未知 string / number / boolean 字段透传保留。
 * 保证进入业务层的 SerialServer 满足形态。
 */
export function normalizeSerialServerList(
  raw: unknown[],
  onWarning?: (message: string) => void
): SerialServer[] {
  const servers: SerialServer[] = []
  const seenIds = new Set<string>()
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) {
      onWarning?.(`服务器条目不是对象，已跳过：${safePreview(entry)}`)
      continue
    }
    const record = entry as Record<string, unknown>
    const { id, name, serialPath } = record
    if (typeof id !== 'string' || id.length === 0) {
      onWarning?.(`服务器条目缺少合法 id，已跳过：${safePreview(entry)}`)
      continue
    }
    if (seenIds.has(id)) {
      onWarning?.(`服务器条目 id 重复（${id}），保留首个。`)
      continue
    }
    if (typeof name !== 'string' || name.length === 0) {
      onWarning?.(`服务器条目（${id}）name 非法，已跳过。`)
      continue
    }
    if (typeof serialPath !== 'string' || serialPath.length === 0) {
      onWarning?.(`服务器条目（${id}）serialPath 非法，已跳过。`)
      continue
    }
    seenIds.add(id)

    const fallback = <T>(value: unknown, def: T, isValid: (v: unknown) => v is T): T =>
      isValid(value) ? value : def
    servers.push({
      ...DEFAULT_SERIAL_PARAMS,
      ...pickUnknownScalars(record),
      id,
      name,
      serialPath,
      baudRate:
        typeof record.baudRate === 'number' &&
        Number.isFinite(record.baudRate) &&
        record.baudRate > 0
          ? record.baudRate
          : DEFAULT_SERIAL_PARAMS.baudRate,
      dataBits: fallback(record.dataBits, DEFAULT_SERIAL_PARAMS.dataBits, isDataBits),
      stopBits: fallback(record.stopBits, DEFAULT_SERIAL_PARAMS.stopBits, isStopBits),
      parity: fallback(record.parity, DEFAULT_SERIAL_PARAMS.parity, isParity),
      flowControl: fallback(record.flowControl, DEFAULT_SERIAL_PARAMS.flowControl, isFlowControl),
      lineEnding: fallback(record.lineEnding, DEFAULT_SERIAL_PARAMS.lineEnding, isLineEnding),
      autoLogin: record.autoLogin === true,
      username: typeof record.username === 'string' ? record.username : '',
      description: typeof record.description === 'string' ? record.description : '',
      createdAt: typeof record.createdAt === 'number' ? record.createdAt : 0,
      updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : 0,
    })
  }
  return servers
}

/**
 * 未知 string / number / boolean 字段透传（与 ItemDraft 开放扩展语义一致）。
 * 密码类键一律剔除：SerialServer 数据文件零明文不变量（models.ts / serverSchema.ts，
 * 密码只进 SecretStorage）——手工编辑或外部工具写入数据文件的 password 字段若被
 * 透传，下次保存即明文落盘并推送到 webview DOM（第五轮评估 P1）。
 */
function pickUnknownScalars(record: Record<string, unknown>): Record<string, unknown> {
  const extra: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    if (
      !isKnownServerField(key) &&
      !isSecretLikeKey(key) &&
      (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    ) {
      extra[key] = value
    }
  }
  return extra
}

/** 含 password 的键视作敏感字段（password / adminPassword / user_password 等变体）。 */
function isSecretLikeKey(key: string): boolean {
  return key.toLowerCase().includes('password')
}

const KNOWN_FIELDS = new Set([
  'id',
  'name',
  'serialPath',
  'baudRate',
  'dataBits',
  'stopBits',
  'parity',
  'flowControl',
  'lineEnding',
  'autoLogin',
  'username',
  'description',
  'createdAt',
  'updatedAt',
])

function isKnownServerField(key: string): boolean {
  return KNOWN_FIELDS.has(key)
}

function safePreview(entry: unknown): string {
  const text = JSON.stringify(entry)
  return text.length > 60 ? `${text.slice(0, 60)}…` : text
}
