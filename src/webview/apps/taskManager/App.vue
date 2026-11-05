<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useTemplateRef } from 'vue'
import {
  isHostMessage,
  type TaskBuildTypeWire,
  type TaskItemStatusWire,
  type TaskItemWire,
} from '../../protocol'
import type { FormField } from '../../formSchema'
import SchemaForm from '../../components/SchemaForm.vue'
import { schemaDefaults, toFormFields } from '../../components/fieldAdapter'
import { useTwoStepConfirm } from '../../composables/useTwoStepConfirm'
import { useVsCodeApi } from '../../shared/useVsCodeApi'
import AppShell from '../../ui/AppShell.vue'
import VBadge from '../../ui/VBadge.vue'
import VButton from '../../ui/VButton.vue'
import VEmptyState from '../../ui/VEmptyState.vue'
import VLoading from '../../ui/VLoading.vue'
import VSelect from '../../ui/VSelect.vue'
import VInput from '../../ui/VInput.vue'
import VToolbar from '../../ui/VToolbar.vue'

/**
 * 任务管理（v2.6）：典型 CRUD 实例——
 * 上部「查询参数区」（关键字 / 状态 / 类型 / 每页条数）+ 下部「数据表格区」+ 分页，
 * 支持新增 / 编辑 / 删除 / 查询。后端接口由宿主打桩模拟（stub）或真实 REST（HTTP），
 * 页面侧只认协议，两种实现零改动。
 *
 * 消息流：
 * - `ready` → init（schema = TASK_FIELD_DEFS）；
 * - `taskListRequest`（查询 / 分页）→ 宿主 taskList 页；
 * - `submit`（新建 / 编辑，主按钮先过本地必填校验）→ 宿主写成功后 submitAck
 *   （页面据此关框 + 成功反馈）+ taskList（仅数据刷新）；失败 error（err.field
 *   定位表单控件；宿主提交生命周期 10s 超时兜底）；
 * - `taskDelete` → taskList（行内两段式布防确认，不依赖浏览器模态——webview 沙箱
 *   下 confirm 恒被忽略，见 useTwoStepConfirm / agent.md 硬性规约 9）；
 * - 轮询：init 完成 且 存在排队 / 运行中任务时每 3s 刷新当前查询条件，展示实时进度。
 */

const POLL_INTERVAL_MS = 3000
const DEFAULT_PAGE_SIZE = 10

const vscode = useVsCodeApi()

function post(message: unknown): void {
  vscode.postMessage(message)
}

const STATUS_META: Record<TaskItemStatusWire, { label: string; cls: string }> = {
  queued: { label: '排队中', cls: 'status--queued' },
  running: { label: '运行中', cls: 'status--running' },
  success: { label: '成功', cls: 'status--success' },
  failed: { label: '失败', cls: 'status--failed' },
}

const BUILD_TYPE_LABEL: Record<TaskBuildTypeWire, string> = {
  full: '完整构建',
  incremental: '增量构建',
}

const STATUS_OPTIONS = [
  { value: '', label: '全部状态' },
  { value: 'queued', label: '排队中' },
  { value: 'running', label: '运行中' },
  { value: 'success', label: '成功' },
  { value: 'failed', label: '失败' },
]

const BUILD_TYPE_OPTIONS = [
  { value: '', label: '全部类型' },
  { value: 'full', label: '完整构建' },
  { value: 'incremental', label: '增量构建' },
]

const PAGE_SIZE_OPTIONS = [
  { value: '10', label: '10 条 / 页' },
  { value: '20', label: '20 条 / 页' },
  { value: '50', label: '50 条 / 页' },
]

const fields = ref<FormField[]>([])
const initialized = ref(false)
const loading = ref(false)
const items = ref<TaskItemWire[]>([])
const page = ref(1)
const total = ref(0)
const pageSize = ref(DEFAULT_PAGE_SIZE)
const query = reactive({ keyword: '', status: '', buildType: '' })
const feedback = ref<{ kind: 'success' | 'error'; text: string } | null>(null)

