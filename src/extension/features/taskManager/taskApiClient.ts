/**
 * 任务管理后端接口（典型 CRUD 实例）。
 *
 * - **打桩优先**：`baseUrl` 留空（默认）时使用 `StubTaskApiClient`——内存任务表 +
 *   模拟网络延迟 + 进度推进，前端无需任何改动即可体验完整 CRUD 闭环；
 * - **预留真实接口**：配置 `extStarter.taskApiBaseUrl` 后切换 `HttpTaskApiClient`，
 *   服务端契约 = 本文件的 `TaskCreatePayload` / `TaskItem`（JSON，REST）：
 *     - `GET    /tasks?keyword=&status=&buildType=&page=&pageSize=` → `TaskPage`
 *     - `POST   /tasks`（`TaskCreatePayload`）→ `TaskItem`（201）
 *     - `PUT    /tasks/:id`（`TaskUpdatePayload`）→ `TaskItem`
 *     - `DELETE /tasks/:id` → 204
 *
 * 本文件不 import vscode——宿主侧的 `vscode` 依赖由调用方注入，单测可直接构造。
 */

/** 任务状态（与 protocol 的 TaskItemStatusWire 对齐）。 */
export type TaskStatus = 'queued' | 'running' | 'success' | 'failed'

/** 构建类型。 */
export type TaskBuildType = 'full' | 'incremental'

/** 任务行（列表主显示字段为 name）。 */
export interface TaskItem {
  id: string
  name: string
  branch: string
  buildType: TaskBuildType
  status: TaskStatus
  /** 进度 0-100（queued 为 0） */
  progress: number
  notes?: string
  /** 失败原因 / 完成摘要 */
  message?: string
  /** ISO 时间 */
  createdAt: string
  finishedAt?: string
}

/** 列表查询参数（page 从 1 开始）。 */
export interface TaskQuery {
  keyword?: string
  status?: TaskStatus | 'all'
  buildType?: TaskBuildType | 'all'
  page: number
  pageSize: number
}

/** 分页结果。 */
export interface TaskPage {
  items: TaskItem[]
  total: number
  page: number
  pageSize: number
}

/** 新建任务载荷。 */
export interface TaskCreatePayload {
  name: string
  branch: string
  buildType: TaskBuildType
  notes?: string
}

/** 编辑任务载荷（至少一个字段；全部省略视为无变更）。 */
export type TaskUpdatePayload = Partial<Pick<TaskItem, 'name' | 'branch' | 'buildType' | 'notes'>>

/** 表单校验失败（携带 field 供页面定位控件）。 */
export class TaskValidationError extends Error {
  readonly field?: string
  constructor(message: string, field?: string) {
    super(message)
    this.name = 'TaskValidationError'
    this.field = field
  }
}

/** 后端任务接口（宿主面板与树视图只依赖本接口）。 */
export interface TaskApiClient {
  /** 'stub' 内存打桩 / 'http' 真实接口 */
  readonly mode: 'stub' | 'http'
  /** 分页查询（过滤 + 排序 + 分页）。 */
  query(query: TaskQuery): Promise<TaskPage>
  /** 新建任务。 */
  create(payload: TaskCreatePayload): Promise<TaskItem>
  /** 编辑任务（不存在时抛 TaskValidationError('未找到该任务。', 'id')）。 */
  update(id: string, payload: TaskUpdatePayload): Promise<TaskItem>
  /** 删除任务。 */
  remove(id: string): Promise<void>
  /** 释放内部定时器等资源（幂等）。 */
  dispose(): void
}

/** 打桩模拟参数（可注入，便于单测与可预测性）。 */
export interface StubTaskApiOptions {
  /** 单次请求的模拟网络延迟（默认 120ms）。 */
  latencyMs?: number
  /** 任务创建后自动进入 running 的延迟（默认 800ms）。 */
  startDelayMs?: number
  /** 进度推进间隔（默认 500ms）。 */
  tickMs?: number
  /** 每档进度增量（默认 25）。 */
  tickStep?: number
  /** 列表内存上限（默认 200）。 */
  maxItems?: number
}

