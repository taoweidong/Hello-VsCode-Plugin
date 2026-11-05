import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  HttpTaskApiClient,
  StubTaskApiClient,
  TaskValidationError,
  createTaskApiClient,
  normalizeQuery,
} from '../../../extension/features/taskManager/taskApiClient'

/**
 * 任务管理后端（典型 CRUD 实例）：
 * - normalizeQuery 归一化（越界钳制）；
 * - StubTaskApiClient：内存表 + 延迟 + 分页过滤 + 状态机推进 + dispose；
 * - HttpTaskApiClient：REST /tasks 四方法（fetch 桩）。
 */

describe('normalizeQuery', () => {
  it('合法参数原样返回', () => {
    expect(normalizeQuery({ page: 2, pageSize: 20 })).toEqual({ page: 2, pageSize: 20 })
  })

  it('page 非正整数 → 1；pageSize 非正整数 → 10；pageSize 上限 100', () => {
    expect(normalizeQuery({ page: 0, pageSize: 0 }).page).toBe(1)
    expect(normalizeQuery({ page: -3, pageSize: 0 }).page).toBe(1)
    expect(normalizeQuery({ page: 1.5, pageSize: 0 }).page).toBe(1)
    expect(normalizeQuery({ page: 1, pageSize: 0 }).pageSize).toBe(10)
    expect(normalizeQuery({ page: 1, pageSize: 500 }).pageSize).toBe(100)
  })

  it('保留过滤字段', () => {
    const normalized = normalizeQuery({
      keyword: '编译',
      status: 'running',
      buildType: 'incremental',
      page: 1,
      pageSize: 10,
    })
    expect(normalized.keyword).toBe('编译')
    expect(normalized.status).toBe('running')
    expect(normalized.buildType).toBe('incremental')
  })
})

