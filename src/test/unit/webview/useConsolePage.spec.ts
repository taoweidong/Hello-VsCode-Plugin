import { beforeEach, describe, expect, it } from 'vitest'
import { defineComponent, h } from 'vue'
import { mount } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import {
  useConsolePage,
  type ConsoleInitExtra,
  type ConsoleLinkState,
} from '../../../webview/composables/useConsolePage'
import type { WebviewMessage } from '../../../webview/protocol'
import { __setVsCodeApiForTest, type VsCodeApi } from '../../../webview/shared/useVsCodeApi'
import { hostMessage } from './appTestUtils'

/**
 * useConsolePage composable 直接用例（第五轮补盲区：此前仅经 serialConsoleApp 间接）：
 * ready 握手 / init 装配与 extra 元素级过滤 / 各类宿主消息分发 / 生命周期清理。
 */

const FIELD = { key: 'name', label: '名称', type: 'text' }

const VALID_SERVER = {
  id: 'srv-1',
  name: '服务器甲',
  serialPath: 'COM3',
  baudRate: 115200,
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
  flowControl: 'none',
  lineEnding: 'lf',
  autoLogin: false,
  username: '',
  description: '',
  createdAt: 1,
  updatedAt: 1,
}

const VALID_HISTORY = { id: 'h1', command: 'show version', lastUsedAt: 1, useCount: 2 }

interface Calls {
  init: Array<{ schema: unknown; extra: ConsoleInitExtra; persisted: unknown }>
  servers: unknown[]
  link: ConsoleLinkState[]
  data: Array<{ text: string; seq: number }>
  ports: unknown[]
  history: unknown[]
  error: Array<{ message: string; field?: string }>
}

let api: VsCodeApi & { posted: unknown[] }
let wrapper: VueWrapper | undefined

beforeEach(() => {
  api = {
    posted: [],
    postMessage(message: unknown): void {
      api.posted.push(message)
    },
    getState: () => undefined,
    setState: () => undefined,
  }
  __setVsCodeApiForTest(api)
})

function mountPage(): { calls: Calls; post: (message: WebviewMessage) => void } {
  const calls: Calls = {
    init: [],
    servers: [],
    link: [],
    data: [],
    ports: [],
    history: [],
    error: [],
  }
  let post: (message: WebviewMessage) => void = () => {}
  const Host = defineComponent({
    setup() {
      const page = useConsolePage({
        onInit: (schema, extra, persisted) => calls.init.push({ schema, extra, persisted }),
        onServers: (servers) => calls.servers.push(servers),
        onLinkState: (payload) => calls.link.push(payload),
        onData: (text, seq) => calls.data.push({ text, seq }),
        onPorts: (ports) => calls.ports.push(ports),
        onHistory: (entries) => calls.history.push(entries),
        onError: (message, field) => calls.error.push({ message, field }),
      })
      post = page.post
      return () => h('div')
    },
  })
  wrapper = mount(Host)
  return { calls, post }
}

describe('useConsolePage：握手与发送', () => {
  it('挂载即上报 ready；post 透传协议消息', () => {
    const { post } = mountPage()
    expect(api.posted).toEqual([{ type: 'ready' }])
    post({ type: 'serialSend', command: 'ls' })
    expect(api.posted[1]).toEqual({ type: 'serialSend', command: 'ls' })
  })
})

describe('useConsolePage：init 装配', () => {
  it('initialized 置位；schema / servers / history / persisted 原样透传', () => {
    const { calls } = mountPage()
    hostMessage({
      type: 'init',
      page: 'serialConsole',
      schema: [FIELD],
      value: null,
      extra: {
        servers: [VALID_SERVER],
        history: [VALID_HISTORY],
        initialServerId: 'srv-1',
        persisted: { draft: { name: '草稿' } },
      },
    })
    expect(calls.init).toHaveLength(1)
    const { schema, extra, persisted } = calls.init[0]
    expect(schema).toEqual([FIELD])
    expect(extra.servers).toEqual([VALID_SERVER])
    expect(extra.history).toEqual([VALID_HISTORY])
    expect(extra.initialServerId).toBe('srv-1')
    expect(persisted).toEqual({ draft: { name: '草稿' } })
  })

  it('extra 畸形元素被过滤（P2-F4 元素级守卫）：坏服务器 / 坏历史不进 UI 状态', () => {
    const { calls } = mountPage()
    hostMessage({
      type: 'init',
      page: 'serialConsole',
      schema: [FIELD],
      value: null,
      extra: {
        servers: [VALID_SERVER, { id: 'bad' }, 'junk', 42],
        history: [VALID_HISTORY, { id: 'bad-h' }],
      },
    })
    expect(calls.init[0].extra.servers).toEqual([VALID_SERVER])
    expect(calls.init[0].extra.history).toEqual([VALID_HISTORY])
  })

  it('extra 缺失或字段非数组：回退空列表，initialServerId 非 string 归 null', () => {
    const { calls } = mountPage()
    hostMessage({ type: 'init', page: 'serialConsole', schema: [FIELD], value: null })
    expect(calls.init[0].extra).toEqual({
      servers: [],
      history: [],
      initialServerId: null,
    })
    expect(calls.init[0].persisted).toBeUndefined()
  })
})

describe('useConsolePage：消息分发', () => {
  it('serialServers / serialState（含 error）/ serialData / serialPorts / commandHistory 各归各位', () => {
    const { calls } = mountPage()
    hostMessage({ type: 'serialServers', servers: [VALID_SERVER] })
    hostMessage({ type: 'serialState', serverId: 'srv-1', state: 'connected' })
    hostMessage({ type: 'serialState', serverId: null, state: 'error', error: 'COM3 被占用' })
    hostMessage({ type: 'serialData', seq: 7, text: 'hello\n' })
    hostMessage({ type: 'serialPorts', ports: [{ path: 'COM9' }] })
    hostMessage({ type: 'commandHistory', entries: [VALID_HISTORY] })

    expect(calls.servers[0]).toEqual([VALID_SERVER])
    expect(calls.link[0]).toEqual({ serverId: 'srv-1', state: 'connected' })
    expect(calls.link[1]).toEqual({ serverId: null, state: 'error', error: 'COM3 被占用' })
    expect(calls.data[0]).toEqual({ text: 'hello\n', seq: 7 })
    expect(calls.ports[0]).toEqual([{ path: 'COM9' }])
    expect(calls.history[0]).toEqual([VALID_HISTORY])
  })

  it('error 写 hostError 并回调（含 field）；未过守卫的消息不分发', () => {
    const { calls } = mountPage()
    hostMessage({ type: 'error', message: '名称不能为空。', field: 'name' })
    hostMessage({ type: 'error', message: '连接失败' })
    hostMessage({ type: 'hack' } as never)
    expect(calls.error).toEqual([
      { message: '名称不能为空。', field: 'name' },
      { message: '连接失败', field: undefined },
    ])
  })

  it('卸载后移除 message 监听：宿主消息不再分发', () => {
    const { calls } = mountPage()
    wrapper?.unmount()
    wrapper = undefined
    hostMessage({ type: 'serialServers', servers: [VALID_SERVER] })
    hostMessage({ type: 'error', message: '晚到的错误' })
    expect(calls.servers).toHaveLength(0)
    expect(calls.error).toHaveLength(0)
  })
})
