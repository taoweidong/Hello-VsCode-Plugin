import { afterEach } from 'vitest'
import { __resetStubs } from './stubs/vscode'
import { __setVsCodeApiForTest } from '../../webview/shared/useVsCodeApi'

/**
 * 全局测试清理（第五轮基建）：
 * - 每个用例后复位 vscode 测试桩（config / dialog 队列 / 录制器）；
 * - 复位 useVsCodeApi 单例，避免 mock 实例跨用例泄漏；
 * - 既有 spec 内的显式复位保持不动（幂等兼容）；文件级隔离（isolate）保留，
 *   本清理为「切 isolate:false」预留的前置条件（agent.md 测试卫生规约）。
 */
afterEach(() => {
  __resetStubs()
  __setVsCodeApiForTest(undefined)
})
