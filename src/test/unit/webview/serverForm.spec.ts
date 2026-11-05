import { describe, expect, it } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { reactive } from 'vue'
import ServerForm from '../../../webview/apps/serialConsole/components/ServerForm.vue'
import type { FormField } from '../../../webview/formSchema'

/**
 * ServerForm 组件级用例（第五轮补盲区：此前仅经 App 间接触达）：
 * 必填本地校验 / 保存 / Ctrl+Enter 提交 / 重置两段式布防态 / 检测串口 chips。
 *
 * 无父组件回写 v-model：挂 reactive model 直接传 prop 引用（SchemaForm 校验读
 * props.modelValue），用例直改 model 字段模拟父级 v-model 行为。
 */

const SCHEMA: FormField[] = [
  { key: 'name', label: '服务器名称', type: 'text', required: true, placeholder: '如：服务器甲' },
  { key: 'serialPath', label: '串口路径', type: 'text', required: true, placeholder: '如 COM3' },
]

function mountForm(overrides: Record<string, unknown> = {}): {
  w: VueWrapper
  model: Record<string, unknown>
} {
  const model = reactive<Record<string, unknown>>({ name: '', serialPath: '' })
  const w = mount(ServerForm, {
    props: {
      schema: SCHEMA,
      modelValue: model,
      errors: {},
      ports: [],
      editing: false,
      saving: false,
      resetArmed: false,
      ...overrides,
    },
  })
  return { w, model }
}

describe('ServerForm：保存与校验', () => {
  it('空必填点保存：本地校验拦截，不 emit submit，显示字段错误', async () => {
    const { w } = mountForm()
    await w
      .findAll('button')
      .find((b) => b.text().includes('保存服务器'))
      ?.trigger('click')
    expect(w.emitted('submit')).toBeUndefined()
    expect(w.text()).toContain('请填写「服务器名称」')
  })

  it('填写必填后保存：emit submit', async () => {
    const { w, model } = mountForm()
    model.name = '服务器乙'
    model.serialPath = 'COM7'
    await w.vm.$nextTick()
    await w
      .findAll('button')
      .find((b) => b.text().includes('保存服务器'))
      ?.trigger('click')
    expect(w.emitted('submit')).toHaveLength(1)
  })

  it('Ctrl+Enter 提交：经 SchemaForm 内部校验后 emit submit', async () => {
    const { w, model } = mountForm()
    model.name = '服务器乙'
    model.serialPath = 'COM7'
    await w.vm.$nextTick()
    await w.find('form').trigger('keydown', { key: 'Enter', ctrlKey: true })
    expect(w.emitted('submit')).toHaveLength(1)
  })

  it('Esc 触发 reset 事件（重置确认逻辑由页面层两段式布防处理）', async () => {
    const w = mountForm().w
    await w.find('form').trigger('keydown', { key: 'Escape' })
    expect(w.emitted('reset')).toHaveLength(1)
  })
})

describe('ServerForm：重置布防态', () => {
  it('resetArmed=false：普通重置按钮；true：进入确认态（文案 / 标题 / 样式）', async () => {
    const w = mountForm().w
    const normal = w.findAll('button').find((b) => b.text().includes('重置'))
    expect(normal?.text()).toBe('重置')
    expect(normal?.attributes('title')).toBe('恢复默认值')

    const armed = mountForm({ resetArmed: true }).w
    const armedButton = armed.findAll('button').find((b) => b.text().includes('重置'))
    expect(armedButton?.text()).toBe('确认重置')
    expect(armedButton?.attributes('title')).toBe('再次点击确认重置')
    expect(armedButton?.classes()).toContain('server-form__reset--armed')

    await armedButton?.trigger('click')
    expect(armed.emitted('reset')).toHaveLength(1)
  })
})

describe('ServerForm：检测串口', () => {
  it('点击检测 emit detect；chips 点击 emit update:modelValue 回填 serialPath', async () => {
    const { w, model } = mountForm({
      ports: [{ path: 'COM9' }, { path: 'COM10', manufacturer: 'USB-SERIAL' }],
    })
    await w
      .findAll('button')
      .find((b) => b.text().includes('检测串口'))
      ?.trigger('click')
    expect(w.emitted('detect')).toHaveLength(1)

    const chip = w.findAll('.server-form__chip')[0]
    expect(chip.text()).toBe('COM9')
    await chip.trigger('click')
    // 组件测试无父级回写：以 emit 载荷断言回填语义（payload = {...model, serialPath: 'COM9'}）
    const update = w.emitted('update:modelValue')?.[0]?.[0] as Record<string, unknown>
    expect(update.serialPath).toBe('COM9')
    expect(model.name).toBe('')
  })
})
