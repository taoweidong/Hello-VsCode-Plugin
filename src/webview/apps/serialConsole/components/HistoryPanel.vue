<script setup lang="ts">
import { computed, ref } from 'vue'
import type { CommandHistoryWire } from '../../../protocol'
import { useTwoStepConfirm } from '../../../composables/useTwoStepConfirm'
import VButton from '../../../ui/VButton.vue'
import VEmptyState from '../../../ui/VEmptyState.vue'
import VInput from '../../../ui/VInput.vue'

/**
 * 历史命令面板（MRU 去重列表由宿主维护）：
 * 搜索过滤 / 单击填入输入框 / 双击直接发送 / 单条删除 / 两段式清空。
 */
const props = defineProps<{
  entries: CommandHistoryWire[]
}>()

const emit = defineEmits<{
  (e: 'fill', command: string): void
  (e: 'send', command: string): void
  (e: 'remove', id: string): void
  (e: 'clear'): void
}>()

const search = ref('')
const clearConfirm = useTwoStepConfirm()

const filtered = computed(() => {
  const keyword = search.value.trim().toLowerCase()
  if (!keyword) return props.entries
  return props.entries.filter((entry) => entry.command.toLowerCase().includes(keyword))
})

function formatTime(at: number): string {
  if (at <= 0) return ''
  const date = new Date(at)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function onClear(): void {
  if (clearConfirm.confirm('clear')) {
    emit('clear')
  }
}
</script>

<template>
  <section class="history-panel" aria-label="历史命令">
    <div class="history-panel__toolbar">
      <VInput
        :model-value="search"
        placeholder="搜索历史命令"
        aria-label="搜索历史命令"
        class="history-panel__search"
        @update:model-value="search = String($event)"
      ></VInput>
      <VButton
        variant="secondary"
        icon="clearAll"
        :disabled="entries.length === 0"
        :class="{ 'history-panel__clear--armed': clearConfirm.isArmed('clear') }"
        :title="clearConfirm.isArmed('clear') ? '再次点击确认清空' : '清空历史'"
        @click="onClear"
      >
        {{ clearConfirm.isArmed('clear') ? '确认清空' : '清空' }}
      </VButton>
    </div>

    <VEmptyState
      v-if="filtered.length === 0"
      title="暂无历史命令"
      description="发送过的命令会自动去重并按最近使用排序"
      icon="history"
    />
    <ul v-else class="history-panel__list" role="listbox" aria-label="历史命令列表">
      <li
        v-for="entry in filtered"
        :key="entry.id"
        class="history-panel__row"
        role="option"
        :aria-label="entry.command"
        tabindex="0"
        title="单击填入输入框，双击直接发送"
        @click="emit('fill', entry.command)"
        @dblclick="emit('send', entry.command)"
        @keydown.enter.prevent="emit('fill', entry.command)"
      >
        <code class="history-panel__command">{{ entry.command }}</code>
        <span class="history-panel__meta">
          <span v-if="entry.useCount > 1" class="history-panel__count">×{{ entry.useCount }}</span>
          <span class="history-panel__time">{{ formatTime(entry.lastUsedAt) }}</span>
        </span>
        <button
          type="button"
          class="history-panel__remove"
          title="删除该条历史"
          aria-label="删除该条历史"
          @click.stop="emit('remove', entry.id)"
        >
          ×
        </button>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.history-panel {
  display: flex;
  flex-direction: column;
  gap: var(--ui-space-2);
  min-height: 0;
}

.history-panel__toolbar {
  display: flex;
  gap: var(--ui-space-2);
}

.history-panel__search {
  flex: 1;
}

.history-panel__clear--armed {
  color: var(--ui-error);
}

.history-panel__list {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: var(--ui-history-max-height);
  overflow: auto;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius);
}

.history-panel__row {
  display: flex;
  align-items: center;
  gap: var(--ui-space-2);
  padding: var(--ui-space-1) var(--ui-space-2);
  cursor: pointer;
}

.history-panel__row:hover {
  background: var(--ui-surface-hover);
}

.history-panel__command {
  flex: 1;
  min-width: 0;
  color: var(--ui-fg);
  font-family: var(--vscode-editor-font-family, Consolas, 'Courier New', monospace);
  font-size: var(--vscode-editor-font-size, 12px);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.history-panel__meta {
  display: flex;
  gap: var(--ui-space-2);
  color: var(--ui-fg-muted);
  font-size: 0.85em;
  flex: none;
}

.history-panel__count {
  color: var(--ui-fg-muted);
}

.history-panel__remove {
  border: none;
  background: transparent;
  color: var(--ui-fg-muted);
  cursor: pointer;
  padding: 0 var(--ui-space-1);
  font-size: 1em;
  flex: none;
}

.history-panel__remove:hover {
  color: var(--ui-error);
}
</style>