describe('StubTaskApiClient：CRUD', () => {
  let api: StubTaskApiClient

  beforeEach(() => {
    // startDelayMs 远大于用例时长：状态机不会在断言期间自动推进，任务保持 queued
    api = new StubTaskApiClient({ latencyMs: 0, startDelayMs: 60000, tickMs: 0, tickStep: 25 })
  })

  afterEach(() => {
    api.dispose()
    vi.restoreAllMocks()
  })

  it('create 创建任务并返回副本（返回对象不污染内部状态）', async () => {
    const created = await api.create({ name: '任务甲', branch: 'main', buildType: 'full' })
    expect(created).toMatchObject({
      name: '任务甲',
      branch: 'main',
      buildType: 'full',
      status: 'queued',
      progress: 0,
    })
    created.name = '被篡改'
    const listed = await api.query({ page: 1, pageSize: 10 })
    expect(listed.items[0].name).toBe('任务甲')
  })

  it('create 校验 name / branch：空值抛 TaskValidationError 且带 field', async () => {
    await expect(
      api.create({ name: '  ', branch: 'main', buildType: 'full' })
    ).rejects.toMatchObject({ name: 'TaskValidationError', field: 'name' })
    await expect(
      api.create({ name: '任务甲', branch: ' ', buildType: 'full' })
    ).rejects.toMatchObject({ name: 'TaskValidationError', field: 'branch' })
  })

  it('create 校验 buildType / notes 类型', async () => {
    await expect(
      api.create({ name: '任务甲', branch: 'main', buildType: 'patch' as never })
    ).rejects.toMatchObject({ field: 'buildType' })
    await expect(
      api.create({ name: '任务甲', branch: 'main', buildType: 'full', notes: 1 } as never)
    ).rejects.toMatchObject({ field: 'notes' })
  })

  it('update 编辑字段；不存在的任务抛 TaskValidationError(field=id)', async () => {
    const created = await api.create({ name: '任务甲', branch: 'main', buildType: 'full' })
    const updated = await api.update(created.id, { name: '任务乙', buildType: 'incremental' })
    expect(updated).toMatchObject({ name: '任务乙', branch: 'main', buildType: 'incremental' })

    await expect(api.update('missing', { name: 'x' })).rejects.toMatchObject({
      name: 'TaskValidationError',
      field: 'id',
    })
  })

  it('update 空值校验（name/branch 不能置空）', async () => {
    const created = await api.create({ name: '任务甲', branch: 'main', buildType: 'full' })
    await expect(api.update(created.id, { name: '  ' })).rejects.toMatchObject({ field: 'name' })
    await expect(api.update(created.id, { branch: '' })).rejects.toMatchObject({ field: 'branch' })
    await expect(api.update(created.id, { buildType: 'patch' as never })).rejects.toMatchObject({
      field: 'buildType',
    })
    await expect(api.update(created.id, { notes: 1 } as never)).rejects.toMatchObject({
      field: 'notes',
    })
  })

  it('remove 删除任务；不存在抛 TaskValidationError', async () => {
    const created = await api.create({ name: '任务甲', branch: 'main', buildType: 'full' })
    await api.remove(created.id)
    expect(await api.query({ page: 1, pageSize: 10 })).toMatchObject({ items: [], total: 0 })
    await expect(api.remove(created.id)).rejects.toMatchObject({ field: 'id' })
  })

  it('query 分页：total 为过滤后总数，items 为当前页切片', async () => {
    for (let i = 0; i < 15; i += 1) {
      await api.create({ name: `任务${i}`, branch: 'main', buildType: 'full' })
    }
    const first = await api.query({ page: 1, pageSize: 10 })
    expect(first.items).toHaveLength(10)
    expect(first.total).toBe(15)
    const second = await api.query({ page: 2, pageSize: 10 })
    expect(second.items).toHaveLength(5)
  })

  it('query 过滤：keyword / status / buildType 可组合', async () => {
    await api.create({ name: '编译A', branch: 'main', buildType: 'full' })
    await api.create({ name: '编译B', branch: 'dev', buildType: 'incremental' })
    await api.create({ name: '其他C', branch: 'main', buildType: 'full' })

    expect((await api.query({ page: 1, pageSize: 10, keyword: '编译' })).total).toBe(2)
    expect((await api.query({ page: 1, pageSize: 10, status: 'queued' })).total).toBe(3)
    expect((await api.query({ page: 1, pageSize: 10, buildType: 'incremental' })).total).toBe(1)
    expect(
      (await api.query({ page: 1, pageSize: 10, keyword: '编译', buildType: 'full' })).total
    ).toBe(1)
  })

  it('列表按创建时间倒序（新任务在前）', async () => {
    const first = await api.create({ name: '先', branch: 'main', buildType: 'full' })
    const second = await api.create({ name: '后', branch: 'main', buildType: 'full' })
    const page = await api.query({ page: 1, pageSize: 10 })
    expect(page.items.map((item) => item.id)).toEqual([second.id, first.id])
  })

  it('maxItems 截断内存表', async () => {
    const bounded = new StubTaskApiClient({ latencyMs: 0, maxItems: 2 })
    await bounded.create({ name: '甲', branch: 'main', buildType: 'full' })
    await bounded.create({ name: '乙', branch: 'main', buildType: 'full' })
    await bounded.create({ name: '丙', branch: 'main', buildType: 'full' })
    expect(await bounded.query({ page: 1, pageSize: 100 })).toMatchObject({ total: 2 })
    bounded.dispose()
  })

  it('dispose 后查询返回空页；状态机不再推进', async () => {
    const created = await api.create({ name: '任务甲', branch: 'main', buildType: 'full' })
    api.dispose()
    expect(await api.query({ page: 1, pageSize: 10 })).toMatchObject({ items: [], total: 0 })
    // 状态机不再推进：advance 入口在 dispose 后被跳过
    expect((await api.query({ page: 1, pageSize: 10 })).total).toBe(0)
    // dispose 只清定时器，内存表仍在（update/remove 语义不因 dispose 改变）
    await expect(api.update(created.id, { name: '任务乙' })).resolves.toMatchObject({
      name: '任务乙',
    })
  })
})

