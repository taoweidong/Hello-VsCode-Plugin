import * as nodeFs from 'node:fs'
import * as nodeOs from 'node:os'
import * as nodePath from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as vscode from 'vscode'
import { STORAGE } from '../../../extension/constants'
import {
  createFavoritesStore,
  FAVORITES_SCHEMA_VERSION,
  FavoritesService,
  JsonFavoritesStore,
  MAX_FAVORITES,
  MementoFavoritesStore,
  normalizeFavoriteList,
} from '../../../extension/features/favorites/favoritesService'
import { __resetStubs, __stubs, createMementoStub } from '../stubs/vscode'

/**
 * 收藏夹服务（v3.4，13 方案）：存储契约（信封 / 顶层兼容 / 损坏备份）、
 * 归一化守卫（丢坏条 / 上限裁剪 / 别名回退）、添加去重 / 批量 / 重命名 / 移除、
 * 相对路径解析与打开路由（文件 vscode.open / 文件夹 revealInExplorer）。
 */

let tmpRoot = ''

async function makeTmpWorkspace(): Promise<string> {
  const root = await nodeFs.promises.mkdtemp(nodePath.join(nodeOs.tmpdir(), 'favorites-'))
  await nodeFs.promises.mkdir(nodePath.join(root, '.vscode'))
  return root
}

function setWorkspace(root: string): void {
  __stubs.workspaceFolders = [
    { uri: vscode.Uri.file(root), name: nodePath.basename(root), index: 0 },
  ]
}

function favoritesFileUri(root: string): vscode.Uri {
  return vscode.Uri.joinPath(vscode.Uri.file(root), ...STORAGE.favoritesFileName.split('/'))
}

async function writeFile(root: string, rel: string, content = ''): Promise<vscode.Uri> {
  const abs = nodePath.join(root, rel)
  await nodeFs.promises.mkdir(nodePath.dirname(abs), { recursive: true })
  await nodeFs.promises.writeFile(abs, content)
  return vscode.Uri.file(abs)
}

function makeService(root = tmpRoot, onWarning?: (message: string) => void): FavoritesService {
  return new FavoritesService(new JsonFavoritesStore(favoritesFileUri(root), { onWarning }))
}

beforeEach(async () => {
  __resetStubs()
  tmpRoot = await makeTmpWorkspace()
  setWorkspace(tmpRoot)
})

afterEach(async () => {
  __stubs.workspaceFolders = undefined
  await nodeFs.promises.rm(tmpRoot, { recursive: true, force: true })
})

describe('JsonFavoritesStore（存储契约）', () => {
  it('① 文件不存在视为空数据（首次使用）', async () => {
    const store = new JsonFavoritesStore(favoritesFileUri(tmpRoot))
    await expect(store.load()).resolves.toEqual([])
  })

  it('② save → load 往返保持信封格式', async () => {
    const store = new JsonFavoritesStore(favoritesFileUri(tmpRoot))
    const items = [
      {
        id: 'a',
        name: '首页',
        path: 'index.html',
        isFolder: false,
        addedAt: '2026-11-08T00:00:00Z',
      },
    ]
    await store.save(items)
    await expect(store.load()).resolves.toEqual(items)
    const envelope = JSON.parse(
      await nodeFs.promises.readFile(favoritesFileUri(tmpRoot).fsPath, 'utf8')
    ) as { schemaVersion: number; items: unknown[] }
    expect(envelope.schemaVersion).toBe(FAVORITES_SCHEMA_VERSION)
    expect(Array.isArray(envelope.items)).toBe(true)
  })

  it('③ 顶层数组宽容读取（手写形态）', async () => {
    await nodeFs.promises.writeFile(
      favoritesFileUri(tmpRoot).fsPath,
      JSON.stringify([
        { path: 'src/app.ts', name: '入口', isFolder: false, addedAt: '2026-11-08T00:00:00Z' },
      ])
    )
    const store = new JsonFavoritesStore(favoritesFileUri(tmpRoot))
    const items = await store.load()
    expect(items).toHaveLength(1)
    expect(items[0]?.name).toBe('入口')
  })

  it('④ 损坏文件：复制 .bak 备份后按空数据继续，原文件保留', async () => {
    await nodeFs.promises.writeFile(favoritesFileUri(tmpRoot).fsPath, '{broken json')
    const warnings: string[] = []
    const store = new JsonFavoritesStore(favoritesFileUri(tmpRoot), {
      onWarning: (message) => warnings.push(message),
    })
    await expect(store.load()).resolves.toEqual([])
    const dirEntries = nodeFs.readdirSync(nodePath.join(tmpRoot, '.vscode'))
    expect(dirEntries.some((name) => name.includes('.bak'))).toBe(true)
    expect(warnings.some((message) => message.includes('损坏'))).toBe(true)
  })
})

