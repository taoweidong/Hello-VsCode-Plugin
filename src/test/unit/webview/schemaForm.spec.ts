import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import type { ComponentPublicInstance } from 'vue'
import SchemaForm from '../../../webview/components/SchemaForm.vue'
import { parseTags, joinTags } from '../../../webview/components/tagsInput'
import type { FormField } from '../../../webview/formSchema'
import { inputValue } from './appTestUtils'

/** SchemaForm（M4-T4.1）：渲染 / 回填 / 校验 / tags / 键盘 / IME / 错误定位。 */

const SCHEMA: FormField[] = [
  { key: 'name', label: '名称', type: 'text', required: true, placeholder: '请输入名称' },
  { key: 'category', label: '分类', type: 'text' },
  {
    key: 'priority',
    label: '优先级',
    type: 'select',
    defaultValue: 'medium',
    options: [
      { value: 'low', label: '低' },
      { value: 'medium', label: '中' },
      { value: 'high', label: '高' },
    ],
  },
  { key: 'tags', label: '标签', type: 'tags', placeholder: '前端, 待办' },
  { key: 'enabled', label: '启用', type: 'boolean' },
  { key: 'note', label: '备注', type: 'textarea' },
]

type SchemaFormInstance = ComponentPublicInstance & {
  validate: () => boolean
  focusFirst: () => void
}

function mountForm(props: Partial<InstanceType<typeof SchemaForm>['$props']> = {}) {
  return mount(SchemaForm, {
    props: {
      schema: SCHEMA,
      modelValue: {
        name: '',
        category: '',
        priority: 'medium',
        tags: [],
        enabled: false,
        note: '',
      },
      ...props,
    },
  })
}

describe('SchemaForm：渲染与类型分发', () => {
  it('按 type 分发字段控件：text/select/tags/boolean/textarea 各就各位', () => {
    const wrapper = mountForm()
    // name + category + tags（tags 也用单行输入，实时解析）
    expect(wrapper.findAll('input[type="text"]').length).toBe(3)
    expect(wrapper.findAll('select').length).toBe(1)
    expect(wrapper.findAll('textarea').length).toBe(1)
    expect(wrapper.findAll('input[type="checkbox"]').length).toBe(1)
  })

  it('每个字段都包在 VFormField 内（label + htmlFor → 控件 id）', () => {
    const wrapper = mountForm()
    const labels = wrapper.findAll('label')
    const nameLabel = labels.find((label) => label.text().includes('名称'))
    expect(nameLabel).toBeDefined()
    const forId = nameLabel!.attributes('for')
    expect(forId).toBeTruthy()
    const control = wrapper.find(`#${forId}`)
    expect(control.exists()).toBe(true)
  })

  it('select 渲染 schema 的 options；必填字段带星号与（必填）隐藏文本', () => {
    const wrapper = mountForm()
    const options = wrapper.findAll('option')
    expect(options.map((option) => option.text())).toEqual(['低', '中', '高'])
    expect(wrapper.text()).toContain('*')
    expect(wrapper.text()).toContain('（必填）')
  })

  it('未知 type 回退 text 输入（schema 前向兼容）', () => {
    const wrapper = mountForm({
      schema: [{ key: 'future', label: '未来字段', type: 'future-type' }],
      modelValue: { future: '' },
    })
    expect(wrapper.find('input[type="text"]').exists()).toBe(true)
  })

  it('P2-B4：password 类型复用 text 输入但以掩码渲染（input[type=password]）', () => {
    const wrapper = mountForm({
      schema: [{ key: 'password', label: '登录密码', type: 'password', placeholder: '选填' }],
      modelValue: { password: '' },
    })
    const masked = wrapper.find('input[type="password"]')
    expect(masked.exists()).toBe(true)
    expect(masked.attributes('placeholder')).toBe('选填')
    // 文本输入框数量不受影响（password 不再计入 type=text）
    expect(wrapper.findAll('input[type="text"]').length).toBe(0)
  })

  it('输入触发 update:modelValue（浅拷贝 + 字段更新）', async () => {
    const wrapper = mountForm()
    await wrapper.findAll('input[type="text"]')[0].setValue('新名称')
    expect(wrapper.emitted('update:modelValue')).toBeTruthy()
    const events = wrapper.emitted('update:modelValue')!
    expect(events.at(-1)![0]).toMatchObject({ name: '新名称', priority: 'medium' })
  })

  it('tags 字段解析分隔符 , ，; ；、 并去重去空', async () => {
    const wrapper = mountForm()
    const tagsInput = wrapper.findAll('input[type="text"]')[2]
    await tagsInput.setValue('前端, 待办，后端;测试、待办 ')
    const events = wrapper.emitted('update:modelValue')!
    expect(events.at(-1)![0]).toMatchObject({ tags: ['前端', '待办', '后端', '测试'] })
  })

  it('tags 值外部变化时回显为逗号文本（编辑回填 / 草稿恢复）', async () => {
    const wrapper = mountForm()
    await wrapper.setProps({
      modelValue: { name: '', priority: 'medium', tags: ['a', 'b'], enabled: false },
    })
    const tagsInput = wrapper.findAll('input[type="text"]')[2]
    expect(inputValue(tagsInput.element)).toBe('a, b')
  })

  it('R-U-1 tags 尾随分隔符不被回显吞掉（逐字符输入逗号）', async () => {
    const wrapper = mountForm()
    const tagsInput = wrapper.findAll('input[type="text"]')[2]
    await tagsInput.setValue('前端,')
    // 模拟父级 v-model 回传（新引用对象）→ 触发 TagsField 的回显 watch：
    // 旧实现按文本相等覆盖，用户刚输入的逗号会被吞掉，最终合成一个词
    const emitted = wrapper.emitted('update:modelValue')!
    await wrapper.setProps({ modelValue: emitted.at(-1)![0] })
    expect(inputValue(tagsInput.element)).toBe('前端,')
  })

  it('boolean 字段切换触发 update:modelValue（true/false）', async () => {
    const wrapper = mountForm()
    await wrapper.find('input[type="checkbox"]').setValue(true)
    const events = wrapper.emitted('update:modelValue')!
    expect(events.at(-1)![0]).toMatchObject({ enabled: true })
  })
})

