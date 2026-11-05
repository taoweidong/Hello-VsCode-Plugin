import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TreeItemCollapsibleState } from '../stubs/vscode'
import {
  StubTaskApiClient,
  type TaskItem,
  type TaskPage,
} from '../../../extension/features/taskManager/taskApiClient'
import { TaskManagerTreeProvider } from '../../../extension/features/taskManager/taskManagerTreeProvider'

/**
 * 任务管理侧边栏树视图：
 * - refresh / 轮询拉取列表；
 * - 空态与拉取失败 info 节点；
 * - 任务条目 label / description / icon / command / tooltip；
 * - dispose 停轮询。
 */

function makeTask(overrides: Partial<TaskItem> = {}): TaskItem {
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

let api: StubTaskApiClient
let provider: TaskManagerTreeProvider

beforeEach(() => {
  // startDelayMs 远大于用例时长：状态机不会在断言期间自动推进，任务保持 queued
  api = new StubTaskApiClient({ latencyMs: 0, startDelayMs: 60000, tickMs: 0, tickStep: 25 })
  provider = new TaskManagerTreeProvider(api)
})

afterEach(() => {
  provider.dispose()
  api.dispose()
})

describe('TaskManagerTreeProvider：数据加载', () => {
  it('refresh 拉取列表并触发 onDidChangeTreeData', async () => {
    const listener = vi.fn()
    provider.onDidChangeTreeData(listener)
    await api.create({ name: '任务甲', branch: 'main', buildType: 'full' })
    await provider.refresh()
    expect(listener).toHaveBeenCalled()
    const nodes = await provider.getChildren()
    expect(nodes).toHaveLength(1)
    expect(nodes[0]).toMatchObject({
      kind: 'task',
      task: expect.objectContaining({ name: '任务甲' }),
    })
  })

  it('空列表返回 info 空态节点', async () => {
    await provider.refresh()
    const nodes = await provider.getChildren()
    expect(nodes).toHaveLength(1)
    expect(nodes[0]).toMatchObject({ kind: 'info', icon: 'info' })
    expect(nodes[0].kind === 'info' && nodes[0].text).toContain('暂无任务')
  })

  it('拉取失败：info 错误节点（保留旧数据不置空）', async () => {
    await api.create({ name: '任务甲', branch: 'main', buildType: 'full' })
    await provider.refresh()
    vi.spyOn(api, 'query').mockRejectedValueOnce(new Error('网络中断'))
    await provider.refresh()
    const nodes = await provider.getChildren()
    expect(nodes[0]).toMatchObject({ kind: 'info', icon: 'error' })
    expect(nodes[0].kind === 'info' && nodes[0].text).toContain('网络中断')
  })

  it('getChildren 错误态先于空态判断（有错误时不再回退到空态）', async () => {
    vi.spyOn(api, 'query').mockRejectedValue(new Error('持续失败'))
    await provider.refresh()
    const nodes = await provider.getChildren()
    expect(nodes[0].kind === 'info' && nodes[0].text).toContain('持续失败')
  })
})

describe('TaskManagerTreeProvider：任务条目', () => {
  beforeEach(async () => {
    await api.create({ name: '任务甲', branch: 'release/1.0.0', buildType: 'full' })
    await provider.refresh()
  })

  it('label=任务名称，command 打开任务管理弹框', async () => {
    const node = (await provider.getChildren())[0]
    const item = provider.getTreeItem(node)
    expect(item.label).toBe('任务甲')
    expect(item.command).toMatchObject({ command: 'extStarter.openTaskManager' })
  })

  it('running 显示进度；非 running 不带进度', async () => {
    const task = makeTask({ status: 'running', progress: 42, name: '任务乙', id: 'task-2' })
    const node = { kind: 'task' as const, task }
    const item = provider.getTreeItem(node)
    expect(item.description).toContain('42%')
    const done = provider.getTreeItem({ kind: 'task', task: makeTask({ status: 'success' }) })
    expect(done.description).not.toContain('%')
  })

  it('tooltip 含名称 / 分支 / 类型 / 状态 / 备注 / 时间', () => {
    const node = { kind: 'task' as const, task: makeTask({ status: 'success' }) }
    const item = provider.getTreeItem(node)
    const tooltip = String(
      (item.tooltip as { value?: string } | undefined)?.value ?? item.tooltip ?? ''
    )
    expect(tooltip).toContain('任务甲')
    expect(tooltip).toContain('release/1.0.0')
    expect(tooltip).toContain('完整')
    expect(tooltip).toContain('成功')
    expect(tooltip).toContain('备注甲')
  })

  it('finishedAt 存在时 tooltip 带结束时间；缺失时省略', () => {
    const withEnd = provider.getTreeItem({ kind: 'task', task: makeTask() })
    expect(
      String((withEnd.tooltip as { value?: string } | undefined)?.value ?? withEnd.tooltip ?? '')
    ).toContain('结束于')
    const noEnd = provider.getTreeItem({
      kind: 'task',
      task: makeTask({ finishedAt: undefined }),
    })
    expect(
      String((noEnd.tooltip as { value?: string } | undefined)?.value ?? noEnd.tooltip ?? '')
    ).not.toContain('结束于')
  })

  it('info 节点渲染为 ThemeIcon 且不可折叠', () => {
    const item = provider.getTreeItem({ kind: 'info', text: '提示', icon: 'warning' })
    expect(item.collapsibleState).toBe(TreeItemCollapsibleState.None)
    expect(item.iconPath).toBeDefined()
  })

  it('status → icon 映射：具体 ThemeIcon id（第五轮强化：原断言只验存在性，映射全错也绿）', () => {
    const iconIdOf = (status: TaskItem['status']): string => {
      const item = provider.getTreeItem({ kind: 'task', task: makeTask({ status }) })
      const icon = item.iconPath as { id?: string }
      return icon.id ?? ''
    }
    expect(iconIdOf('queued')).toBe('clock')
    expect(iconIdOf('running')).toBe('sync~spin')
    expect(iconIdOf('success')).toBe('check')
    expect(iconIdOf('failed')).toBe('error')
  })
})

describe('TaskManagerTreeProvider：轮询', () => {
  it('setPolling(true) 触发 refresh；false 停轮询', async () => {
    vi.useFakeTimers()
    const spy = vi.spyOn(provider, 'refresh')
    provider.setPolling(true)
    expect(spy).toHaveBeenCalledTimes(1)
    provider.setPolling(false)
    expect(spy).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('重复 setPolling(true) 幂等（不叠加定时器）', () => {
    vi.useFakeTimers()
    const spy = vi.spyOn(provider, 'refresh')
    provider.setPolling(true)
    provider.setPolling(true)
    provider.setPolling(true)
    expect(spy).toHaveBeenCalledTimes(1)
    provider.dispose()
    vi.useRealTimers()
  })

  it('轮询周期：可见期每 3s 恰好触发一次；停止后静默（第五轮强化：原用例未推进时钟）', () => {
    vi.useFakeTimers()
    const spy = vi.spyOn(provider, 'refresh')
    provider.setPolling(true)
    spy.mockClear() // 布防时的立即 refresh 已单独断言过，这里只看周期触发

    vi.advanceTimersByTime(3_500)
    expect(spy).toHaveBeenCalledTimes(1) // 3.5s 内恰好 1 次周期触发
    vi.advanceTimersByTime(3_000)
    expect(spy).toHaveBeenCalledTimes(2)

    provider.setPolling(false)
    vi.advanceTimersByTime(9_000)
    expect(spy).toHaveBeenCalledTimes(2) // 停止后不再触发
    vi.useRealTimers()
  })
})

describe('TaskManagerTreeProvider：并发单飞', () => {
  it('进行中的 refresh 复用同一 Promise（页面轮询与手动刷新并发不叠加请求）', async () => {
    let resolveQuery: (page: TaskPage) => void = () => {}
    const queryStub = vi.spyOn(api, 'query').mockImplementation(
      () =>
        new Promise<TaskPage>((resolve) => {
          resolveQuery = resolve
        })
    )
    const first = provider.refresh()
    const second = provider.refresh()
    expect(queryStub).toHaveBeenCalledTimes(1)

    resolveQuery({ items: [], total: 0, page: 1, pageSize: 100 })
    await Promise.all([first, second])

    // 落定后再次 refresh：单飞窗口已关闭，重新发起查询（mock 会重挂新的 resolver）
    const third = provider.refresh()
    expect(queryStub).toHaveBeenCalledTimes(2)
    resolveQuery({ items: [], total: 0, page: 1, pageSize: 100 })
    await third
  })
})
