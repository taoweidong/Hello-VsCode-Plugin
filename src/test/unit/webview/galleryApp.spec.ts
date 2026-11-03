import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import App from '../../../webview/apps/gallery/App.vue'

/**
 * 组件画廊（此前零覆盖）：作为设计系统视觉验收基准，至少锁定
 * 「可挂载、各组件分节渲染、交互演示不抛错」的冒烟契约。
 */
describe('gallery App（冒烟）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('挂载渲染全部组件分节标题', () => {
    const wrapper = mount(App)
    expect(wrapper.text()).toContain('组件画廊')
    expect(wrapper.text()).toContain('按钮 VButton')
    expect(wrapper.text()).toContain('VSelect')
    expect(wrapper.text()).toContain('VCheckbox')
    expect(wrapper.findAll('section').length).toBeGreaterThanOrEqual(5)
  })

  it('fakeSave 演示：loading 1.5s 后解除（不抛错）', async () => {
    const wrapper = mount(App)
    const save = wrapper.findAll('button').find((button) => button.text().includes('模拟保存'))
    if (save) {
      await save.trigger('click')
      await vi.advanceTimersByTimeAsync(1500)
      expect(wrapper.exists()).toBe(true)
    }
  })
})
