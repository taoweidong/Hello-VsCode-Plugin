import { describe, expect, it } from 'vitest'
import * as vscode from 'vscode'
import { __resetStubs } from '../stubs/vscode'
import {
  EnvironmentTreeProvider,
  type EnvTreeNode,
} from '../../../extension/providers/environmentTreeProvider'
import { TaskRunner } from '../../../extension/tasks/taskRunner'
import type { TaskResult } from '../../../extension/tasks/types'

/**
 * 环境信息树视图（此前零覆盖）：运行态占位 / 结果分组 / 条目命令绑定 /
 * 系统条目不绑命令 / 空态提示。
 */

function makeResult(overrides: Partial<TaskResult> = {}): TaskResult {
  return {
    taskId: 'environment',
    taskTitle: '环境检测',
    status: 'ok',
    durationMs: 123,
    finishedAt: '2026-11-03T00:00:00.000Z',
    items: [],
    ...overrides,
  }
}

function makeRunner(results: TaskResult[] = []) {
  const runner = new TaskRunner([], vscode.window.createOutputChannel('test'))
  // 直接注入结果（runAll 是唯一写入路径；无任务运行时 getter 只读快照）
  Object.defineProperty(runner, 'lastResults', { value: results, configurable: true })
  return runner
}

const provider = (runner: ReturnType<typeof makeRunner>) => new EnvironmentTreeProvider(runner)

describe('EnvironmentTreeProvider', () => {
  it('空结果：显示尚未检测提示（不抛错）', async () => {
    __resetStubs()
    const nodes = await provider(makeRunner()).getChildren()
    expect(nodes).toEqual([
      { kind: 'info', text: expect.stringContaining('尚未检测'), icon: 'info' },
    ])
  })

  it('任务执行中：显示转圈占位', async () => {
    __resetStubs()
    let release!: () => void
    const hanging = new TaskRunner(
      [
        {
          id: 'a',
          title: 'A',
          run: () =>
            new Promise((resolve) => {
              release = resolve as () => void
            }),
        },
      ],
      vscode.window.createOutputChannel('test')
    )
    const running = hanging.runAll()
    const nodes = await new EnvironmentTreeProvider(hanging).getChildren()
    expect(nodes).toEqual([
      { kind: 'info', text: expect.stringContaining('正在检测'), icon: 'sync~spin' },
    ])
    release()
    await running
  })

  it('结果分组：每个结果一个 task 节点；其子节点为条目', async () => {
    __resetStubs()
    const result = makeResult({
      status: 'warn',
      items: [
        { label: 'Node.js', description: 'v20.11.0', status: 'ok' },
        { label: 'Python', description: '未检测到', status: 'missing' },
      ],
    })
    const p = provider(makeRunner([result]))
    const roots = await p.getChildren()
    expect(roots).toHaveLength(1)
    const root = roots[0] as Extract<EnvTreeNode, { kind: 'task' }>
    expect(root.kind).toBe('task')
    const items = await p.getChildren(root)
    expect(items.map((node) => (node as { item?: { label: string } }).item?.label)).toEqual([
      'Node.js',
      'Python',
    ])
  })

  it('getTreeItem：task 节点状态图标 / 描述；item 节点绑定探针重检命令', () => {
    __resetStubs()
    const p = provider(
      makeRunner([
        makeResult({
          items: [
            { label: 'Node.js', description: 'v20', status: 'ok' },
            { label: '操作系统', description: 'Windows', status: 'ok' },
          ],
        }),
      ])
    )
    const taskItem = p.getTreeItem({ kind: 'task', result: makeResult({ status: 'warn' }) })
    expect(taskItem.label).toBe('环境检测')
    expect((taskItem.iconPath as vscode.ThemeIcon).id).toBe('warning')
    expect(taskItem.contextValue).toBe('envTask')

    const probeItem = p.getTreeItem({
      kind: 'item',
      item: { label: 'Node.js', description: 'v20', status: 'ok' },
    })
    expect(probeItem.command?.command).toBe('extStarter.refreshEnvironment')
    expect(probeItem.command?.arguments).toEqual(['Node.js'])

    // 系统信息条目（不在探针注册表）：不绑定命令
    const systemItem = p.getTreeItem({
      kind: 'item',
      item: { label: '操作系统', description: 'Windows', status: 'ok' },
    })
    expect(systemItem.command).toBeUndefined()
  })

  it('getTreeItem：info 节点渲染文本与图标；条目缺 status 按 missing 图标', () => {
    __resetStubs()
    const p = provider(makeRunner())
    const info = p.getTreeItem({ kind: 'info', text: '提示', icon: 'info' })
    expect(info.label).toBe('提示')
    expect((info.iconPath as vscode.ThemeIcon).id).toBe('info')
    const missing = p.getTreeItem({ kind: 'item', item: { label: 'X', description: '' } })
    expect((missing.iconPath as vscode.ThemeIcon).id).toBe('circle-slash')
  })
})
