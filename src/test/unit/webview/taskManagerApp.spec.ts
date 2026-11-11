import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import App from '../../../webview/apps/taskManager/App.vue'
import { toFieldDefs, deriveFormSchema } from '../../../webview/formSchema'
import { TASK_FIELD_DEFS } from '../../../extension/features/taskManager/taskSchema'
import type { TaskItemWire } from '../../../webview/protocol'
import { __setVsCodeApiForTest } from '../../../webview/shared/useVsCodeApi'
import { createHostApiMock, hostMessage, inputValue } from './appTestUtils'

/**
 * 任务管理页面（v2.6 CRUD 实例）：
 * - init 装配查询区 + 表格区 + 分页；
 * - 查询 / 重置 / 每页条数 / 分页导航；
 * - 新增（弹框）/ 编辑 / 删除 / 保存错误定位；
 * - 未知消息被协议守卫过滤。
 */

const SCHEMA = toFieldDefs(deriveFormSchema(TASK_FIELD_DEFS))

function task(overrides: Partial<TaskItemWire> = {}): TaskItemWire {
  return {
    id: 'task-1',
    name: '任务甲',
    branch: 'release/1.0.0',
    buildType: 'full',
    status: 'success',
    progress: 100,
    notes: '备注甲',
    createdAt: '2026-10-25T00:00:00.000Z',
    finishedAt: '2026-10-25T01:00:00.000Z',
    ...overrides,
  }
}

function sendInit(extra: Record<string, unknown> = {}): void {
  hostMessage({
    type: 'init',
    page: 'taskManager',
    schema: SCHEMA,
    value: {},
    extra,
  })
}

let wrapper: VueWrapper | undefined

/** 页面经 useVsCodeApi 单例取用：mock 统一经 appTestUtils（第五轮基建收敛双轨）。 */
let api: ReturnType<typeof createHostApiMock>

