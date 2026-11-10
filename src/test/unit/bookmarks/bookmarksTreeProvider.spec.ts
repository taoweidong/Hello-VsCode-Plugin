import { beforeEach, describe, expect, it } from 'vitest'
import * as vscode from 'vscode'
import { COMMAND } from '../../../extension/constants'
import type {
  BookmarkItem,
  IBookmarksStore,
} from '../../../extension/features/bookmarks/bookmarksService'
import { BookmarksService } from '../../../extension/features/bookmarks/bookmarksService'
import { BookmarksTreeProvider } from '../../../extension/features/bookmarks/bookmarksTreeProvider'
import { __resetStubs, TreeItemCollapsibleState } from '../stubs/vscode'

/**
 * 书签树视图（v3.6，14 方案 §6）：文件分组两级树（分组按 path 升序、组内按 line 升序）、
 * 条目渲染（label=行文本快照 / description=L 行号 / 单击路由 jumpToBookmark /
 * contextValue 区分文件组与条目）、空态与加载失败 info、onDidChange 驱动刷新。
 */

/** 内存存储（用例隔离，不落盘）。 */
function makeMemoryStore(initial: BookmarkItem[] = []): IBookmarksStore {
  let items = initial
  return {
    async load() {
      return items
    },
    async save(next) {
      items = next
    },
    dataFileUri: () => vscode.Uri.file('/memory/bookmarks.json'),
  }
}

function makeItem(path: string, line: number, text: string): BookmarkItem {
  return { id: `${path}:${line}`, path, line, text, addedAt: '2026-11-10T00:00:00Z' }
}

beforeEach(() => {
  __resetStubs()
})

describe('BookmarksTreeProvider（书签树视图）', () => {
  it('① 空态渲染「暂无书签」info 节点（含 Ctrl+Alt+K 引导）', async () => {
    const provider = new BookmarksTreeProvider(new BookmarksService(makeMemoryStore()))
    const children = await provider.getChildren()
    expect(children).toHaveLength(1)
    expect(children[0]?.kind).toBe('info')
    if (children[0]?.kind === 'info') {
      expect(children[0].text).toContain('暂无书签')
      expect(children[0].text).toContain('Ctrl+Alt+K')
      expect(children[0].icon).toBe('bookmark')
    }
  })

  it('② 文件分组保序：交错添加后按 path 升序分组、组内按 line 升序', async () => {
    const store = makeMemoryStore([
      makeItem('b.ts', 20, 'b20'),
      makeItem('a.ts', 10, 'a10'),
      makeItem('b.ts', 5, 'b5'),
      makeItem('a.ts', 30, 'a30'),
    ])
    const service = new BookmarksService(store)
    await service.load()
    const provider = new BookmarksTreeProvider(service)
    const children = await provider.getChildren()
    expect(children).toHaveLength(2)
    expect(children[0]?.kind).toBe('file')
    expect(children[1]?.kind).toBe('file')
    if (children[0]?.kind === 'file' && children[1]?.kind === 'file') {
      expect(children[0].path).toBe('a.ts')
      expect(children[0].children.map((item) => item.line)).toEqual([10, 30])
      expect(children[1].path).toBe('b.ts')
      expect(children[1].children.map((item) => item.line)).toEqual([5, 20])
    }
  })

  it('③ 文件节点渲染：label=basename、description=所在目录、单击路由组内第一条、默认展开', async () => {
    const store = makeMemoryStore([makeItem('deep/nested/a.ts', 10, 'a10')])
    const service = new BookmarksService(store)
    await service.load()
    const provider = new BookmarksTreeProvider(service)
    const children = await provider.getChildren()
    if (children[0]?.kind !== 'file') {
      throw new Error('应为 file 节点')
    }
    const treeItem = provider.getTreeItem(children[0])
    expect(treeItem.label).toBe('a.ts')
    expect(treeItem.description).toBe('deep/nested')
    expect(treeItem.contextValue).toBe('bookmarkFile')
    expect(treeItem.collapsibleState).toBe(TreeItemCollapsibleState.Expanded)
    expect(treeItem.command?.command).toBe(COMMAND.jumpToBookmark)
    expect(treeItem.command?.arguments?.[0]).toBe(children[0].children[0])
  })

  it('④ 书签条目渲染：label=行文本快照、description=L 行号、单击路由自身', async () => {
    const item = makeItem('a.ts', 9, 'const value = 1')
    const service = new BookmarksService(makeMemoryStore([item]))
    await service.load()
    const provider = new BookmarksTreeProvider(service)
    const groups = await provider.getChildren()
    if (groups[0]?.kind !== 'file') {
      throw new Error('应为 file 节点')
    }
    const children = await provider.getChildren(groups[0])
    expect(children).toHaveLength(1)
    if (children[0]?.kind !== 'bookmark') {
      throw new Error('应为 bookmark 节点')
    }
    const treeItem = provider.getTreeItem(children[0])
    expect(treeItem.label).toBe('const value = 1')
    expect(treeItem.description).toBe('L10')
    expect(treeItem.contextValue).toBe('bookmark')
    expect(treeItem.collapsibleState).toBe(TreeItemCollapsibleState.None)
    expect(treeItem.command?.command).toBe(COMMAND.jumpToBookmark)
    expect(treeItem.command?.arguments?.[0]).toBe(item)
    // stub 的 MarkdownString 把文本存在 .value
    const tooltip = (treeItem.tooltip as { value: string }).value
    expect(tooltip).toContain('快照')
  })

  it('⑤ 数据变化驱动刷新（service.onDidChange → fire）', async () => {
    const service = new BookmarksService(makeMemoryStore())
    await service.load()
    const provider = new BookmarksTreeProvider(service)
    let fired = 0
    provider.onDidChangeTreeData(() => {
      fired += 1
    })
    await service.toggle(vscode.Uri.file('/tmp/x.ts'), 0, 'x')
    expect(fired).toBeGreaterThanOrEqual(1)
  })

  it('⑥ 加载失败以 error info 呈现', async () => {
    const failing: IBookmarksStore = {
      load: () => Promise.reject(new Error('磁盘不可用')),
      save: () => Promise.resolve(),
      dataFileUri: () => vscode.Uri.file('/memory/bookmarks.json'),
    }
    const service = new BookmarksService(failing)
    await service.load()
    const provider = new BookmarksTreeProvider(service)
    const children = await provider.getChildren()
    if (children[0]?.kind === 'info') {
      expect(children[0].text).toContain('磁盘不可用')
      expect(children[0].icon).toBe('error')
    } else {
      throw new Error('应渲染 info 节点')
    }
  })
})