const DEFAULT_LATENCY_MS = 120
const DEFAULT_START_DELAY_MS = 800
const DEFAULT_TICK_MS = 500
const DEFAULT_TICK_STEP = 25
const DEFAULT_MAX_ITEMS = 200
const HTTP_TIMEOUT_MS = 10_000

/** 分页参数归一化：page ≥ 1，pageSize ∈ [1, 100]。 */
export function normalizeQuery(
  query: TaskQuery
): Required<Pick<TaskQuery, 'page' | 'pageSize'>> & TaskQuery {
  const page = Number.isInteger(query.page) && query.page > 0 ? query.page : 1
  const rawSize = Number.isInteger(query.pageSize) && query.pageSize > 0 ? query.pageSize : 10
  return {
    ...query,
    page,
    pageSize: Math.min(100, rawSize),
  }
}

/** 是否包含「fail」关键字（用于演示失败路径；大小写不敏感）。 */
function shouldFail(name: string, branch: string): boolean {
  return `${name} ${branch}`.toLowerCase().includes('fail')
}

/** 深拷贝（保留结构，去掉运行时附加字段，避免调用方误改内部状态）。 */
function clone(item: TaskItem): TaskItem {
  return { ...item }
}

/**
 * 内存打桩实现：典型 CRUD + 分页 + 状态机推进。
 * 所有异步延迟均可注入，单测可传 0 实现确定性断言。
 */
export class StubTaskApiClient implements TaskApiClient {
  readonly mode = 'stub' as const
  private items: TaskItem[] = []
  private timers = new Set<ReturnType<typeof setTimeout>>()
  private seq = 0
  private disposed = false
  private readonly latencyMs: number
  private readonly startDelayMs: number
  private readonly tickMs: number
  private readonly tickStep: number
  private readonly maxItems: number

  constructor(options: StubTaskApiOptions = {}) {
    this.latencyMs = options.latencyMs ?? DEFAULT_LATENCY_MS
    this.startDelayMs = options.startDelayMs ?? DEFAULT_START_DELAY_MS
    this.tickMs = options.tickMs ?? DEFAULT_TICK_MS
    this.tickStep = options.tickStep ?? DEFAULT_TICK_STEP
    this.maxItems = options.maxItems ?? DEFAULT_MAX_ITEMS
  }

