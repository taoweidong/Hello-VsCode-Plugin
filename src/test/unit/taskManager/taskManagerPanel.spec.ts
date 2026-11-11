import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as vscode from 'vscode'
import { __resetStubs, Uri } from '../stubs/vscode'
import { WebviewController } from '../../../webview/host/webviewController'
import {
  TaskManagerPanel,
  createTaskManagerDeps,
  createTaskManagerServices,
  toTaskItemWire,
  toTaskPageWire,
  toTaskQueryWire,
  type TaskManagerServices,
} from '../../../extension/features/taskManager/taskManagerPanel'
import {
  StubTaskApiClient,
  type TaskApiClient,
  type TaskPage,
  type TaskQuery,
} from '../../../extension/features/taskManager/taskApiClient'
import { lastPosted, makePanelDeps, type FakePanel } from '../panels/support/fakePanel'

/**
 * 任务管理宿主面板（v2.6 改造）：
 * - init 携带任务表单 Schema；
 * - taskListRequest → api.query → 回 taskList 分页页（含过滤条件透传）；
 * - submit（新建/编辑）→ api.create/update → 重查（新建回第 1 页）；
 * - taskDelete → api.remove → 重查；
 * - 失败回 error（err.field 随行）。
 */

const context = {
  subscriptions: [],
  extensionUri: Uri.file(process.cwd()),
} as unknown as vscode.ExtensionContext

function makeServices() {
  const api = new StubTaskApiClient({ latencyMs: 0, startDelayMs: 0, tickMs: 0, tickStep: 25 })
  const output = { appendLine: vi.fn() }
  const onAfterChange = vi.fn()
  const services: TaskManagerServices = {
    api,
    output: output as unknown as vscode.OutputChannel,
    onAfterChange,
  }
  return { services, api, output, onAfterChange }
}

/** 打开面板并完成 ready → init 握手。 */
async function openPanel(
  services: TaskManagerServices,
  panelDeps = makePanelDeps()
): Promise<FakePanel> {
  TaskManagerPanel.configure(context)
  TaskManagerPanel.createOrShow(services, panelDeps.deps)
  const panel = panelDeps.panels[0]
  panel.webview.__emit({ type: 'ready' })
  await vi.waitFor(() => {
    expect(lastPosted(panel, 'init')).toBeDefined()
  })
  return panel
}

beforeEach(() => {
  __resetStubs()
  WebviewController.__resetForTest()
})

afterEach(() => {
  WebviewController.__resetForTest()
  vi.restoreAllMocks()
})

describe('taskManagerPanel：init 与列表查询', () => {
  it('init 携带任务表单 Schema（name / branch / buildType / notes）', async () => {
    const { services } = makeServices()
    const panel = await openPanel(services)
    const init = lastPosted(panel, 'init')
    expect(init?.extra).toMatchObject({ mode: 'taskManager' })
    expect(init?.schema).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'name', type: 'text' }),
        expect.objectContaining({ key: 'branch', type: 'text' }),
        expect.objectContaining({ key: 'buildType', type: 'select' }),
        expect.objectContaining({ key: 'notes', type: 'textarea' }),
      ])
    )
  })

  it('taskListRequest：透传查询条件，回 taskList 分页页', async () => {
    const { services } = makeServices()
    const panel = await openPanel(services)
    panel.webview.__emit({
      type: 'taskListRequest',
      query: {
        keyword: '编译',
        status: 'running',
        buildType: 'incremental',
        page: 2,
        pageSize: 20,
      },
    })
    await vi.waitFor(() => {
      expect(lastPosted(panel, 'taskList')).toBeDefined()
    })
    const page = lastPosted(panel, 'taskList')
    expect(page?.page).toMatchObject({ page: 2, pageSize: 20, total: 0, items: [] })
  })

  it('查询失败：回 error 并记录日志（不静默）', async () => {
    const { services } = makeServices()
    services.api.query = vi.fn(async () => {
      throw new Error('网络中断')
    })
    const panel = await openPanel(services)
    panel.webview.__emit({ type: 'taskListRequest', query: { page: 1, pageSize: 10 } })
    await vi.waitFor(() => {
      expect(lastPosted(panel, 'error')).toBeDefined()
    })
    expect(lastPosted(panel, 'error')?.message).toContain('网络中断')
    expect(services.output.appendLine).toHaveBeenCalledWith(expect.stringContaining('网络中断'))
  })
})

