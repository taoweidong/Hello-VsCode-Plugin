<script setup lang="ts">
import { computed, inject, useId } from 'vue'
import { VFORM_FIELD_KEY, type VFormFieldContext } from './formFieldContext'

/**
 * 单行输入框（docs/需求与优化方案/04 §4.2）。
 * invalid 时描边与焦点环切 --ui-error-border；包在 VFormField 内时自动获得
 * id / aria-invalid / aria-describedby。
 */
const props = withDefaults(
  defineProps<{
    modelValue?: string
    placeholder?: string
    invalid?: boolean
    disabled?: boolean
    maxlength?: number
    /** 输入类型（password 用于凭据掩码渲染，P2-B4；其余场景保持 text） */
    type?: 'text' | 'password'
    /** 覆盖 VFormField 生成的控件 id（一般无需传） */
    id?: string
  }>(),
  { modelValue: '', invalid: false, disabled: false, type: 'text' }
)

const emit = defineEmits<{ (e: 'update:modelValue', value: string): void }>()

const field = inject<VFormFieldContext | null>(VFORM_FIELD_KEY, null)
const fallbackId = useId()
const controlId = computed(() => props.id ?? field?.controlId.value ?? fallbackId)
const isInvalid = computed(() => props.invalid || (field?.invalid.value ?? false))

function onInput(event: Event): void {
  // isComposing 期间的输入由组件消费方（SchemaForm）处理，这里只透传最新值。
  emit('update:modelValue', (event.target as HTMLInputElement).value)
}
</script>

<template>
  <input
    :id="controlId"
    class="v-input"
    :class="{ 'v-input--invalid': isInvalid }"
    :type="type"
    :value="modelValue"
    :placeholder="placeholder"
    :maxlength="maxlength"
    :disabled="disabled"
    :aria-invalid="isInvalid || undefined"
    :aria-describedby="field?.describedBy.value"
    @input="onInput"
  />
</template>

<style scoped>
.v-input {
  box-sizing: border-box;
  width: 100%;
  height: var(--ui-control-height);
  padding: var(--ui-input-pad-y) var(--ui-input-pad-x);
  border: 1px solid var(--ui-input-border);
  border-radius: var(--ui-radius);
  background: var(--ui-input-bg);
  color: var(--ui-input-fg);
  font-family: var(--ui-font);
  font-size: var(--ui-font-size);
  transition:
    border-color var(--ui-motion),
    background-color var(--ui-motion);
}

.v-input::placeholder {
  color: var(--ui-input-placeholder);
}

.v-input:focus {
  outline: 1px solid var(--ui-focus);
  outline-offset: -1px;
}

.v-input--invalid {
  border-color: var(--ui-error-border);
}

.v-input--invalid:focus {
  outline-color: var(--ui-error-border);
}

.v-input:disabled {
  color: var(--ui-fg-disabled);
  cursor: default;
}
</style>
