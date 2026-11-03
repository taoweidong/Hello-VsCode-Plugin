import { describe, expect, it } from 'vitest'
import { BUILD_FIELD_DEFS } from '../../../extension/features/build/buildSchema'
import { deriveFormSchema, toFieldDefs } from '../../../webview/formSchema'

/**
 * 构建表单字段表（此前无专属 spec）：注册表结构、必填与 select 默认值、
 * 经 deriveFormSchema 派生后的派生链完整性（分支编译弹框的 schema 来源）。
 */

describe('BUILD_FIELD_DEFS', () => {
  it('恰为 3 字段：branch / buildType / notes', () => {
    expect(BUILD_FIELD_DEFS.map((def) => def.key)).toEqual(['branch', 'buildType', 'notes'])
  })

  it('branch 必填；buildType 为 select 且默认 full；notes 选填 textarea', () => {
    const branch = BUILD_FIELD_DEFS[0]
    expect(branch.required).toBe(true)
    const buildType = BUILD_FIELD_DEFS[1]
    expect(buildType.type).toBe('select')
    expect(buildType.defaultValue).toBe('full')
    expect(buildType.options?.map((option) => option.value)).toEqual(['full', 'incremental'])
    const notes = BUILD_FIELD_DEFS[2]
    expect(notes.type).toBe('textarea')
    expect(notes.required).toBeUndefined()
  })

  it('派生链：deriveFormSchema → toFieldDefs 后字段形状保持（宿主 init 载荷来源）', () => {
    const fields = toFieldDefs(deriveFormSchema(BUILD_FIELD_DEFS))
    expect(fields.map((field) => field.key)).toEqual(['branch', 'buildType', 'notes'])
    expect(fields[0]).toMatchObject({ required: true, label: '分支名' })
    expect(fields[1]?.options).toEqual([
      { value: 'full', label: '完整构建' },
      { value: 'incremental', label: '增量构建' },
    ])
  })
})