describe('StubTaskApiClient：状态机推进', () => {
  let api: StubTaskApiClient

  beforeEach(() => {
    vi.useFakeTimers()
    api = new StubTaskApiClient({
      latencyMs: 0,
      startDelayMs: 100,
      tickMs: 50,
      tickStep: 30,
    })
  })

  afterEach(() => {
    api.dispose()
    vi.useRealTimers()
  })

  /** query / create 自身也走 setTimeout 延迟：发起后推进 1ms 让延迟定时器落定。 */
  async function queryNow() {
    const promise = api.query({ page: 1, pageSize: 10 })
    await vi.advanceTimersByTimeAsync(1)
    return await promise
  }

  async function createNow(payload: Parameters<StubTaskApiClient['create']>[0]) {
    const promise = api.create(payload)
    await vi.advanceTimersByTimeAsync(1)
    return await promise
  }

  it('queued → running → 进度 100 → success', async () => {
    const created = await createNow({ name: '任务甲', branch: 'main', buildType: 'full' })
    expect(created.status).toBe('queued')

    await vi.advanceTimersByTimeAsync(100)
    let running = (await queryNow()).items[0]
    expect(running.status).toBe('running')
    expect(running.progress).toBe(10)

    await vi.advanceTimersByTimeAsync(50)
    expect((await queryNow()).items[0].progress).toBe(40)
    await vi.advanceTimersByTimeAsync(50)
    expect((await queryNow()).items[0].progress).toBe(70)

    await vi.advanceTimersByTimeAsync(50)
    const done = (await queryNow()).items[0]
    expect(done.status).toBe('success')
    expect(done.progress).toBe(100)
    expect(done.finishedAt).toBeDefined()
    expect(done.message).toBe('构建成功。')
  })

  it('name / branch 含 fail → failed 且带失败信息', async () => {
    await createNow({ name: 'fail-case', branch: 'main', buildType: 'full' })
    await vi.advanceTimersByTimeAsync(100)
    await vi.advanceTimersByTimeAsync(50)
    await vi.advanceTimersByTimeAsync(50)
    await vi.advanceTimersByTimeAsync(50)
    const done = (await queryNow()).items[0]
    expect(done.status).toBe('failed')
    expect(done.progress).toBe(100)
    expect(done.message).toContain('fail')
  })

  it('dispose 后定时器不再推进', async () => {
    await createNow({ name: '任务甲', branch: 'main', buildType: 'full' })
    api.dispose()
    await vi.advanceTimersByTimeAsync(1000)
    expect((await api.query({ page: 1, pageSize: 10 })).items).toHaveLength(0)
  })
})

