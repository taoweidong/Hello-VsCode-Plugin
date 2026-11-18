import * as nodeFs from 'node:fs'
import * as nodeOs from 'node:os'
import * as nodePath from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import * as vscode from 'vscode'
import { COMMAND, STORAGE } from '../../../extension/constants'
import type { FavoriteItem } from '../../../extension/features/favorites/favoritesService'
import {
  FAVORITES_SCHEMA_VERSION,
  FavoritesService,
  JsonFavoritesStore,
} from '../../../extension/features/favorites/favoritesService'
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
    dataFileUri: () => vscode.Uri.file('/memory/favorites.json'),
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
  it('① 8 个命令全部注册', () => {
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
        COMMAND.openFavoritesDataFile,
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

  it('P0 回归（v4.0.1）：菜单传入节点包装（{ kind: favorite, item }）时打开生效', async () => {
    const favorites = makeService()
    const registered = new Map<string, (...args: unknown[]) => unknown>()
    registerFavoritesCommands((id, cb) => registered.set(id, cb), { favorites })
    await favorites.add([await makeRealFile('wrapped.ts')], '包装')
    const live = favorites.list()[0]!
    const node = { kind: 'favorite', item: live }
    await registered.get(COMMAND.openFavorite)?.(node)
    expect(
      __stubs.recorded.some(
        (entry) =>
          entry.kind === 'executeCommand' && JSON.stringify(entry.args).includes('vscode.open')
      )
    ).toBe(true)
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

  it('⑩ 打开数据文件：缺失先写空信封，再 vscode.open 数据文件路径', async () => {
    const dir = await nodeFs.promises.mkdtemp(nodePath.join(nodeOs.tmpdir(), 'favdata-'))
    const fileUri = vscode.Uri.joinPath(
      vscode.Uri.file(dir),
      ...STORAGE.favoritesFileName.split('/')
    )
    const favorites = new FavoritesService(new JsonFavoritesStore(fileUri))
    const registered = new Map<string, (...args: unknown[]) => unknown>()
    registerFavoritesCommands((id, cb) => registered.set(id, cb), { favorites })
    await registered.get(COMMAND.openFavoritesDataFile)?.()
    const envelope = JSON.parse(await nodeFs.promises.readFile(fileUri.fsPath, 'utf8')) as {
      schemaVersion: number
      items: unknown[]
    }
    expect(envelope).toEqual({ schemaVersion: FAVORITES_SCHEMA_VERSION, items: [] })
    expect(
      __stubs.recorded.some(
        (entry) =>
          entry.kind === 'executeCommand' && JSON.stringify(entry.args).includes('vscode.open')
      )
    ).toBe(true)
  })
})

/**
 * 错误与取消分支（17 方案阶段 5 补测：命令壳分支覆盖 62.5% → 补齐）。
 * 用最小假服务（只实现命令消费面）驱动 service 抛错 / 状态分支，避免真实存储装配。
 */
describe('registerFavoritesCommands：错误与取消分支', () => {
  const err = new Error('EIO: store unavailable')
  let calls: Record<string, unknown[]> = {}

  /** 按用例需要覆写方法的最小 FavoritesService 形状。 */
  function makeFakeService(overrides: Record<string, (...args: unknown[]) => unknown> = {}): {
    favorites: FavoritesService
    registered: Map<string, (...args: unknown[]) => unknown>
    run: (id: string, ...args: unknown[]) => Promise<unknown>
  } {
    calls = {}
    const record =
      (name: string) =>
      (...args: unknown[]) => {
        calls[name] = args
        return undefined
      }
    const base = {
      list: () => [] as FavoriteItem[],
      add: async () => ({ added: 0, skipped: 0 }),
      open: record('open'),
      reveal: record('reveal'),
      absolutePath: async () => '/abs/path',
      rename: async () => true,
      remove: async () => true,
      ensureDataFile: record('ensureDataFile'),
      dataFileUri: () => vscode.Uri.file('/memory/favorites.json'),
      // 覆写方法同样先录制再委托，保持 calls 可断言
      ...Object.fromEntries(
        Object.entries(overrides).map(([name, fn]) => [
          name,
          (...args: unknown[]) => {
            record(name)(...args)
            return fn(...args)
          },
        ])
      ),
    }
    const favorites = base as unknown as FavoritesService
    const registered = new Map<string, (...args: unknown[]) => unknown>()
    registerFavoritesCommands((id, cb) => registered.set(id, cb), { favorites })
    return {
      favorites,
      registered,
      run: (id, ...args) => Promise.resolve(registered.get(id)?.(...args)),
    }
  }

  const recordedOf = (kind: string) => __stubs.recorded.filter((entry) => entry.kind === kind)
  const item = (overrides: Partial<FavoriteItem> = {}): FavoriteItem => ({
    id: 'f1',
    name: '文件甲',
    path: '/ws/a.ts',
    isFolder: false,
    addedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  })

  beforeEach(() => {
    __resetStubs()
    void vscode.commands.registerCommand('vscode.open', (uri: unknown) => uri)
    void vscode.commands.registerCommand('revealInExplorer', (uri: unknown) => uri)
  })

  it('addFavorite：无可用目标（无编辑器 / 非 Uri 入参）→ 提示且不调用 service', async () => {
    const { run } = makeFakeService()
    await run(COMMAND.addFavorite, 'not-a-uri')
    expect(recordedOf('showInformationMessage').at(-1)?.args[0]).toMatchObject({
      message: expect.stringContaining('没有可收藏'),
    })
    expect(recordedOf('showInputBox')).toHaveLength(0)
  })

  it('addFavorite：service.add 抛错 → showError 不抛出', async () => {
    const { run } = makeFakeService({ add: async () => Promise.reject(err) })
    const fileUri = await makeRealFile('boom.ts')
    __stubs.dialogQueue.push('别名')
    await expect(run(COMMAND.addFavorite, fileUri)).resolves.toBeUndefined()
    expect(recordedOf('showErrorMessage').at(-1)?.args[0]).toMatchObject({
      message: expect.stringContaining('EIO'),
    })
  })

  it('addFavorite：added/skipped 均为 0 → 不弹汇总提示', async () => {
    const { run } = makeFakeService()
    const fileUri = await makeRealFile('dup.ts')
    __stubs.dialogQueue.push('别名')
    await run(COMMAND.addFavorite, fileUri)
    expect(recordedOf('showInformationMessage')).toHaveLength(0)
  })

  it('quickOpenFavorites：QuickPick 取消 → 不调用 open', async () => {
    const { run } = makeFakeService({ list: () => [item()] })
    __stubs.dialogQueue.push(undefined)
    await run(COMMAND.quickOpenFavorites)
    expect(calls['open']).toBeUndefined()
    expect(recordedOf('showErrorMessage')).toHaveLength(0)
  })

  it('quickOpenFavorites：open 抛错 → showError', async () => {
    const { run } = makeFakeService({
      list: () => [item()],
      open: async () => Promise.reject(err),
    })
    __stubs.dialogQueue.push({ label: '文件甲', item: item() })
    await run(COMMAND.quickOpenFavorites)
    expect(recordedOf('showErrorMessage').at(-1)?.args[0]).toMatchObject({
      message: expect.stringContaining('EIO'),
    })
  })

  it('openFavorite / revealFavorite：service 抛错 → showError；reveal 主路径生效', async () => {
    const { run } = makeFakeService({
      open: async () => Promise.reject(err),
      reveal: async () => Promise.reject(err),
    })
    await expect(run(COMMAND.openFavorite, item())).resolves.toBeUndefined()
    expect(recordedOf('showErrorMessage').at(-1)?.args[0]).toMatchObject({
      message: expect.stringContaining('EIO'),
    })
    await expect(run(COMMAND.revealFavorite, item())).resolves.toBeUndefined()
    expect(recordedOf('showErrorMessage').length).toBe(2)
  })

  it('copyFavoritePath：absolutePath 抛错 → showError 且剪贴板不变', async () => {
    const { run } = makeFakeService({ absolutePath: async () => Promise.reject(err) })
    __stubs.clipboard = '原内容'
    await run(COMMAND.copyFavoritePath, item())
    expect(recordedOf('showErrorMessage').at(-1)?.args[0]).toMatchObject({
      message: expect.stringContaining('EIO'),
    })
    expect(__stubs.clipboard).toBe('原内容')
  })

  it('renameFavorite：取消输入 / 重命名失败（空名或条目已不存在）各给一次处理', async () => {
    const { run } = makeFakeService({ rename: async () => false })
    __stubs.dialogQueue.push(undefined)
    await run(COMMAND.renameFavorite, item())
    expect(calls['rename']).toBeUndefined() // 取消：不进 service

    __stubs.dialogQueue.push('   ')
    await run(COMMAND.renameFavorite, item())
    expect(calls['rename']).toBeDefined()
    expect(recordedOf('showInformationMessage').at(-1)?.args[0]).toMatchObject({
      message: expect.stringContaining('别名不能为空'),
    })
  })

  it('renameFavorite：service 抛错 → showError', async () => {
    const { run } = makeFakeService({ rename: async () => Promise.reject(err) })
    __stubs.dialogQueue.push('新名')
    await run(COMMAND.renameFavorite, item())
    expect(recordedOf('showErrorMessage').at(-1)?.args[0]).toMatchObject({
      message: expect.stringContaining('EIO'),
    })
  })

  it('removeFavorite：条目已不存在（removed=false）→ 静默；抛错 → showError', async () => {
    const { run } = makeFakeService({ remove: async () => false })
    await run(COMMAND.removeFavorite, item())
    expect(recordedOf('showInformationMessage')).toHaveLength(0)

    const failing = makeFakeService({ remove: async () => Promise.reject(err) })
    await failing.run(COMMAND.removeFavorite, item())
    expect(recordedOf('showErrorMessage').at(-1)?.args[0]).toMatchObject({
      message: expect.stringContaining('EIO'),
    })
  })

  it('openFavoritesDataFile：ensureDataFile 抛错 → showError 且不打开编辑器', async () => {
    const { run } = makeFakeService({ ensureDataFile: async () => Promise.reject(err) })
    await run(COMMAND.openFavoritesDataFile)
    expect(recordedOf('showErrorMessage').at(-1)?.args[0]).toMatchObject({
      message: expect.stringContaining('EIO'),
    })
    expect(
      recordedOf('executeCommand').filter(
        (entry) => (entry.args[0] as { command?: string }).command === 'vscode.open'
      )
    ).toHaveLength(0)
  })
})