describe('taskManagerPanel：submit（增 / 改）', () => {
  it('新建：调 api.create 并回 submitAck；列表刷新到第 1 页', async () => {
    const { services, api } = makeServices()
    const panel = await openPanel(services)
    const create = vi.spyOn(api, 'create')
    panel.webview.__emit({
      type: 'submit',
      draft: { name: '任务甲', branch: 'main', buildType: 'full' },
    })
    await vi.waitFor(() => {
      expect(lastPosted(panel, 'submitAck')).toBeDefined()
    })
    expect(create).toHaveBeenCalledWith({
      name: '任务甲',
      branch: 'main',
      buildType: 'full',
      notes: undefined,
    })
    const page = lastPosted(panel, 'taskList')
    expect(page?.page).toMatchObject({
      page: 1,
      items: [expect.objectContaining({ name: '任务甲' })],
    })
    expect(services.onAfterChange).toHaveBeenCalled()
  })

  it('编辑：draft.id 存在时调 api.update 并沿用原查询条件', async () => {
    const { services, api } = makeServices()
    const panel = await openPanel(services)
    const created = await api.create({ name: '任务甲', branch: 'main', buildType: 'full' })
    // 先按关键字查一次（建立 lastQuery），再编辑，验证沿用条件
    panel.webview.__emit({
      type: 'taskListRequest',
      query: { keyword: '甲', page: 1, pageSize: 10 },
    })
    await vi.waitFor(() => expect(lastPosted(panel, 'taskList')).toBeDefined())

    const update = vi.spyOn(api, 'update')
    const query = vi.spyOn(api, 'query')
    panel.webview.__emit({
      type: 'submit',
      draft: { id: created.id, name: '任务乙', branch: 'dev', buildType: 'incremental' },
    })
    await vi.waitFor(() => {
      expect(update).toHaveBeenCalled()
    })
    expect(update).toHaveBeenCalledWith(created.id, {
      name: '任务乙',
      branch: 'dev',
      buildType: 'incremental',
      notes: undefined,
    })
    // 编辑后重新查询沿用原查询条件（keyword=甲, page=1，而非重置到第 1 页空条件）
    await vi.waitFor(() => {
      expect(query).toHaveBeenCalledWith(
        expect.objectContaining({ keyword: '甲', page: 1, pageSize: 10 })
      )
    })
  })

  it('校验失败：回 error 且 field 定位（name 空）', async () => {
    const { services, api } = makeServices()
    const panel = await openPanel(services)
    const create = vi.spyOn(api, 'create')
    panel.webview.__emit({
      type: 'submit',
      draft: { name: '  ', branch: 'main', buildType: 'full' },
    })
    await vi.waitFor(() => {
      expect(lastPosted(panel, 'error')).toBeDefined()
    })
    expect(lastPosted(panel, 'error')).toMatchObject({ field: 'name' })
    expect(create).not.toHaveBeenCalled()
  })

  it('校验失败：branch 空同理定位（field=branch，不触发 create / update）', async () => {
    const { services, api } = makeServices()
    const panel = await openPanel(services)
    const create = vi.spyOn(api, 'create')
    const update = vi.spyOn(api, 'update')
    panel.webview.__emit({
      type: 'submit',
      draft: { name: '任务甲', branch: '', buildType: 'full' },
    })
    await vi.waitFor(() => {
      expect(lastPosted(panel, 'error')).toMatchObject({ field: 'branch' })
    })
    expect(create).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
  })

  it('编辑失败：api.update 抛错回 error（不产生 submitAck），err.field 随行', async () => {
    const { services, api } = makeServices()
    const panel = await openPanel(services)
    vi.spyOn(api, 'update').mockRejectedValue(
      Object.assign(new Error('任务不存在'), { field: 'name' })
    )
    panel.webview.__emit({
      type: 'submit',
      draft: { id: 'task-x', name: '任务甲', branch: 'main', buildType: 'full' },
    })
    await vi.waitFor(() => {
      expect(lastPosted(panel, 'error')).toBeDefined()
    })
    expect(lastPosted(panel, 'error')).toMatchObject({ message: '任务不存在', field: 'name' })
    expect(lastPosted(panel, 'submitAck')).toBeUndefined()
  })

  it('提交成功但列表刷新失败：仍回 submitAck，仅记日志', async () => {
    const { services, api } = makeServices()
    const panel = await openPanel(services)
    vi.spyOn(api, 'create').mockResolvedValue({
      id: 'task-9',
      name: '任务甲',
      branch: 'main',
      buildType: 'full',
      status: 'queued',
      progress: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    vi.spyOn(api, 'query').mockRejectedValue(new Error('刷新失败'))
    panel.webview.__emit({
      type: 'submit',
      draft: { name: '任务甲', branch: 'main', buildType: 'full' },
    })
    await vi.waitFor(() => expect(lastPosted(panel, 'submitAck')).toBeDefined())
    expect(services.output.appendLine).toHaveBeenCalledWith(
      expect.stringContaining('创建成功但任务列表刷新失败')
    )
  })
})

describe('taskManagerPanel：删除', () => {
  it('taskDelete：调 api.remove 并重查', async () => {
    const { services, api } = makeServices()
    const panel = await openPanel(services)
    const created = await api.create({ name: '任务甲', branch: 'main', buildType: 'full' })
    panel.webview.__emit({ type: 'taskDelete', id: created.id })
    await vi.waitFor(() => {
      expect(lastPosted(panel, 'taskList')?.page).toMatchObject({ total: 0 })
    })
    expect(services.onAfterChange).toHaveBeenCalled()
  })

  it('删除不存在任务：回 error', async () => {
    const { services } = makeServices()
    const panel = await openPanel(services)
    panel.webview.__emit({ type: 'taskDelete', id: 'missing' })
    await vi.waitFor(() => {
      expect(lastPosted(panel, 'error')).toBeDefined()
    })
    expect(lastPosted(panel, 'error')?.message).toContain('删除任务失败')
    expect(services.output.appendLine).toHaveBeenCalledWith(expect.stringContaining('删除任务失败'))
  })
})

describe('taskManagerPanel：并发防护与页码钳制', () => {
  /** 可控 query 桩：query 调用挂起，由用例逐个放行应答（模拟乱序 / 慢接口）。 */
  function makeDeferredQueryApi() {
    const pending: Array<{ query: TaskQuery; resolve: (page: TaskPage) => void }> = []
    const api: TaskApiClient = {
      mode: 'stub',
      query: (query: TaskQuery) =>
        new Promise<TaskPage>((resolve) => {
          pending.push({ query, resolve })
        }),
      create: () => Promise.reject(new Error('用例未用到 create')),
      update: () => Promise.reject(new Error('用例未用到 update')),
      remove: () => Promise.resolve(),
      dispose: () => {},
    }
    return { api, pending }
  }

  it('过期应答丢弃：慢的旧查询应答不覆盖新查询结果（请求序号防护）', async () => {
    const { api, pending } = makeDeferredQueryApi()
    const output = { appendLine: vi.fn() }
    const services: TaskManagerServices = { api, output: output as unknown as vscode.OutputChannel }
    const panel = await openPanel(services)

    panel.webview.__emit({ type: 'taskListRequest', query: { page: 1, pageSize: 10 } })
    panel.webview.__emit({ type: 'taskListRequest', query: { page: 2, pageSize: 10 } })
    expect(pending).toHaveLength(2)

    // 新查询（第 2 页）先返回：入页面
    pending[1].resolve({ items: [], total: 0, page: 2, pageSize: 10 })
    await vi.waitFor(() => {
      expect(lastPosted(panel, 'taskList')).toMatchObject({ page: { page: 2 } })
    })

    // 旧查询（第 1 页）后返回：丢弃，不覆盖第 2 页，仅记日志
    pending[0].resolve({ items: [], total: 99, page: 1, pageSize: 10 })
    await vi.waitFor(() => {
      expect(output.appendLine).toHaveBeenCalledWith(expect.stringContaining('丢弃过期'))
    })
    expect(lastPosted(panel, 'taskList')).toMatchObject({ page: { page: 2 } })
  })

  it('onAfterChange 仅写操作触发：纯读 taskListRequest 不驱动树刷新', async () => {
    const { services } = makeServices()
    const panel = await openPanel(services)
    panel.webview.__emit({ type: 'taskListRequest', query: { page: 1, pageSize: 10 } })
    await vi.waitFor(() => {
      expect(lastPosted(panel, 'taskList')).toBeDefined()
    })
    expect(services.onAfterChange).not.toHaveBeenCalled()
  })

  it('删除后当前页越界时钳制回最后一页（不驻留空页）', async () => {
    const { api, pending } = makeDeferredQueryApi()
    const output = { appendLine: vi.fn() }
    const services: TaskManagerServices = { api, output: output as unknown as vscode.OutputChannel }
    const panel = await openPanel(services)

    // 当前查询停在第 2 页（每页 10 条）
    panel.webview.__emit({ type: 'taskListRequest', query: { page: 2, pageSize: 10 } })
    pending[0].resolve({ items: [], total: 12, page: 2, pageSize: 10 })
    await vi.waitFor(() => {
      expect(lastPosted(panel, 'taskList')).toMatchObject({ page: { page: 2 } })
    })

    // 删除后仅剩第 1 页数据：probe 沿用原查询（第 2 页）返回 total=5 → maxPage=1
    panel.webview.__emit({ type: 'taskDelete', id: 'task-x' })
    await vi.waitFor(() => {
      expect(pending).toHaveLength(2)
    })
    expect(pending[1].query).toMatchObject({ page: 2 })
    pending[1].resolve({ items: [], total: 5, page: 2, pageSize: 10 })

    // 钳制后重查第 1 页并回页面
    await vi.waitFor(() => {
      expect(pending).toHaveLength(3)
      expect(pending[2].query).toMatchObject({ page: 1 })
    })
    pending[2].resolve({ items: [], total: 5, page: 1, pageSize: 10 })
    await vi.waitFor(() => {
      expect(lastPosted(panel, 'taskList')).toMatchObject({ page: { page: 1 } })
    })
  })
})

describe('toTaskItemWire / toTaskQueryWire / toTaskPageWire', () => {
  it('线类型转换保持字段', () => {
    const item = {
      id: 'task-1',
      name: '任务甲',
      branch: 'main',
      buildType: 'full' as const,
      status: 'success' as const,
      progress: 100,
      createdAt: '2026-10-25T00:00:00.000Z',
    }
    expect(toTaskItemWire(item)).toEqual(item)
    expect(toTaskQueryWire({ page: 1, pageSize: 10 })).toEqual({ page: 1, pageSize: 10 })
    expect(toTaskPageWire({ items: [item], total: 1, page: 1, pageSize: 10 }).pageSize).toBe(10)
  })
})

describe('createTaskManagerServices', () => {
  it('baseUrl 留空时返回打桩 api（mode=stub）', () => {
    const services = createTaskManagerServices({
      appendLine: vi.fn(),
    } as unknown as vscode.OutputChannel)
    expect(services.api.mode).toBe('stub')
    services.api.dispose()
  })
})

describe('createTaskManagerDeps', () => {
  it('buildInit 返回任务 schema 与空 value', () => {
    const { services } = makeServices()
    const deps = createTaskManagerDeps(services)
    expect(deps.buildInit?.({ persistedState: undefined })).toMatchObject({ value: {} })
  })
})

describe('configure 输出通道（v5.1.1 P3-17）', () => {
  it('早退诊断走输出通道（不再依赖 console.error）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const output = { appendLine: vi.fn() } as unknown as vscode.OutputChannel
    try {
      TaskManagerPanel.configure(undefined as unknown as vscode.ExtensionContext, output)
      const { services } = makeServices()
      TaskManagerPanel.createOrShow(services)
      expect(output.appendLine).toHaveBeenCalledWith(expect.stringContaining('createOrShow 早退'))
      expect(errorSpy).not.toHaveBeenCalled()
      expect(warnSpy).not.toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
      warnSpy.mockRestore()
    }
  })
})
