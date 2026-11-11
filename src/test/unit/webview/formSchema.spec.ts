import { describe, expect, it } from 'vitest'
import {
  deriveFormSchema,
  type FormField,
  type SchemaFieldDef,
  toFieldDefs,
} from '../../../webview/formSchema'

/**
 * formSchema 派生（09 方案阶段 2 后）：FORM_SCHEMA / ITEM_FIELD_DEFS / UI_FIELD_EXTRAS
 * 已随条目领域删除，本文件锁定**领域无关**的派生契约——任何领域的字段表
 * （样例用合成字段表）都能派生，加字段零 UI 改动。
 * v4.0.0：串口功能下线后不再借用 SERVER_FIELD_DEFS，改用本文件内的合成字段表。
 */

const SAMPLE_FIELD_DEFS: SchemaFieldDef[] = [
  { key: 'name', type: 'text', label: '名称', required: true, maxLength: 100 },
  { key: 'remark', type: 'textarea', label: '备注', placeholder: '选填' },
  {
    key: 'baudRate',
    type: 'select',
    label: '波特率',
    defaultValue: '9600',
    options: [
      { value: '9600', label: '9600' },
      { value: '115200', label: '115200' },
    ],
  },
  { key: 'autoLogin', type: 'boolean', label: '自动登录', defaultValue: 'false' },
]

describe('deriveFormSchema（领域 Schema → 表单字段）', () => {
  it('在领域定义副本中加一个字段 → deriveFormSchema 输出自动包含（加字段零 UI 改动）', () => {
    const extended: SchemaFieldDef[] = [
      ...SAMPLE_FIELD_DEFS,
      { key: 'owner', type: 'text', label: '负责人', placeholder: '选填' },
    ]
    const schema = deriveFormSchema(extended)
    expect(schema.length).toBe(SAMPLE_FIELD_DEFS.length + 1)
    const owner = schema.find((field) => field.key === 'owner')
    expect(owner).toMatchObject({ label: '负责人', type: 'text', placeholder: '选填' })
  })

  it('领域字段属性逐项透传（label/hint/placeholder/defaultValue/options/required）', () => {
    const schema = deriveFormSchema(SAMPLE_FIELD_DEFS)
    expect(schema.map((field) => field.key)).toEqual(SAMPLE_FIELD_DEFS.map((def) => def.key))
    expect(schema.find((field) => field.key === 'autoLogin')).toMatchObject({
      type: 'boolean',
      defaultValue: 'false',
    })
    expect(schema.find((field) => field.key === 'baudRate')?.options?.[0]).toEqual({
      value: '9600',
      label: '9600',
    })
  })

  it('select 选项深拷贝（改派生结果不影响领域定义）', () => {
    const schema = deriveFormSchema(SAMPLE_FIELD_DEFS)
    const options = schema.find((field) => field.key === 'baudRate')?.options
    expect(options).toBeDefined()
    if (options?.[0]) {
      options[0].label = '被篡改'
    }
    expect(SAMPLE_FIELD_DEFS.find((def) => def.key === 'baudRate')?.options?.[0].label).toBe('9600')
  })

  it('toFieldDefs 透传全部表单属性', () => {
    const fields: FormField[] = [
      {
        key: 'name',
        label: '名称',
        type: 'text',
        required: true,
        placeholder: '请输入',
        hint: '说明',
      },
    ]
    const defs = toFieldDefs(fields)
    expect(defs.find((def) => def.key === 'name')).toMatchObject({
      label: '名称',
      type: 'text',
      required: true,
      placeholder: '请输入',
      hint: '说明',
    })
  })
})
