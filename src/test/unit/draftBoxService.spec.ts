import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as nodeFs from 'node:fs'
import * as nodeOs from 'node:os'
import * as nodePath from 'node:path'
import * as vscode from 'vscode'
import { STORAGE } from '../../extension/constants'
import { DraftBoxService } from '../../extension/features/drafts/draftBoxService'
import { __resetStubs } from './stubs/vscode'

/**
 * 草稿箱服务（09 方案 §3.5：右键示例新载体；v2.2.3 代码评审修复）：
 * - 落盘 .vscode/ext-starter.drafts.json（B3：路径与忽略清单同源）；
 * - **全文落盘**：selection 保存完整 content（标题仅摘要，超 64K 截断并标记）；
 * - 串行化「重读 → 变更 → 原子写」：并发不丢条目、外部手改不被覆盖；
 * - 损坏文件备份 .bak 后按空数据继续；上限 100 条。
 */

let rootDir: string
let service: DraftBoxService

beforeEach(() => {
  __resetStubs()
  rootDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'crud-drafts-'))
  service = new DraftBoxService(() => vscode.Uri.file(rootDir))
})

afterEach(() => {
  nodeFs.rmSync(rootDir, { recursive: true, force: true })
})

const draftsFile = (): string => nodePath.join(rootDir, STORAGE.draftsFileName)

const readPersisted = (): {
  schemaVersion: number
  entries: {
    id: string
    kind: string
    title: string
    detail: string
    content?: string
    createdAt: number
  }[]
} => JSON.parse(nodeFs.readFileSync(draftsFile(), 'utf8')) as never

describe('DraftBoxService：登记与持久化', () => {
  it('addSelection：title 取摘要、content 保存全文，落盘可被 load 复原', async () => {
    const text = `${'长内容'.repeat(20)}\n第二行`
    const count = await service.addSelection(text, 'auth.ts')
    expect(count).toBe(1)
    const persisted = readPersisted()
    expect(persisted.schemaVersion).toBe(1)
    expect(persisted.entries[0]).toMatchObject({
      kind: 'selection',
      detail: '来源：auth.ts',
    })
    // 标题是摘要（截断 + 省略号），content 是完整文本
    expect(persisted.entries[0].title.endsWith('…')).toBe(true)
    expect(persisted.entries[0].content).toBe(text)
    const reloaded = new DraftBoxService(() => vscode.Uri.file(rootDir))
    expect(await reloaded.load()).toBe(1)
    expect(reloaded.list()[0]?.content).toBe(text)
  })

  it('超长内容截断为 64K 并显式标记（不静默丢内容）', async () => {
    await service.addSelection('x'.repeat(70 * 1024), 'big.txt')
    const persisted = readPersisted()
    const content = persisted.entries[0].content ?? ''
    expect(content.length).toBeLessThan(70 * 1024)
    expect(content.endsWith('已截断）')).toBe(true)
  })

  it('appendToLatest：完整文本追加到 content，摘要追加到 detail；空箱降级新增', async () => {
    await service.addSelection('第一条正文', 'a.ts')
    const appended = await service.appendToLatest('补充内容全文', 'b.ts')
    expect(appended).toBe(true)
    const entry = service.list()[0]
    expect(entry?.content).toContain('第一条正文')
    expect(entry?.content).toContain('补充内容全文')
    expect(entry?.detail).toContain('补充内容全文')

    // 空草稿箱（全新目录）降级新增
    const freshRoot = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'crud-drafts-empty-'))
    try {
      const empty = new DraftBoxService(() => vscode.Uri.file(freshRoot))
      expect(await empty.appendToLatest('孤本全文', 'c.ts')).toBe(false)
      expect(empty.list()).toHaveLength(1)
      expect(empty.list()[0]?.content).toBe('孤本全文')
    } finally {
      nodeFs.rmSync(freshRoot, { recursive: true, force: true })
    }
  })

  it('addFile：登记文件名与绝对路径（不复制内容）；目录抛错', async () => {
    const file = nodePath.join(rootDir, 'demo.md')
    nodeFs.writeFileSync(file, '# demo', 'utf8')
    await service.addFile(vscode.Uri.file(file))
    expect(service.list()[0]).toMatchObject({ kind: 'file', title: 'demo.md', detail: file })
    expect(service.list()[0]?.content).toBeUndefined()
    await expect(service.addFile(vscode.Uri.file(rootDir))).rejects.toThrow('请选择文件而非文件夹')
  })

  it('addFolder：登记目录清单汇总（排序、限流）；空目录抛错；文件抛错', async () => {
    nodeFs.mkdirSync(nodePath.join(rootDir, 'docs'))
    nodeFs.writeFileSync(nodePath.join(rootDir, 'docs', 'b.md'), 'b', 'utf8')
    nodeFs.writeFileSync(nodePath.join(rootDir, 'docs', 'a.md'), 'a', 'utf8')
    await service.addFolder(vscode.Uri.file(nodePath.join(rootDir, 'docs')))
    expect(service.list()[0]).toMatchObject({
      kind: 'folder',
      title: 'docs',
      detail: 'a.md、b.md',
    })

    nodeFs.mkdirSync(nodePath.join(rootDir, 'empty'))
    await expect(
      service.addFolder(vscode.Uri.file(nodePath.join(rootDir, 'empty')))
    ).rejects.toThrow('没有文件')
    await expect(
      service.addFolder(vscode.Uri.file(nodePath.join(rootDir, 'docs', 'a.md')))
    ).rejects.toThrow('请选择文件夹')
  })

  it('上限 100 条：超出后丢最旧', async () => {
    for (let i = 0; i < 105; i++) {
      await service.addSelection(`草稿 ${i}`, 'a.ts')
    }
    expect(service.list()).toHaveLength(100)
    expect(service.list()[0]?.title).toBe('草稿 104')
    expect(service.list()[99]?.title).toBe('草稿 5')
  })
})

