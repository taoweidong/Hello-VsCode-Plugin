/**
 * 串行化「加载先行 + 写前重读」变更队列（17 方案阶段 1，修复 P1-1/P1-2）。
 *
 * 契约（行为蓝本：draftBoxService.enqueue，v2.2.3 数据完整性契约）：
 * - **加载先行**：首次变更前等待初始加载完成——激活瞬间（磁盘慢/网络盘）用户
 *   先写入一条时，不会用空内存列表抹掉磁盘已有数据；
 * - **写前重读**：每次变更前从磁盘重读最新状态再变更（store 是唯一真值源）——
 *   多窗口 / 用户手改 / 外部迁移不会互相整文件覆盖；重读失败（非 FileNotFound
 *   的 IO 错误）中止本次变更并向上抛错，绝不带着陈旧状态落盘；
 * - **串行化**：所有变更排队执行，连续快速操作不互相覆盖；前次变更失败不阻塞
 *   后续变更（队列自身吞错，调用方仍能从返回的 Promise 收到错误）。
 *
 * 接线约定：
 * - `ensureLoaded` 传服务自身的加载管理（通常 `() => service 内部 loadPromise 缓存`）；
 * - `reread` 直接调用 store.load() 并把结果刷进内存——Json*Store 的 load 语义为
 *   FileNotFound → 空数据、损坏 → 备份后空数据、其余 IO 错误 → 抛出（抛出即中止）。
 */
export class QueuedStoreMutations {
  private queue: Promise<void> = Promise.resolve()
  /** 初始加载缓存（只执行一次；失败不缓存，下次变更重试）。 */
  private loaded: Promise<unknown> | undefined

  constructor(
    /** 完整加载（返回值忽略；服务可返回条数等统计信息）。 */
    private readonly ensureLoaded: () => Promise<unknown>,
    private readonly reread: () => Promise<void>
  ) {}

  /**
   * 排队执行一次变更：加载先行 → 写前重读 → mutate（含落盘）。
   * 返回 mutate 的返回值；重读或 mutate 抛错时该 Promise reject，队列继续。
   */
  run<T>(mutate: () => T | Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      await this.ensureLoadedOnce()
      await this.reread()
      return await mutate()
    })
    // 队列自身吞错（调用方仍能从 run 收到错误），前次失败不阻塞后续变更
    this.queue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  /** 初始加载只执行一次（与服务的 loadPromise 缓存一致；失败不缓存以便重试）。 */
  private ensureLoadedOnce(): Promise<unknown> {
    this.loaded ??= Promise.resolve()
      .then(() => this.ensureLoaded())
      .catch((err: unknown) => {
        this.loaded = undefined
        throw err
      })
    return this.loaded
  }
}
