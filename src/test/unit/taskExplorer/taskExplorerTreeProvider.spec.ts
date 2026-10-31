import { beforeEach, describe, expect, it } from 'vitest'
import * as vscode from 'vscode'
import { TaskExplorerTreeProvider } from '../../../extension/features/taskExplorer/taskExplorerTreeProvider'
import { type WorkspaceTaskEntry } from '../../../extension/features/taskExplorer/taskSource'
import { TaskStatusTracker } from '../../../extension/features/taskExplorer/taskStatusTracker'
import { TaskUsageStore } from '../../../extension/features/taskExplorer/taskUsageStore'
import {
  __resetStubs,
  __setTaskExecutions,
  __stubs,
  createMementoStub,
  FakeTaskExecution,
  Task,
} from '../stubs/vscode'
import { makeFolder, makeShellExecution, makeTask, setWorkspace } from './support/fakeWorkspaceTask'

/**
 * 树视图（10 方案 §7，§11.2 用例 ①-⑭）：三组固定顺序、空态占位、
 * 四种 contextValue、运行态图标、失效 ref 隐藏、失败保留旧数据。
 */

const root = makeFolder('work', '/repo/work')

type GroupNode = { kind: 'group'; group: string; children: { kind: string }[]; count: number }

beforeEach(() => {
  __resetStubs()
})

interface Harness {
  provider: TaskExplorerTreeProvider
  usage: TaskUsageStore
  status: TaskStatusTracker
}

function makeHarness(memento = createMementoStub()): Harness {
  const output = vscode.window.createOutputChannel('test')
  const usage = new TaskUsageStore(memento, output)
  const status = new TaskStatusTracker(output)
  const provider = new TaskExplorerTreeProvider(usage, status, output)
  return { provider, usage, status }
}

async function roots(provider: TaskExplorerTreeProvider): Promise<GroupNode[]> {
  return (await provider.getChildren()) as unknown as GroupNode[]
}

