import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  __setVsCodeApiForTest,
  useVsCodeApi,
  type VsCodeApi,
} from '../../../webview/shared/useVsCodeApi'

/** useVsCodeApi 单例（03 §9：acquireVsCodeApi 只能调用一次）。 */
describe('useVsCodeApi', () => {
  afterEach(() => {
    // 模拟宿主注入的全局函数用完即清，防止跨用例泄漏（17 方案阶段 5）
    delete (globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi
    __setVsCodeApiForTest(undefined)
  })

  it('无 acquireVsCodeApi 环境抛清晰错误（提示注入 mock）', () => {
    __setVsCodeApiForTest(undefined)
    expect(() => useVsCodeApi()).toThrow(/acquireVsCodeApi.*__setVsCodeApiForTest/)
  })

  it('重复调用返回同一实例（模块级单例）', () => {
    const fake: VsCodeApi = {
      postMessage: () => undefined,
      getState: () => undefined,
      setState: () => undefined,
    }
    __setVsCodeApiForTest(fake)
    expect(useVsCodeApi()).toBe(fake)
    expect(useVsCodeApi()).toBe(fake)
    __setVsCodeApiForTest(undefined)
  })

  it('globalThis 存在 acquireVsCodeApi：调用宿主注入并缓存实例（真机路径）', () => {
    const fake: VsCodeApi = {
      postMessage: vi.fn(),
      getState: () => undefined,
      setState: () => undefined,
    }
    const acquire: () => VsCodeApi = vi.fn(() => fake)
    ;(globalThis as { acquireVsCodeApi?: typeof acquire }).acquireVsCodeApi = acquire
    __setVsCodeApiForTest(undefined)
    expect(useVsCodeApi()).toBe(fake)
    expect(acquire).toHaveBeenCalledTimes(1)
    // 实例已缓存：后续调用不再触发 acquire（面板级「只能调用一次」约束）
    expect(useVsCodeApi()).toBe(fake)
    expect(acquire).toHaveBeenCalledTimes(1)
  })
})
