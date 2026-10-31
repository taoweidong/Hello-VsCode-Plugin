import * as vscode from 'vscode'
import { STORAGE } from '../../constants'
import { taskKeyFromRef, type RecentTaskRef, type TaskRef, type TaskUsage } from './taskSource'

/**
 * 任务管理器的最近运行 / 收藏持久化（v2.3，10 方案 §6.4）。
 *
 * - 只存任务身份 `TaskRef` 到 `workspaceState`（按工作区隔离、跨窗口恢复），
 *   不存 Task 对象、不复制输出；恢复时按 key 重新匹配，匹配不到的收藏
 *   隐藏但保留、最近运行由上限自然淘汰（显示层负责，见树 provider）。
 * - 只接受 `version === 1`：任一元素结构非法 → 丢弃该条并写输出通道；
 *   整体结构非法 / 版本不符 → 重置为空结构（不动 memento 里的其他键）。
 * - 全部写操作即时 `memento.update`；写失败捕获、写输出通道并继续以内存
 *   状态提供 UI（下次激活回退到磁盘值）。
 */

/** 存储上限：recent 20（展示层再截 10），favorites 不设上限 */
const RECENT_LIMIT = 20

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function parseTaskRef(value: unknown): TaskRef | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  const ref = value as Record<string, unknown>
  if (
    !isNonEmptyString(ref.scopeUri) ||
    !isNonEmptyString(ref.source) ||
    !isNonEmptyString(ref.name)
  ) {
    return undefined
  }
  return { scopeUri: ref.scopeUri, source: ref.source, name: ref.name }
}

function parseRecentTaskRef(value: unknown): RecentTaskRef | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  const record = value as Record<string, unknown>
  const ref = parseTaskRef(value)
  if (!ref || typeof record.lastRunAt !== 'number' || !Number.isFinite(record.lastRunAt)) {
    return undefined
  }
  return { ...ref, lastRunAt: record.lastRunAt }
}

export class TaskUsageStore implements vscode.Disposable {
  private favorites: TaskRef[] = []
  private recent: RecentTaskRef[] = []
  private disposed = false
  /** 读取时整体结构非法/版本不符而重置（空态提示「本地记录已重置」用） */
  private reset = false

  private readonly _onDidChange = new vscode.EventEmitter<void>()
  readonly onDidChange = this._onDidChange.event

  constructor(
    private readonly memento: vscode.Memento,
    private readonly output: vscode.OutputChannel,
    storageKey: string = STORAGE.taskExplorerUsageKey
  ) {
    this.storageKey = storageKey
    this.load()
  }

  private readonly storageKey: string

  /** 存储是否曾因结构损坏被重置（provider 在最近运行/收藏组下显示 warning 提示） */
  get wasReset(): boolean {
    return this.reset
  }

  /** 读取 + 校验 + 去重排序（构造时执行一次；之后由 onDidChange 驱动，不重复读 memento） */
  private load(): void {
    const raw = this.memento.get<TaskUsage>(this.storageKey)
    if (raw === undefined) {
      return
    }
    if (
      typeof raw !== 'object' ||
      raw === null ||
      (raw as TaskUsage).version !== 1 ||
      !Array.isArray((raw as TaskUsage).favorites) ||
      !Array.isArray((raw as TaskUsage).recent)
    ) {
      this.output.appendLine(
        '[taskExplorer] 最近运行/收藏数据结构非法或版本不符，已重置为空（其他存储数据不受影响）。'
      )
      this.reset = true
      this.persist()
      return
    }
    const seenFavorites = new Set<string>()
    for (const item of raw.favorites) {
      const ref = parseTaskRef(item)
      if (!ref) {
        this.output.appendLine(
          `[taskExplorer] 收藏记录结构非法，已丢弃该条：${JSON.stringify(item)}`
        )
        continue
      }
      const key = taskKeyFromRef(ref)
      if (!seenFavorites.has(key)) {
        seenFavorites.add(key)
        this.favorites.push(ref)
      }
    }
    const latestByKey = new Map<string, RecentTaskRef>()
    for (const item of raw.recent) {
      const ref = parseRecentTaskRef(item)
      if (!ref) {
        this.output.appendLine(
          `[taskExplorer] 最近运行记录结构非法，已丢弃该条：${JSON.stringify(item)}`
        )
        continue
      }
      const key = taskKeyFromRef(ref)
      const existing = latestByKey.get(key)
      if (!existing || ref.lastRunAt > existing.lastRunAt) {
        latestByKey.set(key, ref)
      }
    }
    this.recent = [...latestByKey.values()]
      .sort((a, b) => b.lastRunAt - a.lastRunAt)
      .slice(0, RECENT_LIMIT)
  }

  private persist(): void {
    const usage: TaskUsage = {
      version: 1,
      favorites: [...this.favorites],
      recent: [...this.recent],
    }
    // Memento.update 返回 Thenable（无 catch）；先入微任务统一捕获同步/异步两种失败
    Promise.resolve()
      .then(() => this.memento.update(this.storageKey, usage))
      .catch((err: unknown) => {
        // 写失败不阻断 UI：内存状态继续生效，下次激活回退到磁盘值（10 方案 §6.4）
        this.output.appendLine(`[taskExplorer] 最近运行/收藏写入失败：${String(err)}`)
      })
  }

  getFavorites(): readonly TaskRef[] {
    return this.favorites
  }

  getRecent(): readonly RecentTaskRef[] {
    return this.recent
  }

  isFavorite(key: string): boolean {
    return this.favorites.some((ref) => taskKeyFromRef(ref) === key)
  }

  /** 已存在返回 false（调用方无需预查） */
  addFavorite(ref: TaskRef): boolean {
    const key = taskKeyFromRef(ref)
    if (this.isFavorite(key)) {
      return false
    }
    this.favorites = [...this.favorites, ref]
    this.persist()
    this._onDidChange.fire()
    return true
  }

  removeFavorite(ref: TaskRef): boolean {
    const key = taskKeyFromRef(ref)
    const before = this.favorites.length
    this.favorites = this.favorites.filter((item) => taskKeyFromRef(item) !== key)
    if (this.favorites.length === before) {
      return false
    }
    this.persist()
    this._onDidChange.fire()
    return true
  }

  /** 同 key 去重置顶 + 上限淘汰；仅在 controller 的 run 命令 executeTask 成功后调用 */
  recordRun(ref: TaskRef, at: number = Date.now()): void {
    const key = taskKeyFromRef(ref)
    this.recent = [
      { ...ref, lastRunAt: at },
      ...this.recent.filter((item) => taskKeyFromRef(item) !== key),
    ]
    this.recent = this.recent.slice(0, RECENT_LIMIT)
    this.persist()
    this._onDidChange.fire()
  }

  clearRecent(): void {
    if (this.recent.length === 0) {
      return
    }
    this.recent = []
    this.persist()
    this._onDidChange.fire()
  }

  dispose(): void {
    this.disposed = true
    this._onDidChange.dispose()
  }

  /** dispose 后事件源不再分发（测试断言用；fire 内部已判 disposed） */
  get isDisposed(): boolean {
    return this.disposed
  }
}
