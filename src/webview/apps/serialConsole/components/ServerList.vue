<script setup lang="ts">
import type { SerialServerWire } from '../../../protocol'
import { useTwoStepConfirm } from '../../../composables/useTwoStepConfirm'
import VButton from '../../../ui/VButton.vue'
import VEmptyState from '../../../ui/VEmptyState.vue'

/**
 * 左栏服务器列表：状态徽标 + 选中高亮 + 行内操作（连接 / 编辑 / 删除）。
 * 删除采用两段式确认（首次点击布防，3 秒内再次点击才删除），避免误删。
 */
const props = defineProps<{
  servers: SerialServerWire[]
  selectedId?: string
  activeServerId: string | null
  linkState: string
}>()

const emit = defineEmits<{
  (e: 'select', id: string): void
  (e: 'connect', id: string): void
  (e: 'edit', id: string): void
  (e: 'delete', id: string): void
}>()

const deleteConfirm = useTwoStepConfirm()

function isConnected(id: string): boolean {
  return props.activeServerId === id && props.linkState === 'connected'
}

function isBusy(id: string): boolean {
  return props.activeServerId === id && props.linkState === 'connecting'
}

function onRowClick(server: SerialServerWire): void {
  emit('select', server.id)
}

function onDelete(id: string): void {
  if (deleteConfirm.confirm(id)) {
    emit('delete', id)
  }
}
</script>

<template>
  <div class="server-list" role="list" aria-label="服务器列表">
    <VEmptyState
      v-if="servers.length === 0"
      title="暂无服务器"
      description="在下方表单录入第一台串口服务器"
      icon="server"
    />
    <div
      v-for="server in servers"
      :key="server.id"
      class="server-list__row"
      :class="{
        'server-list__row--selected': server.id === selectedId,
        'server-list__row--connected': isConnected(server.id),
      }"
      role="listitem"
      tabindex="0"
      @click="onRowClick(server)"
      @keydown.enter.prevent="onRowClick(server)"
    >
      <span
        class="server-list__status"
        :class="{
          'server-list__status--connected': isConnected(server.id),
          'server-list__status--busy': isBusy(server.id),
        }"
        aria-hidden="true"
      ></span>
      <div class="server-list__info">
        <span class="server-list__name">{{ server.name }}</span>
        <span class="server-list__meta">{{ server.serialPath }} · {{ server.baudRate }}</span>
      </div>
      <div class="server-list__actions" @click.stop>
        <VButton
          variant="secondary"
          :icon="isConnected(server.id) ? 'close' : 'plug'"
          :title="isConnected(server.id) ? '断开' : '连接'"
          @click="emit('connect', server.id)"
        ></VButton>
        <VButton
          variant="secondary"
          icon="edit"
          title="编辑"
          @click="emit('edit', server.id)"
        ></VButton>
        <VButton
          variant="secondary"
          :icon="deleteConfirm.isArmed(server.id) ? 'warning' : 'delete'"
          :title="deleteConfirm.isArmed(server.id) ? '再次点击确认删除' : '删除'"
          class="server-list__delete"
          :class="{ 'server-list__delete--armed': deleteConfirm.isArmed(server.id) }"
          @click="onDelete(server.id)"
        ></VButton>
      </div>
    </div>
  </div>
</template>

<style scoped>
.server-list {
  display: flex;
  flex-direction: column;
  gap: var(--ui-space-1);
}

.server-list__row {
  display: flex;
  align-items: center;
  gap: var(--ui-space-2);
  padding: var(--ui-space-2);
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius);
  cursor: pointer;
}

.server-list__row:hover {
  background: var(--ui-surface-hover);
}

.server-list__row--selected {
  background: var(--ui-surface-selected);
}

.server-list__status {
  width: var(--ui-status-dot-size);
  height: var(--ui-status-dot-size);
  border-radius: 50%;
  background: var(--ui-fg-disabled);
  flex: none;
}

.server-list__status--connected {
  background: var(--ui-focus);
}

.server-list__status--busy {
  background: var(--ui-fg-muted);
  animation: server-list-pulse 1s ease infinite;
}

@keyframes server-list-pulse {
  50% {
    opacity: 0.4;
  }
}

.server-list__info {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
}

.server-list__name {
  color: var(--ui-fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.server-list__meta {
  color: var(--ui-fg-muted);
  font-size: 0.85em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.server-list__actions {
  display: flex;
  gap: var(--ui-space-1);
}

.server-list__delete--armed {
  color: var(--ui-error);
}
</style>
