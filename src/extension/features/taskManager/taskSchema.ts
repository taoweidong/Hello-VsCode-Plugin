import type { SchemaFieldDef } from '../../../webview/formSchema'

/** 构建类型选项（表单与查询区共用，label 与 protocol 展示层一致）。 */
export const TASK_BUILD_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: 'full', label: '完整构建' },
  { value: 'incremental', label: '增量构建' },
]

/**
 * 任务表单字段表（任务管理 CRUD 弹框；经 deriveFormSchema 派生表单，加字段只改这里）。
 * 校验语义：任务名称 / 分支名必填（提交侧统一校验，失败经协议 error.field 定位控件）。
 */
export const TASK_FIELD_DEFS: readonly SchemaFieldDef[] = [
  {
    key: 'name',
    type: 'text',
    label: '任务名称',
    required: true,
    maxLength: 64,
    placeholder: '如 主干每日构建（打桩规则：含 fail 模拟失败）',
  },
  {
    key: 'branch',
    type: 'text',
    label: '分支名',
    required: true,
    maxLength: 128,
    placeholder: '如 release/1.2.0',
  },
  {
    key: 'buildType',
    type: 'select',
    label: '构建类型',
    defaultValue: 'full',
    options: TASK_BUILD_TYPE_OPTIONS,
  },
  { key: 'notes', type: 'textarea', label: '备注', placeholder: '选填，随任务提交给服务端' },
]
