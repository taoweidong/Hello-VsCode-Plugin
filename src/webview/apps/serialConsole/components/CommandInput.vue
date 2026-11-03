<script setup lang="ts">
import VButton from '../../../ui/VButton.vue'
import VInput from '../../../ui/VInput.vue'

/**
 * 命令输入行：Enter 发送（IME 组合中忽略，修复 W3 同款）、↑/↓ 遍历历史命令。
 * 未连接时输入可用（便于预先编辑），发送按钮禁用并由宿主兜底校验。
 * 历史遍历（修复 P2-F1）：首次 ↑ 记住当前输入为「草稿」，↓ 回到最底时恢复草稿
 * 而非清空；未进入遍历时 ↓ 是无操作；遍历中用户重新输入即退出遍历。
 */
const props = defineProps<{
  modelValue: string
  connected: boolean
  sending?: boolean
  /** MRU 序的历史命令（最新在前），供 ↑/↓ 遍历。 */
  historyCommands: string[]
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void
  (e: 'send', command: string): void
}>()

let historyIndex = -1
/** 进入历史遍历前的输入草稿：↓ 回到最底时恢复。 */
let draft = ''

function send(): void {
  const command = props.modelValue
  if (command.trim().length === 0 || props.sending) return
  historyIndex = -1
  draft = ''
  emit('send', command)
  emit('update:modelValue', '')
}

/** VInput 的用户输入事件：遍历中开始编辑则退出遍历，并以此为新草稿。 */
function onUserInput(value: string): void {
  if (historyIndex !== -1) {
    historyIndex = -1
  }
  draft = value
  emit('update:modelValue', value)
}

function onKeydown(event: KeyboardEvent): void {
  if (event.isComposing) return
  if (event.key === 'Enter') {
    event.preventDefault()
    send()
    return
  }
  if (event.key === 'ArrowUp' && props.historyCommands.length > 0) {
    event.preventDefault()
    if (historyIndex === -1) {
      draft = props.modelValue // 首次上溯：记住用户当前输入
    }
    historyIndex = Math.min(historyIndex + 1, props.historyCommands.length - 1)
    emit('update:modelValue', props.historyCommands[historyIndex] ?? '')
    return
  }
  if (event.key === 'ArrowDown' && historyIndex !== -1) {
    // 仅在历史遍历中生效；未遍历时 ↓ 不动输入（单行输入框原生行为）
    event.preventDefault()
    historyIndex = Math.max(historyIndex - 1, -1)
    emit(
      'update:modelValue',
      historyIndex === -1 ? draft : (props.historyCommands[historyIndex] ?? '')
    )
  }
}
</script>

<template>
  <div class="command-input">
    <VInput
      :model-value="modelValue"
      placeholder="输入命令，Enter 发送（↑/↓ 选择历史）"
      :disabled="sending"
      aria-label="串口命令输入"
      @update:model-value="onUserInput"
      @keydown="onKeydown"
    ></VInput>
    <VButton
      variant="primary"
      icon="send"
      :disabled="!connected || modelValue.trim().length === 0"
      :loading="sending"
      title="发送到串口"
      @click="send"
    >
      发送
    </VButton>
  </div>
</template>

<style scoped>
.command-input {
  display: flex;
  gap: var(--ui-space-2);
  align-items: center;
}
</style>
