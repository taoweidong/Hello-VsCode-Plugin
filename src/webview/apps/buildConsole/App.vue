<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, useTemplateRef } from 'vue'
import SchemaForm from '../../components/SchemaForm.vue'
import { schemaDefaults, toFormFields } from '../../components/fieldAdapter'
import type { FormField } from '../../formSchema'
import { isHostMessage, type BuildTaskWire } from '../../protocol'
import { useVsCodeApi } from '../../shared/useVsCodeApi'
import AppShell from '../../ui/AppShell.vue'
import VBadge from '../../ui/VBadge.vue'
import VButton from '../../ui/VButton.vue'
import VEmptyState from '../../ui/VEmptyState.vue'

/**
 * 分支编译弹框（v2.0）：SchemaForm 填写 → 提交（宿主经打桩/真实 HTTP 接口创建任务）
 * → 轮询任务列表展示。表单 schema 由宿主 init 下发（BUILD_FIELD_DEFS 派生）；
 * 提交走通用 submit 生命周期（submitAck 解锁 / error 定位字段）。
 *
 * 布局（v2.1.2 重设计）：双卡片结构——「提交构建」表单卡与「构建任务」列表卡
 * 视觉分离；刷新按钮归属它刷新的数据（列表卡头）；进行中任务带进度条。
 */

/** 轮询间隔（页面在前景时每 3s 拉一次任务列表）。 */
const POLL_INTERVAL_MS = 3000

const vscode = useVsCodeApi()

let pollTimer: ReturnType<typeof setInterval> | undefined

const fields = ref<FormField[]>([])
const draft = ref<Record<string, unknown>>({})
const errors = ref<Record<string, string>>({})
const tasks = ref<BuildTaskWire[]>([])
const initialized = ref(false)
const submitting = ref(false)
const feedback = ref('')

const formRef = useTemplateRef<typeof SchemaForm>('form')

const runningCount = computed(
  () => tasks.value.filter((task) => task.status === 'queued' || task.status === 'running').length
)

const STATUS_META: Record<BuildTaskWire['status'], { label: string; cls: string }> = {
  queued: { label: '排队中', cls: 'queued' },
  running: { label: '构建中', cls: 'running' },
  success: { label: '成功', cls: 'success' },
  failed: { label: '失败', cls: 'failed' },
}

const BUILD_TYPE_LABEL: Record<string, string> = {
  full: '完整',
  incremental: '增量',
}

function post(message: unknown): void {
  vscode.postMessage(message)
}

function requestList(): void {
  post({ type: 'buildListRequest' })
}

function onSubmit(): void {
  if (submitting.value) {
    return
  }
  // 主按钮同样走 SchemaForm 必填校验（P2-F2，对齐 ServerForm：失败聚焦首个控件）
  if (formRef.value && !formRef.value.validate()) {
    formRef.value.focusFirst()
    return
  }
  errors.value = {}
  feedback.value = ''
  submitting.value = true
  post({ type: 'submit', draft: { ...draft.value } })
}

function refresh(): void {
  requestList()
}

function formatTime(iso: string | undefined): string {
  if (!iso) {
    return ''
  }
  return new Date(iso).toLocaleTimeString()
}

function onMessage(event: MessageEvent): void {
  const data: unknown = event.data
  if (!isHostMessage(data)) {
    return
  }
  switch (data.type) {
    case 'init': {
      fields.value = toFormFields(data.schema)
      const seed = (data.value ?? {}) as Record<string, unknown>
      draft.value = { ...schemaDefaults(fields.value), ...seed }
      initialized.value = true
      requestList()
      break
    }
    case 'buildList':
      tasks.value = data.tasks
      break
    case 'submitAck':
      submitting.value = false
      feedback.value = ''
      requestList()
      break
    case 'error':
      submitting.value = false
      feedback.value = data.message
      if (data.field) {
        errors.value = { [data.field]: data.message }
      }
      break
  }
}

