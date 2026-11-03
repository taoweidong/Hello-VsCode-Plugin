import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import VInput from '../../../webview/ui/VInput.vue'
import VTextarea from '../../../webview/ui/VTextarea.vue'

/** VInput / VTextarea（04 §4.2）：v-model、invalid、placeholder、disabled、maxlength。 */
describe('VInput', () => {
  it('modelValue 渲染为元素值', () => {
    const wrapper = mount(VInput, { props: { modelValue: '任务A' } })
    expect((wrapper.element as { value?: string }).value).toBe('任务A')
  })

  it('输入触发 update:modelValue（v-model 双向）', async () => {
    const wrapper = mount(VInput, { props: { modelValue: '' } })
    await wrapper.setValue('新值')
    expect(wrapper.emitted('update:modelValue')).toEqual([['新值']])
  })

  it('invalid：类名 + aria-invalid', () => {
    const wrapper = mount(VInput, { props: { modelValue: '', invalid: true } })
    expect(wrapper.classes()).toContain('v-input--invalid')
    expect(wrapper.attributes('aria-invalid')).toBe('true')
  })

  it('合法状态不输出 aria-invalid', () => {
    const wrapper = mount(VInput, { props: { modelValue: 'x' } })
    expect(wrapper.attributes('aria-invalid')).toBeUndefined()
  })

  it('placeholder / maxlength / disabled 透传', () => {
    const wrapper = mount(VInput, {
      props: { placeholder: '请输入名称', maxlength: 20, disabled: true },
    })
    expect(wrapper.attributes('placeholder')).toBe('请输入名称')
    expect(wrapper.attributes('maxlength')).toBe('20')
    expect(wrapper.attributes('disabled')).toBeDefined()
  })

  it('type=password：掩码渲染（P2-B4）；缺省保持 text', () => {
    expect(mount(VInput, { props: {} }).attributes('type')).toBe('text')
    const masked = mount(VInput, { props: { type: 'password' } })
    expect(masked.attributes('type')).toBe('password')
  })
})

describe('VTextarea', () => {
  it('modelValue 渲染 + 输入触发 update:modelValue', async () => {
    const wrapper = mount(VTextarea, { props: { modelValue: '第一行' } })
    expect((wrapper.element as { value?: string }).value).toBe('第一行')
    await wrapper.setValue('第二行')
    expect(wrapper.emitted('update:modelValue')).toEqual([['第二行']])
  })

  it('invalid 类名与 aria-invalid', () => {
    const wrapper = mount(VTextarea, { props: { modelValue: '', invalid: true } })
    expect(wrapper.classes()).toContain('v-textarea--invalid')
    expect(wrapper.attributes('aria-invalid')).toBe('true')
  })

  it('placeholder 与 disabled', () => {
    const wrapper = mount(VTextarea, { props: { placeholder: '补充说明（可选）', disabled: true } })
    expect(wrapper.attributes('placeholder')).toBe('补充说明（可选）')
    expect(wrapper.attributes('disabled')).toBeDefined()
  })
})
