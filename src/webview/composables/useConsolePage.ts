import { ref } from 'vue'
import {
  isCommandHistoryWire,
  isSerialPortBrief,
  isSerialServerWire,
  sanitizeWireList,
  type CommandHistoryWire,
  type FieldDef,
  type SerialLinkStateWire,
  type SerialConsoleInitExtra,
  type SerialPortBrief,
  type SerialServerWire,
  type WebviewMessage,
} from '../protocol'
import { useHostMessages } from '../shared/useHostMessages'

/**
 * 串口控制台页面的消息编排（17 方案阶段 3 起与 taskManager/useTaskPage 同基
 * useHostMessages）：宿主消息经守卫后按类型分发；页面侧只经 post 发送协议消息。
 * 表单类页面（init/submitAck/error）之外，本页是事件驱动控制台——
 * init 只在握手时出现一次，其余消息随时可到。
 */

/** 页面 init 装配数据（键约定见 protocol.SerialConsoleInitExtra——单一来源）。 */
export type ConsoleInitExtra = SerialConsoleInitExtra

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
  const initialized = ref(false)
  const hostError = ref('')

  const { post } = useHostMessages((message) => {
    switch (message.type) {
      case 'init': {
        initialized.value = true
        const extra = (message.extra ?? {}) as Record<string, unknown>
        options.onInit(
          message.schema,
          {
            // 元素级守卫（P2-F4）：isHostMessage 对 init.extra 只验容器，
            // 畸形元素在此过滤，不让坏数据进入 UI 状态
            servers: Array.isArray(extra.servers)
              ? sanitizeWireList(extra.servers, isSerialServerWire, '服务器列表')
              : [],
            history: Array.isArray(extra.history)
              ? sanitizeWireList(extra.history, isCommandHistoryWire, '命令历史')
              : [],
            initialServerId:
              typeof extra.initialServerId === 'string' ? extra.initialServerId : null,
          },
          extra.persisted
        )
        break
      }
      case 'serialServers':
        options.onServers(sanitizeWireList(message.servers, isSerialServerWire, '服务器列表'))
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
        options.onPorts(sanitizeWireList(message.ports, isSerialPortBrief, '串口列表'))
        break
      case 'commandHistory':
        options.onHistory(sanitizeWireList(message.entries, isCommandHistoryWire, '命令历史'))
        break
      case 'error':
        hostError.value = message.message
        options.onError(message.message, message.field)
        break
      default:
        break
    }
  })

  return { initialized, hostError, post }
}
