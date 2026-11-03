import { describe, expect, it } from 'vitest'
import { schemaDefaults, toFormField, toFormFields } from '../../../webview/components/fieldAdapter'
import type { FormField } from '../../../webview/formSchema'
import type { FieldDef } from '../../../webview/protocol'

/**
 * R-E-8：fieldAdapter 是「宿主下发的协议字段 → 页面 FormField」的唯一收窄层，
 * 此前零覆盖——宿主新增字段类型、下发脏 options 时旧页面是否安全全靠人肉推断。
 * 本 spec 用负例矩阵把它钉住。
 */

function def(overrides: Partial<FieldDef> = {}): FieldDef {
  return { key: 'k', label: '标签', type: 'text', ...overrides }
}

describe('toFormField：协议字段收窄', () => {
  it('只声明 key/label/type 时得到最小 FormField（其余属性为 undefined）', () => {
    expect(toFormField(def())).toEqual({ key: 'k', label: '标签', type: 'text' })
  })

  it.each([
    ['text', 'text'],
    ['textarea', 'textarea'],
    ['select', 'select'],
    ['tags', 'tags'],
    ['boolean', 'boolean'],
    ['password', 'password'],
  ])('已知 type「%s」原样保留', (given, expected) => {
    expect(toFormField(def({ type: given })).type).toBe(expected)
  })

  it.each([
    ['color', '新增的宿主类型'],
    ['', '空串'],
    [42, '非字符串'],
    [undefined, '缺失'],
  ])('未知 / 非法 type（%s：%s）回退 text，保证前向兼容', (given, _reason) => {
    expect(toFormField(def({ type: given as unknown as string })).type).toBe('text')
  })

  it('可选属性逐个按类型收窄：类型不符的一律丢弃（不把脏值透给控件）', () => {
    const field = toFormField(
      def({
        required: true,
        placeholder: '提示',
        hint: '说明',
        defaultValue: 'x',
      })
    )
    expect(field.required).toBe(true)
    expect(field.placeholder).toBe('提示')
    expect(field.hint).toBe('说明')
    expect(field.defaultValue).toBe('x')

    const dirty = toFormField(
      def({
        required: 'yes',
        placeholder: 1,
        hint: null,
        defaultValue: {},
      } as unknown as FieldDef)
    )
    expect(dirty.required).toBeUndefined()
    expect(dirty.placeholder).toBeUndefined()
    expect(dirty.hint).toBeUndefined()
    expect(dirty.defaultValue).toBeUndefined()
  })

  it('options：非对象 / 数组 / 缺 value·label 的项被过滤；过滤后为空则不置 options', () => {
    const field = toFormField(
      def({
        type: 'select',
        options: [
          { value: 'a', label: '甲' },
          { value: 'b' },
          { label: '丙' },
          null,
          [],
          'x',
        ] as unknown as FieldDef['options'],
      })
    )
    expect(field.options).toEqual([{ value: 'a', label: '甲' }])

    const empty = toFormField(
      def({ type: 'select', options: [{ value: 'b' }] as unknown as FieldDef['options'] })
    )
    expect(empty.options).toBeUndefined()
  })

  it('options 逐项拷贝：结果对象与入参不是同一引用（避免外部改动污染表单）', () => {
    const option = { value: 'a', label: '甲' }
    const field = toFormField(
      def({ type: 'select', options: [option] as unknown as FieldDef['options'] })
    )
    expect(field.options?.[0]).toEqual(option)
    expect(field.options?.[0]).not.toBe(option)
  })
})

describe('toFormFields：批量映射', () => {
  it('逐条收窄并保持顺序', () => {
    const fields = toFormFields([def({ key: 'a' }), def({ key: 'b', type: 'nope' })])
    expect(fields.map((field) => field.key)).toEqual(['a', 'b'])
    expect(fields[1].type).toBe('text')
  })
})

describe('schemaDefaults：各类型的初始值', () => {
  const schema = (partial: Partial<FormField>[]): FormField[] =>
    partial.map((item) => ({ key: 'k', label: 'L', type: 'text', ...item }))

  it('text / textarea（含未知类型回退）→ 空串', () => {
    expect(schemaDefaults(schema([{ key: 'a' }, { key: 'b', type: 'textarea' }]))).toEqual({
      a: '',
      b: '',
    })
  })

  it('password → 空串（与 text 同为文本值域，仅渲染为掩码）', () => {
    expect(schemaDefaults(schema([{ key: 'p', type: 'password' }]))).toEqual({ p: '' })
  })

  it('tags → 空数组', () => {
    expect(schemaDefaults(schema([{ key: 't', type: 'tags' }]))).toEqual({ t: [] })
  })

  it('select → defaultValue；无 defaultValue 取首项；都没有则空串', () => {
    const values = schemaDefaults(
      schema([
        {
          key: 'a',
          type: 'select',
          defaultValue: 'high',
          options: [{ value: 'low', label: '低' }],
        },
        { key: 'b', type: 'select', options: [{ value: 'low', label: '低' }] },
        { key: 'c', type: 'select' },
      ])
    )
    expect(values).toEqual({ a: 'high', b: 'low', c: '' })
  })

  it.each([
    ['true', true],
    ['false', false],
    [undefined, false],
  ])('boolean：defaultValue=%s → %s（只有字符串 "true" 为真）', (given, expected) => {
    const values = schemaDefaults(
      schema([{ key: 'b', type: 'boolean', defaultValue: given as string | undefined }])
    )
    expect(values.b).toBe(expected)
  })
})
