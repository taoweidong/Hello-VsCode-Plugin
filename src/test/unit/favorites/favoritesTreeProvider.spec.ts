import * as nodeFs from 'node:fs'
import * as nodeOs from 'node:os'
import * as nodePath from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import * as vscode from 'vscode'
import { COMMAND } from '../../../extension/constants'
import type {
  FavoriteItem,
  IFavoritesStore,
} from '../../../extension/features/favorites/favoritesService'
import { FavoritesService } from '../../../extension/features/favorites/favoritesService'
import { FavoritesTreeProvider } from '../../../extension/features/favorites/favoritesTreeProvider'
import { __resetStubs, TreeItemCollapsibleState } from '../stubs/vscode'

/**
 * 收藏夹树视图（v3.4，13 方案）：空态 info、条目渲染（label=别名 / description=路径 /
 * 单击路由 openFavorite / contextValue=favorite）、onDidChange 驱动刷新、加载失败 info。
 */

/** 内存存储（用例隔离，不落盘）。 */
function makeMemoryStore(initial: FavoriteItem[] = []): IFavoritesStore {
  let items = initial
  return {
    async load() {
      return items
    },
    async save(next) {
      items = next
    },
  }
}

async function makeRealFile(): Promise<vscode.Uri> {
  const dir = await nodeFs.promises.mkdtemp(nodePath.join(nodeOs.tmpdir(), 'favtree-'))
  const abs = nodePath.join(dir, 'index.html')
  await nodeFs.promises.writeFile(abs, '<html></html>')
  return vscode.Uri.file(abs)
}

beforeEach(() => {
  __resetStubs()
})

describe('FavoritesTreeProvider（收藏夹树视图）', () => {
  it('① 空态渲染「暂无收藏」info 节点', async () => {
    const provider = new FavoritesTreeProvider(new FavoritesService(makeMemoryStore()))
    const children = await provider.getChildren()
    expect(children).toHaveLength(1)
    expect(children[0]?.kind).toBe('info')
    if (children[0]?.kind === 'info') {
      expect(children[0].text).toContain('暂无收藏')
      expect(children[0].icon).toBe('star-empty')
    }
  })

  it('② 条目渲染：label=别名、description=路径、单击路由 openFavorite、contextValue=favorite', async () => {
    const service = new FavoritesService(makeMemoryStore())
    const fileUri = await makeRealFile()
    await service.add([fileUri], '首页')
    const provider = new FavoritesTreeProvider(service)
    const children = await provider.getChildren()
    expect(children[0]?.kind).toBe('favorite')
    if (children[0]?.kind === 'favorite') {
      const treeItem = provider.getTreeItem(children[0])
      expect(treeItem.label).toBe('首页')
      expect(treeItem.description).toBe(children[0].item.path)
      expect(treeItem.command?.command).toBe(COMMAND.openFavorite)
      expect(treeItem.command?.arguments?.[0]).toBe(children[0].item)
      expect(treeItem.contextValue).toBe('favorite')
      expect(treeItem.collapsibleState).toBe(TreeItemCollapsibleState.None)
    }
  })

  it('③ 数据变化驱动刷新（service.onDidChange → fire）', async () => {
    const service = new FavoritesService(makeMemoryStore())
    const provider = new FavoritesTreeProvider(service)
    let fired = 0
    provider.onDidChangeTreeData(() => {
      fired += 1
    })
    await service.add([await makeRealFile()])
    expect(fired).toBeGreaterThanOrEqual(1)
  })

  it('④ 加载失败以 error info 呈现', async () => {
    const failing: IFavoritesStore = {
      load: () => Promise.reject(new Error('磁盘不可用')),
      save: () => Promise.resolve(),
    }
    const service = new FavoritesService(failing)
    await service.load()
    const provider = new FavoritesTreeProvider(service)
    const children = await provider.getChildren()
    if (children[0]?.kind === 'info') {
      expect(children[0].text).toContain('磁盘不可用')
      expect(children[0].icon).toBe('error')
    } else {
      throw new Error('应渲染 info 节点')
    }
  })
})
