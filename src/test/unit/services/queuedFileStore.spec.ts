import { describe, expect, it, vi } from 'vitest'
import { QueuedStoreMutations } from '../../../extension/services/stores/queuedFileStore'

/**
 * 串行化「加载先行 + 写前重读」队列（17 方案阶段 1，P1-1/P1-2 修复的共享契约）：
 * - 加载先行：首次变更前等待初始加载完成；
 * - 写前重读：每次变更前从磁盘重读，重读失败中止且不落盘；
 * - 串行化：变更排队，前次失败不阻塞后续；
 * - 行为蓝本：draftBoxService.enqueue（v2.2.3 数据完整性契约）。
 */

describe('QueuedStoreMutations', () => {
  it('加载先行：首次变更前自动执行一次 load（后续变更复用，不重复加载）', async () => {
    const load = vi.fn(async () => undefined)
    const reread = vi.fn(async () => undefined)
    const queue = new QueuedStoreMutations(load, reread)
    await queue.run(() => 'a')
    await queue.run(() => 'b')
    expect(load).toHaveBeenCalledTimes(1)
    expect(reread).toHaveBeenCalledTimes(2)
  })

  it('写前重读先于变更执行（变更看到的是磁盘最新状态）', async () => {
    const order: string[] = []
    const queue = new QueuedStoreMutations(
      async () => {
        order.push('load')
      },
      async () => {
        order.push('reread')
      }
    )
    await queue.run(() => {
      order.push('mutate')
    })
    expect(order).toEqual(['load', 'reread', 'mutate'])
  })

  it('重读失败：变更中止并向调用方抛错（绝不带着陈旧状态落盘）', async () => {
    let failRead = false
    const queue = new QueuedStoreMutations(
      async () => undefined,
      async () => {
        if (failRead) {
          throw new Error('EBUSY')
        }
      }
    )
    failRead = true
    await expect(
      queue.run(() => {
        throw new Error('变更不应被执行')
      })
    ).rejects.toThrow('EBUSY')
    failRead = false
  })

  it('前次变更失败不阻塞队列：后续变更正常执行', async () => {
    const applied: string[] = []
    const queue = new QueuedStoreMutations(
      async () => undefined,
      async () => undefined
    )
    await expect(
      queue.run(() => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    await queue.run(() => {
      applied.push('second')
    })
    expect(applied).toEqual(['second'])
  })

  it('串行化：并发发起的变更按发起顺序排队执行（不互相覆盖）', async () => {
    const events: string[] = []
    const queue = new QueuedStoreMutations(
      async () => undefined,
      async () => undefined
    )
    const first = queue.run(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      events.push('first-done')
      return 1
    })
    const second = queue.run(() => {
      // first 尚未完成时发起：必须排在 first 之后
      events.push('second-done')
      return 2
    })
    expect(await Promise.all([first, second])).toEqual([1, 2])
    expect(events).toEqual(['first-done', 'second-done'])
  })

  it('变更返回值透传（同步与异步 mutate 均可）', async () => {
    const queue = new QueuedStoreMutations(
      async () => undefined,
      async () => undefined
    )
    expect(await queue.run(() => 42)).toBe(42)
    expect(await queue.run(async () => 'ok')).toBe('ok')
  })
})
