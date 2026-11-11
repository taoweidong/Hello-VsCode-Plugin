import { beforeEach, describe, expect, it } from 'vitest'
import * as vscode from 'vscode'
import {
  QuickCommandsService,
  type IQuickCommandsStore,
  type QuickCommandsData,
} from '../../../extension/features/quickCommands/quickCommandsService'
import {
  QuickCommandsTreeProvider,
  type QuickCommandTreeNode,
} from '../../../extension/features/quickCommands/quickCommandsTreeProvider'
import { __resetStubs } from '../stubs/vscode'

/**
 * 快捷命令树视图（v3.5，16 方案）：两级树（分组 → 命令）、未分组末位、
 * 空态/错误态 info 节点、命令节点单击路由 executeQuickCommand。
 */

class FakeStore implements IQuickCommandsStore {
  data: QuickCommandsData = { groups: [], commands: [] }

  async load(): Promise<QuickCommandsData> {
    return JSON.parse(JSON.stringify(this.data)) as QuickCommandsData
  }

  async save(data: QuickCommandsData): Promise<void> {
    this.data = JSON.parse(JSON.stringify(data)) as QuickCommandsData
  }

  dataFileUri(): vscode.Uri {
    return vscode.Uri.file('/memory/quick-commands.json')
  }
}

/** 种子宽松形态：只填用例关心的字段，其余由辅助函数补默认值。 */
type GroupSeed = { id: string; name: string; createdAt?: string }
type ItemSeed = {
  id?: string
  name?: string
  command: string
  groupId?: string | null
  addedAt?: string
  useCount?: number
}

function makeHost(data: { groups?: GroupSeed[]; commands?: ItemSeed[] } = {}): {
  service: QuickCommandsService
  provider: QuickCommandsTreeProvider
} {
  const store = new FakeStore()
  store.data = {
    groups: (data.groups ?? []).map((group) => ({
      id: group.id,
      name: group.name,
      createdAt: group.createdAt ?? '2026-01-01T00:00:00.000Z',
    })),
    commands: (data.commands ?? []).map((item, index) => ({
      id: item.id ?? `seed-${index}`,
      name: item.name ?? item.command,
      command: item.command,
      groupId: item.groupId ?? null,
      addedAt: item.addedAt ?? '2026-01-01T00:00:00.000Z',
      ...(item.useCount !== undefined ? { useCount: item.useCount } : {}),
    })),
  }
  const service = new QuickCommandsService(store)
  const provider = new QuickCommandsTreeProvider(service)
  return { service, provider }
}

async function loaded(
  data: { groups?: GroupSeed[]; commands?: ItemSeed[] } = {}
): Promise<QuickCommandsTreeProvider> {
  const { service, provider } = makeHost(data)
  await service.load()
  return provider
}

function isInfo(
  node: QuickCommandTreeNode
): node is Extract<QuickCommandTreeNode, { kind: 'info' }> {
  return node.kind === 'info'
}