describe('SchemaForm：required 校验（含数组空值）', () => {
  it('必填字符串为空：拦截 submit，不 emit；错误显示在对应字段', async () => {
    const wrapper = mountForm()
    await wrapper.find('form').trigger('keydown', { key: 'Enter', ctrlKey: true })
    expect(wrapper.emitted('submit')).toBeUndefined()
    const error = wrapper.find('.v-form-field__error')
    expect(error.text()).toContain('名称')
    expect(error.attributes('role')).toBe('alert')
  })

  it('必填数组为空同样拦截（tags required 空数组）', async () => {
    const wrapper = mountForm({
      schema: [{ key: 'tags', label: '标签', type: 'tags', required: true }],
      modelValue: { tags: [] },
    })
    await wrapper.find('form').trigger('keydown', { key: 'Enter', ctrlKey: true })
    expect(wrapper.emitted('submit')).toBeUndefined()
    expect(wrapper.find('.v-form-field__error').text()).toContain('标签')
  })

  it('全部必填通过后放行 submit（expose 的 validate 同步语义）', async () => {
    const wrapper = mountForm()
    await wrapper.setProps({
      modelValue: { name: '任务A', priority: 'medium', tags: [], enabled: false },
    })
    await wrapper.find('form').trigger('keydown', { key: 'Enter', ctrlKey: true })
    expect(wrapper.emitted('submit')).toHaveLength(1)
    expect((wrapper.vm as unknown as SchemaFormInstance).validate()).toBe(true)
  })

  it('用户继续输入后本地错误清除', async () => {
    const wrapper = mountForm()
    await wrapper.find('form').trigger('keydown', { key: 'Enter', ctrlKey: true })
    expect(wrapper.find('.v-form-field__error').exists()).toBe(true)
    await wrapper.findAll('input[type="text"]')[0].setValue('补上了')
    expect(wrapper.find('.v-form-field__error').exists()).toBe(false)
  })

  it('disabled 时 Ctrl+Enter 不提交', async () => {
    const wrapper = mountForm({ disabled: true })
    await wrapper.setProps({ modelValue: { name: '任务A' } })
    await wrapper.find('form').trigger('keydown', { key: 'Enter', ctrlKey: true })
    expect(wrapper.emitted('submit')).toBeUndefined()
  })
})

describe('SchemaForm：错误定位（errors prop）', () => {
  it('宿主错误按 key 定位：控件 invalid 态 + aria-invalid + role=alert', async () => {
    const wrapper = mountForm({
      errors: { name: '已存在同名条目' },
      modelValue: { name: '任务A' },
    })
    const inputs = wrapper.findAll('input[type="text"]')
    expect(inputs[0].attributes('aria-invalid')).toBe('true')
    expect(inputs[0].classes()).toContain('v-input--invalid')
    const error = wrapper.find('.v-form-field__error')
    expect(error.text()).toContain('已存在同名条目')
    expect(error.attributes('role')).toBe('alert')
  })

  it('宿主错误优先于本地校验错误（同 key）', async () => {
    const wrapper = mountForm({ errors: { name: '服务端拒绝' } })
    await wrapper.find('form').trigger('keydown', { key: 'Enter', ctrlKey: true })
    expect(wrapper.find('.v-form-field__error').text()).toContain('服务端拒绝')
  })
})

describe('SchemaForm：键盘与 IME', () => {
  it('Esc 触发 cancel', async () => {
    const wrapper = mountForm()
    await wrapper.find('form').trigger('keydown', { key: 'Escape' })
    expect(wrapper.emitted('cancel')).toHaveLength(1)
  })

  it('Ctrl+Enter 触发 submit（Mac 的 metaKey 同样生效）', async () => {
    const wrapper = mountForm()
    await wrapper.setProps({ modelValue: { name: '任务A' } })
    await wrapper.find('form').trigger('keydown', { key: 'Enter', metaKey: true })
    expect(wrapper.emitted('submit')).toHaveLength(1)
  })

  it('IME 组合中（isComposing）忽略 Esc / Ctrl+Enter（修复 W3）', async () => {
    const wrapper = mountForm()
    await wrapper.setProps({ modelValue: { name: '任务A' } })
    await wrapper.find('form').trigger('keydown', { key: 'Escape', isComposing: true })
    await wrapper
      .find('form')
      .trigger('keydown', { key: 'Enter', ctrlKey: true, isComposing: true })
    expect(wrapper.emitted('cancel')).toBeUndefined()
    expect(wrapper.emitted('submit')).toBeUndefined()
  })
})

describe('tagsInput 工具', () => {
  it('parseTags：五种分隔符 + trim + 去空 + 去重保序', () => {
    expect(parseTags('a,b，c;d；e、f , b')).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
    expect(parseTags('  , , ')).toEqual([])
  })

  it('joinTags：数组 → 逗号文本；非数组原样 / 其他类型空串', () => {
    expect(joinTags(['a', 'b'])).toBe('a, b')
    expect(joinTags('直接文本')).toBe('直接文本')
    expect(joinTags(42)).toBe('')
  })
})
