import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import TextareaField from '../../../webview/components/fields/TextareaField.vue'
import type { FormField } from '../../../webview/formSchema'

/** textarea 字段：VTextarea 封装——字符串透传 / 非字符串归空 / placeholder / 禁用。 */

const field: FormField = {
  key: 'notes',
  label: '备注',
  type: 'textarea',
  placeholder: '选填',
}

describe('TextareaField', () => {
  it('字符串值透传 + placeholder 接线', () => {
    const wrapper = mount(TextareaField, { props: { field, modelValue: '备注内容' } })
    const area = wrapper.find('textarea')
    expect((area.element as unknown as { value: string }).value).toBe('备注内容')
    expect(area.attributes('placeholder')).toBe('选填')
  })

  it('非字符串值归空（守卫 asText）', () => {
    const wrapper = mount(TextareaField, { props: { field, modelValue: null } })
    expect((wrapper.find('textarea').element as unknown as { value: string }).value).toBe('')
  })

  it('输入 → 透传 update:modelValue；disabled 禁用', async () => {
    const wrapper = mount(TextareaField, { props: { field, modelValue: '' } })
    await wrapper.find('textarea').setValue('新备注')
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual(['新备注'])

    const disabled = mount(TextareaField, { props: { field, modelValue: '', disabled: true } })
    expect(disabled.find('textarea').attributes('disabled')).toBeDefined()
  })
})
