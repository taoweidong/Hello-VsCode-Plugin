import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import App from '../../../webview/apps/buildConsole/App.vue'
import { __setVsCodeApiForTest, type VsCodeApi } from '../../../webview/shared/useVsCodeApi'
import { deriveFormSchema, toFieldDefs } from '../../../webview/formSchema'
import { BUILD_FIELD_DEFS } from '../../../extension/features/build/buildSchema'
import type { BuildTaskWire, FieldDef } from '../../../webview/protocol'
import { browserWindow, hostMessage } from './appTestUtils'

/**
 * 分支编译弹框页面（v2.0）：init 装配表单 / 提交走通用 submit 生命周期 /
 * buildList 渲染任务列表 / 错误反馈与字段定位 / 提交后轮询任务列表。
 */

const SCHEMA: FieldDef[] = toFieldDefs(deriveFormSchema(BUILD_FIELD_DEFS))

function makeTask(overrides: Partial<BuildTaskWire> = {}): BuildTaskWire {
  return {
    id: 'build-1',
    branch: 'release/1.0.0',
    buildType: 'full',
    status: 'running',
    progress: 42,
    createdAt: '2026-10-25T00:00:00.000Z',
    ...overrides,
  }
}

function createApiMock() {
  const api: VsCodeApi & { posted: unknown[] } = {
    posted: [],
    postMessage(message: unknown): void {
      this.posted.push(message)
    },
    getState<T>(): T | undefined {
      return undefined
    },
    setState<T>(_state: T): void {},
  }
  return api
}

let api: ReturnType<typeof createApiMock>
let wrapper: VueWrapper | undefined

const submitButton = (): { text: string; disabled: boolean } | undefined => {
  const button = wrapper
    ?.findAll('button')
    .find((candidate) => candidate.text().includes('提交构建'))
  return button
    ? { text: button.text(), disabled: button.attributes('disabled') !== undefined }
    : undefined
}

beforeEach(() => {
  vi.useFakeTimers()
  api = createApiMock()
  __setVsCodeApiForTest(api)
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  vi.useRealTimers()
})

async function mountApp(): Promise<void> {
  wrapper = mount(App)
  await vi.advanceTimersByTimeAsync(0)
}