describe('DraftBoxService：并发与外部修改（v2.2.3 数据完整性）', () => {
  it('并发登记不丢条目：两次 addSelection 并行 → 两条都在盘上', async () => {
    await Promise.all([
      service.addSelection('并发甲', 'a.ts'),
      service.addSelection('并发乙', 'b.ts'),
    ])
    const titles = readPersisted().entries.map((entry) => entry.title)
    expect(titles).toContain('并发甲')
    expect(titles).toContain('并发乙')
    expect(titles).toHaveLength(2)
  })

  it('外部手改保留：写前重读磁盘，手改条目不被覆盖', async () => {
    await service.addSelection('原始条目', 'a.ts')
    // 模拟用户 / 另一窗口手改：直接改盘上文件（追加一条）
    const manual = readPersisted()
    manual.entries.push({
      id: 'manual-1',
      kind: 'selection',
      title: '手工条目',
      detail: '手改',
      content: '手改内容',
      createdAt: 1,
    })
    nodeFs.writeFileSync(draftsFile(), JSON.stringify(manual, null, 2), 'utf8')

    await service.addSelection('新条目', 'b.ts')
    const titles = readPersisted().entries.map((entry) => entry.title)
    expect(titles).toContain('手工条目') // 外部修改未被覆盖
    expect(titles).toContain('新条目')
  })

  it('损坏文件：复制为 .bak 备份后按空数据继续，原文件不动', async () => {
    nodeFs.mkdirSync(nodePath.join(rootDir, '.vscode'), { recursive: true })
    nodeFs.writeFileSync(draftsFile(), '{broken json', 'utf8')
    const broken = new DraftBoxService(() => vscode.Uri.file(rootDir))
    expect(await broken.load()).toBe(0)
    // 原文件保持原样（读取不写回），损坏内容已复制备份
    expect(nodeFs.readFileSync(draftsFile(), 'utf8')).toBe('{broken json')
    expect(nodeFs.readFileSync(`${draftsFile()}.bak`, 'utf8')).toBe('{broken json')
  })

  it('load 过滤非法条目（缺 id / title 的元素被丢弃）', async () => {
    nodeFs.mkdirSync(nodePath.join(rootDir, '.vscode'), { recursive: true })
    nodeFs.writeFileSync(
      draftsFile(),
      JSON.stringify({
        schemaVersion: 1,
        entries: [
          { id: 'ok', kind: 'file', title: 'ok.md', detail: '', createdAt: 1 },
          { kind: 'file', title: '缺 id', detail: '', createdAt: 2 },
          'not-an-object',
        ],
      }),
      'utf8'
    )
    const partial = new DraftBoxService(() => vscode.Uri.file(rootDir))
    expect(await partial.load()).toBe(1)
    expect(partial.list()[0]?.title).toBe('ok.md')
  })
})

describe('DraftBoxService：容错', () => {
  it('未打开工作区：fileUri 为 undefined，变更仅内存', async () => {
    const noRoot = new DraftBoxService(() => undefined)
    expect(noRoot.fileUri).toBeUndefined()
    expect(await noRoot.load()).toBe(0)
    expect(await noRoot.addSelection('仅内存', 'a.ts')).toBe(1)
  })
})

describe('DraftBoxService：读错误语义（17 方案阶段 1，P1-2）', () => {
  it('读盘失败≠文件不存在：变更中止且绝不以「仅新条目」覆盖原文件', async () => {
    await service.addSelection('第一条', 'a.ts') // 数据文件已含 1 条
    const readFileSpy = vi
      .spyOn(vscode.workspace.fs, 'readFile')
      .mockRejectedValueOnce(Object.assign(new Error('EBUSY: 资源被占用'), { code: 'EBUSY' }))
    try {
      await expect(service.addSelection('第二条', 'b.ts')).rejects.toThrow('EBUSY')
    } finally {
      readFileSpy.mockRestore()
    }
    // 原文件未被覆盖：仍只有既有 1 条（修复前：重读失败被当空数据 → persist 仅写新条目）
    expect(readPersisted().entries).toHaveLength(1)
    expect(readPersisted().entries[0]?.title).toBe('第一条')
    // 队列未被毒化：恢复后重试，写前重读拿到既有 1 条 + 新增 1 条
    expect(await service.addSelection('第二条', 'b.ts')).toBe(2)
    expect(readPersisted().entries).toHaveLength(2)
  })

  it('load：读盘失败置 loadError（不再静默当空数据），且不产生写入', async () => {
    nodeFs.mkdirSync(draftsFile(), { recursive: true }) // 数据文件位置是目录 → readFile 抛 EISDIR（非 FileNotFound）
    expect(await service.load()).toBe(0)
    expect(service.loadError).toBeTruthy()
    expect(nodeFs.statSync(draftsFile()).isDirectory()).toBe(true)
    // 变更同样被中止（重读失败），不产生写入
    await expect(service.addSelection('x', 'a.ts')).rejects.toThrow()
    expect(nodeFs.statSync(draftsFile()).isDirectory()).toBe(true)
  })

  it('load：文件不存在仍按空数据（FileNotFound 语义不变）', async () => {
    expect(await service.load()).toBe(0)
    expect(service.loadError).toBeUndefined()
  })
})
