import * as vscode from 'vscode'
import { STORAGE } from '../../constants'
import { reasonOf } from '../../services/errors'
import { writeJsonAtomic } from '../../services/stores/atomicWrite'
import { copyCorruptBackup } from '../../services/stores/jsonEnvelopeStore'
import { QueuedStoreMutations } from '../../services/stores/queuedFileStore'

/**
 * 草稿箱服务（09 方案 §3.5：右键示例的新载体）。
 *
 * 条目领域删除后，「宿主如何拿到编辑器 / 资源管理器上下文并写入工作区存储」这条
 * 教学链路由草稿箱承担：8 条右键入口（editor/context 4 + explorer/context 3 +
 * editor/title 1）全部落到 `.vscode/ext-starter.drafts.json`（B3：该路径须字面量
 * 进 DEFAULT_DIRTY_IGNORES 与 .gitignore）。
 *
 * 数据完整性契约（v2.2.3，代码评审修复；v3.6.1 读错误语义收紧，17 方案阶段 1）：
 * - **全文落盘**：selection 草稿保存完整选中文本（`content` 字段，64K 字符上限
 *   并显式标记截断），`title` 仅作摘要——此前只存 40 字摘要，大部分内容丢失；
 * - **串行化读-改-写**：所有变更进入队列（QueuedStoreMutations 共享契约），每次
 *   「重读磁盘 → 变更 → 原子写」，多窗口 / 手改文件不会互相覆盖，连续快速登记
 *   不丢条目；
 * - **加载先行**：首次变更前等待初始加载完成，命令不会抹掉已有数据；
 * - **读错误 ≠ 空数据（v3.6.1，P1-2）**：文件不存在 → 空数据；其余读盘错误
 *   （EBUSY/EPERM 等）如实上抛并记入 loadError——变更在重读失败时中止，
 *   绝不以「仅新条目」覆盖原文件；
 * - **损坏备份**：解析失败 / 根节点形态不符先把原文件复制为 `.corrupt-*.bak`
 *   再按空数据继续（copy 型，与收藏夹等数据文件统一机制，17 方案阶段 2）。
 */

export type DraftKind = 'selection' | 'file' | 'folder'

export interface DraftEntry {
  id: string
  kind: DraftKind
  /** 展示标题（选中文本摘要 / 文件名 / 文件夹名） */
  title: string
  /** 补充信息（来源文件、路径、批量清单等） */
  detail: string
  /**
   * 完整内容（v2.2.3）：仅 selection 草稿写入；超过 MAX_CONTENT_CHARS 截断并标记。
   * file / folder 草稿不复制内容（避免把二进制或巨型文件灌进数据文件）。
   */
  content?: string
  createdAt: number
}

const DRAFTS_SCHEMA_VERSION = 1
/** 草稿上限：超出后丢弃最旧的（unshift 到头部、尾部裁剪）。 */
const MAX_DRAFTS = 100
/** 文件夹批量登记时列目录的文件数上限（防超大目录拖垮命令）。 */
const FOLDER_BATCH_LIMIT = 50
/** 选中文本的标题摘要长度。 */
const TITLE_LIMIT = 40
/** selection 草稿完整内容上限（字符）。 */
const MAX_CONTENT_CHARS = 64 * 1024

function nextDraftId(): string {
  // 经 globalThis.crypto 而非 node:crypto：避开 Node 内建依赖（跨侧模块口径），
  // 避免 Webview 可达的模块引入 Node 运行时
  return (globalThis.crypto as { randomUUID(): string }).randomUUID()
}

function summarizeText(text: string): string {
  const singleLine = text.split(/\r?\n/).join(' ').trim()
  return singleLine.length > TITLE_LIMIT ? `${singleLine.slice(0, TITLE_LIMIT)}…` : singleLine
}

/** 完整内容裁剪：超限截断并留下显式标记（不静默丢内容）。 */
function clipContent(text: string): string {
  if (text.length <= MAX_CONTENT_CHARS) {
    return text
  }
  return `${text.slice(0, MAX_CONTENT_CHARS)}\n…（内容超过 ${MAX_CONTENT_CHARS / 1024}K 字符，已截断）`
}

/** 条目守卫：仅收 id + title 均为字符串的对象形态（宽松口径，12 号文档 P3-E2 维持）。 */
function filterDraftEntries(raw: readonly unknown[]): DraftEntry[] {
  return raw.filter(
    (entry): entry is DraftEntry =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as DraftEntry).id === 'string' &&
      typeof (entry as DraftEntry).title === 'string'
  )
}