describe('buildConsole App（分支编译弹框）', () => {
  it('挂载即发送 ready；init 后表单渲染且默认值就位、随后请求任务列表', async () => {
    await mountApp()
    expect(api.posted).toContainEqual({ type: 'ready' })

    hostMessage({ type: 'init', page: 'buildConsole', schema: SCHEMA, value: null })
    await vi.advanceTimersByTimeAsync(0)

    expect(wrapper?.text()).toContain('分支名')
    expect(wrapper?.text()).toContain('构建类型')
    // select 默认值来自字段表 defaultValue
    const select = wrapper?.find('select')
    expect((select?.element as unknown as { value: string }).value).toBe('full')
    expect(api.posted).toContainEqual({ type: 'buildListRequest' })
  })

  it('填写并提交：发送 submit 草稿（含默认构建类型），submitAck 后再次拉取列表', async () => {
    await mountApp()
    hostMessage({ type: 'init', page: 'buildConsole', schema: SCHEMA, value: null })
    await vi.advanceTimersByTimeAsync(0)

    const input = wrapper?.find('input')
    await input?.setValue('release/2.0.0')
    expect(submitButton()?.disabled).toBe(false)
    const submitButtonEl = wrapper
      ?.findAll('button')
      .find((candidate) => candidate.text().includes('提交构建'))
    await submitButtonEl?.trigger('click')
    await vi.advanceTimersByTimeAsync(0)

    const submit = api.posted.find(
      (message) => (message as { type?: string }).type === 'submit'
    ) as { draft: Record<string, unknown> } | undefined
    expect(submit?.draft).toMatchObject({ branch: 'release/2.0.0', buildType: 'full' })

    hostMessage({ type: 'submitAck', ok: true })
    await vi.advanceTimersByTimeAsync(0)
    const posts = api.posted.map((message) => (message as { type?: string }).type)
    expect(posts.filter((type) => type === 'buildListRequest').length).toBeGreaterThanOrEqual(2)
  })

  it('buildList 渲染任务列表：分支 / 类型 / 状态与进行中徽标；空列表走空态', async () => {
    await mountApp()
    hostMessage({ type: 'init', page: 'buildConsole', schema: SCHEMA, value: null })
    await vi.advanceTimersByTimeAsync(0)

    hostMessage({ type: 'buildList', tasks: [] })
    await vi.advanceTimersByTimeAsync(0)
    expect(wrapper?.text()).toContain('暂无构建任务')

    hostMessage({
      type: 'buildList',
      tasks: [
        makeTask(),
        makeTask({
          id: 'build-2',
          branch: 'hotfix/fail-case',
          buildType: 'incremental',
          status: 'failed',
          progress: 100,
          message: '模拟失败：分支名包含 fail（打桩规则）',
        }),
      ],
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(wrapper?.text()).toContain('release/1.0.0')
    expect(wrapper?.text()).toContain('hotfix/fail-case')
    expect(wrapper?.text()).toContain('构建中')
    // 进度经进度条呈现（aria-valuenow），不再以文本展示
    const bar = wrapper?.find('[role="progressbar"]')
    expect(bar?.exists()).toBe(true)
    expect(bar?.attributes('aria-valuenow')).toBe('42')
    expect(wrapper?.text()).toContain('失败')
    expect(wrapper?.text()).toContain('1 个进行中')
  })

  it('宿主 error：反馈展示并定位到分支字段（提交态解锁）', async () => {
    await mountApp()
    hostMessage({ type: 'init', page: 'buildConsole', schema: SCHEMA, value: null })
    await vi.advanceTimersByTimeAsync(0)

    // 先填必填字段：本地校验通过后提交才会发往宿主（P2-F2 起主按钮走 SchemaForm 校验）
    const input = wrapper?.find('input')
    await input?.setValue('release/2.0.0')
    const submitButtonEl = wrapper
      ?.findAll('button')
      .find((candidate) => candidate.text().includes('提交构建'))
    await submitButtonEl?.trigger('click')
    await vi.advanceTimersByTimeAsync(0)
    expect(submitButton()?.disabled).toBe(true) // 提交中

    hostMessage({ type: 'error', message: '分支名不能为空。', field: 'branch' })
    await vi.advanceTimersByTimeAsync(0)
    expect(wrapper?.text()).toContain('分支名不能为空。')
    expect(wrapper?.find('[role="alert"]').exists()).toBe(true)
    expect(submitButton()?.disabled).toBe(false) // 已解锁
  })

  it('P2-F2：主按钮本地校验——必填字段为空时拦截提交并提示，不发 submit', async () => {
    await mountApp()
    hostMessage({ type: 'init', page: 'buildConsole', schema: SCHEMA, value: null })
    await vi.advanceTimersByTimeAsync(0)

    const submitButtonEl = wrapper
      ?.findAll('button')
      .find((candidate) => candidate.text().includes('提交构建'))
    await submitButtonEl?.trigger('click')
    await vi.advanceTimersByTimeAsync(0)

    // 未发 submit（不依赖宿主兜底报错）
    expect(
      api.posted.filter((message) => (message as { type?: string }).type === 'submit')
    ).toHaveLength(0)
    // SchemaForm 本地 required 错误可见（分支为 BUILD_FIELD_DEFS 的必填字段）
    expect(wrapper?.text()).toContain('请填写')
    expect(submitButton()?.disabled).toBe(false) // 未进入提交态
  })

  it('轮询：init 后每 3s 发一次 buildListRequest，卸载后停止', async () => {
    await mountApp()
    hostMessage({ type: 'init', page: 'buildConsole', schema: SCHEMA, value: null })
    await vi.advanceTimersByTimeAsync(0)
    const countAfterInit = api.posted.filter(
      (message) => (message as { type?: string }).type === 'buildListRequest'
    ).length

    await vi.advanceTimersByTimeAsync(3000)
    await vi.advanceTimersByTimeAsync(3000)
    const countAfterPolls = api.posted.filter(
      (message) => (message as { type?: string }).type === 'buildListRequest'
    ).length
    expect(countAfterPolls - countAfterInit).toBe(2)

    wrapper?.unmount()
    wrapper = undefined
    await vi.advanceTimersByTimeAsync(9000)
    expect(
      api.posted.filter((message) => (message as { type?: string }).type === 'buildListRequest')
    ).toHaveLength(countAfterPolls)
  })

  it('非协议消息被忽略（守卫收窄）', async () => {
    await mountApp()
    browserWindow.dispatchEvent(
      new (
        globalThis as unknown as { MessageEvent: new (t: string, i: { data: unknown }) => unknown }
      ).MessageEvent('message', { data: { type: 'buildList', tasks: 'bad' } })
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(wrapper?.text()).not.toContain('undefined')
  })
})