  /** 以 setTimeout 模拟网络延迟；超时/销毁后不再推进。 */
  private delay(): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.timers.delete(timer)
        resolve()
      }, this.latencyMs)
      this.timers.add(timer)
    })
  }

  private schedule(delayMs: number, run: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      run()
    }, delayMs)
    this.timers.add(timer)
  }

  async query(query: TaskQuery): Promise<TaskPage> {
    if (this.disposed) {
      return { items: [], total: 0, page: 1, pageSize: 10 }
    }
    await this.delay()
    const normalized = normalizeQuery(query)
    const keyword = normalized.keyword?.trim().toLowerCase()
    const filtered = this.items.filter((item) => {
      if (normalized.status && normalized.status !== 'all' && item.status !== normalized.status) {
        return false
      }
      if (
        normalized.buildType &&
        normalized.buildType !== 'all' &&
        item.buildType !== normalized.buildType
      ) {
        return false
      }
      if (keyword) {
        const haystack = `${item.name} ${item.branch} ${item.notes ?? ''}`.toLowerCase()
        if (!haystack.includes(keyword)) {
          return false
        }
      }
      return true
    })
    // 新任务在前，保证列表展示稳定（创建时间倒序）。
    filtered.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
    const start = (normalized.page - 1) * normalized.pageSize
    return {
      items: filtered.slice(start, start + normalized.pageSize).map(clone),
      total: filtered.length,
      page: normalized.page,
      pageSize: normalized.pageSize,
    }
  }

  async create(payload: TaskCreatePayload): Promise<TaskItem> {
    await this.delay()
    const name = typeof payload.name === 'string' ? payload.name.trim() : ''
    const branch = typeof payload.branch === 'string' ? payload.branch.trim() : ''
    const buildType = payload.buildType ?? 'full'
    if (!name) {
      throw new TaskValidationError('任务名称不能为空。', 'name')
    }
    if (!branch) {
      throw new TaskValidationError('分支名不能为空。', 'branch')
    }
    if (buildType !== 'full' && buildType !== 'incremental') {
      throw new TaskValidationError('构建类型无效。', 'buildType')
    }
    if (payload.notes !== undefined && typeof payload.notes !== 'string') {
      throw new TaskValidationError('备注格式无效。', 'notes')
    }
    const item: TaskItem = {
      id: `task-${Date.now()}-${++this.seq}`,
      name,
      branch,
      buildType,
      status: 'queued',
      progress: 0,
      notes: payload.notes,
      createdAt: new Date().toISOString(),
    }
    this.items.unshift(item)
    if (this.items.length > this.maxItems) {
      this.items.length = this.maxItems
    }
    this.schedule(this.startDelayMs, () => this.advance(item.id))
    return clone(item)
  }

  async update(id: string, payload: TaskUpdatePayload): Promise<TaskItem> {
    await this.delay()
    const index = this.items.findIndex((item) => item.id === id)
    if (index < 0) {
      throw new TaskValidationError('未找到该任务。', 'id')
    }
    const current = this.items[index]
    const next: TaskItem = { ...current }
    if (payload.name !== undefined) {
      const name = payload.name.trim()
      if (!name) {
        throw new TaskValidationError('任务名称不能为空。', 'name')
      }
      next.name = name
    }
    if (payload.branch !== undefined) {
      const branch = payload.branch.trim()
      if (!branch) {
        throw new TaskValidationError('分支名不能为空。', 'branch')
      }
      next.branch = branch
    }
    if (payload.buildType !== undefined) {
      if (payload.buildType !== 'full' && payload.buildType !== 'incremental') {
        throw new TaskValidationError('构建类型无效。', 'buildType')
      }
      next.buildType = payload.buildType
    }
    if (payload.notes !== undefined && typeof payload.notes !== 'string') {
      throw new TaskValidationError('备注格式无效。', 'notes')
    } else if (payload.notes !== undefined) {
      next.notes = payload.notes
    }
    this.items[index] = next
    return clone(next)
  }

  async remove(id: string): Promise<void> {
    await this.delay()
    const index = this.items.findIndex((item) => item.id === id)
    if (index < 0) {
      throw new TaskValidationError('未找到该任务。', 'id')
    }
    this.items.splice(index, 1)
  }

  /** 状态机推进：queued → running → 进度 → success/failed。 */
  private advance(id: string): void {
    if (this.disposed) {
      return
    }
    const item = this.items.find((entry) => entry.id === id)
    if (!item || item.status !== 'queued') {
      return
    }
    item.status = 'running'
    item.progress = 10
    const tick = (): void => {
      const current = this.items.find((entry) => entry.id === id)
      if (!current || current.status !== 'running') {
        return
      }
      const nextProgress = current.progress + this.tickStep
      if (nextProgress >= 100) {
        const failed = shouldFail(current.name, current.branch)
        current.progress = 100
        current.status = failed ? 'failed' : 'success'
        current.message = failed ? '构建失败：示例失败分支（名称含 fail 触发）。' : '构建成功。'
        current.finishedAt = new Date().toISOString()
        return
      }
      current.progress = nextProgress
      this.schedule(this.tickMs, tick)
    }
    this.schedule(this.tickMs, tick)
  }

  dispose(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    for (const timer of this.timers) {
      clearTimeout(timer)
    }
    this.timers.clear()
  }
}

/** 响应契约校验失败（带 method/path 的可诊断错误，避免下游无上下文 TypeError）。 */
function taskContractError(method: string, path: string, detail: string): Error {
  return new Error(`任务接口 ${method} ${path} 返回不符合契约的数据：${detail}`)
}

/** TaskItem 最小结构校验，返回问题清单（空数组 = 通过）。 */
function taskItemProblems(value: unknown): string[] {
  if (typeof value !== 'object' || value === null) {
    return [`期望任务对象，得到 ${value === null ? 'null' : typeof value}`]
  }
  const v = value as Record<string, unknown>
  const problems: string[] = []
  if (typeof v.id !== 'string' || v.id.length === 0) {
    problems.push('id 非法')
  }
  if (typeof v.name !== 'string') {
    problems.push('name 非法')
  }
  if (typeof v.branch !== 'string') {
    problems.push('branch 非法')
  }
  if (v.buildType !== 'full' && v.buildType !== 'incremental') {
    problems.push('buildType 非法')
  }
  if (typeof v.status !== 'string' || !TASK_STATUS.has(v.status)) {
    problems.push('status 非法')
  }
  if (typeof v.progress !== 'number' || !Number.isFinite(v.progress)) {
    problems.push('progress 非法')
  }
  return problems
}