/** 编辑弹框状态 */
const dialogOpen = ref(false)
const editingId = ref<string | null>(null)
const dialogDraft = ref<Record<string, unknown>>({})
const dialogErrors = ref<Record<string, string>>({})
const saving = ref(false)

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)))
const hasActiveTask = computed(() =>
  items.value.some((task) => task.status === 'queued' || task.status === 'running')
)
const canPrev = computed(() => page.value > 1)
const canNext = computed(() => page.value < totalPages.value)

function currentQuery(): Record<string, unknown> {
  const q: Record<string, unknown> = { page: page.value, pageSize: pageSize.value }
  const keyword = query.keyword.trim()
  if (keyword) q.keyword = keyword
  if (query.status) q.status = query.status
  if (query.buildType) q.buildType = query.buildType
  return q
}

function requestPage(): void {
  loading.value = true
  post({ type: 'taskListRequest', query: currentQuery() })
}

function search(): void {
  page.value = 1
  feedback.value = null
  requestPage()
}

function resetQuery(): void {
  query.keyword = ''
  query.status = ''
  query.buildType = ''
  page.value = 1
  feedback.value = null
  requestPage()
}

function changePageSize(value: string): void {
  pageSize.value = Number(value) || DEFAULT_PAGE_SIZE
  page.value = 1
  requestPage()
}

function gotoPage(target: number): void {
  const clamped = Math.min(Math.max(1, target), totalPages.value)
  if (clamped === page.value) return
  page.value = clamped
  requestPage()
}

/* ------------------------------ 弹框（增 / 改） ------------------------------ */

function openCreate(): void {
  editingId.value = null
  dialogDraft.value = schemaDefaults(fields.value)
  dialogErrors.value = {}
  dialogOpen.value = true
}

function openEdit(task: TaskItemWire): void {
  editingId.value = task.id
  dialogDraft.value = {
    name: task.name,
    branch: task.branch,
    buildType: task.buildType,
    notes: task.notes ?? '',
  }
  dialogErrors.value = {}
  dialogOpen.value = true
}

function closeDialog(): void {
  if (saving.value) return
  dialogOpen.value = false
  editingId.value = null
  dialogErrors.value = {}
}

const dialogFormRef = useTemplateRef<typeof SchemaForm>('dialogForm')

function submitDialog(): void {
  if (saving.value) return
  // 主按钮本地必填校验（对齐 serialConsole / P2-F2）：空必填不发 submit，
  // 就地显示字段错误并聚焦首个控件，避免一次注定失败的宿主往返
  if (dialogFormRef.value && !dialogFormRef.value.validate()) {
    dialogFormRef.value.focusFirst()
    return
  }
  saving.value = true
  dialogErrors.value = {}
  post({
    type: 'submit',
    draft: { ...dialogDraft.value, id: editingId.value ?? undefined },
  })
}

/** 行内删除的两段式布防确认（key = 任务 id，3s 内再点执行）。 */
const deleteConfirm = useTwoStepConfirm()

function confirmDelete(task: TaskItemWire): void {
  if (deleteConfirm.confirm(task.id)) {
    post({ type: 'taskDelete', id: task.id })
  }
}

/* -------------------------------- 消息处理 -------------------------------- */

function onMessage(event: MessageEvent): void {
  const message = event.data
  if (!isHostMessage(message)) return

  switch (message.type) {
    case 'init':
      fields.value = toFormFields(message.schema)
      initialized.value = true
      requestPage()
      break

    case 'taskList': {
      // 纯数据刷新：轮询应答与提交后的重查都走这里，关框只认 submitAck
      // （否则轮询应答先落时会误关弹框并伪造「已保存」）
      loading.value = false
      items.value = message.page.items
      total.value = message.page.total
      page.value = message.page.page
      pageSize.value = message.page.pageSize
      break
    }

    case 'submitAck': {
      // 写操作已被宿主受理：此处关框并给出成功反馈。宿主提交生命周期有 10s
      // 超时兜底（超时走 error 分支复位 saving），弹框不会永久卡死
      if (dialogOpen.value && saving.value) {
        saving.value = false
        dialogOpen.value = false
        editingId.value = null
        feedback.value = { kind: 'success', text: '任务已保存。' }
      }
      break
    }

    case 'error': {
      loading.value = false
      const field = message.field
      if (dialogOpen.value) {
        saving.value = false
        if (field) {
          dialogErrors.value = { ...dialogErrors.value, [field]: message.message }
        }
      }
      feedback.value = { kind: 'error', text: message.message }
      break
    }

    default:
      break
  }
}

