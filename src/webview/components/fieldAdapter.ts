import type { FieldDef } from '../protocol'
import type { FormField, FormFieldType } from '../formSchema'

/**
 * init 消息的 FieldDef → 页面侧 FormField 适配器。
 *
 * 协议层只保证 key/label/type 三个字段；本模块按 FormField 的声明逐字段收窄，
 * 未知 type 回退 text（schema 前向兼容：宿主新增字段类型时旧页面不至于崩溃）。
 */

const FIELD_TYPES: readonly FormFieldType[] = [
  'text',
  'textarea',
  'select',
  'tags',
  'boolean',
  'password',
]

function isFieldType(value: unknown): value is FormFieldType {
  return typeof value === 'string' && (FIELD_TYPES as readonly string[]).includes(value)
}

function isOption(value: unknown): value is { value: string; label: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { value?: unknown }).value === 'string' &&
    typeof (value as { label?: unknown }).label === 'string'
  )
}

export function toFormField(def: FieldDef): FormField {
  const field: FormField = {
    key: def.key,
    label: def.label,
    type: isFieldType(def.type) ? def.type : 'text',
  }
  if (typeof def.required === 'boolean') {
    field.required = def.required
  }
  if (typeof def.placeholder === 'string') {
    field.placeholder = def.placeholder
  }
  if (typeof def.hint === 'string') {
    field.hint = def.hint
  }
  if (typeof def.defaultValue === 'string') {
    field.defaultValue = def.defaultValue
  }
  if (Array.isArray(def.options)) {
    const options = def.options.filter(isOption).map((option) => ({ ...option }))
    if (options.length > 0) {
      field.options = options
    }
  }
  return field
}

export function toFormFields(defs: FieldDef[]): FormField[] {
  return defs.map(toFormField)
}

/**
 * 按 schema 生成初始值：text/textarea 空串、tags 空数组、
 * select 取 defaultValue（缺省取首项）、boolean 按 defaultValue（'true'）。
 */
export function schemaDefaults(schema: FormField[]): Record<string, unknown> {
  const value: Record<string, unknown> = {}
  for (const field of schema) {
    switch (field.type) {
      case 'tags':
        value[field.key] = []
        break
      case 'select':
        value[field.key] = field.defaultValue ?? field.options?.[0]?.value ?? ''
        break
      case 'boolean':
        value[field.key] = field.defaultValue === 'true'
        break
      default:
        value[field.key] = ''
        break
    }
  }
  return value
}