export class DraftBoxService implements vscode.Disposable {
  private entries: DraftEntry[] = []

  /** 初始加载（幂等）：首次变更与显式 load 共用。 */
  private loadPromise: Promise<number> | undefined
  /** 初始加载失败的原因（v3.6.1：不再把读盘错误静默当空数据；成功后清空）。 */
  loadError: string | undefined

  private readonly _onDidChange = new vscode.EventEmitter<void>()
  readonly onDidChange = this._onDidChange.event

  /**
   * 变更队列（共享契约，17 方案阶段 1）：加载先行 → 写前重读 → 变更 → 落盘。
   * 重读失败（非 FileNotFound IO 错误）中止本次变更且不落盘。
   */
  private readonly mutations = new QueuedStoreMutations(
    () => {
      this.loadPromise ??= this.doLoad()
      return this.loadPromise
    },
    async () => {
      this.entries = await this.readEntries()
      this.loadError = undefined
    }
  )

  constructor(private readonly getWorkspaceRoot: () => vscode.Uri | undefined) {}

  /** 数据文件 URI；未打开工作区时为 undefined（草稿功能整体不可用）。 */
  get fileUri(): vscode.Uri | undefined {
    const root = this.getWorkspaceRoot()
    return root ? vscode.Uri.joinPath(root, STORAGE.draftsFileName) : undefined
  }

  /**
   * 从工作区加载数据（幂等）。文件不存在 / 解析失败按空数据继续（解析失败先复制
   * `.bak` 备份，原文件保留不动）；其余读盘错误记入 loadError（不静默吞掉），
   * 返回加载条数；完成后触发变更事件。
   */
  async load(): Promise<number> {
    this.loadPromise = this.doLoad()
    try {
      return await this.loadPromise
    } finally {
      this._onDidChange.fire()
    }
  }

  /** 当前草稿（最新在前）。 */
  list(): readonly DraftEntry[] {
    return [...this.entries]
  }

  /** 登记一条选中文本（source 为来源文件名；保存完整文本，标题取摘要）。 */
  async addSelection(text: string, source: string): Promise<number> {
    const trimmed = text.trim()
    if (!trimmed) {
      return this.entries.length
    }
    return this.mutations.run(async () => {
      const count = this.insert({
        id: nextDraftId(),
        kind: 'selection',
        title: summarizeText(trimmed),
        detail: `来源：${source}`,
        content: clipContent(trimmed),
        createdAt: Date.now(),
      })
      await this.persist()
      this._onDidChange.fire()
      return count
    })
  }

  /**
   * 追加选中文本到最近一条草稿（完整文本追加到 content，摘要追加到 detail）。
   * 没有草稿时降级为新增。返回是否发生了追加（false = 降级新增或空文本无操作）。
   */
  async appendToLatest(text: string, source: string): Promise<boolean> {
    const trimmed = text.trim()
    if (!trimmed) {
      return false
    }
    return this.mutations.run(async () => {
      const latest = this.entries[0]
      if (!latest) {
        this.insert({
          id: nextDraftId(),
          kind: 'selection',
          title: summarizeText(trimmed),
          detail: `来源：${source}`,
          content: clipContent(trimmed),
          createdAt: Date.now(),
        })
        await this.persist()
        this._onDidChange.fire()
        return false
      }
      latest.detail = `${latest.detail}\n${summarizeText(trimmed)}（来自：${source}）`
      latest.content = clipContent(`${latest.content ?? ''}\n${trimmed}`.trim())
      await this.persist()
      this._onDidChange.fire()
      return true
    })
  }

  /** 登记单个文件（拒绝目录）。 */
  async addFile(uri: vscode.Uri): Promise<number> {
    const stat = await vscode.workspace.fs.stat(uri)
    if (stat.type === vscode.FileType.Directory) {
      throw new Error('请选择文件而非文件夹。')
    }
    return this.mutations.run(async () => {
      const count = this.insert({
        id: nextDraftId(),
        kind: 'file',
        title: uri.path.split('/').pop() || uri.fsPath,
        detail: uri.fsPath,
        createdAt: Date.now(),
      })
      await this.persist()
      this._onDidChange.fire()
      return count
    })
  }

