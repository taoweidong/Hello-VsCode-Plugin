import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import ServerList from '../../../webview/apps/serialConsole/components/ServerList.vue'
import type { SerialServerWire } from '../../../webview/protocol'

/**
 * ServerList 组件级用例（第五轮补盲区：此前仅经 App 间接触达）：
 * 列表渲染 / 选中与连接态 / 两段式删除布防 / 连接按钮语义。
 */

function makeServer(overrides: Partial<SerialServerWire> = {}): SerialServerWire {
  return {
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
    ...overrides,
  }
}

function mountList(
  servers: SerialServerWire[],
  overrides: Record<string, unknown> = {}
): VueWrapper {
  return mount(ServerList, {
    props: {
      servers,
      selectedId: undefined,
      activeServerId: null,
      linkState: 'disconnected',
      ...overrides,
    },
  })
}

describe('ServerList：渲染与选择', () => {
  it('渲染服务器行（名称 / 串口 / 波特率）；空列表展示空态', () => {
    const w = mountList([makeServer()])
    expect(w.findAll('.server-list__row')).toHaveLength(1)
    expect(w.text()).toContain('服务器甲')
    expect(w.text()).toContain('COM3 · 115200')

    const empty = mountList([])
    expect(empty.text()).toContain('暂无服务器')
  })

  it('selectedId 行高亮；行点击 emit select', async () => {
    const w = mountList([makeServer(), makeServer({ id: 'srv-2', name: '服务器乙' })], {
      selectedId: 'srv-2',
    })
    const rows = w.findAll('.server-list__row')
    expect(rows[1].classes()).toContain('server-list__row--selected')
    await rows[0].trigger('click')
    expect(w.emitted('select')?.[0]).toEqual(['srv-1'])
  })
})

describe('ServerList：连接态', () => {
  it('活动连接行显示已连接样式，连接按钮切换为「断开」', async () => {
    const w = mountList([makeServer()], {
      activeServerId: 'srv-1',
      linkState: 'connected',
    })
    expect(w.find('.server-list__row').classes()).toContain('server-list__row--connected')
    const connectButton = w
      .findAll('.server-list__actions button')
      .find((b) => b.attributes('title') === '断开')
    expect(connectButton).toBeDefined()
    await connectButton?.trigger('click')
    expect(w.emitted('connect')?.[0]).toEqual(['srv-1'])

    const idle = mountList([makeServer()])
    const idleButton = idle
      .findAll('.server-list__actions button')
      .find((b) => b.attributes('title') === '连接')
    expect(idleButton).toBeDefined()
  })
})

describe('ServerList：两段式删除', () => {
  it('首点布防（按钮进入确认态）不 emit delete；再点才 emit', async () => {
    const w = mountList([makeServer()])
    const deleteButton = () => w.find('.server-list__delete')

    await deleteButton().trigger('click')
    expect(w.emitted('delete')).toBeUndefined()
    expect(deleteButton().attributes('title')).toBe('再次点击确认删除')
    expect(deleteButton().classes()).toContain('server-list__delete--armed')

    await deleteButton().trigger('click')
    expect(w.emitted('delete')?.[0]).toEqual(['srv-1'])
    expect(deleteButton().attributes('title')).toBe('删除')
  })
})
