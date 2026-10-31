import { beforeEach, describe, expect, it } from 'vitest'
import * as vscode from 'vscode'
import { TaskUsageStore } from '../../../extension/features/taskExplorer/taskUsageStore'
import { taskKeyFromRef, type TaskRef } from '../../../extension/features/taskExplorer/taskSource'
import { createMementoStub, __resetStubs, __stubs } from '../stubs/vscode'

/**
 * 最近运行 / 收藏持久化（10 方案 §6.4，§11.2 taskUsageStore.spec.ts 用例 ①-⑭）。
 * 构造注入 createMementoStub + 输出通道桩，无需真实 ExtensionContext。
 */

const refA: TaskRef = { scopeUri: 'file:///repo', source: 'Workspace', name: 'build' }
const refB: TaskRef = { scopeUri: 'file:///repo', source: 'Workspace', name: 'test' }

function makeOutput() {
  return vscode.window.createOutputChannel('test')
}

/** update 可注入抛错的 memento（createMementoStub 的升级包装） */
function makeMemento(initial: Record<string, unknown> = {}, failUpdate = false) {
  const inner = createMementoStub(initial)
  return {
    get: inner.get,
    keys: inner.keys,
    setKeysForSync: inner.setKeysForSync,
    __backing: inner.__backing,
    update: async (key: string, value: unknown): Promise<void> => {
      if (failUpdate) {
        throw new Error('disk full')
      }
      return inner.update(key, value)
    },
  }
}

beforeEach(() => {
  __resetStubs()
})

describe('TaskUsageStore（读取与校验）', () => {
  it('① 空 memento → 空结构', () => {
    const store = new TaskUsageStore(createMementoStub(), makeOutput())
    expect(store.getFavorites()).toEqual([])
    expect(store.getRecent()).toEqual([])
    expect(store.wasReset).toBe(false)
  })

  it('② 合法结构读取（favorites / recent 原样恢复）', () => {
    const usage = {
      version: 1,
      favorites: [refA],
      recent: [{ ...refB, lastRunAt: 42 }],
    }
    const store = new TaskUsageStore(
      createMementoStub({ 'extStarter.taskExplorer.usage': usage }),
      makeOutput()
    )
    expect(store.getFavorites()).toEqual([refA])
    expect(store.getRecent()).toEqual([{ ...refB, lastRunAt: 42 }])
    expect(store.isFavorite(taskKeyFromRef(refA))).toBe(true)
    expect(store.wasReset).toBe(false)
  })

  it('③ 版本不符 → 重置为空 + 告警 + wasReset', () => {
    const memento = createMementoStub({
      'extStarter.taskExplorer.usage': { version: 99, favorites: [], recent: [] },
    })
    const output = makeOutput()
    const store = new TaskUsageStore(memento, output)
    expect(store.getFavorites()).toEqual([])
    expect(store.wasReset).toBe(true)
    expect(__stubs.outputLines.join('\n')).toContain('已重置')
  })

  it('④ 元素字段缺失/类型错误 → 只丢弃该条，合法条目保留', () => {
    const usage = {
      version: 1,
      favorites: [refA, { source: 'Workspace', name: 'broken' }, 42],
      recent: [
        { ...refB, lastRunAt: 1 },
        { ...refB, lastRunAt: 'nope' },
      ],
    }
    const store = new TaskUsageStore(
      createMementoStub({ 'extStarter.taskExplorer.usage': usage }),
      makeOutput()
    )
    expect(store.getFavorites()).toEqual([refA])
    expect(store.getRecent()).toEqual([{ ...refB, lastRunAt: 1 }])
    expect(__stubs.outputLines.filter((line) => line.includes('已丢弃该条'))).toHaveLength(3)
  })

  it('④b recent 元素为非对象 → 丢弃该条', () => {
    const usage = { version: 1, favorites: [], recent: [42, 'nope', null] }
    const store = new TaskUsageStore(
      createMementoStub({ 'extStarter.taskExplorer.usage': usage }),
      makeOutput()
    )
    expect(store.getRecent()).toEqual([])
    expect(__stubs.outputLines.filter((line) => line.includes('已丢弃该条'))).toHaveLength(3)
  })

  it('⑤ favorites 按 key 去重（保留首次出现）', () => {
    const usage = { version: 1, favorites: [refA, { ...refA }], recent: [] }
    const store = new TaskUsageStore(
      createMementoStub({ 'extStarter.taskExplorer.usage': usage }),
      makeOutput()
    )
    expect(store.getFavorites()).toHaveLength(1)
  })

  it('⑥ recent 按 key 去重保留最新一条并按时间倒序', () => {
    const usage = {
      version: 1,
      favorites: [],
      recent: [
        { ...refA, lastRunAt: 100 },
        { ...refB, lastRunAt: 300 },
        { ...refA, lastRunAt: 200 },
      ],
    }
    const store = new TaskUsageStore(
      createMementoStub({ 'extStarter.taskExplorer.usage': usage }),
      makeOutput()
    )
    const recent = store.getRecent()
    expect(recent.map((item) => item.name)).toEqual(['test', 'build'])
    expect(recent[0]?.lastRunAt).toBe(300)
    expect(recent[1]?.lastRunAt).toBe(200)
  })
})