  /** 批量登记文件（资源管理器多选）。目录项会被跳过。 */
  async addFiles(uris: readonly vscode.Uri[]): Promise<number> {
    for (const uri of uris) {
      const stat = await vscode.workspace.fs.stat(uri)
      if (stat.type !== vscode.FileType.Directory) {
        await this.addFile(uri)
      }
    }
    return this.entries.length
  }

  /**
   * 登记文件夹内容为一条汇总草稿（不递归；限 FOLDER_BATCH_LIMIT 个文件）。
   * 空文件夹抛错（右键入口对空文件夹给出可操作提示）。
   */
  async addFolder(uri: vscode.Uri): Promise<number> {
    const stat = await vscode.workspace.fs.stat(uri)
    if (stat.type !== vscode.FileType.Directory) {
      throw new Error('请选择文件夹。')
    }
    const children = await vscode.workspace.fs.readDirectory(uri)
    const files = children
      .filter(([, type]) => type === vscode.FileType.File)
      .map(([name]) => name)
      .sort()
    if (files.length === 0) {
      throw new Error('文件夹内没有文件，无可登记内容。')
    }
    const listed = files.slice(0, FOLDER_BATCH_LIMIT)
    const overflow = files.length > FOLDER_BATCH_LIMIT ? ` 等 ${files.length} 个文件` : ''
    return this.mutations.run(async () => {
      const count = this.insert({
        id: nextDraftId(),
        kind: 'folder',
        title: uri.path.split('/').pop() || uri.fsPath,
        detail: `${listed.join('、')}${overflow}`,
        createdAt: Date.now(),
      })
      await this.persist()
      this._onDidChange.fire()
      return count
    })
  }

  dispose(): void {
    this._onDidChange.dispose()
  }

  /* ---------------- 内部：加载与串行化写 ---------------- */

  /** 加载实现（不触发事件——变更队列内隐式加载不应多发 onDidChange）。 */
  private async doLoad(): Promise<number> {
    try {
      this.entries = await this.readEntries()
      this.loadError = undefined
    } catch (err) {
      this.entries = []
      this.loadError = reasonOf(err)
    }
    return this.entries.length
  }

  /**
   * 读取并校验数据文件（写前重读的数据源，语义即 QueuedStoreMutations 契约）：
   * 文件不存在 → 空数组；其余读盘错误如实上抛（中止变更，绝不带陈旧状态落盘）；
   * 顶层数组宽容读取（手写常见形态，下次保存自动迁移为信封）；解析失败 /
   * 根节点形态不符 → 复制 `.corrupt-*.bak` 备份（与其他数据文件统一机制，
   * 17 方案阶段 2）后按空数据继续，备份失败抛错（绝无备份不覆盖）。
   */
  private async readEntries(): Promise<DraftEntry[]> {
    const uri = this.fileUri
    if (!uri) {
      return []
    }
    let raw: string
    try {
      raw = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8')
    } catch (err) {
      if (err instanceof vscode.FileSystemError && err.code === 'FileNotFound') {
        return [] // 首次使用：空草稿箱
      }
      throw err // 其余读盘错误如实上抛（P1-2：不再当「文件不存在」吞掉）
    }
    if (raw.charCodeAt(0) === 0xfeff) {
      raw = raw.slice(1)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      // 损坏：复制备份（保留原样）后按空数据继续；备份失败向上抛
      await copyCorruptBackup(uri, '草稿')
      return []
    }
    if (Array.isArray(parsed)) {
      // 顶层数组（手写常见形态）：宽容读取
      return filterDraftEntries(parsed)
    }
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      Array.isArray((parsed as { entries?: unknown }).entries)
    ) {
      return filterDraftEntries((parsed as { entries: unknown[] }).entries)
    }
    // 根节点形态不符：与解析失败同走备份恢复
    await copyCorruptBackup(uri, '草稿')
    return []
  }

  /** 头部插入 + 上限裁剪。返回当前条数。 */
  private insert(entry: DraftEntry): number {
    this.entries.unshift(entry)
    if (this.entries.length > MAX_DRAFTS) {
      this.entries.length = MAX_DRAFTS
    }
    return this.entries.length
  }

  private async persist(): Promise<void> {
    const uri = this.fileUri
    if (!uri) {
      return
    }
    await writeJsonAtomic(uri, { schemaVersion: DRAFTS_SCHEMA_VERSION, entries: this.entries })
  }
}