describe('QuickCommandsTreeProvider（两级树）', () => {
  beforeEach(() => {
    __resetStubs()
  })

  it('加载失败 → 单个 error info 节点', async () => {
    const failing = new (class implements IQuickCommandsStore {
      async load(): Promise<QuickCommandsData> {
        throw new Error('读不出来')
      }
      async save(): Promise<void> {}
      dataFileUri(): vscode.Uri {
        return vscode.Uri.file('/memory/quick-commands.json')
      }
    })()
    const service = new QuickCommandsService(failing)
    const provider = new QuickCommandsTreeProvider(service)
    await service.load()
    const nodes = await provider.getChildren()
    expect(nodes).toHaveLength(1)
    const info = nodes[0]!
    expect(isInfo(info) && info.icon).toBe('error')
    expect(isInfo(info) && info.text).toContain('读不出来')
  })

  it('全空 → 单个空态 info 节点', async () => {
    const provider = await loaded()
    const nodes = await provider.getChildren()
    expect(nodes).toHaveLength(1)
    expect(isInfo(nodes[0]!)).toBe(true)
  })

  it('根节点：分组按数组序在前，「未分组」固定末位且无内容不显示', async () => {
    const provider = await loaded({
      groups: [
        { id: 'g1', name: 'git' },
        { id: 'g2', name: '构建' },
      ],
      commands: [
        { id: 'c1', name: 'push', command: 'git push', groupId: 'g2' },
        { id: 'c2', name: 'st', command: 'git status', groupId: 'g1' },
      ],
    })
    const nodes = await provider.getChildren()
    const kinds = nodes.map((node) =>
      node.kind === 'group' ? (node.group?.name ?? '未分组') : node.kind
    )
    expect(kinds).toEqual(['git', '构建'])
  })

  it('未分组有内容时出现在末位', async () => {
    const provider = await loaded({
      groups: [{ id: 'g1', name: 'git' }],
      commands: [
        { id: 'c1', name: 'st', command: 'git status', groupId: 'g1' },
        { id: 'c2', name: 'ls', command: 'ls', groupId: null },
      ],
    })
    const nodes = await provider.getChildren()
    const last = nodes[nodes.length - 1]!
    expect(last.kind === 'group' && last.group === null).toBe(true)
  })

  it('分组节点：label 含计数、图标 folder/inbox、Collapsed、contextValue', async () => {
    const provider = await loaded({
      groups: [{ id: 'g1', name: 'git' }],
      commands: [
        { id: 'c1', name: 'st', command: 'git status', groupId: 'g1' },
        { id: 'c2', name: 'ls', command: 'ls', groupId: null },
      ],
    })
    const nodes = (await provider.getChildren()).filter((node) => node.kind === 'group')
    const git = new vscode.TreeItem('')
    if (nodes[0]!.kind === 'group') {
      Object.assign(git, provider.getTreeItem(nodes[0]!))
    }
    expect(git.label).toBe('git (1)')
    expect((git.iconPath as vscode.ThemeIcon).id).toBe('folder')
    expect(git.collapsibleState).toBe(vscode.TreeItemCollapsibleState.Collapsed)
    expect(git.contextValue).toBe('quickCommandGroup')

    const ungrouped = nodes[1]!
    const ungroupedItem = provider.getTreeItem(ungrouped)
    expect(ungroupedItem.label).toBe('未分组 (1)')
    expect((ungroupedItem.iconPath as vscode.ThemeIcon).id).toBe('inbox')
  })

  it('命令节点：label=别名、description=命令单行、icon=terminal、contextValue、单击路由 executeQuickCommand', async () => {
    const provider = await loaded({
      commands: [{ id: 'c1', name: 'push', command: 'git push\norigin main', groupId: null }],
    })
    const groupNode = (await provider.getChildren())[0]!
    expect(groupNode.kind).toBe('group')
    const commandNodes = await provider.getChildren(groupNode)
    expect(commandNodes).toHaveLength(1)
    const commandNode = commandNodes[0]!
    expect(commandNode.kind).toBe('command')

    const treeItem = provider.getTreeItem(commandNode)
    expect(treeItem.label).toBe('push')
    expect(treeItem.description).toBe('git push origin main')
    expect((treeItem.iconPath as vscode.ThemeIcon).id).toBe('terminal')
    expect(treeItem.contextValue).toBe('quickCommand')
    expect(treeItem.command?.command).toBe('extStarter.executeQuickCommand')
    expect(treeItem.command?.arguments).toEqual([
      (commandNode as Extract<QuickCommandTreeNode, { kind: 'command' }>).item,
    ])
  })

  it('长命令 description 截断 60 字符加省略号；tooltip 含完整命令', async () => {
    const longCommand = `${'x'.repeat(80)} end`
    const provider = await loaded({
      commands: [{ id: 'c1', name: 'long', command: longCommand, groupId: null }],
    })
    const commandNode = (await provider.getChildren((await provider.getChildren())[0]!))[0]!
    const treeItem = provider.getTreeItem(commandNode)
    expect(treeItem.description).toBe(`${'x'.repeat(60 - 1)}…`)
    const tooltip = (treeItem.tooltip as vscode.MarkdownString).value
    expect(tooltip).toContain(longCommand)
  })

  it('onDidChange 数据变更 → 触发树刷新事件', async () => {
    const { service, provider } = makeHost()
    await service.load()
    let fired = 0
    provider.onDidChangeTreeData(() => {
      fired += 1
    })
    await service.addCommand({ command: 'ls', groupId: null })
    expect(fired).toBeGreaterThan(0)
  })
})

describe('未分组节点 contextValue（v4.0.1）', () => {
  it('未分组使用独立 contextValue，不显示分组重命名/删除菜单', async () => {
    const { service, provider } = makeHost({ commands: [{ id: 'c1', name: 'a', command: 'ls' }] })
    await service.load()
    const groups = await provider.getChildren()
    const ungrouped = groups.find((node) => node.kind === 'group' && node.group === null)
    expect(ungrouped).toBeDefined()
    const treeItem = provider.getTreeItem(ungrouped!)
    expect(treeItem.contextValue).toBe('quickCommandGroupUngrouped')
    expect(treeItem.contextValue).not.toBe('quickCommandGroup')
  })

  it('真实分组仍使用 quickCommandGroup', async () => {
    const { service, provider } = makeHost({ groups: [{ id: 'g1', name: 'git' }] })
    await service.load()
    const groups = await provider.getChildren()
    const treeItem = provider.getTreeItem(groups[0]!)
    expect(treeItem.contextValue).toBe('quickCommandGroup')
  })
})
