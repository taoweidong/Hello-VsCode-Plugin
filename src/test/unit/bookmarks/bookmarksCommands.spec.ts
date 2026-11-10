import * as nodeFs from 'node:fs'
import * as nodeOs from 'node:os'
import * as nodePath from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import * as vscode from 'vscode'
import { COMMAND, STORAGE } from '../../../extension/constants'
import type { BookmarkItem } from '../../../extension/features/bookmarks/bookmarksService'
import {
  BookmarksService,
  JsonBookmarksStore,
} from '../../../extension/features/bookmarks/bookmarksService'
import { registerBookmarksCommands } from '../../../extension/commands/bookmarksCommands'
import type { ActiveTextEditorStub } from '../stubs/vscode'
import { __resetStubs, __setDocument, __stubs } from '../stubs/vscode'

/**
 * 书签命令壳（v3.6，14 方案 §5）：8 条命令注册齐全、无参/空态给提示不抛错、
 * toggle 的 scheme 守卫与行文本快照、循环跳转与 QuickPick 路由、清空模态确认、
 * 打开数据文件（executeCommand 与 dialogQueue 录制断言）。
 */

function makeService(): BookmarksService {
  // 内存存储足够命令壳测试；stat 走 stub 的真实 Node fs
  let items: BookmarkItem[] = []
  return new BookmarksService({
    async load() {
      return items
    },
    async save(next) {
      items = next
    },
    dataFileUri: () => vscode.Uri.file('/memory/bookmarks.json'),
  })
}

async function makeRealFile(name: string): Promise<vscode.Uri> {
  const abs = nodePath.join(tmpRoot, name)
  await nodeFs.promises.mkdir(nodePath.dirname(abs), { recursive: true })
  await nodeFs.promises.writeFile(abs, '')
  return vscode.Uri.file(abs)
}

/** toggle 包装返回的 added 条目（测试内多次用到；缺 added 即断言失败）。 */
async function toggleAdded(
  bookmarks: BookmarksService,
  uri: vscode.Uri,
  line: number,
  text: string
): Promise<BookmarkItem> {
  const result = await bookmarks.toggle(uri, line, text)
  const added = result.added
  if (!added) {
    throw new Error('应有 added')
  }
  return added
}

function injectEditor(uri: vscode.Uri, line: number, lines: string[] = ['']): void {
  __stubs.activeTextEditor = {
    document: {
      uri,
      fileName: uri.fsPath,
      getText: () => lines.join('\n'),
      lineAt: (index: number) => ({ text: lines[index] ?? '' }),
    },
    selection: { active: { line } },
  } as unknown as ActiveTextEditorStub
}

function registeredOf(favorites: BookmarksService): Map<string, (...args: unknown[]) => unknown> {
  const registered = new Map<string, (...args: unknown[]) => unknown>()
  registerBookmarksCommands((id, cb) => registered.set(id, cb), { bookmarks: favorites })
  return registered
}

let tmpRoot = ''

beforeEach(async () => {
  __resetStubs()
  tmpRoot = await nodeFs.promises.mkdtemp(nodePath.join(nodeOs.tmpdir(), 'bkcmd-'))
  __stubs.workspaceFolders = [
    { uri: vscode.Uri.file(tmpRoot), name: nodePath.basename(tmpRoot), index: 0 },
  ]
  void vscode.commands.registerCommand('vscode.open', (uri: unknown) => uri)
})

