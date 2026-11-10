import * as nodeFs from 'node:fs'
import * as nodeOs from 'node:os'
import * as nodePath from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as vscode from 'vscode'
import { STORAGE } from '../../../extension/constants'
import {
  BOOKMARK_TEXT_MAX_LENGTH,
  BookmarksService,
  createBookmarksStore,
  EMPTY_LINE_TEXT,
  GlobalJsonBookmarksStore,
  JsonBookmarksStore,
  MAX_BOOKMARKS,
  normalizeBookmarkList,
  type BookmarkItem,
} from '../../../extension/features/bookmarks/bookmarksService'
import { __resetStubs, __setDocument, __stubs, createMementoStub } from '../stubs/vscode'

/**
 * 代码书签服务（v3.6，14 方案）：存储契约（信封 / 顶层兼容 / 损坏备份，与收藏夹同口径）、
 * 归一化守卫（缺 path / line 非法逐条丢弃、上限 500 裁剪）、toggle 语义（同行去重即移除）、
 * 文本快照（trim / 截断 / 空行占位）、循环导航（path+line 升序、严格先后、尾首回绕、
 * 无编辑器兜底）。
 */

let tmpRoot = ''

async function makeTmpWorkspace(): Promise<string> {
  const root = await nodeFs.promises.mkdtemp(nodePath.join(nodeOs.tmpdir(), 'bookmarks-'))
  await nodeFs.promises.mkdir(nodePath.join(root, '.vscode'))
  return root
}

function setWorkspace(root: string): void {
  __stubs.workspaceFolders = [
    { uri: vscode.Uri.file(root), name: nodePath.basename(root), index: 0 },
  ]
}

function bookmarksFileUri(root: string): vscode.Uri {
  return vscode.Uri.joinPath(vscode.Uri.file(root), ...STORAGE.bookmarksFileName.split('/'))
}

async function writeFile(root: string, rel: string, content = ''): Promise<vscode.Uri> {
  const abs = nodePath.join(root, rel)
  await nodeFs.promises.mkdir(nodePath.dirname(abs), { recursive: true })
  await nodeFs.promises.writeFile(abs, content)
  return vscode.Uri.file(abs)
}

function makeService(root = tmpRoot, onWarning?: (message: string) => void): BookmarksService {
  return new BookmarksService(new JsonBookmarksStore(bookmarksFileUri(root), { onWarning }))
}

/** 构造书签条目（解析/跳转用例的手工形态）。 */
function makeItem(path: string, line: number): BookmarkItem {
  return { id: 'test', path, line, text: '', addedAt: '2026-11-10T00:00:00Z' }
}

