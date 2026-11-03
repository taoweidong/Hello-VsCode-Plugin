<script setup lang="ts">
import { computed, ref, useTemplateRef } from 'vue'
import type { Component } from 'vue'
import type { FormField } from '../formSchema'
import VFormField from '../ui/VFormField.vue'
import BooleanField from './fields/BooleanField.vue'
import SelectField from './fields/SelectField.vue'
import TagsField from './fields/TagsField.vue'
import TextField from './fields/TextField.vue'
import TextareaField from './fields/TextareaField.vue'

/**
 * Schema 驱动表单（docs/需求与优化方案/04 §4.10，M4-T4.1）。
 *
 * - 字段组件按 field.type 从注册表分发，未知 type 回退 text（前向兼容）；
 * - 每个字段都包在 VFormField 内（label / 必填星号 / hint / 错误行 / aria 上下文）；
 * - required 本地校验（字符串空白与空数组都算未填），失败拦截 submit 并定位控件；
 * - 外部错误（宿主 coerce 回传的 field）与本校验合并显示，宿主错误优先；
 * - 键盘：Esc 取消、Ctrl/Cmd+Enter 提交、IME 组合中（event.isComposing）忽略（修复 W3）；
 * - 保存按钮的在途禁用由页面层控制（disabled 透传给全部控件）。
 */
const props = withDefaults(
  defineProps<{
    schema: FormField[]
    modelValue: Record<string, unknown>
    /** 字段级错误（key → 错误文案），宿主回传的错误经它定位控件 */
    errors?: Record<string, string>
    disabled?: boolean
    /** 表单可访问名（A-2）：由页面传入标题，屏幕阅读器据此播报表单 */
    ariaLabel?: string
  }>(),
  { errors: () => ({}), disabled: false }
)

const emit = defineEmits<{
  (e: 'update:modelValue', value: Record<string, unknown>): void
  (e: 'submit'): void
  (e: 'cancel'): void
}>()

/** type → 字段组件注册表；新增字段类型在此登记一行。 */
const FIELD_REGISTRY: Record<string, Component> = {
  text: TextField,
  textarea: TextareaField,
  select: SelectField,
  tags: TagsField,
  boolean: BooleanField,
  password: TextField,
}

function componentFor(field: FormField): Component {
  return FIELD_REGISTRY[field.type] ?? TextField
}

/** 本地 required 校验产生的错误（用户继续输入时逐字段清除）。 */
const localErrors = ref<Record<string, string>>({})
const mergedErrors = computed<Record<string, string>>(() => ({
  ...localErrors.value,
  ...props.errors,
}))

function valueFor(field: FormField): unknown {
  return props.modelValue[field.key]
}

function setValue(field: FormField, value: unknown): void {
  if (localErrors.value[field.key] !== undefined) {
    const next = { ...localErrors.value }
    delete next[field.key]
    localErrors.value = next
  }
  // 宿主错误（props.errors）同样随输入清除：页面在 update 事件里整体刷新 errors
  emit('update:modelValue', { ...props.modelValue, [field.key]: value })
}

/** required 判空：字符串去空白、数组看长度，其余按 null/undefined。 */
function isEmptyValue(value: unknown): boolean {
  if (typeof value === 'string') {
    return value.trim().length === 0
  }
  if (Array.isArray(value)) {
    return value.length === 0
  }
  return value === undefined || value === null
}

/** 校验 required 字段；全部通过返回 true，否则填充 localErrors 返回 false。 */
function validateRequired(): boolean {
  const errors: Record<string, string> = {}
  for (const field of props.schema) {
    if (field.required && isEmptyValue(props.modelValue[field.key])) {
      errors[field.key] = `请填写「${field.label}」`
    }
  }
  localErrors.value = errors
  return Object.keys(errors).length === 0
}

function requestSubmit(): void {
  if (props.disabled) {
    return
  }
  if (!validateRequired()) {
    return
  }
  emit('submit')
}

function onKeydown(event: KeyboardEvent): void {
  if (event.isComposing) {
    return // IME 输入组合中不响应快捷键（修复 W3）
  }
  if (event.key === 'Escape') {
    emit('cancel')
    return
  }
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault()
    requestSubmit()
  }
}

const formRef = useTemplateRef<HTMLFormElement>('form')

/** 聚焦第一个可聚焦控件（页面在 init / 恢复完成后调用）。 */
function focusFirst(): void {
  const control = formRef.value?.querySelector<HTMLElement>('input, textarea, select')
  control?.focus()
}

defineExpose({ validate: validateRequired, focusFirst })
</script>

<template>
  <form
    ref="form"
    class="schema-form"
    role="form"
    :aria-label="ariaLabel"
    novalidate
    @keydown="onKeydown"
    @submit.prevent
  >
    <VFormField
      v-for="field in schema"
      :key="field.key"
      :label="field.label"
      :required="field.required"
      :hint="field.hint"
      :error="mergedErrors[field.key]"
    >
      <component
        :is="componentFor(field)"
        :field="field"
        :model-value="valueFor(field)"
        :disabled="disabled"
        @update:model-value="setValue(field, $event)"
      ></component>
    </VFormField>
  </form>
</template>

<style scoped>
.schema-form {
  display: flex;
  flex-direction: column;
}
</style>