describe('normalizeFavoriteList（归一化守卫）', () => {
  it('⑤ 丢弃非法条目、别名回退 basename、缺失 id/addedAt 补齐', () => {
    const items = normalizeFavoriteList([
      { path: 'src/app.ts' },
      { path: '', name: 'x' },
      'not-an-object',
      null,
      {
        id: 'keep',
        path: 'docs/README.md',
        name: '文档',
        isFolder: true,
        addedAt: '2026-11-08T00:00:00Z',
      },
    ])
    expect(items).toHaveLength(2)
    expect(items[0]?.name).toBe('app.ts')
    expect(items[0]?.id).toBeTruthy()
    expect(items[1]?.id).toBe('keep')
    expect(items[1]?.isFolder).toBe(true)
  })

  it('⑥ 超上限裁剪保留前 MAX 条', () => {
    const raw = Array.from({ length: MAX_FAVORITES + 5 }, (_, index) => ({
      path: `f${index}.txt`,
      addedAt: '2026-11-08T00:00:00Z',
    }))
    const items = normalizeFavoriteList(raw)
    expect(items).toHaveLength(MAX_FAVORITES)
    expect(items[0]?.path).toBe('f0.txt')
  })
})

describe('FavoritesService（业务服务）', () => {
  it('⑦ 添加单个文件：别名生效、工作区内存相对路径、落盘持久化', async () => {
    const fileUri = await writeFile(tmpRoot, 'src/index.ts')
    const service = makeService()
    const result = await service.add([fileUri], '入口文件')
    expect(result).toEqual({ added: 1, skipped: 0 })
    const [item] = service.list()
    expect(item?.name).toBe('入口文件')
    expect(item?.path).toBe(toPosixRel('src/index.ts'))
    expect(item?.isFolder).toBe(false)
    // 持久化：新实例读回同一条
    const reloaded = makeService()
    await reloaded.load()
    expect(reloaded.list()[0]?.name).toBe('入口文件')
  })

  it('⑧ 文件夹收藏 isFolder=true；批量添加别名取 basename', async () => {
    const folderUri = vscode.Uri.file(nodePath.join(tmpRoot, 'src'))
    await nodeFs.promises.mkdir(folderUri.fsPath, { recursive: true })
    const fileUri = await writeFile(tmpRoot, 'docs/readme.md')
    const service = makeService()
    const result = await service.add([folderUri, fileUri])
    expect(result.added).toBe(2)
    expect(service.list()[0]?.isFolder).toBe(true)
    expect(service.list()[0]?.path).toBe(toPosixRel('src'))
    expect(service.list()[1]?.name).toBe('readme.md')
  })

  it('⑨ 重复路径去重跳过', async () => {
    const fileUri = await writeFile(tmpRoot, 'app.js')
    const service = makeService()
    await service.add([fileUri])
    const again = await service.add([fileUri], '另一个名')
    expect(again).toEqual({ added: 0, skipped: 1 })
    expect(service.list()).toHaveLength(1)
  })

  it('⑩ 不可访问的 URI 计入 skipped', async () => {
    const service = makeService()
    const result = await service.add([vscode.Uri.file(nodePath.join(tmpRoot, 'no-such.txt'))])
    expect(result).toEqual({ added: 0, skipped: 1 })
  })

  it('⑪ 重命名与移除', async () => {
    const fileUri = await writeFile(tmpRoot, 'a.md')
    const service = makeService()
    await service.add([fileUri])
    const id = service.list()[0]?.id ?? ''
    await expect(service.rename(id, '  新别名 ')).resolves.toBe(true)
    expect(service.list()[0]?.name).toBe('新别名')
    await expect(service.rename(id, '   ')).resolves.toBe(false)
    await expect(service.remove(id)).resolves.toBe(true)
    expect(service.list()).toHaveLength(0)
    await expect(service.remove(id)).resolves.toBe(false)
  })

  it('⑫ 相对路径解析：命中工作区文件夹；绝对路径原样返回', async () => {
    await writeFile(tmpRoot, 'docs/guide.md')
    const service = makeService()
    await service.add([vscode.Uri.file(nodePath.join(tmpRoot, 'docs', 'guide.md'))])
    const item = service.list()[0] ?? failWith('应有收藏')
    const resolved = await service.resolveFavoriteUri(item)
    expect(resolved.fsPath).toBe(nodePath.join(tmpRoot, 'docs', 'guide.md'))
    const absolute = await service.resolveFavoriteUri({
      id: 'x',
      name: '外部',
      path: nodePath.join(tmpRoot, 'outside.txt'),
      isFolder: false,
      addedAt: '2026-11-08T00:00:00Z',
    })
    expect(absolute.fsPath).toBe(nodePath.join(tmpRoot, 'outside.txt'))
  })

  it('⑬ 打开路由：文件 vscode.open、文件夹 revealInExplorer（executeCommand 录制断言）', async () => {
    const fileUri = await writeFile(tmpRoot, 'page.html')
    const folderUri = vscode.Uri.file(nodePath.join(tmpRoot, 'docs'))
    await nodeFs.promises.mkdir(folderUri.fsPath, { recursive: true })
    const opened: string[] = []
    void vscode.commands.registerCommand('vscode.open', (uri: unknown) => {
      opened.push('vscode.open')
      return uri
    })
    void vscode.commands.registerCommand('revealInExplorer', (uri: unknown) => {
      opened.push('revealInExplorer')
      return uri
    })
    const service = makeService()
    await service.add([fileUri])
    await service.add([folderUri]) // 后添加的在头部（MRU 语义）
    const fileItem = service.list().find((entry) => !entry.isFolder) ?? failWith('缺文件收藏')
    const folderItem = service.list().find((entry) => entry.isFolder) ?? failWith('缺文件夹收藏')
    await service.open(fileItem)
    await service.open(folderItem)
    expect(opened).toEqual(['vscode.open', 'revealInExplorer'])
  })

  it('⑭ Memento 双实现：无工作区回退 globalState 往返', async () => {
    const store = new MementoFavoritesStore(createMementoStub(), STORAGE.favoritesMementoKey)
    await store.save([
      {
        id: 'm1',
        name: '备忘',
        path: 'C:/out.txt',
        isFolder: false,
        addedAt: '2026-11-08T00:00:00Z',
      },
    ])
    await expect(store.load()).resolves.toMatchObject([{ id: 'm1', name: '备忘' }])
  })

  it('⑮ createFavoritesStore 装配路由：有工作区 → JSON 文件；无工作区 → Memento', () => {
    setWorkspace(tmpRoot)
    const context = { globalState: createMementoStub() } as unknown as vscode.ExtensionContext
    expect(createFavoritesStore(context)).toBeInstanceOf(JsonFavoritesStore)
    __stubs.workspaceFolders = undefined
    expect(createFavoritesStore(context)).toBeInstanceOf(MementoFavoritesStore)
  })
})

/* ------------------------------ 辅助 ------------------------------ */

function toPosixRel(value: string): string {
  return value.split('\\').join('/')
}

function failWith(message: string): never {
  throw new Error(message)
}