describe('TaskUsageStore（写入与事件）', () => {
  it('⑦ recordRun 去重置顶；同一秒多次运行只留最新', () => {
    const store = new TaskUsageStore(createMementoStub(), makeOutput())
    store.recordRun(refA, 100)
    store.recordRun(refB, 200)
    store.recordRun(refA, 300)
    expect(store.getRecent().map((item) => item.name)).toEqual(['build', 'test'])
  })

  it('⑧ recent 存储上限 20（超出淘汰最旧）', () => {
    const store = new TaskUsageStore(createMementoStub(), makeOutput())
    for (let i = 0; i < 25; i += 1) {
      store.recordRun({ scopeUri: 'file:///repo', source: 'Workspace', name: `task-${i}` }, i)
    }
    const recent = store.getRecent()
    expect(recent).toHaveLength(20)
    expect(recent[0]?.name).toBe('task-24')
    expect(recent.at(-1)?.name).toBe('task-5')
  })

  it('⑨ addFavorite 已存在返回 false；⑩ removeFavorite 命中/未命中', () => {
    const store = new TaskUsageStore(createMementoStub(), makeOutput())
    expect(store.addFavorite(refA)).toBe(true)
    expect(store.addFavorite(refA)).toBe(false)
    expect(store.getFavorites()).toHaveLength(1)
    expect(store.removeFavorite(refB)).toBe(false)
    expect(store.removeFavorite(refA)).toBe(true)
    expect(store.getFavorites()).toEqual([])
  })

  it('⑪ clearRecent 只清 recent，不影响 favorites', () => {
    const store = new TaskUsageStore(createMementoStub(), makeOutput())
    store.addFavorite(refA)
    store.recordRun(refB, 1)
    store.clearRecent()
    expect(store.getRecent()).toEqual([])
    expect(store.getFavorites()).toEqual([refA])
  })

  it('⑫ update 抛错 → 内存仍生效 + 输出通道告警', async () => {
    const store = new TaskUsageStore(makeMemento({}, true), makeOutput())
    store.addFavorite(refA)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(store.getFavorites()).toEqual([refA])
    expect(__stubs.outputLines.join('\n')).toContain('写入失败')
  })

  it('⑬ onDidChange 触发次数（addFavorite/removeFavorite/recordRun/clearRecent 各一次；无变化不触发）', () => {
    const store = new TaskUsageStore(createMementoStub(), makeOutput())
    let events = 0
    store.onDidChange(() => (events += 1))
    store.addFavorite(refA)
    store.addFavorite(refA) // 已存在：无变化不触发
    store.removeFavorite(refB) // 未命中：不触发
    store.removeFavorite(refA)
    store.recordRun(refB, 1)
    store.clearRecent()
    store.clearRecent() // 已为空：不触发
    expect(events).toBe(4)
  })

  it('⑭ dispose 后不再 fire', () => {
    const store = new TaskUsageStore(createMementoStub(), makeOutput())
    let events = 0
    store.onDidChange(() => (events += 1))
    store.dispose()
    expect(store.isDisposed).toBe(true)
    store.recordRun(refA, 1)
    expect(events).toBe(0)
  })

  it('recordRun 后写回 memento（version 1，重启可恢复）', async () => {
    const memento = makeMemento()
    const store = new TaskUsageStore(memento, makeOutput())
    store.recordRun(refA, 7)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const persisted = memento.__backing.get('extStarter.taskExplorer.usage') as {
      version: number
      recent: { name: string; lastRunAt: number }[]
    }
    expect(persisted.version).toBe(1)
    expect(persisted.recent[0]?.name).toBe('build')
    expect(persisted.recent[0]?.lastRunAt).toBe(7)
  })
})
