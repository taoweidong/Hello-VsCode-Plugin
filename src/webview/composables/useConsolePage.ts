import { onBeforeUnmount, onMounted, ref } from 'vue'
import {
  isCommandHistoryWire,
  isHostMessage,
  isSerialServerWire,
  type CommandHistoryWire,
  type FieldDef,
  type SerialLinkStateWire,
  type SerialPortBrief,
  type SerialServerWire,
  type WebviewMessage,
} from '../protocol'
import { useVsCodeApi } from '../shared/useVsCodeApi'

/**
 * window 的最小结构（宿主消息通道）。本文件被根 tsconfig（lib 仅 ES2022，无 DOM）
 * 纳入类型检查，与 shared/useVsCodeApi.ts 同款：经结构化 cast 访问浏览器全局。
 */
interface WebviewWindow {
  addEventListener(type: string, listener: (event: { data: unknown }) => void): void
  removeEventListener(type: string, listener: (event: { data: unknown }) => void): void
}

function webviewWindow(): WebviewWindow {
  return (globalThis as unknown as { window: WebviewWindow }).window
}

/**
 * 串口控制台页面的消息编排（buildConsole 页面未复用本 composable，自行编排）：
 * 宿主消息经 isHostMessage 守卫后按类型分发；页面侧只经 post 发送协议消息。
 * 表单类页面（init/submitAck/error）之外，本页是事件驱动控制台——
 * init 只在握手时出现一次，其余消息随时可到。
 */

export interface ConsoleInitExtra {
  servers: SerialServerWire[]
  history: CommandHistoryWire[]
  initialServerId: string | null
}

export interface ConsoleLinkState {
  serverId: string | null
  state: SerialLinkStateWire
  error?: string
}

export interface ConsolePageOptions {
  onInit(schema: FieldDef[], extra: ConsoleInitExtra, persisted: unknown): void
  onServers(servers: SerialServerWire[]): void
  onLinkState(payload: ConsoleLinkState): void
  onData(text: string, seq: number): void
  onPorts(ports: SerialPortBrief[]): void
  onHistory(entries: CommandHistoryWire[]): void
  onError(message: string, field?: string): void
}

export function useConsolePage(options: ConsolePageOptions): {
  initialized: import('vue').Ref<boolean>
  hostError: import('vue').Ref<string>
  post(message: WebviewMessage): void
} {
  const api = useVsCodeApi()
  const initialized = ref(false)
  const hostError = ref('')

  const onHostMessage = (event: { data: unknown }): void => {
    const message: unknown = event.data
    if (!isHostMessage(message)) {
      return
    }
    switch (message.type) {
      case 'init': {
        initialized.value = true
        const extra = (message.extra ?? {}) as Record<string, unknown>
        options.onInit(
          message.schema,
          {
            // 元素级守卫（P2-F4）：isHostMessage 对 init.extra 只验容器，
            // 畸形元素在此过滤，不让坏数据进入 UI 状态
            servers: Array.isArray(extra.servers) ? extra.servers.filter(isSerialServerWire) : [],
            history: Array.isArray(extra.history) ? extra.history.filter(isCommandHistoryWire) : [],
            initialServerId:
              typeof extra.initialServerId === 'string' ? extra.initialServerId : null,
          },
          extra.persisted
        )
        break
      }
      case 'serialServers':
        options.onServers(message.servers)
        break
      case 'serialState':
        options.onLinkState({
          serverId: message.serverId,
          state: message.state,
          ...(message.error !== undefined ? { error: message.error } : {}),
        })
        break
      case 'serialData':
        options.onData(message.text, message.seq)
        break
      case 'serialPorts':
        options.onPorts(message.ports)
        break
      case 'commandHistory':
        options.onHistory(message.entries)
        break
      case 'error':
        hostError.value = message.message
        options.onError(message.message, message.field)
        break
      default:
        break
    }
  }

  onMounted(() => {
    webviewWindow().addEventListener('message', onHostMessage)
    api.postMessage({ type: 'ready' })
  })
  onBeforeUnmount(() => {
    webviewWindow().removeEventListener('message', onHostMessage)
  })

  const post = (message: WebviewMessage): void => {
    api.postMessage(message)
  }

  return { initialized, hostError, post }
}
