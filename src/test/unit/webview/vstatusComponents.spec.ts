import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import VBadge from '../../../webview/ui/VBadge.vue'
import VEmptyState from '../../../webview/ui/VEmptyState.vue'
import VLoading from '../../../webview/ui/VLoading.vue'

/** VEmptyState / VLoading / VBadge（04 §4.7 / §4.8）。 */
describe('VEmptyState', () => {
  it('标题 + muted 说明 + 图标', () => {
    const wrapper = mount(VEmptyState, {
      props: { title: '暂无条目', description: '从创建第一个条目开始', icon: 'info' },
    })
    expect(wrapper.find('.v-empty-state__title').text()).toBe('暂无条目')
    expect(wrapper.find('.v-empty-state__description').text()).toBe('从创建第一个条目开始')
    expect(wrapper.find('.codicon-info').exists()).toBe(true)
  })

  it('action 插槽渲染行动按钮', () => {
    const wrapper = mount(VEmptyState, {
      props: { title: '没有匹配项' },
      slots: { action: '<button type="button">清除过滤</button>' },
    })
    const button = wrapper.find('.v-empty-state__action button')
    expect(button.exists()).toBe(true)
    expect(button.text()).toBe('清除过滤')
  })
})

describe('VLoading', () => {
  it('role=status + 旋转图标（codicon sync）+ 文字', () => {
    const wrapper = mount(VLoading, { props: { label: '正在加载条目列表…' } })
    expect(wrapper.attributes('role')).toBe('status')
    expect(wrapper.attributes('aria-label')).toBe('正在加载条目列表…')
    expect(wrapper.find('.codicon-sync').exists()).toBe(true)
    expect(wrapper.find('.v-loading__label').text()).toBe('正在加载条目列表…')
  })

  it('缺省文案为「加载中…」', () => {
    const wrapper = mount(VLoading, {})
    expect(wrapper.find('.v-loading__label').text()).toBe('加载中…')
  })
})

describe('VBadge', () => {
  it('渲染数字与文本内容', () => {
    expect(mount(VBadge, { props: { label: 3 } }).text()).toBe('3')
    expect(mount(VBadge, { props: { label: '新' } }).text()).toBe('新')
  })

  it('默认插槽覆盖 label', () => {
    const wrapper = mount(VBadge, { props: { label: 1 }, slots: { default: '99+' } })
    expect(wrapper.text()).toBe('99+')
  })
})