onMounted(() => {
  window.addEventListener('message', onMessage)
  post({ type: 'ready' })
  // init 尚未到达时也先拉一次列表（恢复面板场景 init 会再次触发）
  pollTimer = setInterval(() => {
    if (initialized.value) {
      requestList()
    }
  }, POLL_INTERVAL_MS)
})

onBeforeUnmount(() => {
  window.removeEventListener('message', onMessage)
  if (pollTimer !== undefined) {
    clearInterval(pollTimer)
    pollTimer = undefined
  }
})
</script>

<template>
  <AppShell
    title="分支编译"
    subtitle="填写信息提交构建任务，列表实时展示任务状态（HTTP 接口当前为打桩模拟）"
    width="full"
  >
    <div class="build-layout">
      <!-- 卡片一：提交构建（表单） -->
      <section v-if="initialized" class="build-form build-card" aria-label="构建任务表单">
        <header class="build-card__header">
          <h2 class="build-card__title">提交构建</h2>
          <span class="build-card__hint">带 * 为必填</span>
        </header>

        <SchemaForm
          ref="form"
          v-model="draft"
          :schema="fields"
          :errors="errors"
          :disabled="submitting"
          aria-label="构建任务表单"
          @submit="onSubmit"
        ></SchemaForm>

        <p v-if="feedback" class="build-form__feedback" role="alert">{{ feedback }}</p>

        <div class="build-card__actions">
          <VButton
            variant="primary"
            icon="send"
            :loading="submitting"
            :disabled="submitting"
            @click="onSubmit"
          >
            提交构建
          </VButton>
        </div>
      </section>

      <!-- 卡片二：构建任务（历史列表） -->
      <section class="build-list build-card" aria-label="构建任务列表">
        <header class="build-card__header">
          <h2 class="build-card__title">构建任务</h2>
          <VBadge v-if="runningCount > 0" :label="`${runningCount} 个进行中`"></VBadge>
          <VButton
            class="build-card__header-action"
            variant="secondary"
            icon="refresh"
            :disabled="!initialized"
            @click="refresh"
          >
            刷新
          </VButton>
        </header>

        <VEmptyState
          v-if="tasks.length === 0"
          title="暂无构建任务"
          description="填写上方表单提交第一个构建任务（当前为打桩模拟，接口返回模拟数据）。"
          icon="info"
        ></VEmptyState>

        <ul v-else class="build-task-list">
          <li v-for="task in tasks" :key="task.id" class="build-task">
            <div class="build-task__head">
              <span
                class="build-task__dot"
                :class="`build-task__dot--${STATUS_META[task.status].cls}`"
                :title="STATUS_META[task.status].label"
              ></span>
              <span class="build-task__branch">{{ task.branch }}</span>
              <VBadge :label="BUILD_TYPE_LABEL[task.buildType] ?? task.buildType"></VBadge>
              <span
                class="build-task__status"
                :class="`build-task__status--${STATUS_META[task.status].cls}`"
              >
                {{ STATUS_META[task.status].label }}
              </span>
            </div>

            <div
              v-if="task.status === 'running'"
              class="build-task__bar"
              role="progressbar"
              :aria-valuenow="task.progress"
              aria-valuemin="0"
              aria-valuemax="100"
              :aria-label="`构建进度 ${task.progress}%`"
            >
              <span class="build-task__bar-fill" :style="{ width: `${task.progress}%` }"></span>
            </div>

            <p v-if="task.message" class="build-task__message">{{ task.message }}</p>
            <p class="build-task__meta">
              <template v-if="task.notes">备注：{{ task.notes }} · </template>
              提交于 {{ formatTime(task.createdAt)
              }}<template v-if="task.finishedAt">
                · 结束于 {{ formatTime(task.finishedAt) }}</template
              >
            </p>
          </li>
        </ul>
      </section>
    </div>
  </AppShell>