describe('TaskExplorerTreeProvider（三组根节点）', () => {
  it('① 根节点顺序 = 最近运行 → 收藏 → 工作区任务（空组也显示占位）（②）', async () => {
    setWorkspace([root], [])
    const { provider } = makeHarness()
    const groups = await roots(provider)
    expect(groups.map((node) => node.group)).toEqual(['recent', 'favorites', 'tasks'])
    expect(groups.every((node) => node.children.length === 1)).toBe(true) // 各一个「暂无」info
    const items = groups.map((node) => provider.getTreeItem(node as never))
    expect(items.map((item) => item.label)).toEqual(['最近运行', '收藏', '工作区任务'])
    expect(items.map((item) => (item.iconPath as vscode.ThemeIcon).id)).toEqual([
      'history',
      'star-full',
      'list-tree',
    ])
    provider.dispose()
  })

  it('② 空态占位文案与图标；首次 getChildren 惰性触发一次加载', async () => {
    setWorkspace([root], [])
    const { provider } = makeHarness()
    expect(__stubs.recorded.filter((e) => e.kind === 'fetchTasks')).toHaveLength(0)
    const groups = await roots(provider)
    expect(__stubs.recorded.filter((e) => e.kind === 'fetchTasks')).toHaveLength(1)
    expect(groups[0]?.children).toEqual([
      {
        kind: 'info',
        text: '暂无最近运行的任务',
        icon: 'info',
        tooltip: '运行过的任务会出现在这里',
      },
    ])
    expect(groups[1]?.children).toEqual([
      { kind: 'info', text: '暂无收藏的任务', icon: 'info', tooltip: '点击任务行内的星标收藏' },
    ])
    expect(groups[2]?.children).toEqual([
      { kind: 'info', text: '未在 .vscode/tasks.json 中发现任务', icon: 'info' },
    ])
    provider.dispose()
  })

  it('③ 未打开工作区 / 受限模式的专门空态', async () => {
    const { provider } = makeHarness()
    const groups = await roots(provider)
    expect(groups[2]?.children).toEqual([
      { kind: 'info', text: '未打开工作区文件夹：无法读取 .vscode/tasks.json', icon: 'info' },
    ])

    __stubs.isTrusted = false
    setWorkspace([root], [])
    await provider.refresh() // 工作区/信任变化由 controller 驱动，这里手动等价触发
    const groups2 = await roots(provider)
    expect(groups2[2]?.children).toEqual([
      { kind: 'info', text: '受限模式下不加载任务：信任工作区后自动刷新', icon: 'shield' },
    ])
    provider.dispose()
  })

  it('③b 最近运行按时间倒序、最多展示 10 条（匹配层）', async () => {
    const tasks: Task[] = []
    for (let i = 0; i < 12; i += 1) {
      tasks.push(makeTask({ name: `task-${i}`, folder: root }))
    }
    setWorkspace([root], tasks)
    const { provider, usage } = makeHarness()
    await provider.refresh()
    for (let i = 0; i < 12; i += 1) {
      usage.recordRun({ scopeUri: String(root.uri), source: 'Workspace', name: `task-${i}` }, i)
    }
    // usage 事件只重建分组，不重新 fetchTasks
    const groups = await roots(provider)
    const recent = groups[0]?.children ?? []
    expect(recent).toHaveLength(10)
    expect(recent[0]).toMatchObject({ kind: 'task' })
    // 最新的 task-11 在首位
    const first = provider.getTreeItem(recent[0] as never)
    expect(first.label).toBe('task-11')
    provider.dispose()
  })

  it('④ 收藏按任务名排序', async () => {
    const build = makeTask({ name: 'build', folder: root })
    const alpha = makeTask({ name: 'alpha', folder: root })
    setWorkspace([root], [build, alpha])
    const { provider, usage } = makeHarness()
    await provider.refresh()
    usage.addFavorite({ scopeUri: String(root.uri), source: 'Workspace', name: 'build' })
    usage.addFavorite({ scopeUri: String(root.uri), source: 'Workspace', name: 'alpha' })
    const groups = await roots(provider)
    const labels = (groups[1]?.children ?? []).map(
      (node) => provider.getTreeItem(node as never).label
    )
    expect(labels).toEqual(['alpha', 'build'])
    provider.dispose()
  })

  it('⑤ 失效 ref 隐藏且收藏保留（存储不删）；存储重置显示 warning', async () => {
    const memento = createMementoStub({
      'extStarter.taskExplorer.usage': {
        version: 1,
        favorites: [{ scopeUri: String(root.uri), source: 'Workspace', name: 'ghost' }],
        recent: [],
      },
    })
    setWorkspace([root], [])
    const { provider, usage } = makeHarness(memento)
    await provider.refresh()
    const groups = await roots(provider)
    expect(groups[1]?.children).toEqual([
      { kind: 'info', text: '暂无收藏的任务', icon: 'info', tooltip: '点击任务行内的星标收藏' },
    ])
    expect(usage.getFavorites()).toHaveLength(1) // 存储保留
    provider.dispose()
  })

  it('⑤b 存储损坏重置后，最近运行/收藏组下显示「本地记录已重置」', async () => {
    const memento = createMementoStub({
      'extStarter.taskExplorer.usage': { version: 2, favorites: 'broken', recent: [] },
    })
    setWorkspace([root], [])
    const { provider } = makeHarness(memento)
    const groups = await roots(provider)
    expect(groups[0]?.children).toContainEqual({
      kind: 'info',
      text: '本地记录已重置',
      icon: 'warning',
      tooltip: '阅读输出通道详情',
    })
    expect(groups[1]?.children).toContainEqual({
      kind: 'info',
      text: '本地记录已重置',
      icon: 'warning',
      tooltip: '阅读输出通道详情',
    })
    provider.dispose()
  })
})

