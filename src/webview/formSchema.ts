import type { FieldDef } from './protocol'

/**
 * 表单字段 Schema 派生层。
 *
 * 各领域（串口服务器等）在自己的模块里声明 `SchemaFieldDef[]` 字段表，
 * 经 `deriveFormSchema` 派生成表单字段；「给领域加字段」= 在其字段表加一行，
 * 表单渲染、取值、回填、校验全部自动跟随（详见 README「如何扩展」）。
 * （09 方案阶段 2：条目领域的 ITEM_FIELD_DEFS / FORM_SCHEMA / UI_FIELD_EXTRAS
 * 已随条目领域删除；`deriveFormSchema` 是领域无关参数化派生，串口侧在用。）
 */
export type FormFieldType = 'text' | 'textarea' | 'select' | 'tags' | 'boolean' | 'password'

/**
 * 通用领域字段定义。
 * 独立声明、不绑定任何具体领域：串口服务器等领域定义自己的字段表时，
 * 不必引入其他领域的类型面。
 */
export interface SchemaFieldDef {
  /** 对应领域 Draft 的字段名 */
  key: string
  type: FormFieldType
  label: string
  /** 必填（text / textarea：trim 后非空；select：必须有合法值） */
  required?: boolean
  /** 文本最大长度（trim 后计量，超长报错） */
  maxLength?: number
  /** select / boolean 的默认值 */
  defaultValue?: string
  /** select 的可选项 */
  options?: { value: string; label: string }[]
  /** 字段下方的说明文字 */
  hint?: string
  placeholder?: string
}

export interface FormField {
  /** 对应领域 Draft 的字段名 */
  key: string
  label: string
  type: FormFieldType
  required?: boolean
  placeholder?: string
  /** 字段下方的说明文字 */
  hint?: string
  /** select 类型的默认值 */
  defaultValue?: string
  /** select 类型的选项 */
  options?: { value: string; label: string }[]
}

/**
 * 领域字段定义 → 表单字段（SchemaFieldDef 与 FormField 结构同构，逐属性显式拷贝，
 * 避免把具体领域类型直接引入 Webview 类型程序的 import 面）。
 * 参数为通用结构类型：串口服务器（SERVER_FIELD_DEFS）等任何领域的字段表都能派生，
 * 加字段只需扩展各自的领域定义。
 */
export function deriveFormSchema(defs: readonly SchemaFieldDef[]): FormField[] {
  return defs.map((def) => ({
    key: def.key,
    label: def.label,
    type: def.type,
    required: def.required,
    placeholder: def.placeholder,
    hint: def.hint,
    defaultValue: def.defaultValue,
    options: def.options?.map((option) => ({ ...option })),
  }))
}

/**
 * FormField[] → 协议 FieldDef[]（宿主组装 init 载荷用）。
 * 逐字段拷贝到匿名对象字面量，使结构类型获得隐式索引签名（接口直赋会缺索引签名）。
 */
export function toFieldDefs(schema: FormField[]): FieldDef[] {
  return schema.map((field) => ({
    key: field.key,
    label: field.label,
    type: field.type,
    required: field.required,
    placeholder: field.placeholder,
    hint: field.hint,
    defaultValue: field.defaultValue,
    options: field.options?.map((option) => ({ ...option })),
  }))
}
