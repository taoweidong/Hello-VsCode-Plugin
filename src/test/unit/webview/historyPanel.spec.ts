import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import HistoryPanel from '../../../webview/apps/serialConsole/components/HistoryPanel.vue'
import type { CommandHistoryWire } from '../../../webview/protocol'

/**
 * 历史命令面板（此前零覆盖）：搜索过滤 / 单击填入 / 双击直接发送 /
 * 单条删除 / 两段式清空（3s 布防超时）。
 */

function makeEntry(overrides: Partial<CommandHistoryWire> = {}): CommandHistoryWire {
  return { id: 'h-1', command: 'show version', lastUsedAt: 1, useCount: 1, ...overrides }
}

const ENTRIES = [
  makeEntry({ id: 'h-1', command: 'show version', lastUsedAt: 1700000000000, useCount: 3 }),
  makeEntry({ id: 'h-2', command: 'dir', lastUsedAt: 0, useCount: 1 }),
  makeEntry({ id: 'h-3', command: 'ls -la', lastUsedAt: 1700000060000, useCount: 1 }),
]

describe('HistoryPanel', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('渲染条目（MRU 序原样）与使用次数；空列表走空态', () => {
    const wrapper = mount(HistoryPanel, { props: { entries: ENTRIES } })
    const rows = wrapper.findAll('[role="option"]')
    expect(rows).toHaveLength(3)
    expect(rows[0].text()).toContain('show version')
    expect(rows[0].text()).toContain('×3')

    const empty = mount(HistoryPanel, { props: { entries: [] } })
    expect(empty.text()).toContain('暂无历史命令')
  })

  it('搜索过滤（大小写不敏感的包含匹配）', async () => {
    const wrapper = mount(HistoryPanel, { props: { entries: ENTRIES } })
    const search = wrapper.find('input[aria-label="搜索历史命令"]')
    await search.setValue('SHOW')
    expect(wrapper.findAll('[role="option"]')).toHaveLength(1)
    await search.setValue('不存在的命令')
    expect(wrapper.text()).toContain('暂无历史命令')
  })

  it('单击行 emit fill；Enter 键同 fill；双击行 emit send（P3-H5 路径锁定）', async () => {
    const wrapper = mount(HistoryPanel, { props: { entries: ENTRIES } })
    const row = wrapper.findAll('[role="option"]')[0]
    await row.trigger('click')
    expect(wrapper.emitted('fill')).toEqual([['show version']])
    await row.trigger('dblclick')
    expect(wrapper.emitted('send')).toEqual([['show version']])
    await row.trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('fill')?.at(-1)).toEqual(['show version'])
  })

  it('单条删除按钮 emit remove（不冒泡触发 fill）', async () => {
    const wrapper = mount(HistoryPanel, { props: { entries: ENTRIES } })
    const remove = wrapper.findAll('.history-panel__remove')[1]
    await remove.trigger('click')
    expect(wrapper.emitted('remove')).toEqual([['h-2']])
    expect(wrapper.emitted('fill')).toBeUndefined()
  })

  it('两段式清空：首次布防（可超时自动解除）、再次点击才 emit clear', async () => {
    const wrapper = mount(HistoryPanel, { props: { entries: ENTRIES } })
    const clear = wrapper.findAll('button').find((button) => button.text().includes('清空'))

    await clear?.trigger('click')
    expect(wrapper.text()).toContain('确认清空')
    expect(wrapper.emitted('clear')).toBeUndefined()

    // 布防期间直接清空按钮应不可触发第二段？——可以：立即再点即确认
    await clear?.trigger('click')
    expect(wrapper.emitted('clear')).toHaveLength(1)
  })

  it('布防 3s 无操作：自动解除（回到未布防态，再点需两段）', async () => {
    const wrapper = mount(HistoryPanel, { props: { entries: ENTRIES } })
    const clear = wrapper.findAll('button').find((button) => button.text().includes('清空'))

    await clear?.trigger('click')
    expect(wrapper.text()).toContain('确认清空')
    await vi.advanceTimersByTimeAsync(3000)
    expect(wrapper.text()).not.toContain('确认清空')
    expect(wrapper.emitted('clear')).toBeUndefined()
  })
})