let pollTimer: ReturnType<typeof setInterval> | undefined

function startPolling(): void {
  if (pollTimer !== undefined) return
  pollTimer = setInterval(() => {
    // 仅在 init 完成 且 存在排队 / 运行中任务时刷新：init 失败（initialized
    // 恒 false）不再空转请求，全部任务落定后自然停止
    if (initialized.value && hasActiveTask.value) {
      requestPage()
    }
  }, POLL_INTERVAL_MS)
}

function stopPolling(): void {
  if (pollTimer === undefined) return
  clearInterval(pollTimer)
  pollTimer = undefined
}

watch(hasActiveTask, (active) => {
  if (!active) feedback.value = null
})

onMounted(() => {
  window.addEventListener('message', onMessage)
  post({ type: 'ready' })
  startPolling()
})

onBeforeUnmount(() => {
  window.removeEventListener('message', onMessage)
  stopPolling()
})

function formatTime(iso?: string): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString('zh-CN', { hour12: false })
}

function progressWidth(task: TaskItemWire): string {
  return `${Math.min(100, Math.max(0, Math.round(task.progress)))}%`
}
</script>

<template>
  <AppShell
    title="任务管理"
    subtitle="典型 CRUD 实例：查询参数 + 数据表格 + 分页（后端接口打桩模拟，可切真实 REST）"
    width="full"
  >
    <template #actions>
      <VButton variant="primary" icon="add" title="新建任务" @click="openCreate">
        新建任务
      </VButton>
    </template>

    <!-- 上部：查询参数区 -->
    <section class="task-filters" aria-label="查询参数">
      <VInput v-model="query.keyword" placeholder="按任务名称 / 分支关键字搜索" :invalid="false" />
      <VSelect v-model="query.status" :options="STATUS_OPTIONS" />
      <VSelect v-model="query.buildType" :options="BUILD_TYPE_OPTIONS" />
      <VSelect
        :model-value="String(pageSize)"
        :options="PAGE_SIZE_OPTIONS"
        @update:model-value="changePageSize"
      />
      <VToolbar label="查询操作">
        <VButton variant="primary" icon="search" title="查询" @click="search">查询</VButton>
        <VButton icon="refresh" title="重置条件" @click="resetQuery">重置</VButton>
      </VToolbar>
    </section>

    <p
      v-if="feedback"
      class="task-feedback"
      :class="`task-feedback--${feedback.kind}`"
      role="status"
    >
      {{ feedback.text }}
    </p>

    <!-- 下部：数据表格区 -->
    <section class="task-table-card" aria-label="任务数据表格">
      <div class="task-table-head">
        <h2 class="task-table-title">任务列表</h2>
        <VBadge :label="`共 ${total} 条`" />
        <span v-if="loading" class="task-table-loading">
          <VLoading label="加载中…" />
        </span>
      </div>

      <table class="task-table">
        <thead>
          <tr>
            <th scope="col">任务名称</th>
            <th scope="col">分支</th>
            <th scope="col">类型</th>
            <th scope="col">状态</th>
            <th scope="col">进度</th>
            <th scope="col">信息 / 备注</th>
            <th scope="col">创建时间</th>
            <th scope="col">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="loading && items.length === 0">
            <td class="task-table__placeholder" colspan="8"><VLoading label="加载任务列表…" /></td>
          </tr>
          <tr v-else-if="items.length === 0">
            <td class="task-table__placeholder" colspan="8">
              <VEmptyState
                title="暂无任务"
                description="调整查询条件，或新建一个任务。"
                icon="info"
              >
                <template #action>
                  <VButton variant="primary" icon="add" title="新建任务" @click="openCreate">
                    新建任务
                  </VButton>
                </template>
              </VEmptyState>
            </td>
          </tr>
          <template v-else>
            <tr v-for="task in items" :key="task.id" class="task-row">
              <td class="task-row__name">{{ task.name }}</td>
              <td class="task-row__branch">{{ task.branch }}</td>
              <td class="task-row__type">
                {{ BUILD_TYPE_LABEL[task.buildType] ?? task.buildType }}
              </td>
              <td class="task-row__status">
                <span class="task-status" :class="STATUS_META[task.status].cls">
                  {{ STATUS_META[task.status].label }}
                </span>
              </td>
              <td class="task-row__progress">
                <div
                  class="task-progress"
                  role="progressbar"
                  :aria-valuenow="task.progress"
                  aria-valuemin="0"
                  aria-valuemax="100"
                >
                  <div class="task-progress__bar" :style="{ width: progressWidth(task) }"></div>
                </div>
                <span class="task-progress__text">{{ task.progress }}%</span>
              </td>
              <td class="task-row__message">
                <span v-if="task.message" class="task-row__message-text">{{ task.message }}</span>
                <span v-else-if="task.notes" class="task-row__notes">{{ task.notes }}</span>
                <span v-else class="task-row__notes muted">—</span>
              </td>
              <td class="task-row__time">{{ formatTime(task.createdAt) }}</td>
              <td class="task-row__actions">
                <VButton variant="icon" icon="edit" title="编辑任务" @click="openEdit(task)" />
                <VButton
                  variant="icon"
                  :icon="deleteConfirm.isArmed(task.id) ? 'warning' : 'delete'"
                  :title="deleteConfirm.isArmed(task.id) ? '再次点击确认删除' : '删除任务'"
                  :class="{ 'task-row__delete--armed': deleteConfirm.isArmed(task.id) }"
                  @click="confirmDelete(task)"
                />
              </td>
            </tr>
          </template>
        </tbody>
      </table>

      <!-- 分页 -->
      <nav class="task-pagination" aria-label="分页">
        <VSelect
          :model-value="String(pageSize)"
          :options="PAGE_SIZE_OPTIONS"
          @update:model-value="changePageSize"
        />
        <span class="task-pagination__info">
          第 {{ page }} / {{ totalPages }} 页 · 共 {{ total }} 条
        </span>
        <VToolbar label="分页导航">
          <VButton
            variant="icon"
            icon="arrowUp"
            title="上一页"
            :disabled="!canPrev"
            @click="gotoPage(page - 1)"
          />
          <VButton
            variant="icon"
            icon="arrowDown"
            title="下一页"
            :disabled="!canNext"
            @click="gotoPage(page + 1)"
          />
        </VToolbar>
      </nav>
    </section>

    <!-- 新增 / 编辑弹框 -->
    <div
      v-if="dialogOpen"
      class="task-dialog"
      role="dialog"
      aria-modal="true"
      aria-label="任务表单"
    >
      <div class="task-dialog__panel">
        <h2 class="task-dialog__title">{{ editingId ? '编辑任务' : '新建任务' }}</h2>
        <SchemaForm
          ref="dialogForm"
          :schema="fields"
          :model-value="dialogDraft"
          :errors="dialogErrors"
          :disabled="saving"
          aria-label="任务表单"
          @update:model-value="dialogDraft = $event"
          @submit="submitDialog"
          @cancel="closeDialog"
        />
        <div class="task-dialog__footer">
          <VButton :disabled="saving" @click="closeDialog">取消</VButton>
          <VButton variant="primary" :loading="saving" @click="submitDialog">保存</VButton>
        </div>
      </div>
    </div>
  </AppShell>