describe('TaskExplorerTreeProvider（图标显示）', () => {
  it('图标优先级：运行转圈 > 任务分组 > 任务类型 > terminal 兜底', async () => {
    const build = makeTask({ name: 'b', folder: root, group: vscode.TaskGroup.Build })
    const test = makeTask({ name: 't', folder: root, group: vscode.TaskGroup.Test })
    const shell = makeTask({ name: 's', folder: root })
    const proc = makeTask({ name: 'p', folder: root, definitionType: 'process' })
    const npm = makeTask({ name: 'n', folder: root, definitionType: 'npm' })
    const custom = makeTask({ name: 'c', folder: root, definitionType: 'gulp' })
    setWorkspace([root], [build, test, shell, proc, npm, custom])
    const { provider } = makeHarness()
    await provider.refresh()
    const groups = await roots(provider)
    const fileNode = (groups[2] as unknown as { children: { kind: string }[] }).children[0]
    const nodes = (await provider.getChildren(fileNode as never)) as unknown as {
      entry: WorkspaceTaskEntry
    }[]
    const iconOf = (label: string): string =>
      (
        provider.getTreeItem(nodes.find((n) => n.entry.label === label) as never) as unknown as {
          iconPath: vscode.ThemeIcon
        }
      ).iconPath.id

    expect(iconOf('b')).toBe('tools') // 分组优先于类型
    expect(iconOf('t')).toBe('beaker')
    expect(iconOf('s')).toBe('terminal') // shell 类型
    expect(iconOf('p')).toBe('gear') // process 类型
    expect(iconOf('n')).toBe('package') // npm 类型
    expect(iconOf('c')).toBe('terminal') // 未知 contributed 类型兜底

    // 运行态转圈优先于一切
    const execution = new FakeTaskExecution(nodes[0]!.entry.task as unknown as Task)
    __setTaskExecutions([execution])
    expect(iconOf('b')).toBe('sync~spin')
    provider.dispose()
  })
})

describe('TaskExplorerTreeProvider（tooltip 与 info 渲染）', () => {
  it('tooltip 三种执行形态与可选字段（process / command+args / 复合 / detail / isBackground）', async () => {
    const taskWithProcess = makeTask({ name: 'proc', folder: root })
    taskWithProcess.execution = {
      process: 'python',
      args: ['-u', 'x.py'],
      options: { cwd: '${workspaceRoot}/ci' },
    } as never
    const taskShellArgs = makeTask({ name: 'shellargs', folder: root })
    taskShellArgs.execution = {
      command: { value: 'npm' },
      args: ['run', 'compile'],
      options: {},
    } as never
    const taskDetail = makeTask({ name: 'detail', folder: root })
    taskDetail.detail = '编译全部包'
    taskDetail.isBackground = true
    const composite = makeTask({ name: 'composite', folder: root }) // 无 execution

    setWorkspace([root], [taskWithProcess, taskShellArgs, taskDetail, composite])
    const { provider } = makeHarness()
    await provider.refresh()
    const groups = await roots(provider)
    const fileNode = (groups[2] as unknown as { children: { kind: string }[] }).children[0]
    const nodes = (await provider.getChildren(fileNode as never)) as unknown as {
      entry: WorkspaceTaskEntry
    }[]
    const tooltipOf = (label: string): string =>
      String(
        (
          provider.getTreeItem(nodes.find((n) => n.entry.label === label) as never) as unknown as {
            tooltip: vscode.MarkdownString
          }
        ).tooltip.value
      )

    const procTooltip = tooltipOf('proc')
    expect(procTooltip).toContain('命令：`python -u x.py`')
    expect(procTooltip).toContain('工作目录：`${workspaceRoot}/ci`')
    expect(tooltipOf('shellargs')).toContain('命令：`npm run compile`')
    const detailTooltip = tooltipOf('detail')
    expect(detailTooltip).toContain('详情：编译全部包')
    expect(detailTooltip).toContain('后台任务：是')
    expect(tooltipOf('composite')).toContain('命令：`复合任务（无直接命令）`')
    provider.dispose()
  })

  it('info 节点渲染（含/不含 tooltip）；task/info 为叶子节点', async () => {
    setWorkspace([root], [])
    const { provider } = makeHarness()
    const groups = await roots(provider)
    const emptyInfo = groups[0]?.children[0] as unknown as {
      kind: string
      text: string
      tooltip?: string
    }
    const infoItem = provider.getTreeItem(emptyInfo as never)
    expect(infoItem.label).toBe('暂无最近运行的任务')
    expect(infoItem.tooltip).toBe('运行过的任务会出现在这里')
    expect((infoItem.iconPath as vscode.ThemeIcon).id).toBe('info')

    const noTooltipInfo = groups[2]?.children[0] as unknown as { kind: string; tooltip?: string }
    expect(provider.getTreeItem(noTooltipInfo as never).tooltip).toBeUndefined()
    expect(await provider.getChildren(emptyInfo as never)).toEqual([])
    provider.dispose()
  })
})