/** TaskItem 契约断言（第五轮评估 P1：恢复旧实现的响应字段级校验）。 */
function assertTaskItemShape(
  value: unknown,
  method: string,
  path: string
): asserts value is TaskItem {
  const problems = taskItemProblems(value)
  if (problems.length > 0) {
    throw taskContractError(method, path, problems.join('；'))
  }
}

/** TaskPage 契约断言：items 数组逐项校验 + 分页字段。 */
function assertTaskPageShape(
  value: unknown,
  method: string,
  path: string
): asserts value is TaskPage {
  if (typeof value !== 'object' || value === null) {
    throw taskContractError(
      method,
      path,
      `期望分页对象，得到 ${value === null ? 'null' : typeof value}`
    )
  }
  const v = value as Record<string, unknown>
  if (!Array.isArray(v.items)) {
    throw taskContractError(method, path, 'items 不是数组')
  }
  const badIndex = v.items.findIndex((item) => taskItemProblems(item).length > 0)
  if (badIndex >= 0) {
    const problems = taskItemProblems(v.items[badIndex]).join('；')
    throw taskContractError(method, path, `items[${badIndex}] ${problems}`)
  }
  if (typeof v.total !== 'number' || typeof v.page !== 'number' || typeof v.pageSize !== 'number') {
    throw taskContractError(method, path, '分页字段（total / page / pageSize）非法')
  }
}

const TASK_STATUS = new Set(['queued', 'running', 'success', 'failed'])

/** 真实 HTTP 实现：REST /tasks。 */
export class HttpTaskApiClient implements TaskApiClient {
  readonly mode = 'http' as const
  private disposed = false

  constructor(private readonly baseUrl: string) {
    if (!baseUrl.trim()) {
      throw new Error('HttpTaskApiClient 需要非空 baseUrl')
    }
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (this.disposed) {
      throw new Error('任务接口客户端已释放，无法发起请求。')
    }
    const response = await fetch(`${this.baseUrl.replace(/\/+$/, '')}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    })
    if (!response.ok) {
      throw new Error(`任务接口 ${method} ${path} 失败：${response.status} ${response.statusText}`)
    }
    if (response.status === 204) {
      return undefined as T
    }
    return (await response.json()) as T
  }

  async query(query: TaskQuery): Promise<TaskPage> {
    const normalized = normalizeQuery(query)
    const search = new URLSearchParams()
    if (normalized.keyword) {
      search.set('keyword', normalized.keyword)
    }
    if (normalized.status && normalized.status !== 'all') {
      search.set('status', normalized.status)
    }
    if (normalized.buildType && normalized.buildType !== 'all') {
      search.set('buildType', normalized.buildType)
    }
    search.set('page', String(normalized.page))
    search.set('pageSize', String(normalized.pageSize))
    const page = await this.request<unknown>('GET', `/tasks?${search.toString()}`)
    assertTaskPageShape(page, 'GET', '/tasks')
    return page
  }

  async create(payload: TaskCreatePayload): Promise<TaskItem> {
    const item = await this.request<unknown>('POST', '/tasks', payload)
    assertTaskItemShape(item, 'POST', '/tasks')
    return item
  }

  async update(id: string, payload: TaskUpdatePayload): Promise<TaskItem> {
    const path = `/tasks/${encodeURIComponent(id)}`
    const item = await this.request<unknown>('PUT', path, payload)
    assertTaskItemShape(item, 'PUT', path)
    return item
  }

  async remove(id: string): Promise<void> {
    await this.request<void>('DELETE', `/tasks/${encodeURIComponent(id)}`)
  }

  dispose(): void {
    this.disposed = true
  }
}

/** 按 baseUrl 是否为空切换打桩 / 真实接口。 */
export function createTaskApiClient(baseUrl: string): TaskApiClient {
  return baseUrl.trim() ? new HttpTaskApiClient(baseUrl.trim()) : new StubTaskApiClient()
}
