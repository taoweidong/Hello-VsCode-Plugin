import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import SelectField from '../../../webview/components/fields/SelectField.vue'
import type { FormField } from '../../../webview/formSchema'

/** select 字段：VSelect 封装——字符串透传 / 非字符串归空 / 选项与禁用接线。 */

const field: FormField = {
  key: 'buildType',
  label: '构建类型',
  type: 'select',
  options: [
    { value: 'full', label: '完整构建' },
    { value: 'inc', label: '增量构建' },
  ],
}

describe('SelectField', () => {
  it('字符串值透传给 VSelect 并渲染全部选项', () => {
    const wrapper = mount(SelectField, { props: { field, modelValue: 'inc' } })
    const options = wrapper.findAll('option')
    expect(options.map((option) => option.element.value)).toEqual(['full', 'inc'])
    expect((wrapper.find('select').element as unknown as { value: string }).value).toBe('inc')
  })

  it('非字符串值归空（守卫 asText）', () => {
    const wrapper = mount(SelectField, { props: { field, modelValue: 42 } })
    expect((wrapper.find('select').element as unknown as { value: string }).value).toBe('')
  })

  it('选择 → 透传 update:modelValue；disabled 禁用', async () => {
    const wrapper = mount(SelectField, { props: { field, modelValue: 'full' } })
    await wrapper.find('select').setValue('inc')
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual(['inc'])

    const disabled = mount(SelectField, { props: { field, modelValue: 'full', disabled: true } })
    expect(disabled.find('select').attributes('disabled')).toBeDefined()
  })
})