describe('TaskExplorerTreeProvider（工作区任务组）', () => {
  it('⑥ 单根：工作区任务 → tasks.json → 任务', async () => {
    const build = makeTask({ name: 'build', folder: root, group: vscode.TaskGroup.Build })
    const test = makeTask({ name: 'test', folder: root, group: vscode.TaskGroup.Test })
    setWorkspace([root], [build, test])
    const { provider } = makeHarness()
    await provider.refresh()
    const groups = await roots(provider)
    const tasksGroup = groups[2] as unknown as { children: { kind: string }[] }
    expect(tasksGroup.children).toHaveLength(1)
    const fileNode = tasksGroup.children[0] as unknown as {
      kind: string
      folder: { uri: { fsPath: string } }
      entries: unknown[]
    }
    expect(fileNode.kind).toBe('file')
    const fileItem = provider.getTreeItem(fileNode as never)
    expect(fileItem.label).toBe('tasks.json')
    expect(fileItem.description).toBe('2 个任务')
    expect(fileItem.contextValue).toBe('tasksFile')

    const taskNodes = (await provider.getChildren(fileNode as never)) as unknown as {
      entry: WorkspaceTaskEntry
    }[]
    expect(taskNodes.map((node) => node.entry.label)).toEqual(['build', 'test'])
    const buildItem = provider.getTreeItem(taskNodes[0] as never)
    expect(buildItem.label).toBe('build')
    expect(buildItem.description).toBe('构建')
    expect(buildItem.contextValue).toBe('workspaceTask')
    const testItem = provider.getTreeItem(taskNodes[1] as never)
    expect(testItem.description).toBe('测试')
    expect((testItem.iconPath as vscode.ThemeIcon).id).toBe('beaker')
    expect((buildItem.iconPath as vscode.ThemeIcon).id).toBe('tools')
    provider.dispose()
  })

  it('⑦ 多根：文件夹 → tasks.json → 任务（无任务文件夹不显示，按 workspaceFolders 顺序）', async () => {
    const first = makeFolder('first', '/repo/first')
    const second = makeFolder('second', '/repo/second', 1)
    const empty = makeFolder('empty', '/repo/empty', 2)
    const taskInSecond = makeTask({ name: 's', folder: second })
    const taskInFirst = makeTask({ name: 'f', folder: first })
    setWorkspace([first, second, empty], [taskInFirst, taskInSecond])
    const { provider } = makeHarness()
    await provider.refresh()
    const groups = await roots(provider)
    const folderNodes = (groups[2] as unknown as { children: { kind: string; folder: unknown }[] })
      .children
    expect(folderNodes.map((node) => node.folder)).toEqual([first, second])

    const fileChildren = (await provider.getChildren(folderNodes[0] as never)) as unknown as {
      kind: string
    }[]
    expect(fileChildren[0]?.kind).toBe('file')
    const folderItem = provider.getTreeItem(folderNodes[0] as never)
    expect(folderItem.contextValue).toBe('taskExplorerFolder')
    expect(folderItem.collapsibleState).toBe(vscode.TreeItemCollapsibleState.Collapsed)
    expect(folderItem.command?.command).toBe('extStarter.openTasksJson')
    expect(folderItem.command?.arguments?.[0]).toBe(first)
    provider.dispose()
  })

  it('⑧⑨ 四种 contextValue 组合与运行态图标（三处同 key 一致）', async () => {
    const build = makeTask({
      name: 'build',
      folder: root,
      execution: makeShellExecution('echo hi', '${workspaceFolder}'),
    })
    setWorkspace([root], [build])
    const { provider, usage, status } = makeHarness()
    await provider.refresh()
    const groups = await roots(provider)
    const fileNode = (groups[2] as unknown as { children: { kind: string }[] }).children[0]
    const taskNodes = (await provider.getChildren(fileNode as never)) as unknown as {
      entry: WorkspaceTaskEntry
    }[]
    const key = taskNodes[0]!.entry.key
    const itemOf = (): { contextValue?: string; iconPath?: unknown; tooltip?: unknown } =>
      provider.getTreeItem(taskNodes[0] as never) as never

    expect(itemOf().contextValue).toBe('workspaceTask')

    usage.addFavorite({ scopeUri: String(root.uri), source: 'Workspace', name: 'build' })
    expect(itemOf().contextValue).toBe('workspaceTaskFavorite')
    // 收藏组中的同 key 节点状态一致
    const favoritesGroup = (await roots(provider))[1] as unknown as { children: unknown[] }
    const favoriteItem = provider.getTreeItem(favoritesGroup.children[0] as never)
    expect(favoriteItem.contextValue).toBe('workspaceTaskFavorite')

    const execution = new FakeTaskExecution(taskNodes[0]!.entry.task as unknown as Task)
    __setTaskExecutions([execution])
    expect(status.isRunning(key)).toBe(true)
    expect(itemOf().contextValue).toBe('workspaceTaskRunningFavorite')
    expect((itemOf().iconPath as vscode.ThemeIcon).id).toBe('sync~spin')
    const tooltip = itemOf().tooltip as vscode.MarkdownString
    expect(String(tooltip.value)).toContain('状态：运行中、已收藏')
    expect(String(tooltip.value)).toContain('工作目录：`${workspaceFolder}`')
    expect(String(tooltip.value)).toContain('依赖：由 VS Code 任务引擎自动编排')

    // 最近运行组中的同 key 节点也是运行态
    usage.recordRun({ scopeUri: String(root.uri), source: 'Workspace', name: 'build' })
    const recentGroup = (await roots(provider))[0] as unknown as { children: unknown[] }
    const recentItem = provider.getTreeItem(recentGroup.children[0] as never)
    expect(recentItem.contextValue).toBe('workspaceTaskRunningFavorite')
    provider.dispose()
  })

  it('⑫ 任务 command 参数为原始 Task；file/folder 的 openTasksJson 参数为 folder', async () => {
    const build = makeTask({ name: 'build', folder: root })
    setWorkspace([root], [build])
    const { provider } = makeHarness()
    await provider.refresh()
    const groups = await roots(provider)
    const fileNode = (groups[2] as unknown as { children: { kind: string }[] }).children[0]
    const fileItem = provider.getTreeItem(fileNode as never)
    expect(fileItem.command?.arguments?.[0]).toBe(root)
    const taskNode = (
      (await provider.getChildren(fileNode as never)) as unknown as { entry: WorkspaceTaskEntry }[]
    )[0]!
    const taskItem = provider.getTreeItem(taskNode as never)
    expect(taskItem.command?.command).toBe('extStarter.runWorkspaceTask')
    expect(taskItem.command?.arguments?.[0]).toBe(taskNode.entry.task)
    expect(taskItem.id).toBe(`task:${taskNode.entry.key}`)
    provider.dispose()
  })

  it('⑪ 加载失败保留旧数据 + error info（三组均不受影响）', async () => {
    const build = makeTask({ name: 'build', folder: root })
    setWorkspace([root], [build])
    const { provider } = makeHarness()
    await provider.refresh()

    __stubs.fetchTasksError = new Error('host offline')
    await provider.refresh()
    const groups = await roots(provider)
    const tasksChildren = (groups[2] as unknown as { children: { kind: string; text?: string }[] })
      .children
    expect(tasksChildren[0]).toMatchObject({
      kind: 'info',
      text: '任务加载失败：host offline',
      icon: 'error',
    })
    expect(tasksChildren).toHaveLength(2) // 错误 info + 旧数据 file 节点
    expect(tasksChildren[1]?.kind).toBe('file')
    // 恢复后自动清除错误
    __stubs.fetchTasksError = undefined
    await provider.refresh()
    const recovered = (await roots(provider))[2] as unknown as { children: { kind: string }[] }
    expect(recovered.children).toHaveLength(1)
    provider.dispose()
  })

  it('⑬ usage/status 变化只 fire 不重新 fetchTasks；⑭ dispose 幂等', async () => {
    const build = makeTask({ name: 'build', folder: root })
    setWorkspace([root], [build])
    const { provider, usage } = makeHarness()
    await provider.refresh()
    const fetchCalls = (): number => __stubs.recorded.filter((e) => e.kind === 'fetchTasks').length
    expect(fetchCalls()).toBe(1)

    let fires = 0
    provider.onDidChangeTreeData(() => (fires += 1))
    usage.addFavorite({ scopeUri: String(root.uri), source: 'Workspace', name: 'build' })
    expect(fires).toBe(1)
    expect(fetchCalls()).toBe(1)

    provider.dispose()
    provider.dispose() // 幂等：不抛错
    expect(() =>
      usage.addFavorite({ scopeUri: 'file:///x', source: 'Workspace', name: 'y' })
    ).not.toThrow()
  })
})
