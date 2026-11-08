import * as nodeFs from 'node:fs'
import * as nodeOs from 'node:os'
import * as nodePath from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import * as vscode from 'vscode'
import { COMMAND } from '../../../extension/constants'
import type { FavoriteItem } from '../../../extension/features/favorites/favoritesService'
import { FavoritesService } from '../../../extension/features/favorites/favoritesService'
import { registerFavoritesCommands } from '../../../extension/commands/favoritesCommands'
import { __resetStubs, __stubs } from '../stubs/vscode'

/**
 * 收藏夹命令壳（v3.4，13 方案）：7 条命令注册齐全、无参调用给提示不抛错、
 * 单条添加走别名输入框（dialogQueue 应答）、批量添加静默用 basename、
 * 打开/复制/重命名/移除逐条委托 service（executeCommand 与 clipboard 录制断言）。
 */

function makeService(): FavoritesService {
  // 内存存储足够命令壳测试；stat 走 stub 的真实 Node fs
  let items: FavoriteItem[] = []
  return new FavoritesService({
    async load() {
      return items
    },
    async save(next) {
      items = next
    },
  })
}

async function makeRealFile(name = 'index.ts'): Promise<vscode.Uri> {
  const dir = await nodeFs.promises.mkdtemp(nodePath.join(nodeOs.tmpdir(), 'favcmd-'))
  const abs = nodePath.join(dir, name)
  await nodeFs.promises.writeFile(abs, '')
  return vscode.Uri.file(abs)
}

beforeEach(() => {
  __resetStubs()
  // 服务层 open/reveal 经 executeCommand 路由：预注册内置命令假处理器（录制即可）
  void vscode.commands.registerCommand('vscode.open', (uri: unknown) => uri)
  void vscode.commands.registerCommand('revealInExplorer', (uri: unknown) => uri)
})

