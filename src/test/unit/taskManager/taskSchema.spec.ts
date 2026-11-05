import { describe, expect, it } from 'vitest'
import { deriveFormSchema } from '../../../webview/formSchema'
import {
  TASK_BUILD_TYPE_OPTIONS,
  TASK_FIELD_DEFS,
} from '../../../extension/features/taskManager/taskSchema'

/**
 * 任务表单字段表（任务管理 CRUD 弹框）：字段名 / 类型 / 必填 / 约束 / 默认值。
 */
describe('TASK_FIELD_DEFS', () => {
  it('覆盖 name / branch / buildType / notes 四个字段', () => {
    expect(TASK_FIELD_DEFS.map((field) => field.key)).toEqual([
      'name',
      'branch',
      'buildType',
      'notes',
    ])
  })

  it('任务名称与分支名必填；名称限长 64、分支限长 128', () => {
    const [name, branch] = TASK_FIELD_DEFS
    expect(name).toMatchObject({ type: 'text', required: true, maxLength: 64 })
    expect(branch).toMatchObject({ type: 'text', required: true, maxLength: 128 })
  })

  it('buildType 为 select 且默认完整构建；notes 为可选 textarea', () => {
    const buildType = TASK_FIELD_DEFS[2]
    const notes = TASK_FIELD_DEFS[3]
    expect(buildType).toMatchObject({ type: 'select', defaultValue: 'full' })
    expect(buildType.options).toBe(TASK_BUILD_TYPE_OPTIONS)
    expect(notes).toMatchObject({ type: 'textarea' })
    expect(notes.required).toBeFalsy()
  })

  it('TASK_BUILD_TYPE_OPTIONS 固定为 full / incremental（与协议展示层一致）', () => {
    expect(TASK_BUILD_TYPE_OPTIONS).toEqual([
      { value: 'full', label: '完整构建' },
      { value: 'incremental', label: '增量构建' },
    ])
  })

  it('deriveFormSchema 保留四个字段（键名不改动）', () => {
    const schema = deriveFormSchema(TASK_FIELD_DEFS)
    expect(schema.map((field) => field.key)).toEqual(['name', 'branch', 'buildType', 'notes'])
  })
})
