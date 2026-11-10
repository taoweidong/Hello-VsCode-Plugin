import { computed, onBeforeUnmount, reactive, ref, watch, type ComputedRef, type Ref } from 'vue'
import {
  isTaskItemWire,
  sanitizeWireList,
  type HostMessage,
  type TaskBuildTypeWire,
  type TaskItemStatusWire,
  type TaskItemWire,
  type TaskQueryWire,
} from '../../protocol'
import { schemaDefaults, toFormFields } from '../../components/fieldAdapter'
import type { FormField } from '../../formSchema'
import { useHostMessages } from '../../shared/useHostMessages'
import { useVsCodeApi } from '../../shared/useVsCodeApi'
import { useTwoStepConfirm } from '../../composables/useTwoStepConfirm'

/**
 * 任务管理页面的消息编排与页面状态（17 方案阶段 3，P2-F1）：
 * 自此前 taskManager/App.vue 内联的「监听 + ready + 守卫分发 + 轮询 + 查询分页 +
 * 弹框状态」全部收进本 composable，编排契约与 useConsolePage 同基（useHostMessages），
 * App.vue 只剩模板胶水。
 *
 * webview state 持久化（P2-F2，pages.ts 设计契约）：查询条件 / 页码 / 每页条数 /
 * 打开中的弹框草稿经 setState 持久化（500ms 防抖），面板隐藏销毁后恢复
 * （对齐 serialConsole 先例）。
 */

const POLL_INTERVAL_MS = 3000
const DEFAULT_PAGE_SIZE = 10
const PERSIST_DEBOUNCE_MS = 500

/** 查询区下拉选项（status/buildType 恢复校验的合法值来源）。 */
const STATUS_VALUES: readonly (TaskItemStatusWire | 'all')[] = [
  'all',
  'queued',
  'running',
  'success',
  'failed',
]
const BUILD_TYPE_VALUES: readonly (TaskBuildTypeWire | 'all')[] = ['all', 'full', 'incremental']

/** webview state 持久化形态（页面自产自销；结构变更即整体作废，无需版本号）。 */
interface TaskPagePersisted {
  query?: { keyword?: unknown; status?: unknown; buildType?: unknown }
  page?: unknown
  pageSize?: unknown
  dialog?: { editingId?: unknown; draft?: unknown }
}