</template>

<style scoped>
.task-filters {
  display: grid;
  grid-template-columns:
    minmax(240px, 2fr) minmax(140px, 1fr) minmax(140px, 1fr) minmax(140px, 1fr)
    auto;
  gap: var(--ui-space-2);
  align-items: center;
  margin-bottom: var(--ui-space-4);
}

.task-feedback {
  margin: 0 0 var(--ui-space-3);
  padding: var(--ui-space-1) var(--ui-space-2);
  border-radius: var(--ui-radius);
  font-size: 0.9em;
}

.task-feedback--success {
  color: var(--ui-success, var(--ui-fg));
  background: var(--ui-surface-hover);
}

.task-feedback--error {
  color: var(--ui-error, var(--ui-fg));
  background: var(--ui-surface-hover);
}

.task-table-card {
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius);
  background: var(--ui-surface);
  overflow: hidden;
}

.task-table-head {
  display: flex;
  align-items: center;
  gap: var(--ui-space-2);
  padding: var(--ui-space-2) var(--ui-space-3);
  border-bottom: 1px solid var(--ui-border);
}

.task-table-title {
  margin: 0;
  font-size: 1em;
  font-weight: 600;
}

.task-table-loading {
  margin-left: auto;
}

.task-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.92em;
}

.task-table thead th {
  position: sticky;
  top: 0;
  text-align: left;
  padding: var(--ui-space-2) var(--ui-space-3);
  border-bottom: 1px solid var(--ui-border);
  background: var(--ui-surface-alt, var(--ui-surface));
  font-weight: 600;
  white-space: nowrap;
}