describe('registerBookmarksCommands（书签命令）', () => {
  it('① 8 个命令全部注册', () => {
    expect([...registeredOf(makeService()).keys()].sort()).toEqual(
      [
        COMMAND.toggleBookmark,
        COMMAND.jumpToNextBookmark,
        COMMAND.jumpToPreviousBookmark,
        COMMAND.quickOpenBookmarks,
        COMMAND.jumpToBookmark,
        COMMAND.removeBookmark,
        COMMAND.clearBookmarks,
        COMMAND.openBookmarksDataFile,
      ].sort()
    )
  })

  it('② toggle：当前行打书签（行文本快照）；同行再 toggle → 移除', async () => {
    const bookmarks = makeService()
    const registered = registeredOf(bookmarks)
    const fileUri = await makeRealFile('src/app.ts')
    injectEditor(fileUri, 3, ['a', 'b', 'c', '  let value = 1;  '])
    await registered.get(COMMAND.toggleBookmark)?.()
    expect(bookmarks.list()).toHaveLength(1)
    expect(bookmarks.list()[0]?.line).toBe(3)
    expect(bookmarks.list()[0]?.text).toBe('let value = 1;')
    expect(
      __stubs.recorded.some(
        (entry) =>
          entry.kind === 'showInformationMessage' &&
          JSON.stringify(entry.args).includes('已添加书签')
      )
    ).toBe(true)
    await registered.get(COMMAND.toggleBookmark)?.()
    expect(bookmarks.list()).toHaveLength(0)
    expect(
      __stubs.recorded.some(
        (entry) =>
          entry.kind === 'showInformationMessage' &&
          JSON.stringify(entry.args).includes('已移除书签')
      )
    ).toBe(true)
  })

  it('③ toggle 守卫：无编辑器 / 非 file: 协议给提示不产生数据', async () => {
    const bookmarks = makeService()
    const registered = registeredOf(bookmarks)
    __stubs.activeTextEditor = undefined
    await registered.get(COMMAND.toggleBookmark)?.()
    expect(
      __stubs.recorded.some(
        (entry) =>
          entry.kind === 'showInformationMessage' &&
          JSON.stringify(entry.args).includes('没有活动的编辑器')
      )
    ).toBe(true)
    // stub 的 Uri.parse 一律归一为 file 协议——直接注入带 untitled scheme 的 uri 形状
    // 对象（守卫只读 .scheme，不会触达 fsPath 之外的字段）
    injectEditor({ scheme: 'untitled', fsPath: 'Untitled-1' } as unknown as vscode.Uri, 0, ['x'])
    await registered.get(COMMAND.toggleBookmark)?.()
    expect(
      __stubs.recorded.some(
        (entry) =>
          entry.kind === 'showInformationMessage' &&
          JSON.stringify(entry.args).includes('仅支持本地文件')
      )
    ).toBe(true)
    expect(bookmarks.list()).toHaveLength(0)
  })

  it('④ 循环跳转：空态提示；有书签时 next 委托服务并定位', async () => {
    const bookmarks = makeService()
    const registered = registeredOf(bookmarks)
    await registered.get(COMMAND.jumpToNextBookmark)?.()
    expect(
      __stubs.recorded.some(
        (entry) =>
          entry.kind === 'showInformationMessage' &&
          JSON.stringify(entry.args).includes('暂无书签')
      )
    ).toBe(true)

    const fileUri = await makeRealFile('a.ts')
    await bookmarks.toggle(fileUri, 0, 'a0')
    __setDocument(fileUri, 'a0\na1')
    __stubs.activeTextEditor = undefined
    await registered.get(COMMAND.jumpToNextBookmark)?.()
    expect(__stubs.recorded.some((entry) => entry.kind === 'showTextDocument')).toBe(true)
  })

  it('⑤ quickOpenBookmarks：空态提示；条目带 文件:行 label，选中后跳转', async () => {
    const bookmarks = makeService()
    const registered = registeredOf(bookmarks)
    await registered.get(COMMAND.quickOpenBookmarks)?.()
    expect(
      __stubs.recorded.some(
        (entry) =>
          entry.kind === 'showInformationMessage' &&
          JSON.stringify(entry.args).includes('暂无书签')
      )
    ).toBe(true)

    const fileUri = await makeRealFile('deep/nested/file.ts')
    const item = await toggleAdded(bookmarks, fileUri, 7, 'const target')
    await bookmarks.toggle(await makeRealFile('zz.ts'), 1, 'z')
    await registered.get(COMMAND.quickOpenBookmarks)?.()
    const pickIndex = __stubs.recorded.findIndex((entry) => entry.kind === 'showQuickPick')
    if (pickIndex < 0) {
      throw new Error('应有 showQuickPick')
    }
    const payload = __stubs.recorded[pickIndex]?.args?.[0] as {
      items: { label: string }[]
    }
    expect(payload.items.some((option) => option.label === 'file.ts:8')).toBe(true)
    __stubs.dialogQueue.push({ label: 'file.ts:8', item })
    const fileDocUri = vscode.Uri.file(nodePath.join(tmpRoot, 'deep', 'nested', 'file.ts'))
    __setDocument(fileDocUri, 'x\n'.repeat(10))
    await registered.get(COMMAND.quickOpenBookmarks)?.()
    expect(__stubs.recorded.some((entry) => entry.kind === 'showTextDocument')).toBe(true)
  })

  it('⑥ jumpToBookmark：带参定位；无参给提示不抛错', async () => {
    const bookmarks = makeService()
    const registered = registeredOf(bookmarks)
    const fileUri = await makeRealFile('j.ts')
    const item = await toggleAdded(bookmarks, fileUri, 2, 'j2')
    __setDocument(fileUri, 'a\nb\nc')
    await registered.get(COMMAND.jumpToBookmark)?.(item)
    expect(__stubs.recorded.some((entry) => entry.kind === 'showTextDocument')).toBe(true)
    const before = __stubs.recorded.length
    await registered.get(COMMAND.jumpToBookmark)?.()
    expect(__stubs.recorded.length).toBe(before + 1)
    expect(
      __stubs.recorded
        .slice(before)
        .some(
          (entry) =>
            entry.kind === 'showInformationMessage' && JSON.stringify(entry.args).includes('书签')
        )
    ).toBe(true)
  })

  it('⑦ removeBookmark：带参移除并提示；无参给提示', async () => {
    const bookmarks = makeService()
    const registered = registeredOf(bookmarks)
    const fileUri = await makeRealFile('r.ts')
    const item = await toggleAdded(bookmarks, fileUri, 0, 'r0')
    await registered.get(COMMAND.removeBookmark)?.(item)
    expect(bookmarks.list()).toHaveLength(0)
    expect(
      __stubs.recorded.some(
        (entry) =>
          entry.kind === 'showInformationMessage' &&
          JSON.stringify(entry.args).includes('已移除书签')
      )
    ).toBe(true)
    const before = __stubs.recorded.length
    await registered.get(COMMAND.removeBookmark)?.()
    expect(__stubs.recorded.length).toBe(before + 1)
    expect(
      __stubs.recorded
        .slice(before)
        .some(
          (entry) =>
            entry.kind === 'showInformationMessage' && JSON.stringify(entry.args).includes('书签')
        )
    ).toBe(true)
  })

  it('⑧ clearBookmarks：模态确认后清空；取消不清', async () => {
    const bookmarks = makeService()
    const registered = registeredOf(bookmarks)
    const fileUri = await makeRealFile('c.ts')
    await bookmarks.toggle(fileUri, 0, 'c0')
    __stubs.dialogQueue.push(undefined) // 模态取消
    await registered.get(COMMAND.clearBookmarks)?.()
    expect(bookmarks.list()).toHaveLength(1)
    __stubs.dialogQueue.push('清空')
    await registered.get(COMMAND.clearBookmarks)?.()
    expect(bookmarks.list()).toHaveLength(0)
    expect(
      __stubs.recorded.some(
        (entry) =>
          entry.kind === 'showInformationMessage' && JSON.stringify(entry.args).includes('已清空')
      )
    ).toBe(true)
  })

  it('⑨ openBookmarksDataFile：缺失先写空信封，再 vscode.open 数据文件路径', async () => {
    const dir = await nodeFs.promises.mkdtemp(nodePath.join(nodeOs.tmpdir(), 'bkdata-'))
    const fileUri = vscode.Uri.joinPath(
      vscode.Uri.file(dir),
      ...STORAGE.bookmarksFileName.split('/')
    )
    const bookmarks = new BookmarksService(new JsonBookmarksStore(fileUri))
    const registered = registeredOf(bookmarks)
    await registered.get(COMMAND.openBookmarksDataFile)?.()
    const envelope = JSON.parse(await nodeFs.promises.readFile(fileUri.fsPath, 'utf8')) as {
      schemaVersion: number
      items: unknown[]
    }
    expect(envelope).toEqual({ schemaVersion: 1, items: [] })
    expect(
      __stubs.recorded.some(
        (entry) =>
          entry.kind === 'executeCommand' && JSON.stringify(entry.args).includes('vscode.open')
      )
    ).toBe(true)
  })
})