export function useTaskPage(): {
  fields: Ref<FormField[]>
  initialized: Ref<boolean>
  loading: Ref<boolean>
  items: Ref<TaskItemWire[]>
  page: Ref<number>
  total: Ref<number>
  pageSize: Ref<number>
  query: {
    keyword: string
    status: TaskItemStatusWire | 'all' | ''
    buildType: TaskBuildTypeWire | 'all' | ''
  }
  feedback: Ref<{ kind: 'success' | 'error'; text: string } | null>
  totalPages: ComputedRef<number>
  hasActiveTask: ComputedRef<boolean>
  canPrev: ComputedRef<boolean>
  canNext: ComputedRef<boolean>
  search(): void
  resetQuery(): void
  changePageSize(value: string): void
  gotoPage(target: number): void
  dialogOpen: Ref<boolean>
  editingId: Ref<string | null>
  dialogDraft: Ref<Record<string, unknown>>
  dialogErrors: Ref<Record<string, string>>
  saving: Ref<boolean>
  openCreate(): void
  openEdit(task: TaskItemWire): void
  closeDialog(): void
  submitDialog(form: unknown): void
  deleteConfirm: ReturnType<typeof useTwoStepConfirm>
  confirmDelete(task: TaskItemWire): void
  post: ReturnType<typeof useHostMessages>['post']
} {
  const fields = ref<FormField[]>([])
  const initialized = ref(false)
  const loading = ref(false)
  const items = ref<TaskItemWire[]>([])
  const page = ref(1)
  const total = ref(0)
  const pageSize = ref(DEFAULT_PAGE_SIZE)
  const query = reactive<{
    keyword: string
    status: TaskItemStatusWire | 'all' | ''
    buildType: TaskBuildTypeWire | 'all' | ''
  }>({ keyword: '', status: '', buildType: '' })
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

  const { post } = useHostMessages((message) => {
    onHostMessage(message)
  })

  function currentQuery(): TaskQueryWire {
    const q: TaskQueryWire = { page: page.value, pageSize: pageSize.value }
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

  function submitDialog(form: unknown): void {
    if (saving.value) return
    // 主按钮本地必填校验（对齐 serialConsole / P2-F2）：空必填不发 submit，
    // 就地显示字段错误并聚焦首个控件，避免一次注定失败的宿主往返
    const instance = form as { validate(): boolean; focusFirst(): void } | null | undefined
    if (instance && !instance.validate()) {
      instance.focusFirst()
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

  /* ------------------------------ 消息分发 ------------------------------ */

  function onHostMessage(message: HostMessage): void {
    switch (message.type) {
      case 'init': {
        fields.value = toFormFields(message.schema)
        initialized.value = true
        restorePersisted(message)
        requestPage()
        break
      }

      case 'taskList': {
        // 纯数据刷新：轮询应答与提交后的重查都走这里，关框只认 submitAck
        // （否则轮询应答先落时会误关弹框并伪造「已保存」）；
        // 坏元素过滤而非整条拒绝（P2-F3 前向兼容）
        loading.value = false
        items.value = sanitizeWireList(message.page.items, isTaskItemWire, '任务列表')
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

  /* ------------------------------ 轮询 ------------------------------ */

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

  startPolling()
  onBeforeUnmount(() => {
    stopPolling()
    if (persistTimer !== undefined) clearTimeout(persistTimer)
  })

  /* ------------------------------ webview state 持久化（P2-F2） ------------------------------ */

  const api = useVsCodeApi()
  let persistTimer: ReturnType<typeof setTimeout> | undefined

  watch(
    [query, page, pageSize, dialogOpen, dialogDraft, editingId],
    () => {
      if (!initialized.value) return
      if (persistTimer !== undefined) clearTimeout(persistTimer)
      persistTimer = setTimeout(() => {
        api.setState?.({
          query: { keyword: query.keyword, status: query.status, buildType: query.buildType },
          page: page.value,
          pageSize: pageSize.value,
          ...(dialogOpen.value
            ? { dialog: { editingId: editingId.value, draft: dialogDraft.value } }
            : {}),
        })
      }, PERSIST_DEBOUNCE_MS)
    },
    { deep: true }
  )

  /** init 时恢复持久化状态（字段逐一窄化，非法值按缺省处理——webview state 无 schema）。 */
  function restorePersisted(message: Extract<HostMessage, { type: 'init' }>): void {
    const saved = (message.extra as Record<string, unknown> | undefined)?.persisted as
      TaskPagePersisted | undefined
    if (!saved || typeof saved !== 'object') {
      return
    }
    const q = saved.query
    if (q && typeof q === 'object') {
      if (typeof q.keyword === 'string') query.keyword = q.keyword
      if (typeof q.status === 'string' && (STATUS_VALUES as readonly string[]).includes(q.status)) {
        query.status = q.status as TaskItemStatusWire | 'all' | ''
      }
      if (
        typeof q.buildType === 'string' &&
        (BUILD_TYPE_VALUES as readonly string[]).includes(q.buildType)
      ) {
        query.buildType = q.buildType as TaskBuildTypeWire | 'all' | ''
      }
    }
    if (typeof saved.pageSize === 'number' && saved.pageSize > 0) {
      pageSize.value = saved.pageSize
    }
    if (typeof saved.page === 'number' && saved.page > 0) {
      page.value = saved.page
    }
    const dialog = saved.dialog
    if (dialog && typeof dialog === 'object' && dialog.draft && typeof dialog.draft === 'object') {
      editingId.value = typeof dialog.editingId === 'string' ? dialog.editingId : null
      dialogDraft.value = dialog.draft as Record<string, unknown>
      dialogErrors.value = {}
      dialogOpen.value = true
    }
  }

  return {
    fields,
    initialized,
    loading,
    items,
    page,
    total,
    pageSize,
    query,
    feedback,
    totalPages,
    hasActiveTask,
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
    submitDialog,
    deleteConfirm,
    confirmDelete,
    post,
  }
}
