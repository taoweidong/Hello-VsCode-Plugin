import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { mount } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import {
  useTwoStepConfirm,
  type TwoStepConfirm,
} from '../../../webview/composables/useTwoStepConfirm'

/**
 * 两段式布防确认 composable：首点布防 / 再点确认 / 超时自动解除 /
 * 布防互斥 / 手动解除 / 卸载清理。是 ServerList / HistoryPanel / taskManager
 * 删除确认的共同实现（替代浏览器模态 confirm——webview 沙箱下恒返回 false）。
 */

let captured: TwoStepConfirm | undefined
let wrapper: VueWrapper | undefined

beforeEach(() => {
  captured = undefined
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  vi.useRealTimers()
})

/** 挂载使用该 composable 的宿主组件，捕获返回值供断言。 */
function mountHost(timeoutMs?: number): TwoStepConfirm {
  const Host = defineComponent({
    setup() {
      captured = timeoutMs === undefined ? useTwoStepConfirm() : useTwoStepConfirm(timeoutMs)
      return () => h('div')
    },
  })
  wrapper = mount(Host)
  return captured!
}

describe('useTwoStepConfirm：布防与确认', () => {
  it('首点布防（返回 false），同 key 再点确认（返回 true 并解除）', () => {
    const api = mountHost()
    expect(api.confirm('a')).toBe(false)
    expect(api.isArmed('a')).toBe(true)
    expect(api.confirm('a')).toBe(true)
    expect(api.isArmed('a')).toBe(false)
  })

  it('布防互斥：确认 B 后 A 不再处于布防态（对齐原列表实现）', () => {
    const api = mountHost()
    expect(api.confirm('a')).toBe(false)
    expect(api.confirm('b')).toBe(false)
    expect(api.isArmed('a')).toBe(false)
    expect(api.isArmed('b')).toBe(true)
    expect(api.confirm('b')).toBe(true)
  })

  it('手动 disarm 解除指定 key；未布防的 key 解除无副作用', () => {
    const api = mountHost()
    api.confirm('a')
    api.disarm('b')
    expect(api.isArmed('a')).toBe(true)
    api.disarm('a')
    expect(api.isArmed('a')).toBe(false)
  })

  it('无参 disarm 解除任意布防', () => {
    const api = mountHost()
    api.confirm('a')
    api.disarm()
    expect(api.isArmed('a')).toBe(false)
    expect(api.confirm('a')).toBe(false)
  })
})

describe('useTwoStepConfirm：超时自动解除', () => {
  it('默认 3s 超时后解除，需重新布防', () => {
    vi.useFakeTimers()
    const api = mountHost()
    api.confirm('a')
    vi.advanceTimersByTime(2_999)
    expect(api.isArmed('a')).toBe(true)
    vi.advanceTimersByTime(1)
    expect(api.isArmed('a')).toBe(false)
    // 解除后首点重新布防而不是误触发
    expect(api.confirm('a')).toBe(false)
    expect(api.confirm('a')).toBe(true)
  })

  it('确认后不再残留定时器（提前 disarm 不受超时影响）', () => {
    vi.useFakeTimers()
    const api = mountHost()
    api.confirm('a')
    expect(api.confirm('a')).toBe(true)
    vi.advanceTimersByTime(10_000)
    expect(api.isArmed('a')).toBe(false)
  })

  it('自定义 timeoutMs 生效', () => {
    vi.useFakeTimers()
    const api = mountHost(500)
    api.confirm('a')
    vi.advanceTimersByTime(499)
    expect(api.isArmed('a')).toBe(true)
    vi.advanceTimersByTime(1)
    expect(api.isArmed('a')).toBe(false)
  })
})

describe('useTwoStepConfirm：卸载清理', () => {
  it('组件卸载后布防态清空', () => {
    const api = mountHost()
    api.confirm('a')
    expect(api.isArmed('a')).toBe(true)
    wrapper?.unmount()
    wrapper = undefined
    expect(api.isArmed('a')).toBe(false)
  })
})
