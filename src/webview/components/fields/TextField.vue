<script setup lang="ts">
import VInput from '../../ui/VInput.vue'
import type { FormField } from '../../formSchema'

/**
 * text 字段：单行输入（VInput）。
 * password 类型（P2-B4）复用本组件但以掩码渲染，凭据输入不回显明文。
 */
defineProps<{
  field: FormField
  modelValue?: unknown
  disabled?: boolean
}>()

const emit = defineEmits<{ (e: 'update:modelValue', value: string): void }>()

function asText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}
</script>

<template>
  <VInput
    :model-value="asText(modelValue)"
    :type="field.type === 'password' ? 'password' : 'text'"
    :placeholder="field.placeholder"
    :disabled="disabled"
    @update:model-value="emit('update:modelValue', $event)"
  ></VInput>
</template>
