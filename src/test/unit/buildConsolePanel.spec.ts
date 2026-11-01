import { describe, expect, it, vi } from 'vitest'
import * as vscode from 'vscode'
import { createBuildConsoleDeps } from '../../extension/features/build/buildConsolePanel'
import type { BuildApiClient, BuildTask } from '../../extension/features/build/buildApiClient'
import { __resetStubs, __stubs } from './stubs/vscode'

/**
 * 分支编译面板依赖（v2.2.3 代码评审修复）：
 * - 提交成功后列表刷新失败 → 提交仍算成功（不 reject，避免假失败诱发重复提交）；
 * - 轮询拉取失败 → 日志 + 向页面下发 error（不再 void 静默）；
 * - 真实接口超时由 buildApiClient 的 AbortSignal 兜底（见 buildApiClient.spec）。
 */

function makeTask(overrides: Partial<BuildTask> = {}): BuildTask {
  return {
    id: 'build-1',
    branch: 'release/1.0.0',
    buildType: 'full',
    status: 'queued',
    progress: 0,
    createdAt: '2026-10-25T00:00:00.000Z',
    ...overrides,
  }
}

function makeApi(overrides: Partial<BuildApiClient> = {}): BuildApiClient {
  return {
    mode: 'stub',
    submit: async () => makeTask(),
    list: async () => [makeTask()],
    dispose: () => undefined,
    ...overrides,
  }
}

function makeServices(api: BuildApiClient, onAfterSubmit?: () => void) {
  const output = vscode.window.createOutputChannel('Hello VSCode Plugin Test')
  return { api, output, onAfterSubmit }
}

const submittedDraft = { branch: 'release/1.0.0', buildType: 'full' }

describe('createBuildConsoleDeps：失败路径', () => {
  it('提交成功但列表刷新失败：onSubmit 仍 resolve（任务已受理），日志记录刷新失败', async () => {
    __resetStubs()
    const deps = createBuildConsoleDeps(
      makeServices(
        makeApi({
          list: async () => {
            throw new Error('HTTP 503')
          },
        })
      )
    )
    await expect(deps.onSubmit?.(submittedDraft)).resolves.toBeUndefined()
    expect(__stubs.outputLines.some((line) => line.includes('提交成功但任务列表刷新失败'))).toBe(
      true
    )
  })

  it('提交失败：onSubmit 抛错（控制器统一转 error 下发并解锁页面）', async () => {
    __resetStubs()
    const deps = createBuildConsoleDeps(
      makeServices(
        makeApi({
          submit: async () => {
            throw new Error('HTTP 500')
          },
        })
      )
    )
    await expect(deps.onSubmit?.(submittedDraft)).rejects.toThrow('HTTP 500')
  })

  it('空分支名：拒绝并带 field=branch（页面定位控件）', async () => {
    __resetStubs()
    const deps = createBuildConsoleDeps(makeServices(makeApi()))
    await expect(deps.onSubmit?.({ branch: '  ', buildType: 'full' })).rejects.toMatchObject({
      field: 'branch',
    })
  })

  it('轮询拉取失败：日志记录 + 不抛未处理异常', async () => {
    __resetStubs()
    const deps = createBuildConsoleDeps(
      makeServices(
        makeApi({
          list: async () => {
            throw new Error('网络中断')
          },
        })
      )
    )
    deps.onPageMessage?.({ type: 'buildListRequest' })
    // 等待 promise 链落定（catch 分支异步执行）
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(__stubs.outputLines.some((line) => line.includes('任务列表拉取失败：网络中断'))).toBe(
      true
    )
  })

  it('提交成功后触发 onAfterSubmit（事件驱动刷新树视图）', async () => {
    __resetStubs()
    const onAfterSubmit = vi.fn()
    const deps = createBuildConsoleDeps(makeServices(makeApi(), onAfterSubmit))
    await deps.onSubmit?.(submittedDraft)
    expect(onAfterSubmit).toHaveBeenCalledTimes(1)
  })

  it('buildInit：下发 3 个字段的表单 schema（分支名 / 构建类型 / 备注）', () => {
    __resetStubs()
    const deps = createBuildConsoleDeps(makeServices(makeApi()))
    const payload = deps.buildInit?.({ persistedState: undefined }) as {
      schema: { key: string }[]
    }
    expect(payload.schema.map((field) => field.key)).toEqual(['branch', 'buildType', 'notes'])
  })
})
