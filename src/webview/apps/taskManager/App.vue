<script setup lang="ts">
import { useTemplateRef } from 'vue'
import type { TaskBuildTypeWire, TaskItemStatusWire, TaskItemWire } from '../../protocol'
import SchemaForm from '../../components/SchemaForm.vue'
import AppShell from '../../ui/AppShell.vue'
import VBadge from '../../ui/VBadge.vue'
import VButton from '../../ui/VButton.vue'
import VEmptyState from '../../ui/VEmptyState.vue'
import VLoading from '../../ui/VLoading.vue'
import VSelect from '../../ui/VSelect.vue'
import VInput from '../../ui/VInput.vue'
import VToolbar from '../../ui/VToolbar.vue'
import { useTaskPage } from './useTaskPage'

/**
 * 任务管理（v2.6）：典型 CRUD 实例——
 * 上部「查询参数区」（关键字 / 状态 / 类型 / 每页条数）+ 下部「数据表格区」+ 分页，
 * 支持新增 / 编辑 / 删除 / 查询。后端接口由宿主打桩模拟（stub）或真实 REST（HTTP），
 * 页面侧只认协议，两种实现零改动。
 *
 * 消息流（编排契约见 useTaskPage / useHostMessages，17 方案阶段 3 收敛）：
 * - `ready` → init（schema = TASK_FIELD_DEFS）；
 * - `taskListRequest`（查询 / 分页）→ 宿主 taskList 页；
 * - `submit`（新建 / 编辑，主按钮先过本地必填校验）→ 宿主写成功后 submitAck
 *   （页面据此关框 + 成功反馈）+ taskList（仅数据刷新）；失败 error（err.field
 *   定位表单控件；宿主提交生命周期 10s 超时兜底）；
 * - `taskDelete` → taskList（行内两段式布防确认，不依赖浏览器模态——webview 沙箱
 *   下 confirm 恒被忽略，见 useTwoStepConfirm / agent.md 硬性规约 9）；
 * - 轮询：init 完成 且 存在排队 / 运行中任务时每 3s 刷新当前查询条件，展示实时进度。
 * - 持久化：查询条件 / 页码 / 打开中的弹框草稿经 webview state 恢复（P2-F2）。
 */

const {
  fields,
  loading,
  items,
  page,
  total,
  pageSize,
  query,
  feedback,
  totalPages,
  canPrev,
  canNext,
  search,
  resetQuery,
  changePageSize,
  gotoPage,
  dialogOpen,
  editingId,
  dialogDraft,
  dialogErrors,
  saving,
  openCreate,
  openEdit,
  closeDialog,
  submitDialog: submitDialogRaw,
  deleteConfirm,
  confirmDelete,
} = useTaskPage()

const STATUS_META: Record<TaskItemStatusWire, { label: string; cls: string }> = {
  queued: { label: '排队中', cls: 'task-status--queued' },
  running: { label: '运行中', cls: 'task-status--running' },
  success: { label: '成功', cls: 'task-status--success' },
  failed: { label: '失败', cls: 'task-status--failed' },
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

/** 弹框表单模板引用：本地必填校验经 SchemaForm 的 validate/focusFirst 完成。 */
const dialogFormRef = useTemplateRef<typeof SchemaForm>('dialogForm')

function submitDialog(): void {
  submitDialogRaw(dialogFormRef.value ?? undefined)
}

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

      <!-- 横向滚动容器：八列表格在窄面板下保列宽可读，宁滚不挤 -->
      <div class="task-table-scroll">
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
              <td class="task-table__placeholder" colspan="8">
                <VLoading label="加载任务列表…" />
              </td>
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
      </div>

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

/* 排版优化：窄面板降级——关键字占整行、其余两列排布，避免五列互相挤压。
   断点为裸 px（媒体查询非尺寸声明，不受令牌门禁约束；同 AppShell 400px 先例） */
@media (max-width: 840px) {
  .task-filters {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .task-filters > :first-child {
    grid-column: 1 / -1;
  }
}

@media (max-width: 480px) {
  .task-filters {
    grid-template-columns: minmax(0, 1fr);
  }

  .task-filters > :last-child {
    justify-self: start;
  }
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

.task-table-scroll {
  overflow-x: auto;
}

.task-table {
  width: 100%;
  min-width: var(--ui-task-table-min-width);
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

.task-row:hover {
  background: var(--ui-surface-hover);
}

.task-row__name {
  font-weight: 600;
  overflow-wrap: anywhere;
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
  padding: var(--ui-task-status-pad-y) var(--ui-space-1);
  border-radius: var(--ui-radius);
  background: var(--ui-surface-hover);
}

/* 排版优化：状态按语义着色（此前四种状态视觉无差别，只能靠文字区分） */
.task-status--queued {
  color: var(--ui-fg-muted);
}

.task-status--success {
  color: var(--ui-success);
}

.task-status--failed {
  color: var(--ui-error);
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
  flex-wrap: wrap;
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
