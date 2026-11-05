<script setup lang="ts">
import { useTemplateRef } from 'vue'
import type { SerialPortBrief } from '../../../protocol'
import type { FormField } from '../../../formSchema'
import SchemaForm from '../../../components/SchemaForm.vue'
import VButton from '../../../ui/VButton.vue'
import VToolbar from '../../../ui/VToolbar.vue'

/**
 * 左栏服务器表单：SchemaForm（宿主下发的服务器字段 Schema）+ 检测串口 chips +
 * 保存 / 重置。密码字段由页面在提交时剥离单独携带，本地不做持久化。
 */
const props = defineProps<{
  schema: FormField[]
  modelValue: Record<string, unknown>
  errors: Record<string, string>
  ports: SerialPortBrief[]
  editing: boolean
  saving: boolean
  /** 编辑态重置的两段式布防态（由页面级 useTwoStepConfirm 持有，Esc / 按钮共用）。 */
  resetArmed: boolean
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: Record<string, unknown>): void
  (e: 'submit'): void
  (e: 'reset'): void
  (e: 'detect'): void
}>()

const formRef = useTemplateRef<typeof SchemaForm>('form')

function onSaveClick(): void {
  if (formRef.value && !formRef.value.validate()) {
    formRef.value.focusFirst()
    return
  }
  emit('submit')
}

/** Ctrl/Cmd+Enter 提交（SchemaForm 内部已校验 required）。 */
function onFormSubmit(): void {
  if (props.saving) return
  emit('submit')
}

function pickPort(path: string): void {
  emit('update:modelValue', { ...props.modelValue, serialPath: path })
}
</script>

<template>
  <section class="server-form" aria-label="服务器表单">
    <VToolbar>
      <span class="server-form__title">{{ editing ? '编辑服务器' : '新增服务器' }}</span>
      <VButton variant="secondary" icon="plug" title="检测本机串口" @click="emit('detect')">
        检测串口
      </VButton>
      <VButton
        variant="secondary"
        :icon="resetArmed ? 'warning' : 'refresh'"
        :title="resetArmed ? '再次点击确认重置' : '恢复默认值'"
        :class="{ 'server-form__reset--armed': resetArmed }"
        @click="emit('reset')"
      >
        {{ resetArmed ? '确认重置' : '重置' }}
      </VButton>
    </VToolbar>

    <p v-if="ports.length > 0" class="server-form__ports">
      <button
        v-for="port in ports"
        :key="port.path"
        type="button"
        class="server-form__chip"
        :title="port.manufacturer ? `${port.path}（${port.manufacturer}）` : port.path"
        @click="pickPort(port.path)"
      >
        {{ port.path }}
      </button>
    </p>

    <SchemaForm
      ref="form"
      :schema="schema"
      :model-value="modelValue"
      :errors="errors"
      :disabled="saving"
      :aria-label="editing ? '编辑服务器表单' : '新增服务器表单'"
      @update:model-value="emit('update:modelValue', $event)"
      @submit="onFormSubmit"
      @cancel="emit('reset')"
    ></SchemaForm>

    <div class="server-form__footer">
      <VButton
        variant="primary"
        icon="save"
        :loading="saving"
        :disabled="saving"
        @click="onSaveClick"
      >
        {{ editing ? '保存修改' : '保存服务器' }}
      </VButton>
    </div>
  </section>
</template>

<style scoped>
.server-form {
  display: flex;
  flex-direction: column;
  gap: var(--ui-space-2);
}

.server-form__title {
  color: var(--ui-fg);
  font-weight: 600;
}

.server-form__reset--armed {
  color: var(--ui-error);
}

.server-form__ports {
  display: flex;
  flex-wrap: wrap;
  gap: var(--ui-space-1);
  margin: 0;
}

.server-form__chip {
  /* 第五轮：垂直内边距 2px 登记为 --ui-chip-pad-y（原 px 字面量混写擦边过门禁） */
  padding: var(--ui-chip-pad-y) var(--ui-space-2);
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius);
  background: var(--ui-surface);
  color: var(--ui-link);
  font-family: var(--ui-font);
  font-size: var(--ui-font-size);
  cursor: pointer;
}

.server-form__chip:hover {
  background: var(--ui-surface-hover);
}

.server-form__footer {
  display: flex;
  justify-content: flex-end;
}
</style>