describe('HttpTaskApiClient', () => {
  let api: HttpTaskApiClient

  function mockFetch(handler: (input: string, init?: RequestInit) => unknown): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => handler(input, init))
    )
  }

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('空 baseUrl 构造抛错', () => {
    expect(() => new HttpTaskApiClient('   ')).toThrow('HttpTaskApiClient')
  })

  it('query：拼 query 串（keyword / status / buildType / page / pageSize）并解析 TaskPage', async () => {
    api = new HttpTaskApiClient('https://api.test')
    mockFetch(() => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ items: [], total: 0, page: 1, pageSize: 10 }),
    }))
    const page = await api.query({
      keyword: '编译',
      status: 'running',
      buildType: 'incremental',
      page: 2,
      pageSize: 20,
    })
    const input = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(input).toBe(
      'https://api.test/tasks?keyword=%E7%BC%96%E8%AF%91&status=running&buildType=incremental&page=2&pageSize=20'
    )
    expect(page).toMatchObject({ total: 0, page: 1, pageSize: 10 })
  })

  it('query 跳过 all 过滤项', async () => {
    api = new HttpTaskApiClient('https://api.test/')
    mockFetch(() => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ items: [], total: 0, page: 1, pageSize: 10 }),
    }))
    await api.query({ status: 'all', buildType: 'all', page: 1, pageSize: 10 })
    const input = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(input).toBe('https://api.test/tasks?page=1&pageSize=10')
  })

  it('create / update / remove：POST/PUT/DELETE 请求体与 204 处理', async () => {
    api = new HttpTaskApiClient('https://api.test')
    const calls: Array<{ method: string; input: string; init?: RequestInit }> = []
    const taskWire = {
      id: 'task-1',
      name: '甲',
      branch: 'main',
      buildType: 'full',
      status: 'queued',
      progress: 0,
    }
    mockFetch((input, init) => {
      calls.push({ method: String(init?.method), input, init })
      const isDelete = init?.method === 'DELETE'
      return {
        ok: true,
        status: isDelete ? 204 : 200,
        statusText: isDelete ? 'No Content' : 'OK',
        json: async () => taskWire,
      }
    })
    await api.create({ name: '甲', branch: 'main', buildType: 'full' })
    await api.update('task-1', { name: '乙' })
    await api.remove('task-1')

    expect(calls[0]).toMatchObject({ method: 'POST', input: 'https://api.test/tasks' })
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      name: '甲',
      branch: 'main',
      buildType: 'full',
    })
    expect(calls[1]).toMatchObject({ method: 'PUT', input: 'https://api.test/tasks/task-1' })
    expect(calls[2]).toMatchObject({ method: 'DELETE', input: 'https://api.test/tasks/task-1' })
  })

  it('响应契约校验：query 返回缺 items / 分页字段时抛带 method+path 的可诊断错误', async () => {
    api = new HttpTaskApiClient('https://api.test')
    mockFetch(() => ({ ok: true, status: 200, statusText: 'OK', json: async () => ({ foo: 1 }) }))
    await expect(api.query({ page: 1, pageSize: 10 })).rejects.toThrow(/GET \/tasks.*不符合契约/)
    mockFetch(() => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ items: 'nope', total: 0, page: 1, pageSize: 10 }),
    }))
    await expect(api.query({ page: 1, pageSize: 10 })).rejects.toThrow('items 不是数组')
    mockFetch(() => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ items: [], total: 'many', page: 1, pageSize: 10 }),
    }))
    await expect(api.query({ page: 1, pageSize: 10 })).rejects.toThrow('分页字段')
  })

  it('响应契约校验：条目字段畸形（status 未知 / progress 非数字）逐项定位拒绝', async () => {
    api = new HttpTaskApiClient('https://api.test')
    mockFetch(() => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        items: [
          {
            id: 't1',
            name: '甲',
            branch: 'main',
            buildType: 'full',
            status: 'boom',
            progress: 0,
          },
        ],
        total: 1,
        page: 1,
        pageSize: 10,
      }),
    }))
    await expect(api.query({ page: 1, pageSize: 10 })).rejects.toThrow(/items\[0\].*status/)
    mockFetch(() => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        items: [{ id: 't2', name: '乙', branch: 'main', buildType: 'full', status: 'queued' }],
        total: 1,
        page: 1,
        pageSize: 10,
      }),
    }))
    await expect(api.query({ page: 1, pageSize: 10 })).rejects.toThrow(/items\[0\].*progress/)
  })

  it('响应契约校验：create / update 返回非任务对象时抛带 method+path 的契约错误', async () => {
    api = new HttpTaskApiClient('https://api.test')
    mockFetch(() => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ unexpected: true }),
    }))
    await expect(api.create({ name: '甲', branch: 'main', buildType: 'full' })).rejects.toThrow(
      /POST \/tasks.*不符合契约/
    )
    await expect(api.update('t1', { name: '乙' })).rejects.toThrow(/PUT \/tasks.*不符合契约/)
  })

  it('非 ok 响应抛错；id 编码安全', async () => {
    api = new HttpTaskApiClient('https://api.test')
    mockFetch((input) => {
      if (input.endsWith('task%2F2')) {
        return { ok: false, status: 500, statusText: 'Server Error' }
      }
      return { ok: true, status: 200, statusText: 'OK', json: async () => ({}) }
    })
    await expect(api.update('task/2', { name: 'x' })).rejects.toThrow('任务接口 PUT')
  })
})

describe('createTaskApiClient', () => {
  it('baseUrl 留空 → stub；非空 → http', () => {
    expect(createTaskApiClient('') instanceof StubTaskApiClient).toBe(true)
    expect(createTaskApiClient('   ') instanceof StubTaskApiClient).toBe(true)
    expect(createTaskApiClient('https://api.test') instanceof HttpTaskApiClient).toBe(true)
  })
})

describe('TaskValidationError', () => {
  it('是 Error 子类且携带 field', () => {
    const err = new TaskValidationError('名称不能为空', 'name')
    expect(err).toBeInstanceOf(Error)
    expect(err.field).toBe('name')
    expect(err.name).toBe('TaskValidationError')
  })
})
