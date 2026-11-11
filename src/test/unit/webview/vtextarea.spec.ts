import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref } from 'vue'
import VTextarea from '../../../webview/ui/VTextarea.vue'
import { VFORM_FIELD_KEY } from '../../../webview/ui/formFieldContext'

/** VTextarea（04 §4.2）：v-model / 禁用 / invalid 语义 / 表单上下文可访问性接线。 */

describe('VTextarea', () => {
  it('渲染 modelValue；输入触发 update:modelValue', async () => {
    const wrapper = mount(VTextarea, { props: { modelValue: '初始' } })
    const area = wrapper.find('textarea')
    expect((area.element as unknown as { value: string }).value).toBe('初始')
    await area.setValue('改后')
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual(['改后'])
  })

  it('placeholder / maxlength / disabled 透传', () => {
    const wrapper = mount(VTextarea, {
      props: { placeholder: '备注', maxlength: 100, disabled: true },
    })
    const area = wrapper.find('textarea')
    expect(area.attributes('placeholder')).toBe('备注')
    expect(area.attributes('maxlength')).toBe('100')
    expect(area.attributes('disabled')).toBeDefined()
  })

  it('invalid → invalid class + aria-invalid；未 invalid 时均不出现', () => {
    const invalid = mount(VTextarea, { props: { invalid: true } })
    expect(invalid.find('textarea').classes()).toContain('v-textarea--invalid')
    expect(invalid.find('textarea').attributes('aria-invalid')).toBe('true')
    const normal = mount(VTextarea, { props: {} })
    expect(normal.find('textarea').classes()).not.toContain('v-textarea--invalid')
    expect(normal.find('textarea').attributes('aria-invalid')).toBeUndefined()
  })

  it('注入 VFORM_FIELD_KEY：controlId / describedBy 接线；field.invalid 叠加', () => {
    const wrapper = mount(VTextarea, {
      props: {},
      global: {
        provide: {
          [VFORM_FIELD_KEY as symbol]: {
            controlId: ref('field-ctrl'),
            invalid: ref(true),
            describedBy: ref('field-hint'),
          },
        },
      },
    })
    const area = wrapper.find('textarea')
    expect(area.attributes('id')).toBe('field-ctrl')
    expect(area.attributes('aria-describedby')).toBe('field-hint')
    expect(area.classes()).toContain('v-textarea--invalid')
  })
})