/** 无工作区场景的 ExtensionContext 替身（globalStorageUri 落在 tmpRoot 下）。 */
function makeContext(
  initial: Record<string, unknown> = {},
  globalRoot = nodePath.join(tmpRoot, 'global-storage')
): { memento: ReturnType<typeof createMementoStub>; context: vscode.ExtensionContext } {
  const memento = createMementoStub(initial)
  const context = {
    globalState: memento,
    globalStorageUri: vscode.Uri.file(globalRoot),
  } as unknown as vscode.ExtensionContext
  return { memento, context }
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

describe('JsonBookmarksStore（存储契约）', () => {
  it('① 文件不存在视为空数据（首次使用）', async () => {
    const store = new JsonBookmarksStore(bookmarksFileUri(tmpRoot))
    await expect(store.load()).resolves.toEqual([])
  })

  it('② save → load 往返保持信封格式', async () => {
    const store = new JsonBookmarksStore(bookmarksFileUri(tmpRoot))
    const items = [
      { id: 'a', path: 'src/app.ts', line: 3, text: '入口', addedAt: '2026-11-10T00:00:00Z' },
    ]
    await store.save(items)
    await expect(store.load()).resolves.toEqual(items)
    const envelope = JSON.parse(
      await nodeFs.promises.readFile(bookmarksFileUri(tmpRoot).fsPath, 'utf8')
    ) as { schemaVersion: number; items: unknown[] }
    expect(envelope.schemaVersion).toBe(1)
    expect(Array.isArray(envelope.items)).toBe(true)
  })

  it('③ 顶层数组宽容读取（手写形态）', async () => {
    await nodeFs.promises.writeFile(
      bookmarksFileUri(tmpRoot).fsPath,
      JSON.stringify([{ path: 'src/app.ts', line: 0, text: 'x', addedAt: '2026-11-10T00:00:00Z' }])
    )
    const store = new JsonBookmarksStore(bookmarksFileUri(tmpRoot))
    await expect(store.load()).resolves.toHaveLength(1)
  })

  it('④ 损坏文件：复制 .bak 备份后按空数据继续，原文件保留', async () => {
    await nodeFs.promises.writeFile(bookmarksFileUri(tmpRoot).fsPath, '{broken json')
    const warnings: string[] = []
    const store = new JsonBookmarksStore(bookmarksFileUri(tmpRoot), {
      onWarning: (message) => warnings.push(message),
    })
    await expect(store.load()).resolves.toEqual([])
    const dirEntries = nodeFs.readdirSync(nodePath.join(tmpRoot, '.vscode'))
    expect(dirEntries.some((name) => name.includes('.bak'))).toBe(true)
    expect(warnings.some((message) => message.includes('损坏'))).toBe(true)
  })
})

describe('normalizeBookmarkList（归一化守卫）', () => {
  it('⑤ 缺 path / line 非整数 / line<0 逐条丢弃并警告，合法条目补齐缺失字段', () => {
    const warnings: string[] = []
    const items = normalizeBookmarkList(
      [
        { path: 'a.ts', line: 2 },
        { path: '', line: 1 },
        { line: 1 },
        { path: 'b.ts', line: 1.5 },
        { path: 'c.ts', line: -1 },
        { path: 'd.ts', line: '3' },
        'not-an-object',
        null,
      ],
      (message) => warnings.push(message)
    )
    expect(items).toHaveLength(1)
    expect(items[0]?.path).toBe('a.ts')
    expect(items[0]?.line).toBe(2)
    expect(items[0]?.id).toBeTruthy()
    expect(items[0]?.text).toBe('')
    expect(items[0]?.addedAt).toBeTruthy()
    expect(warnings.some((message) => message.includes('丢弃'))).toBe(true)
  })

  it('⑥ 超上限裁剪保留前 MAX 条（新插头部语义，丢最旧）', () => {
    const raw = Array.from({ length: MAX_BOOKMARKS + 5 }, (_, index) => ({
      path: `f${index}.ts`,
      line: index,
    }))
    const items = normalizeBookmarkList(raw)
    expect(items).toHaveLength(MAX_BOOKMARKS)
    expect(items[0]?.path).toBe('f0.ts')
  })
})

describe('文本快照与路径形态', () => {
  it('⑦ snapshotText：空白行存占位符、trim、超长截断', () => {
    const service = makeService()
    expect(service.snapshotText('   ')).toBe(EMPTY_LINE_TEXT)
    expect(service.snapshotText('  const a = 1;  ')).toBe('const a = 1;')
    expect(service.snapshotText('x'.repeat(BOOKMARK_TEXT_MAX_LENGTH + 10))).toHaveLength(
      BOOKMARK_TEXT_MAX_LENGTH
    )
  })

  it('⑧ storagePathFor：工作区内 POSIX 相对路径；工作区外绝对 fsPath', () => {
    const service = makeService()
    expect(service.storagePathFor(vscode.Uri.file(nodePath.join(tmpRoot, 'src', 'a.ts')))).toBe(
      'src/a.ts'
    )
    const outside = nodePath.join(nodeOs.tmpdir(), 'outside-书签.ts')
    // 工作区外存原始 fsPath（与收藏夹 buildItem 同口径，不做分隔符归一）
    expect(service.storagePathFor(vscode.Uri.file(outside))).toBe(vscode.Uri.file(outside).fsPath)
  })
})

describe('BookmarksService（业务服务）', () => {
  it('⑨ toggle 新增：插头部、持久化、返回 added', async () => {
    const uri = await writeFile(tmpRoot, 'src/index.ts', 'const a = 1\n')
    const service = makeService()
    const result = await service.toggle(uri, 0, 'const a = 1')
    const added = result.added
    if (!added) {
      throw new Error('应返回 added')
    }
    expect(added.path).toBe('src/index.ts')
    expect(added.line).toBe(0)
    expect(added.text).toBe('const a = 1')
    expect(service.list()).toHaveLength(1)
    const reloaded = makeService()
    await reloaded.load()
    expect(reloaded.list()).toHaveLength(1)
    expect(reloaded.list()[0]?.line).toBe(0)
  })

  it('⑩ 同文件同行再 toggle → 移除（去重即 toggle 语义）', async () => {
    const uri = await writeFile(tmpRoot, 'src/index.ts')
    const service = makeService()
    const first = await service.toggle(uri, 3, 'let b = 2')
    expect(first.added).toBeTruthy()
    const second = await service.toggle(uri, 3, 'let b = 2')
    expect(second.removed?.line).toBe(3)
    expect(second.added).toBeUndefined()
    expect(service.list()).toHaveLength(0)
  })

  it('⑪ 上限 500：新书签插头部，超出丢最旧（尾部）', async () => {
    // 内存 store：上限裁剪是纯服务逻辑，500 次落盘徒增 Windows 清理竞态（ENOTEMPTY）
    let saved: BookmarkItem[] = []
    const service = new BookmarksService({
      async load() {
        return saved
      },
      async save(next) {
        saved = next
      },
      dataFileUri: () => vscode.Uri.file('/memory/bookmarks.json'),
    })
    const firstUri = vscode.Uri.file(nodePath.join(tmpRoot, 'first.ts'))
    await service.toggle(firstUri, 0, 'first')
    for (let index = 0; index < MAX_BOOKMARKS; index += 1) {
      const uri = vscode.Uri.file(nodePath.join(tmpRoot, `f${index}.ts`))
      await service.toggle(uri, index, `f${index}`)
    }
    expect(service.list()).toHaveLength(MAX_BOOKMARKS)
    // first.ts 是最早添加的（已在尾部被裁掉），f499 最新在头部
    expect(service.list()[0]?.path).toBe('f499.ts')
    expect(service.list().some((item) => item.path === 'first.ts')).toBe(false)
  })

  it('⑫ ordered：按 toPosix(path) 升序 + line 升序（与插入顺序无关）', async () => {
    const service = makeService()
    await service.toggle(vscode.Uri.file(nodePath.join(tmpRoot, 'b.ts')), 20, 'b20')
    await service.toggle(vscode.Uri.file(nodePath.join(tmpRoot, 'a.ts')), 10, 'a10')
    await service.toggle(vscode.Uri.file(nodePath.join(tmpRoot, 'b.ts')), 5, 'b5')
    await service.toggle(vscode.Uri.file(nodePath.join(tmpRoot, 'a.ts')), 30, 'a30')
    expect(service.ordered().map((item) => `${item.path}:${item.line}`)).toEqual([
      'a.ts:10',
      'a.ts:30',
      'b.ts:5',
      'b.ts:20',
    ])
  })

  it('⑬ next：同文件下一个、跨文件、当前位置被跳过', async () => {
    const service = makeService()
    const aUri = vscode.Uri.file(nodePath.join(tmpRoot, 'a.ts'))
    const bUri = vscode.Uri.file(nodePath.join(tmpRoot, 'b.ts'))
    await service.toggle(aUri, 10, 'a10')
    await service.toggle(aUri, 20, 'a20')
    await service.toggle(bUri, 2, 'b2')
    expect(service.next(vscode.Uri.file(nodePath.join(tmpRoot, 'a.ts')), 10, 'next')?.text).toBe(
      'a20'
    )
    expect(service.next(vscode.Uri.file(nodePath.join(tmpRoot, 'a.ts')), 20, 'next')?.text).toBe(
      'b2'
    )
    // 当前位置本身是书签 → 跳过它
    expect(service.next(vscode.Uri.file(nodePath.join(tmpRoot, 'b.ts')), 2, 'next')?.text).toBe(
      'a10'
    )
  })

  it('⑭ next/prev 回绕：尾后回首条、首前回末条', async () => {
    const service = makeService()
    await service.toggle(vscode.Uri.file(nodePath.join(tmpRoot, 'a.ts')), 10, 'a10')
    await service.toggle(vscode.Uri.file(nodePath.join(tmpRoot, 'b.ts')), 2, 'b2')
    // 排序：a.ts:10 → b.ts:2；从 b.ts:2 之后无书签 → 回绕到 a.ts:10
    expect(service.next(vscode.Uri.file(nodePath.join(tmpRoot, 'b.ts')), 2, 'next')?.text).toBe(
      'a10'
    )
    // 从 a.ts:10 之前无书签 → 回绕到末条 b.ts:2
    expect(service.next(vscode.Uri.file(nodePath.join(tmpRoot, 'a.ts')), 10, 'prev')?.text).toBe(
      'b2'
    )
  })

  it('⑮ 无活动编辑器兜底：next 首条 / prev 末条；全局无书签 → undefined', async () => {
    const service = makeService()
    expect(service.next(undefined, undefined, 'next')).toBeUndefined()
    expect(service.next(undefined, undefined, 'prev')).toBeUndefined()
    await service.toggle(vscode.Uri.file(nodePath.join(tmpRoot, 'a.ts')), 10, 'a10')
    await service.toggle(vscode.Uri.file(nodePath.join(tmpRoot, 'b.ts')), 2, 'b2')
    expect(service.next(undefined, undefined, 'next')?.text).toBe('a10')
    expect(service.next(undefined, undefined, 'prev')?.text).toBe('b2')
  })

  it('⑯ 当前文件无书签：排序键始终可比，由回绕自然覆盖', async () => {
    const service = makeService()
    await service.toggle(vscode.Uri.file(nodePath.join(tmpRoot, 'a.ts')), 10, 'a10')
    await service.toggle(vscode.Uri.file(nodePath.join(tmpRoot, 'c.ts')), 3, 'c3')
    // c.ts 位于 a、c 之间？b.ts 排序在 a.ts 之后 c.ts 之前
    const next = service.next(vscode.Uri.file(nodePath.join(tmpRoot, 'b.ts')), 7, 'next')
    expect(next?.text).toBe('c3')
    const prev = service.next(vscode.Uri.file(nodePath.join(tmpRoot, 'b.ts')), 7, 'prev')
    expect(prev?.text).toBe('a10')
  })

  it('⑰ remove / clear：返回值真实反映，onDidChange 触发刷新', async () => {
    const uri = await writeFile(tmpRoot, 'a.ts')
    const service = makeService()
    let fired = 0
    service.onDidChange(() => {
      fired += 1
    })
    const added = (await service.toggle(uri, 0, 'a')).added
    await service.toggle(vscode.Uri.file(nodePath.join(tmpRoot, 'b.ts')), 1, 'b')
    expect(fired).toBe(2)
    if (!added) {
      throw new Error('应有书签')
    }
    await expect(service.remove(added.id)).resolves.toBe(true)
    await expect(service.remove(added.id)).resolves.toBe(false)
    expect(await service.clear()).toBe(1)
    expect(await service.clear()).toBe(0)
    expect(service.list()).toHaveLength(0)
  })
})

describe('store 装配路由（14 方案 §3）', () => {
  it('⑱ 有工作区 → 工作区 JSON；无工作区 → globalStorage JSON；往返可用', async () => {
    setWorkspace(tmpRoot)
    const { context } = makeContext()
    expect(createBookmarksStore(context)).toBeInstanceOf(JsonBookmarksStore)
    __stubs.workspaceFolders = undefined
    const global = createBookmarksStore(context)
    expect(global).toBeInstanceOf(GlobalJsonBookmarksStore)
    expect(global.dataFileUri().fsPath).toBe(
      vscode.Uri.joinPath(context.globalStorageUri, STORAGE.bookmarksGlobalFileName).fsPath
    )
    const items = [
      { id: 'g1', path: 'C:/out.ts', line: 4, text: '全局', addedAt: '2026-11-10T00:00:00Z' },
    ]
    await global.save(items)
    await expect(global.load()).resolves.toEqual(items)
  })
})

describe('resolveBookmarkUri / jump / ensureDataFile（14 方案 §4）', () => {
  function revealStartLine(): number {
    const reveal = __stubs.recorded.find((entry) => entry.kind === 'revealRange')
    const payload = reveal?.args?.[0] as { range: { start: { line: number } } } | undefined
    if (!payload?.range) {
      throw new Error('应有 revealRange 录制')
    }
    return payload.range.start.line
  }

  it('⑲ 相对路径：命中所属工作区文件夹', async () => {
    await writeFile(tmpRoot, 'docs/g.md')
    const service = makeService()
    const resolved = await service.resolveBookmarkUri(makeItem('docs/g.md', 3))
    expect(resolved.fsPath).toBe(nodePath.join(tmpRoot, 'docs', 'g.md'))
  })

  it('⑳ 多根：命中第二工作区文件夹；全未命中回退第一个文件夹', async () => {
    const secondRoot = nodePath.join(tmpRoot, 'second-root')
    await nodeFs.promises.mkdir(nodePath.join(secondRoot, 'x'), { recursive: true })
    await nodeFs.promises.writeFile(nodePath.join(secondRoot, 'x', 'bm.md'), '')
    __stubs.workspaceFolders = [
      { uri: vscode.Uri.file(tmpRoot), name: 'first', index: 0 },
      { uri: vscode.Uri.file(secondRoot), name: 'second', index: 1 },
    ]
    const service = makeService()
    const hit = await service.resolveBookmarkUri(makeItem('x/bm.md', 0))
    expect(hit.fsPath).toBe(nodePath.join(secondRoot, 'x', 'bm.md'))
    const miss = await service.resolveBookmarkUri(makeItem('y/nope.md', 0))
    expect(miss.fsPath).toBe(nodePath.join(tmpRoot, 'y', 'nope.md'))
  })

  it('㉑ 绝对路径直接 Uri.file（无工作区也不受影响）', async () => {
    const outsidePath = nodePath.join(nodeOs.tmpdir(), `bm-outside-${Date.now()}.ts`)
    await nodeFs.promises.writeFile(outsidePath, '')
    __stubs.workspaceFolders = undefined
    const service = makeService()
    const resolved = await service.resolveBookmarkUri(makeItem(outsidePath, 0))
    expect(resolved.fsPath).toBe(vscode.Uri.file(outsidePath).fsPath)
    await nodeFs.promises.rm(outsidePath, { force: true })
  })

  it('㉒ jump：showTextDocument + reveal 定位到行（0-based → 定位第 2 行）', async () => {
    const fileUri = await writeFile(tmpRoot, 'doc.md', 'l0\nl1\nl2')
    __setDocument(fileUri, 'l0\nl1\nl2')
    const service = makeService()
    const uri = await service.jump(makeItem('doc.md', 1))
    expect(uri.fsPath).toBe(fileUri.fsPath)
    expect(__stubs.recorded.some((entry) => entry.kind === 'showTextDocument')).toBe(true)
    expect(revealStartLine()).toBe(1)
  })

  it('㉓ 行号越界：钳制到文件末尾并如实提示', async () => {
    const fileUri = await writeFile(tmpRoot, 'doc.md', 'l0\nl1\nl2')
    __setDocument(fileUri, 'l0\nl1\nl2')
    const service = makeService()
    await service.jump(makeItem('doc.md', 99))
    expect(revealStartLine()).toBe(2)
    expect(
      __stubs.recorded.some(
        (entry) =>
          entry.kind === 'showInformationMessage' && JSON.stringify(entry.args).includes('越界')
      )
    ).toBe(true)
  })

  it('㉔ 空文档：定位到第 0 行并提示越界', async () => {
    const fileUri = await writeFile(tmpRoot, 'empty.md', '')
    __setDocument(fileUri, '')
    const service = makeService()
    await service.jump(makeItem('empty.md', 5))
    expect(revealStartLine()).toBe(0)
    expect(
      __stubs.recorded.some(
        (entry) =>
          entry.kind === 'showInformationMessage' && JSON.stringify(entry.args).includes('越界')
      )
    ).toBe(true)
  })

  it('㉕ 文件不存在：openTextDocument 抛错向上传播（命令壳负责呈现）', async () => {
    const service = makeService()
    await expect(service.jump(makeItem('ghost.md', 0))).rejects.toThrow()
  })

  it('㉖ ensureDataFile：文件缺失写空信封；已存在不改写', async () => {
    const service = makeService()
    expect(service.dataFileUri().fsPath).toBe(bookmarksFileUri(tmpRoot).fsPath)
    await service.ensureDataFile()
    const envelope = JSON.parse(
      await nodeFs.promises.readFile(bookmarksFileUri(tmpRoot).fsPath, 'utf8')
    ) as { schemaVersion: number; items: unknown[] }
    expect(envelope).toEqual({ schemaVersion: 1, items: [] })
    await nodeFs.promises.writeFile(bookmarksFileUri(tmpRoot).fsPath, 'KEEP')
    await service.ensureDataFile()
    await expect(nodeFs.promises.readFile(bookmarksFileUri(tmpRoot).fsPath, 'utf8')).resolves.toBe(
      'KEEP'
    )
  })
})