.task-table tbody td {
  padding: var(--ui-space-2) var(--ui-space-3);
  border-bottom: 1px solid var(--ui-border);
  vertical-align: middle;
}

.task-table__placeholder {
  /* 第五轮：原 --ui-space-8 未登记，var() 静默失效导致 padding 归零——改既有刻度 */
  padding: var(--ui-space-6) var(--ui-space-3) !important;
  text-align: center;
}

.task-row__name {
  font-weight: 600;
  word-break: break-all;
}

.task-row__branch,
.task-row__type,
.task-row__time {
  white-space: nowrap;
  color: var(--ui-fg-muted);
}

.task-row__message {
  max-width: var(--ui-task-message-max-width);
  word-break: break-word;
}

.task-row__message-text {
  color: var(--ui-error, var(--ui-fg));
}

.task-row__notes.muted {
  color: var(--ui-fg-muted);
}

.task-row__actions {
  white-space: nowrap;
  text-align: right;
}

.task-row__delete--armed {
  color: var(--ui-error);
}

.task-status {
  display: inline-flex;
  align-items: center;
  gap: var(--ui-space-1);
  padding: 2px var(--ui-space-1);
  border-radius: var(--ui-radius);
  background: var(--ui-surface-hover);
}

.task-status--running::before {
  content: '';
  display: inline-block;
  width: var(--ui-task-status-dot);
  height: var(--ui-task-status-dot);
  border-radius: 50%;
  background: currentColor;
  animation: task-pulse 1s ease-in-out infinite;
}

@keyframes task-pulse {
  50% {
    opacity: 0.3;
  }
}

.task-progress {
  display: inline-flex;
  align-items: center;
  width: var(--ui-task-progress-width);
  height: var(--ui-progress-height);
  border-radius: var(--ui-task-progress-radius);
  background: var(--ui-surface-hover);
  overflow: hidden;
}

.task-progress__bar {
  height: 100%;
  background: var(--ui-btn-bg);
  transition: width var(--ui-motion);
}

.task-progress__text {
  margin-left: var(--ui-space-1);
  font-size: 0.85em;
  color: var(--ui-fg-muted);
}

.task-pagination {
  display: flex;
  align-items: center;
  gap: var(--ui-space-3);
  padding: var(--ui-space-2) var(--ui-space-3);
  border-top: 1px solid var(--ui-border);
}

.task-pagination :deep(.v-select) {
  width: auto;
  min-width: var(--ui-task-select-min-width);
}

.task-pagination__info {
  margin-left: auto;
  color: var(--ui-fg-muted);
}

.task-dialog {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  /* 第五轮：遮罩色登记为语义令牌（原 rgba 硬编码擦边过样式门禁） */
  background: var(--ui-dialog-scrim);
  z-index: 20;
}

.task-dialog__panel {
  width: min(var(--ui-form-max-width), 90%);
  max-height: 80vh;
  overflow: auto;
  /* 第五轮：原 --ui-space-5 未登记，var() 静默失效导致 padding 归零——改既有刻度 */
  padding: var(--ui-space-4);
  border-radius: var(--ui-radius);
  background: var(--ui-surface);
  border: 1px solid var(--ui-border);
}

.task-dialog__title {
  margin: 0 0 var(--ui-space-4);
  font-size: 1.1em;
}

.task-dialog__footer {
  display: flex;
  justify-content: flex-end;
  gap: var(--ui-space-2);
  margin-top: var(--ui-space-4);
}

.task-dialog__panel :deep(.v-button--icon) {
  width: var(--ui-task-action-size);
  height: var(--ui-task-action-size);
}
</style>
