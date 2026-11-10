import { StringDecoder } from 'node:string_decoder'
import { reasonOf } from '../../services/errors'
import { LINE_ENDING_CHARS, type SerialServer } from './models'
import type { SerialPortFactory, SerialPortLike } from './serialPortFactory'

/**
 * 串口链路服务（单活动连接，v1）：状态机 + 数据批处理 + 命令写入。
 *
 * - 状态机 disconnected → connecting → connected →（error | disconnected）；
 * - 数据 40ms 批处理（seq 单调递增），防止高频输出打爆 webview 消息通道；
 * - 字节流经 StringDecoder 按 UTF-8 解码（多字节字符跨 data 包不产生乱码）；
 * - 连接中可断开（generation 代际守卫：open 迟到 resolve 不再进入 connected）；
 * - 切换服务器 = 自动断开旧连接再连新连接；
 * - close/flush 幂等：重复断开、拔线、I/O 错误都不产生重复状态通知。
 */

export type LinkState = 'disconnected' | 'connecting' | 'connected' | 'error'

/** 数据批处理窗口（ms）：窗口内的多次 data 事件合并为一次 onData。 */
export const SERIAL_DATA_BATCH_MS = 40

export interface SerialLinkHooks {
  onData(text: string, seq: number): void
  onState(state: LinkState, error?: string): void
}

export interface SerialLinkService {
  /** 打开串口；失败 reject（同时经 onState 上报 error）。 */
  connect(server: SerialServer): Promise<void>
  /** 写入命令（追加服务器配置的换行符）；未连接抛错。 */
  send(command: string): void
  /** 断开（幂等）；断开前 flush 残留数据。 */
  disconnect(): void
  state(): LinkState
  connectedServerId(): string | undefined
}

export function createSerialLinkService(
  factory: SerialPortFactory,
  hooks: SerialLinkHooks
): SerialLinkService {
  let state: LinkState = 'disconnected'
  let port: SerialPortLike | undefined
  let server: SerialServer | undefined
  let pendingText = ''
  let pendingTimer: ReturnType<typeof setTimeout> | undefined
  let seq = 0
  /** 代际计数：connect 发起时分配，disconnect/新 connect 使旧代际失效。 */
  let generation = 0
  /** UTF-8 增量解码器：多字节字符跨 data 包拆分时按字节缓冲（P2-B1）。 */
  const decoder = new StringDecoder('utf8')

  const setState = (next: LinkState, error?: string): void => {
    state = next
    hooks.onState(next, error)
  }

  /** 刷出批处理缓冲（close/disconnect 前调用，保证尾包不丢）。 */
  const flush = (): void => {
    if (pendingTimer !== undefined) {
      clearTimeout(pendingTimer)
      pendingTimer = undefined
    }
    if (pendingText.length > 0) {
      seq += 1
      hooks.onData(pendingText, seq)
      pendingText = ''
    }
  }

  /** 关闭端口并清理引用（不再发状态，由调用方决定下一状态）。 */
  const teardownPort = (): void => {
    flush()
    // 解码器残留的不完整字节随断开一次性刷出（不静默丢弃），随后重置解码器
    const tail = decoder.end()
    if (tail.length > 0) {
      seq += 1
      hooks.onData(tail, seq)
    }
    const current = port
    port = undefined
    server = undefined
    if (current) {
      try {
        current.close()
      } catch {
        // 端口已由对端关闭等场景下 close 报错不阻塞状态迁移
      }
    }
  }

  const attach = (opened: SerialPortLike): void => {
    opened.on('data', (chunk: Buffer) => {
      if (port !== opened) return
      pendingText += decoder.write(chunk)
      if (pendingTimer === undefined) {
        pendingTimer = setTimeout(() => {
          pendingTimer = undefined
          flush()
        }, SERIAL_DATA_BATCH_MS)
      }
    })
    opened.on('close', () => {
      if (port !== opened) return
      teardownPort()
      if (state !== 'disconnected') setState('disconnected')
    })
    opened.on('error', (err: Error) => {
      if (port !== opened) return
      teardownPort()
      if (state !== 'error') setState('error', err.message)
    })
  }

  return {
    async connect(next: SerialServer): Promise<void> {
      if (state === 'connecting') {
        throw new Error('正在建立串口连接，请稍候')
      }
      if (port) {
        // 切换服务器：先断开旧连接（会发出 disconnected → connecting 序列）
        teardownPort()
        if (state !== 'disconnected') setState('disconnected')
      }
      const myGeneration = (generation += 1)
      setState('connecting')
      try {
        const opened = await factory.open({
          path: next.serialPath,
          baudRate: next.baudRate,
          dataBits: next.dataBits,
          stopBits: next.stopBits,
          parity: next.parity,
          flowControl: next.flowControl === 'hardware',
        })
        if (generation !== myGeneration) {
          // 连接期间被断开 / 被新连接取代：静默关闭迟到的端口
          try {
            opened.close()
          } catch {
            // 同上，不阻塞
          }
          return
        }
        port = opened
        server = next
        attach(opened)
        setState('connected')
      } catch (err) {
        if (generation !== myGeneration) return // 已被取消，不再上报
        const message = reasonOf(err)
        setState('error', `串口 ${next.serialPath} 打开失败：${message}`)
        throw err instanceof Error ? err : new Error(message)
      }
    },

    send(command: string): void {
      if (state !== 'connected' || !port) {
        throw new Error('串口未连接')
      }
      const lineEnding = LINE_ENDING_CHARS[server?.lineEnding ?? 'lf']
      port.write(command + lineEnding)
    },

    disconnect(): void {
      if (state === 'connecting') {
        // 代际守卫：使进行中的 open 作废，迟到 resolve 被静默关闭
        generation += 1
        setState('disconnected')
        return
      }
      if (!port && state === 'disconnected') return
      teardownPort()
      if (state !== 'disconnected') setState('disconnected')
    },

    state: () => state,

    connectedServerId: () => server?.id,
  }
}
