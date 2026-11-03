import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import CommandInput from '../../../webview/apps/serialConsole/components/CommandInput.vue'
import { inputValue } from './appTestUtils'

/**
 * 命令输入行：Enter 发送 / ↑↓ 历史遍历 / 草稿恢复（P2-F1 回归锁定）。
 * 历史命令为 MRU 序（最新在前），与宿主 commandHistory 推送一致。
 */

const HISTORY = ['ls', 'dir', 'show version']

function mountInput(modelValue = '') {
  return mount(CommandInput, {
    props: { modelValue, connected: true, historyCommands: HISTORY },
  })
}

const inputValueOf = (wrapper: ReturnType<typeof mountInput>) =>
  inputValue(wrapper.find('input').element)

async function pressKey(wrapper: ReturnType<typeof mountInput>, key: string): Promise<void> {
  await wrapper.find('input').trigger('keydown', { key })
  await syncModelValue(wrapper)
}

/** 模拟父组件 v-model 回写：把最近一次 update:modelValue 写回 props。 */
async function syncModelValue(wrapper: ReturnType<typeof mountInput>): Promise<void> {
  const events = wrapper.emitted('update:modelValue')
  const latest = events?.at(-1)?.[0]
  if (typeof latest === 'string') {
    await wrapper.setProps({ modelValue: latest })
  }
}

describe('CommandInput 历史遍历', () => {
  it('Enter 发送：emit send + 清空输入；空命令不发送', async () => {
    const wrapper = mountInput('ls')
    await pressKey(wrapper, 'Enter')
    expect(wrapper.emitted('send')).toEqual([['ls']])
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([''])

    const empty = mountInput('   ')
    await pressKey(empty, 'Enter')
    expect(empty.emitted('send')).toBeUndefined()
  })

  it('↑ 进入历史遍历显示最近一条；连续 ↑ 逐条回溯', async () => {
    const wrapper = mountInput()
    await pressKey(wrapper, 'ArrowUp')
    expect(inputValueOf(wrapper)).toBe('ls')
    await pressKey(wrapper, 'ArrowUp')
    expect(inputValueOf(wrapper)).toBe('dir')
    await pressKey(wrapper, 'ArrowUp')
    expect(inputValueOf(wrapper)).toBe('show version')
    // 顶部不再回溯
    await pressKey(wrapper, 'ArrowUp')
    expect(inputValueOf(wrapper)).toBe('show version')
  })

  it('P2-F1：未进入历史遍历时 ↓ 不清空已输入内容', async () => {
    const wrapper = mountInput('show run')
    await pressKey(wrapper, 'ArrowDown')
    expect(inputValueOf(wrapper)).toBe('show run')
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
  })

  it('P2-F1：历史遍历到底后 ↓ 恢复进入遍历前的草稿（而非清空）', async () => {
    const wrapper = mountInput('show run')
    await pressKey(wrapper, 'ArrowUp') // → ls
    await pressKey(wrapper, 'ArrowDown') // → 回到草稿
    expect(inputValueOf(wrapper)).toBe('show run')
    // 继续按 ↓：已无历史可回，保持草稿
    await pressKey(wrapper, 'ArrowDown')
    expect(inputValueOf(wrapper)).toBe('show run')
  })

  it('发送后草稿清空：再次 ↓ 回到 -1 不恢复旧草稿', async () => {
    const wrapper = mountInput('show run')
    await pressKey(wrapper, 'ArrowUp') // → ls（草稿 = show run）
    await wrapper.find('input').trigger('keydown', { key: 'Enter' }) // 发送 ls
    expect(wrapper.emitted('send')).toEqual([['ls']])
    // 发送后输入已清空且草稿重置；↓（未遍历）不再动
    await pressKey(wrapper, 'ArrowDown')
    expect(inputValueOf(wrapper)).toBe('')
  })

  it('遍历中用户重新输入：退出遍历并以此为新草稿', async () => {
    const wrapper = mountInput()
    await pressKey(wrapper, 'ArrowUp') // → ls
    await wrapper.find('input').setValue('reboot') // 用户编辑
    await syncModelValue(wrapper)
    expect(inputValueOf(wrapper)).toBe('reboot')
    // ↓ 不再在历史中回退（已退出遍历），输入保持
    await pressKey(wrapper, 'ArrowDown')
    expect(inputValueOf(wrapper)).toBe('reboot')
    // 再 ↑：以 reboot 为草稿重新进入遍历
    await pressKey(wrapper, 'ArrowUp')
    expect(inputValueOf(wrapper)).toBe('ls')
    await pressKey(wrapper, 'ArrowDown')
    expect(inputValueOf(wrapper)).toBe('reboot')
  })

  it('IME 组合中的按键不触发发送', async () => {
    const wrapper = mountInput('zhong')
    await wrapper.find('input').trigger('keydown', { key: 'Enter', isComposing: true })
    expect(wrapper.emitted('send')).toBeUndefined()
  })

  it('sending 为 true 时 Enter 不发送', async () => {
    const wrapper = mount(CommandInput, {
      props: { modelValue: 'ls', connected: true, sending: true, historyCommands: HISTORY },
    })
    await pressKey(wrapper, 'Enter')
    expect(wrapper.emitted('send')).toBeUndefined()
  })
})