describe('registerFavoritesCommands（收藏夹命令）', () => {
  it('① 7 个命令全部注册', () => {
    const registered = new Map<string, (...args: unknown[]) => unknown>()
    registerFavoritesCommands((id, cb) => registered.set(id, cb), { favorites: makeService() })
    expect([...registered.keys()].sort()).toEqual(
      [
        COMMAND.addFavorite,
        COMMAND.quickOpenFavorites,
        COMMAND.openFavorite,
        COMMAND.revealFavorite,
        COMMAND.copyFavoritePath,
        COMMAND.renameFavorite,
        COMMAND.removeFavorite,
      ].sort()
    )
  })

  it('② 单条添加：别名输入框（留空回退 basename）', async () => {
    const favorites = makeService()
    const registered = new Map<string, (...args: unknown[]) => unknown>()
    registerFavoritesCommands((id, cb) => registered.set(id, cb), { favorites })
    const fileUri = await makeRealFile('landing.html')
    __stubs.dialogQueue.push('我的别名')
    await registered.get(COMMAND.addFavorite)?.(fileUri)
    expect(favorites.list()[0]?.name).toBe('我的别名')
  })

  it('③ 取消输入框：不入列', async () => {
    const favorites = makeService()
    const registered = new Map<string, (...args: unknown[]) => unknown>()
    registerFavoritesCommands((id, cb) => registered.set(id, cb), { favorites })
    __stubs.dialogQueue.push(undefined)
    await registered.get(COMMAND.addFavorite)?.(await makeRealFile('x.js'))
    expect(favorites.list()).toHaveLength(0)
  })

  it('④ 批量添加：不弹输入框、别名取 basename、汇总提示', async () => {
    const favorites = makeService()
    const registered = new Map<string, (...args: unknown[]) => unknown>()
    registerFavoritesCommands((id, cb) => registered.set(id, cb), { favorites })
    const first = await makeRealFile('a.ts')
    const second = await makeRealFile('b.ts')
    await registered.get(COMMAND.addFavorite)?.(first, [first, second])
    expect(__stubs.recorded.some((entry) => entry.kind === 'showInputBox')).toBe(false)
    expect(favorites.list()).toHaveLength(2)
    expect(
      favorites
        .list()
        .map((item) => item.name)
        .sort()
    ).toEqual(['a.ts', 'b.ts'])
  })

  it('⑤ 打开收藏：带参委托 service（vscode.open 录制）；无参给提示不抛错', async () => {
    const favorites = makeService()
    const registered = new Map<string, (...args: unknown[]) => unknown>()
    registerFavoritesCommands((id, cb) => registered.set(id, cb), { favorites })
    await favorites.add([await makeRealFile('src-index.ts')], '首页')
    const live = favorites.list()[0]
    if (!live) {
      throw new Error('应有收藏')
    }
    await registered.get(COMMAND.openFavorite)?.(live)
    expect(
      __stubs.recorded.some(
        (entry) =>
          entry.kind === 'executeCommand' && JSON.stringify(entry.args).includes('vscode.open')
      )
    ).toBe(true)
    const before = __stubs.recorded.length
    await registered.get(COMMAND.openFavorite)?.()
    expect(__stubs.recorded.length).toBe(before + 1) // 仅新增一条 info 提示
    expect(__stubs.recorded.at(-1)?.kind).toBe('showInformationMessage')
  })

  it('⑥ 复制路径写入剪贴板（解析为绝对路径）', async () => {
    const favorites = makeService()
    const registered = new Map<string, (...args: unknown[]) => unknown>()
    registerFavoritesCommands((id, cb) => registered.set(id, cb), { favorites })
    const fileUri = await makeRealFile('note.md')
    await favorites.add([fileUri], '笔记')
    await registered.get(COMMAND.copyFavoritePath)?.(favorites.list()[0])
    expect(__stubs.clipboard).toBe(fileUri.fsPath)
  })

  it('⑦ 重命名：输入框预填现别名，提交后生效', async () => {
    const favorites = makeService()
    const registered = new Map<string, (...args: unknown[]) => unknown>()
    registerFavoritesCommands((id, cb) => registered.set(id, cb), { favorites })
    await favorites.add([await makeRealFile('r.ts')], '旧名')
    const item = favorites.list()[0]
    __stubs.dialogQueue.push('新名')
    await registered.get(COMMAND.renameFavorite)?.(item)
    expect(favorites.list()[0]?.name).toBe('新名')
  })

  it('⑧ 移除：委托 service 并提示', async () => {
    const favorites = makeService()
    const registered = new Map<string, (...args: unknown[]) => unknown>()
    registerFavoritesCommands((id, cb) => registered.set(id, cb), { favorites })
    await favorites.add([await makeRealFile('d.ts')], '待删')
    const item = favorites.list()[0]
    await registered.get(COMMAND.removeFavorite)?.(item)
    expect(favorites.list()).toHaveLength(0)
    expect(
      __stubs.recorded.some(
        (entry) =>
          entry.kind === 'showInformationMessage' &&
          JSON.stringify(entry.args).includes('已从收藏夹移除')
      )
    ).toBe(true)
  })

  it('⑨ 快速打开：空态提示；选中后委托 open', async () => {
    const favorites = makeService()
    const registered = new Map<string, (...args: unknown[]) => unknown>()
    registerFavoritesCommands((id, cb) => registered.set(id, cb), { favorites })
    await registered.get(COMMAND.quickOpenFavorites)?.()
    expect(
      __stubs.recorded.some(
        (entry) =>
          entry.kind === 'showInformationMessage' &&
          JSON.stringify(entry.args).includes('收藏夹为空')
      )
    ).toBe(true)

    await favorites.add([await makeRealFile('q.ts')], '快速')
    const item = favorites.list()[0]
    __stubs.dialogQueue.push({ label: '快速', description: item?.path, detail: '文件', item })
    await registered.get(COMMAND.quickOpenFavorites)?.()
    expect(
      __stubs.recorded.some(
        (entry) =>
          entry.kind === 'executeCommand' && JSON.stringify(entry.args).includes('vscode.open')
      )
    ).toBe(true)
  })
})