</template>

<style scoped>
/* ---- 双卡片栅格：宽面板并排（表单 5 : 任务 7），窄面板自动堆叠 ---- */
.build-layout {
  display: grid;
  grid-template-columns: minmax(0, 5fr) minmax(0, 7fr);
  gap: var(--ui-space-4);
  align-items: start;
}

@media (max-width: 1000px) {
  .build-layout {
    grid-template-columns: minmax(0, 1fr);
  }
}

/* ---- 卡片骨架：表单卡与列表卡共用，视觉分离两块内容 ---- */
.build-card {
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius);
  background: var(--ui-surface);
  padding: var(--ui-space-4);
}

@media (max-width: 1000px) {
  .build-card + .build-card {
    margin-block-start: var(--ui-space-4);
  }
}

.build-card__header {
  display: flex;
  align-items: center;
  gap: var(--ui-space-2);
  padding-block-end: var(--ui-space-3);
  border-block-end: 1px solid var(--ui-hairline);
  margin-block-end: var(--ui-space-3);
}

.build-card__title {
  margin: 0;
  font-size: var(--ui-font-size);
  font-weight: 600;
}

.build-card__hint {
  color: var(--ui-fg-muted);
  font-size: var(--ui-badge-size);
}

.build-card__header-action {
  margin-inline-start: auto;
}

.build-card__actions {
  display: flex;
  justify-content: flex-end;
  margin-block-start: var(--ui-space-3);
}

/* ---- 反馈条 ---- */
.build-form__feedback {
  margin: 0 0 var(--ui-space-3);
  padding: var(--ui-space-2) var(--ui-space-3);
  border: 1px solid var(--ui-error-border);
  border-radius: var(--ui-radius);
  background: var(--ui-error-bg);
  color: var(--ui-error);
  font-size: var(--ui-badge-size);
}

/* ---- 任务列表 ---- */
.build-task-list {
  display: flex;
  flex-direction: column;
  gap: var(--ui-space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}

.build-task {
  padding: var(--ui-space-3);
  border: 1px solid var(--ui-hairline);
  border-radius: var(--ui-radius);
}

.build-task__head {
  display: flex;
  align-items: center;
  gap: var(--ui-space-2);
}

.build-task__branch {
  font-weight: 600;
}

.build-task__status {
  margin-inline-start: auto;
  font-size: var(--ui-badge-size);
}

.build-task__status--running {
  color: var(--ui-link);
}

.build-task__status--success {
  color: var(--ui-link-active);
}

.build-task__status--failed {
  color: var(--ui-error);
}

.build-task__status--queued {
  color: var(--ui-fg-muted);
}

/* 状态色点（失败 / 成功 / 运行中 / 排队）：颜色全部走 --vscode-* / --ui-* 令牌 */
.build-task__dot {
  inline-size: var(--ui-status-dot-size);
  block-size: var(--ui-status-dot-size);
  border-radius: 50%;
  background: var(--ui-fg-muted);
}

.build-task__dot--running {
  background: var(--ui-link);
}

.build-task__dot--success {
  background: var(--ui-link-active);
}

.build-task__dot--failed {
  background: var(--ui-error);
}

/* 进行中任务的进度条（令牌：--ui-progress 颜色 / --ui-progress-height 高度） */
.build-task__bar {
  margin-block-start: var(--ui-space-2);
  block-size: var(--ui-progress-height);
  border-radius: var(--ui-radius);
  background: var(--ui-hairline);
  overflow: hidden;
}

.build-task__bar-fill {
  display: block;
  block-size: 100%;
  background: var(--ui-progress);
}

.build-task__message {
  margin: var(--ui-space-2) 0 0;
  font-size: var(--ui-badge-size);
}

.build-task__meta {
  margin: var(--ui-space-2) 0 0;
  font-size: var(--ui-badge-size);
  color: var(--ui-fg-muted);
}
</style>