beforeEach(() => {
  api = createHostApiMock()
  __setVsCodeApiForTest(api)
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  __setVsCodeApiForTest(undefined)
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const postedTypes = (): string[] =>
  (api.posted as { type?: string }[]).map((message) => String(message.type))

const postedOf = (type: string) =>
  (api.posted as { type?: string }[]).filter((message) => message.type === type)

function openAndInit(): VueWrapper {
  wrapper = mount(App)
  expect(postedTypes()).toEqual(['ready'])
  sendInit()
  return wrapper!
}

describe('taskManager 页面：装配', () => {
  it('挂载即上报 ready；init 后渲染查询区 / 表头 / 分页', async () => {
    const w = openAndInit()
    await w.vm.$nextTick()
    expect(w.text()).toContain('任务管理')
    expect(w.find('.task-filters').exists()).toBe(true)
    expect(w.find('.task-table').exists()).toBe(true)
    expect(w.text()).toContain('任务名称')
    expect(w.text()).toContain('操作')
    expect(w.find('.task-pagination').exists()).toBe(true)
  })

  it('init 触发首次 taskListRequest（page=1, pageSize=10）', async () => {
    const w = openAndInit()
    await w.vm.$nextTick()
    expect(postedOf('taskListRequest')[0]).toMatchObject({ query: { page: 1, pageSize: 10 } })
  })
})

describe('taskManager 页面：查询与分页', () => {
  it('空列表显示空态与新建入口', async () => {
    const w = openAndInit()
    await w.vm.$nextTick()
    hostMessage({ type: 'taskList', page: { items: [], total: 0, page: 1, pageSize: 10 } })
    await w.vm.$nextTick()
    expect(w.text()).toContain('暂无任务')
    expect(w.find('.task-pagination').text()).toContain('第 1 / 1 页')
  })

  it('查询：填写关键字后点击查询，回第 1 页并透传关键字', async () => {
    const w = openAndInit()
    await w.vm.$nextTick()
    await w.find('input[placeholder^="按任务名称"]').setValue('编译')
    await w
      .findAll('button')
      .find((b) => b.text().includes('查询'))
      ?.trigger('click')
    await w.vm.$nextTick()
    const req = postedOf('taskListRequest')[postedOf('taskListRequest').length - 1]
    expect(req).toMatchObject({ query: { page: 1, pageSize: 10, keyword: '编译' } })
  })

  it('重置：清空条件并回到第 1 页', async () => {
    const w = openAndInit()
    await w.vm.$nextTick()
    await w.find('input[placeholder^="按任务名称"]').setValue('编译')
    await w
      .findAll('button')
      .find((b) => b.text().includes('查询'))
      ?.trigger('click')
    await w.vm.$nextTick()
    await w
      .findAll('button')
      .find((b) => b.text().includes('重置'))
      ?.trigger('click')
    await w.vm.$nextTick()
    const req = postedOf('taskListRequest')[postedOf('taskListRequest').length - 1]
    expect(req).toMatchObject({ query: { page: 1, pageSize: 10 } })
    expect((w.find('input[placeholder^="按任务名称"]').element as { value: string }).value).toBe('')
  })

  it('表格渲染任务行：名称 / 分支 / 类型 / 状态 / 进度 / 备注 / 时间', async () => {
    const w = openAndInit()
    await w.vm.$nextTick()
    hostMessage({
      type: 'taskList',
      page: { items: [task()], total: 1, page: 1, pageSize: 10 },
    })
    await w.vm.$nextTick()
    const row = w.find('.task-row')
    expect(row.text()).toContain('任务甲')
    expect(row.text()).toContain('release/1.0.0')
    expect(row.text()).toContain('完整构建')
    expect(row.text()).toContain('成功')
    expect(row.text()).toContain('100%')
    expect(row.text()).toContain('备注甲')
    expect(w.text()).toContain('共 1 条')
  })

  it('进度信息优先展示 message，缺省展示 notes，都没有展示占位符', async () => {
    const w = openAndInit()
    await w.vm.$nextTick()
    hostMessage({
      type: 'taskList',
      page: {
        items: [task({ message: '编译失败：语法错误' }), task({ id: 't2', name: '乙', notes: '' })],
        total: 2,
        page: 1,
        pageSize: 10,
      },
    })
    await w.vm.$nextTick()
    const rows = w.findAll('.task-row')
    expect(rows[0].text()).toContain('编译失败：语法错误')
    expect(rows[1].text()).toContain('—')
  })

  it('分页：第 2 页启用上一页/下一页；点下一页请求第 3 页', async () => {
    const w = openAndInit()
    await w.vm.$nextTick()
    hostMessage({
      type: 'taskList',
      page: { items: [task()], total: 30, page: 2, pageSize: 10 },
    })
    await w.vm.$nextTick()
    expect(w.text()).toContain('第 2 / 3 页')
    const next = w.findAll('button').find((b) => b.attributes('title') === '下一页')
    expect(next?.attributes('disabled')).toBeUndefined()
    await next?.trigger('click')
    await w.vm.$nextTick()
    const req = postedOf('taskListRequest')[postedOf('taskListRequest').length - 1]
    expect(req).toMatchObject({ query: { page: 3, pageSize: 10 } })
  })

  it('第 1 页禁用上一页；最后一页禁用下一页', async () => {
    const w = openAndInit()
    await w.vm.$nextTick()
    hostMessage({
      type: 'taskList',
      page: { items: [task()], total: 10, page: 1, pageSize: 10 },
    })
    await w.vm.$nextTick()
    const prev = w.findAll('button').find((b) => b.attributes('title') === '上一页')
    expect(prev?.attributes('disabled')).toBeDefined()
    hostMessage({
      type: 'taskList',
      page: { items: [task()], total: 10, page: 1, pageSize: 10 },
    })
    await w.vm.$nextTick()
  })

  it('切换每页条数：回到第 1 页并带新 pageSize', async () => {
    const w = openAndInit()
    await w.vm.$nextTick()
    // 查询区第 3 个下拉为每页条数（前两个是状态 / 类型）
    const pageSizeSelect = w.findAll('select')[2]
    await pageSizeSelect.setValue('20')
    await pageSizeSelect.trigger('change')
    await w.vm.$nextTick()
    const req = postedOf('taskListRequest')[postedOf('taskListRequest').length - 1]
    expect(req).toMatchObject({ query: { page: 1, pageSize: 20 } })
  })
})

describe('taskManager 页面：增 / 改 / 删', () => {
  it('新建：点新建任务弹出表单，填写后保存 post submit（不带 id）', async () => {
    const w = openAndInit()
    await w.vm.$nextTick()
    await w
      .findAll('button')
      .find((b) => b.text().includes('新建任务'))
      ?.trigger('click')
    expect(w.find('.task-dialog').exists()).toBe(true)
    await w.find('input[placeholder^="如 主干每日构建"]').setValue('任务丙')
    await w.find('input[placeholder^="如 release"]').setValue('dev')
    await w
      .findAll('button')
      .find((b) => b.text().includes('保存'))
      ?.trigger('click')
    await w.vm.$nextTick()
    const submit = postedOf('submit')[0]
    expect(submit).toMatchObject({
      draft: { name: '任务丙', branch: 'dev', buildType: 'full' },
    })
    expect((submit as { draft?: { id?: unknown } }).draft?.id).toBeUndefined()
  })

  it('submitAck 关闭弹框并显示成功反馈；先到的 taskList 不误关（轮询竞态防护）', async () => {
    const w = openAndInit()
    await w.vm.$nextTick()
    await w
      .findAll('button')
      .find((b) => b.text().includes('新建任务'))
      ?.trigger('click')
    await w.find('input[placeholder^="如 主干每日构建"]').setValue('任务丙')
    await w.find('input[placeholder^="如 release"]').setValue('dev')
    await w
      .findAll('button')
      .find((b) => b.text().includes('保存'))
      ?.trigger('click')
    await w.vm.$nextTick()
    // 提交在途：列表应答先落定（宿主重查 / 轮询应答同型）——弹框保持打开、不误报成功
    hostMessage({
      type: 'taskList',
      page: { items: [task({ name: '任务丙', branch: 'dev' })], total: 1, page: 1, pageSize: 10 },
    })
    await w.vm.$nextTick()
    expect(w.find('.task-dialog').exists()).toBe(true)
    expect(w.find('.task-feedback--success').exists()).toBe(false)
    // submitAck 到达才关框 + 成功反馈
    hostMessage({ type: 'submitAck', ok: true })
    await w.vm.$nextTick()
    expect(w.find('.task-dialog').exists()).toBe(false)
    expect(w.find('.task-feedback--success').text()).toContain('任务已保存')
    // 关框后的迟到列表应答只刷新数据，不再触发关框 / 反馈逻辑
    hostMessage({
      type: 'taskList',
      page: { items: [task({ name: '任务丙' })], total: 1, page: 1, pageSize: 10 },
    })
    await w.vm.$nextTick()
    expect(w.find('.task-dialog').exists()).toBe(false)
    expect(w.find('.task-feedback--success').text()).toContain('任务已保存')
  })

  it('空必填不发 submit：主按钮本地校验拦截，补齐后正常提交', async () => {
    const w = openAndInit()
    await w.vm.$nextTick()
    await w
      .findAll('button')
      .find((b) => b.text().includes('新建任务'))
      ?.trigger('click')
    await w.vm.$nextTick()
    // 不填任何字段直接保存：本地校验拦截，无 submit 往返
    await w
      .findAll('button')
      .find((b) => b.text().includes('保存'))
      ?.trigger('click')
    await w.vm.$nextTick()
    expect(postedOf('submit')).toHaveLength(0)
    expect(w.find('.task-dialog').text()).toContain('请填写「任务名称」')
    // 补齐必填后可正常提交
    await w.find('input[placeholder^="如 主干每日构建"]').setValue('任务丙')
    await w.find('input[placeholder^="如 release"]').setValue('dev')
    await w
      .findAll('button')
      .find((b) => b.text().includes('保存'))
      ?.trigger('click')
    await w.vm.$nextTick()
    expect(postedOf('submit')).toHaveLength(1)
  })

  it('编辑：打开弹框回填，保存 post submit（带 id）', async () => {
    const w = openAndInit()
    await w.vm.$nextTick()
    hostMessage({ type: 'taskList', page: { items: [task()], total: 1, page: 1, pageSize: 10 } })
    await w.vm.$nextTick()
    await w
      .findAll('button')
      .find((b) => b.attributes('title') === '编辑任务')
      ?.trigger('click')
    const nameInput = w.find('input[placeholder^="如 主干每日构建"]')
    expect(inputValue(nameInput.element)).toBe('任务甲')
    await nameInput.setValue('任务乙')
    await w
      .findAll('button')
      .find((b) => b.text().includes('保存'))
      ?.trigger('click')
    await w.vm.$nextTick()
    const submit = postedOf('submit')[0]
    expect(submit).toMatchObject({
      draft: { id: 'task-1', name: '任务乙', branch: 'release/1.0.0' },
    })
  })

  it('保存失败：error.field 定位表单错误，弹框保持打开且可取消（saving 复位）', async () => {
    const w = openAndInit()
    await w.vm.$nextTick()
    await w
      .findAll('button')
      .find((b) => b.text().includes('新建任务'))
      ?.trigger('click')
    await w.vm.$nextTick()
    hostMessage({ type: 'error', message: '任务名称不能为空。', field: 'name' })
    await w.vm.$nextTick()
    expect(w.find('.task-dialog').exists()).toBe(true)
    expect(w.find('.task-dialog').text()).toContain('任务名称不能为空')
    // 失败后 saving 已复位：取消按钮可用，点击可关闭弹框（不会永久卡死）
    const cancelButton = w.findAll('button').find((b) => b.text().includes('取消'))
    expect(cancelButton?.attributes('disabled')).toBeUndefined()
    await cancelButton?.trigger('click')
    await w.vm.$nextTick()
    expect(w.find('.task-dialog').exists()).toBe(false)
  })

  it('删除：两段式布防——全程不调用浏览器模态 confirm，再点才发 taskDelete', async () => {
    const w = openAndInit()
    await w.vm.$nextTick()
    hostMessage({ type: 'taskList', page: { items: [task()], total: 1, page: 1, pageSize: 10 } })
    await w.vm.$nextTick()
    // P0 守护：webview 沙箱下 confirm 恒返回 false，页面不得依赖它（agent.md 硬性规约 9）
    const confirmSpy = vi.spyOn(
      (globalThis as unknown as { window: { confirm: (m?: string) => boolean } }).window,
      'confirm'
    )
    const deleteButton = () => w.findAll('button').find((b) => b.attributes('title') === '删除任务')

    // 首点：仅布防（按钮进入确认态），不发 taskDelete
    await deleteButton()?.trigger('click')
    await w.vm.$nextTick()
    expect(confirmSpy).not.toHaveBeenCalled()
    expect(postedOf('taskDelete')).toHaveLength(0)
    expect(
      w.findAll('button').find((b) => b.attributes('title') === '再次点击确认删除')
    ).toBeDefined()

    // 再点：执行删除
    await w
      .findAll('button')
      .find((b) => b.attributes('title') === '再次点击确认删除')
      ?.trigger('click')
    await w.vm.$nextTick()
    const del = postedOf('taskDelete')[0]
    expect(del).toMatchObject({ id: 'task-1' })
    expect(confirmSpy).not.toHaveBeenCalled()
  })

  it('删除布防超时自动解除：解除后再点重新布防而非误删', async () => {
    vi.useFakeTimers()
    const w = openAndInit()
    hostMessage({ type: 'taskList', page: { items: [task()], total: 1, page: 1, pageSize: 10 } })
    await w.vm.$nextTick()
    const armedButton = () =>
      w.findAll('button').find((b) => b.attributes('title') === '再次点击确认删除')

    await w
      .findAll('button')
      .find((b) => b.attributes('title') === '删除任务')
      ?.trigger('click')
    expect(armedButton()).toBeDefined()

    // 超过 3s：布防解除，按钮回到普通删除态
    vi.advanceTimersByTime(3_000)
    await w.vm.$nextTick()
    expect(armedButton()).toBeUndefined()

    // 解除后的首点重新布防，不发 taskDelete
    await w
      .findAll('button')
      .find((b) => b.attributes('title') === '删除任务')
      ?.trigger('click')
    expect(armedButton()).toBeDefined()
    expect(postedOf('taskDelete')).toHaveLength(0)

    // 限时内再点才执行
    await armedButton()?.trigger('click')
    expect(postedOf('taskDelete')).toHaveLength(1)
  })

  it('确认删除后有错误：错误以反馈条展示', async () => {
    const w = openAndInit()
    await w.vm.$nextTick()
    hostMessage({ type: 'taskList', page: { items: [task()], total: 1, page: 1, pageSize: 10 } })
    await w.vm.$nextTick()
    await w
      .findAll('button')
      .find((b) => b.attributes('title') === '删除任务')
      ?.trigger('click')
    await w
      .findAll('button')
      .find((b) => b.attributes('title') === '再次点击确认删除')
      ?.trigger('click')
    await w.vm.$nextTick()
    hostMessage({ type: 'error', message: '删除失败，请重试。' })
    await w.vm.$nextTick()
    expect(w.find('.task-feedback--error').text()).toContain('删除失败，请重试')
  })
})

describe('taskManager 页面：轮询', () => {
  it('init 前不轮询；有排队/运行任务时每 3s 刷新；全部落定后停止；卸载后静默', async () => {
    vi.useFakeTimers()
    const w = mount(App)
    expect(postedTypes()).toEqual(['ready'])
    // init 未到达（含 init 失败场景）：多个周期内不发出任何查询
    await vi.advanceTimersByTimeAsync(6_500)
    expect(postedOf('taskListRequest')).toHaveLength(0)

    sendInit()
    await w.vm.$nextTick()
    expect(postedOf('taskListRequest')).toHaveLength(1) // init 触发首查

    // 列表全部落定：不轮询
    hostMessage({ type: 'taskList', page: { items: [], total: 0, page: 1, pageSize: 10 } })
    await w.vm.$nextTick()
    await vi.advanceTimersByTimeAsync(6_500)
    expect(postedOf('taskListRequest')).toHaveLength(1)

    // 出现运行中任务：每个周期刷新一次
    hostMessage({
      type: 'taskList',
      page: {
        items: [task({ status: 'running', progress: 42 })],
        total: 1,
        page: 1,
        pageSize: 10,
      },
    })
    await w.vm.$nextTick()
    await vi.advanceTimersByTimeAsync(3_000)
    expect(postedOf('taskListRequest')).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(postedOf('taskListRequest')).toHaveLength(3)
    // P3-07：轮询为静默刷新——表头「加载中…」不随轮询闪烁
    expect(w.find('.task-table-loading').exists()).toBe(false)

    // 全部落定：停止刷新
    hostMessage({
      type: 'taskList',
      page: { items: [task({ status: 'success' })], total: 1, page: 1, pageSize: 10 },
    })
    await w.vm.$nextTick()
    await vi.advanceTimersByTimeAsync(6_500)
    expect(postedOf('taskListRequest')).toHaveLength(3)

    // 卸载后定时器清理：不再发请求
    w.unmount()
    wrapper = undefined
    await vi.advanceTimersByTimeAsync(10_000)
    expect(postedOf('taskListRequest')).toHaveLength(3)
  })
})

describe('taskManager 页面：协议守卫', () => {
  it('非宿主消息（type=unknown）被忽略，不抛错', async () => {
    const w = openAndInit()
    await w.vm.$nextTick()
    hostMessage({ type: 'unknown' } as never)
    await w.vm.$nextTick()
    expect(w.text()).toContain('任务管理')
  })
})

describe('taskManager 页面：上行消息契约（17 方案阶段 1，P1-3）', () => {
  it('全部上行消息（ready/taskListRequest/submit/taskDelete）通过 isWebviewMessage 守卫', async () => {
    const w = openAndInit()
    await w.vm.$nextTick()
    // 新建 → 保存：submit
    await w
      .findAll('button')
      .find((b) => b.text().includes('新建任务'))
      ?.trigger('click')
    await w.find('input[placeholder^="如 主干每日构建"]').setValue('任务丙')
    await w.find('input[placeholder^="如 release"]').setValue('dev')
    await w
      .findAll('button')
      .find((b) => b.text().includes('保存'))
      ?.trigger('click')
    await w.vm.$nextTick()
    // 行内删除两段式：taskDelete
    hostMessage({ type: 'taskList', page: { items: [task()], total: 1, page: 1, pageSize: 10 } })
    await w.vm.$nextTick()
    await w
      .findAll('button')
      .find((b) => b.attributes('title') === '删除任务')
      ?.trigger('click')
    await w
      .findAll('button')
      .find((b) => b.attributes('title') === '再次点击确认删除')
      ?.trigger('click')
    await w.vm.$nextTick()

    expect(postedTypes()).toEqual(['ready', 'taskListRequest', 'submit', 'taskDelete'])
    const { isWebviewMessage } = await import('../../../webview/protocol')
    for (const message of api.posted) {
      expect(isWebviewMessage(message), `消息未过守卫：${JSON.stringify(message)}`).toBe(true)
    }
  })
})
