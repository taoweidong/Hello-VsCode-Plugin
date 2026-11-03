import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import ConsoleOutput from '../../../webview/apps/serialConsole/components/ConsoleOutput.vue'

/**
 * 控制台输出区（此前零覆盖）：块渲染与 echo 弱化 / 清空按钮 / 自动跟随滚动 /
 * 向上滚动暂停 / 恢复跟随。jsdom 无布局，滚动几何用属性 mock 驱动。
 */

/** 与 ConsoleOutput 的 OutputBlock 同形（SFC 导出类型对 tsc 不可见，本地声明）。 */
interface OutputBlock {
  seq: number
  text: string
  kind?: 'echo'
}

type ScrollLike = { scrollTop: number; scrollHeight: number; clientHeight: number }

function makeBlocks(count: number): OutputBlock[] {
  return Array.from({ length: count }, (_, index) => ({
    seq: index + 1,
    text: `block-${index + 1}\n`,
    ...(index === 0 ? { kind: 'echo' as const } : {}),
  }))
}

function mockScrollGeometry(el: unknown, scrollHeight: number, clientHeight: number): void {
  let scrollTopValue = 0
  Object.defineProperty(el, 'scrollHeight', { value: scrollHeight, configurable: true })
  Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true })
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => scrollTopValue,
    set: (value: number) => {
      scrollTopValue = value
    },
  })
}

describe('ConsoleOutput', () => {
  beforeEach(() => {
    vi.stubGlobal('scrollTo', () => undefined)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('空列表：空态展示；清空按钮禁用', () => {
    const wrapper = mount(ConsoleOutput, { props: { blocks: [] } })
    expect(wrapper.text()).toContain('暂无输出')
    const clear = wrapper.findAll('button').find((button) => button.text().includes('清空'))
    expect(clear?.attributes('disabled')).toBeDefined()
  })

  it('块渲染：按 seq 为 key 输出文本；echo 块带弱化类', () => {
    const wrapper = mount(ConsoleOutput, { props: { blocks: makeBlocks(3) } })
    const blocks = wrapper.findAll('pre')
    expect(blocks).toHaveLength(3)
    expect(blocks[0].classes()).toContain('console-output__block--echo')
    expect(blocks[1].classes()).not.toContain('console-output__block--echo')
    // text() 会 trim 尾部换行；原始文本经 textContent 校验
    expect(blocks[2].text()).toBe('block-3')
    expect(blocks[2].element.textContent).toBe('block-3\n')
  })

  it('清空按钮：点击 emit clear', async () => {
    const wrapper = mount(ConsoleOutput, { props: { blocks: makeBlocks(1) } })
    const clear = wrapper.findAll('button').find((button) => button.text().includes('清空'))
    await clear?.trigger('click')
    expect(wrapper.emitted('clear')).toHaveLength(1)
  })

  it('新块到达且未暂停：滚动容器 scrollTop 跟随到底（自动跟随）', async () => {
    const wrapper = mount(ConsoleOutput, { props: { blocks: [] } })
    const el = wrapper.find('[role="log"]').element as unknown as ScrollLike
    mockScrollGeometry(el, 1000, 100)
    await wrapper.setProps({ blocks: makeBlocks(1) })
    await wrapper.vm.$nextTick()
    expect(el.scrollTop).toBe(1000)
  })

  it('向上滚动离底：进入暂停态（按钮文案切换）；新块不再强制滚动', async () => {
    const wrapper = mount(ConsoleOutput, { props: { blocks: makeBlocks(2) } })
    const el = wrapper.find('[role="log"]').element as unknown as ScrollLike
    mockScrollGeometry(el, 1000, 100)
    // 用户向上滚：scrollTop 远离底部 → onScroll 判定暂停
    el.scrollTop = 0
    await wrapper.find('[role="log"]').trigger('scroll')
    expect(wrapper.text()).toContain('已暂停，滚动到底')

    await wrapper.setProps({ blocks: makeBlocks(3) })
    await wrapper.vm.$nextTick()
    expect(el.scrollTop).toBe(0) // 暂停中不强制跟随
  })

  it('点击「滚动到底」：恢复跟随并滚到底部', async () => {
    const wrapper = mount(ConsoleOutput, { props: { blocks: makeBlocks(2) } })
    const el = wrapper.find('[role="log"]').element as unknown as ScrollLike
    mockScrollGeometry(el, 1000, 100)
    el.scrollTop = 0
    await wrapper.find('[role="log"]').trigger('scroll')
    const follow = wrapper.findAll('button').find((button) => button.text().includes('滚动到底'))
    await follow?.trigger('click')
    expect(el.scrollTop).toBe(1000)
    expect(wrapper.text()).toContain('跟随输出')
  })

  it('靠近底部（<40px）的轻微滚动不触发暂停', async () => {
    const wrapper = mount(ConsoleOutput, { props: { blocks: makeBlocks(2) } })
    const el = wrapper.find('[role="log"]').element as unknown as ScrollLike
    mockScrollGeometry(el, 1000, 100)
    Object.defineProperty(el, 'scrollTop', { value: 980, configurable: true }) // 差 20px
    await wrapper.find('[role="log"]').trigger('scroll')
    expect(wrapper.text()).not.toContain('已暂停')
  })
})
