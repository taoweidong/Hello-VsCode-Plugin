import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import type * as vscode from 'vscode'
import { createExtensionContextStub, __resetStubs, __stubs, Uri } from '../stubs/vscode'
import {
  WebviewController,
  webviewViewType,
  type WebviewControllerDeps,
  type WebviewLike,
  type WebviewPanelLike,
} from '../../../webview/host/webviewController'

/**
 * WebviewController（05 T2.4）：
 * 守卫过滤 / submit 在途幂等与超时 / 幂等 dispose / 单例 reveal。
 */

interface FakePanel {
  viewType: string
  title: string
  revealCalls: number
  disposeCalls: number
  posted: unknown[]
  webview: {
    html: string
    cspSource: string
    postMessage(message: unknown): Promise<boolean>
    asWebviewUri(uri: unknown): unknown
    onDidReceiveMessage(listener: (message: unknown) => unknown): { dispose(): void }
    __emit(message: unknown): void
  }
  onDidDispose(listener: () => void): { dispose(): void }
  reveal(): void
  dispose(): void
  __close(): void
}

function createFakePanel(viewType: string, title: string): FakePanel {
  const disposeListeners = new Set<() => void>()
  const messageListeners = new Set<(message: unknown) => unknown>()
  const panel: FakePanel = {
    viewType,
    title,
    revealCalls: 0,
    disposeCalls: 0,
    posted: [],
    webview: {
      html: '',
      cspSource: 'vscode-webview-view:',
      postMessage(message: unknown): Promise<boolean> {
        panel.posted.push(message)
        return Promise.resolve(true)
      },
      asWebviewUri(uri: unknown): unknown {
        return uri
      },
      onDidReceiveMessage(listener: (message: unknown) => unknown): { dispose(): void } {
        messageListeners.add(listener)
        return {
          dispose(): void {
            messageListeners.delete(listener)
          },
        }
      },
      __emit(message: unknown): void {
        for (const listener of [...messageListeners]) {
          listener(message)
        }
      },
    },
    onDidDispose(listener: () => void): { dispose(): void } {
      disposeListeners.add(listener)
      return {
        dispose(): void {
          disposeListeners.delete(listener)
        },
      }
    },
    reveal(): void {
      panel.revealCalls += 1
    },
    dispose(): void {
      panel.disposeCalls += 1
      for (const listener of [...disposeListeners]) {
        listener()
      }
    },
    __close(): void {
      for (const listener of [...disposeListeners]) {
        listener()
      }
    },
  }
  return panel
}

function makeDeps() {
  const panels: FakePanel[] = []
  const logs: string[] = []
  const deps = {
    createPanel(viewType: string, title: string): WebviewPanelLike {
      const panel = createFakePanel(viewType, title)
      panels.push(panel)
      return panel as unknown as WebviewPanelLike
    },
    async resolveAssets(
      _webview: WebviewLike
    ): Promise<{ scriptUri: vscode.Uri; styleUris: vscode.Uri[] }> {
      return {
        scriptUri: stubUri('/assets/gallery-1.js'),
        styleUris: [stubUri('/assets/tokens-2.css')],
      }
    },
    log(message: string): void {
      logs.push(message)
    },
  }
  return { deps, panels, logs }
}

/** 运行时 'vscode' 经 vitest alias 指向测试桩；类型层用 unknown 断言桥接桩与 @types/vscode。 */
const context = createExtensionContextStub() as unknown as vscode.ExtensionContext
const stubUri = (path: string) => Uri.file(path) as unknown as vscode.Uri

beforeEach(() => {
  __resetStubs()
  WebviewController.__resetForTest()
})

afterEach(() => {
  WebviewController.__resetForTest()
})

describe('createOrShow / 单例', () => {
  it('创建面板并写入 HTML 外壳（data-page / 脚本 / 样式 / CSP）', async () => {
    const { deps, panels } = makeDeps()
    const controller = WebviewController.createOrShow('gallery', context, deps)
    await controller.ready
    expect(panels).toHaveLength(1)
    expect(panels[0].viewType).toBe(webviewViewType('gallery'))
    expect(panels[0].title).toBe('组件画廊（开发）')
    const html = panels[0].webview.html
    expect(html).toContain('data-page="gallery"')
    expect(html).toContain('gallery-1.js')
    expect(html).toContain('tokens-2.css')
    expect(html).toContain('script-src')
  })

  it('已存在则 reveal，不重复创建', async () => {
    const { deps, panels } = makeDeps()
    const first = WebviewController.createOrShow('gallery', context, deps)
    await first.ready
    const second = WebviewController.createOrShow('gallery', context, deps)
    expect(second).toBe(first)
    expect(panels).toHaveLength(1)
    expect(panels[0].revealCalls).toBe(1)
  })

  it('未注册的 pageId 抛清晰错误', () => {
    expect(() => new WebviewController('nope', context, {})).toThrow(/未注册的 Webview 页面 id/)
  })

  it('资源解析失败时写入诊断 HTML 并记日志（不抛出）', async () => {
    const { deps, panels, logs } = makeDeps()
    deps.resolveAssets = async (): Promise<{ scriptUri: vscode.Uri; styleUris: vscode.Uri[] }> => {
      throw new Error('manifest 缺失')
    }
    const controller = WebviewController.createOrShow('gallery', context, deps)
    await controller.ready
    expect(panels[0].webview.html).toContain('页面资源加载失败')
    expect(logs.some((line) => line.includes('manifest 缺失'))).toBe(true)
  })
})

describe('消息分发（protocol 守卫）', () => {
  it('伪造消息（null / 空对象 / 未知 type）不抛错、不产生回复', async () => {
    const { deps, panels, logs } = makeDeps()
    const controller = WebviewController.createOrShow('gallery', context, deps)
    await controller.ready
    panels[0].posted.length = 0
    for (const junk of [null, undefined, {}, { type: 'hack' }, 42]) {
      panels[0].webview.__emit(junk)
    }
    expect(panels[0].posted).toHaveLength(0)
    expect(logs.some((line) => line.includes('忽略无法识别'))).toBe(true)
    controller.dispose()
  })

  it('ready → 回 init（page / 空 schema / null value）', async () => {
    const { deps, panels } = makeDeps()
    const controller = WebviewController.createOrShow('gallery', context, deps)
    await controller.ready
    panels[0].posted.length = 0
    panels[0].webview.__emit({ type: 'ready' })
    expect(panels[0].posted).toEqual([{ type: 'init', page: 'gallery', schema: [], value: null }])
  })

  it('恢复面板时持久化状态随 init.extra.persisted 传回（草稿恢复入口）', async () => {
    const { deps } = makeDeps()
    const controller = new WebviewController('gallery', context, deps)
    const panel = createFakePanel(webviewViewType('gallery'), '组件画廊（开发）')
    await controller.attachPanel(panel as unknown as WebviewPanelLike, { draft: { name: '任务A' } })
    panel.webview.__emit({ type: 'ready' })
    expect(panel.posted).toEqual([
      {
        type: 'init',
        page: 'gallery',
        schema: [],
        value: null,
        extra: { persisted: { draft: { name: '任务A' } } },
      },
    ])
  })
})

describe('registerSerializer（窗口重载恢复）', () => {
  it('为每个页面注册 serializer；反序列化重建控制器并随 init 传回持久化状态', async () => {
    const { deps } = makeDeps()
    const serializerContext = createExtensionContextStub() as unknown as vscode.ExtensionContext
    // 工厂形态 deps：覆盖「按 pageId 分发」分支
    WebviewController.registerSerializer(serializerContext, () => deps)
    expect(__stubs.registeredSerializers.size).toBe(3)

    // 模拟窗口重载恢复 taskManager 面板（带持久化状态）
    const panel = createFakePanel(webviewViewType('taskManager'), '任务管理')
    const serializer = __stubs.registeredSerializers.get(webviewViewType('taskManager'))
    await serializer!.deserializeWebviewPanel(panel as never, { draft: { name: '任务A' } })
    // 页面加载完成后上报 ready，宿主回 init（携带持久化状态）
    panel.webview.__emit({ type: 'ready' })
    await WebviewController.get('taskManager')!.ready
    expect(panel.posted[0]).toMatchObject({
      type: 'init',
      page: 'taskManager',
      extra: { persisted: { draft: { name: '任务A' } } },
    })
    // 恢复后的控制器进注册表：后续消息按单例路由
    expect(WebviewController.get('taskManager')).toBeDefined()
    WebviewController.get('taskManager')!.dispose()
  })
})

describe('createOrShow open 失败兜底', () => {
  it('面板工厂抛错：如实弹错提示、记日志并清理注册表（不再静默）', async () => {
    const { deps, logs } = makeDeps()
    const failing = {
      ...deps,
      createPanel: () => {
        throw new Error('面板创建失败')
      },
    } as unknown as WebviewControllerDeps
    const controller = WebviewController.createOrShow('gallery', context, failing)
    await vi.waitFor(() => {
      expect(
        __stubs.recorded.some(
          (entry) =>
            entry.kind === 'showErrorMessage' &&
            String((entry.args[0] as { message?: string } | undefined)?.message).includes(
              '打开失败'
            )
        )
      ).toBe(true)
    })
    expect(WebviewController.get('gallery')).toBeUndefined()
    expect(logs.some((line) => line.includes('打开失败'))).toBe(true)
    controller.dispose() // 清理路径已走完，dispose 幂等兜底
  })
})

describe('R-U-9 协议健壮性（init 同步抛错）', () => {
  it('同步 buildInit 抛错：下发 error 而非炸掉 onDidReceiveMessage 监听器', async () => {
    const { deps, panels, logs } = makeDeps()
    const controller = WebviewController.createOrShow('gallery', context, {
      ...deps,
      buildInit: () => {
        throw new Error('schema 读取失败')
      },
    })
    await controller.ready
    panels[0].posted.length = 0
    expect(() => panels[0].webview.__emit({ type: 'ready' })).not.toThrow()
    await vi.waitFor(() => {
      expect(panels[0].posted).toEqual([
        { type: 'error', message: '页面初始化失败：schema 读取失败' },
      ])
    })
    expect(logs.some((line) => line.includes('init 载荷构造失败'))).toBe(true)
    // 监听器仍然存活：后续消息照常处理（同步抛错不再是「炸掉整个面板消息通道」）
    panels[0].webview.__emit({ type: 'hack' })
    expect(logs.filter((line) => line.includes('忽略无法识别')).length).toBeGreaterThan(0)
    controller.dispose()
  })
})

describe('submit 幂等与超时', () => {
  it('成功回 submitAck；失败回 error', async () => {
    const { deps, panels } = makeDeps()
    const onSubmit = vi.fn(async (draft: Record<string, unknown>) => {
      if (draft['boom'] === 1) {
        throw new Error('名称不能为空')
      }
    })
    const controller = WebviewController.createOrShow('gallery', context, { ...deps, onSubmit })
    await controller.ready

    panels[0].webview.__emit({ type: 'submit', draft: { name: '任务A' } })
    await vi.waitFor(() => {
      expect(panels[0].posted).toEqual([{ type: 'submitAck', ok: true }])
    })

    panels[0].posted.length = 0
    panels[0].webview.__emit({ type: 'submit', draft: { boom: 1 } })
    await vi.waitFor(() => {
      expect(panels[0].posted).toEqual([{ type: 'error', message: '名称不能为空' }])
    })
  })

  it('在途时忽略重复提交（onSubmit 只被调用一次）', async () => {
    vi.useFakeTimers()
    try {
      const { deps, panels } = makeDeps()
      const onSubmit = vi.fn(() => new Promise<void>(() => undefined))
      const controller = WebviewController.createOrShow('gallery', context, { ...deps, onSubmit })
      await controller.ready

      panels[0].webview.__emit({ type: 'submit', draft: {} })
      await vi.advanceTimersByTimeAsync(100)
      panels[0].webview.__emit({ type: 'submit', draft: {} })
      await vi.advanceTimersByTimeAsync(100)
      expect(onSubmit).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('R-C-10 提交超时：不抢发 error、不永久锁死；任务随后成功时如实下发 submitAck', async () => {
    vi.useFakeTimers()
    try {
      const { deps, panels } = makeDeps()
      let settle: (() => void) | undefined
      const onSubmit = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            settle = resolve
          })
      )
      const controller = WebviewController.createOrShow('gallery', context, { ...deps, onSubmit })
      await controller.ready

      panels[0].webview.__emit({ type: 'submit', draft: {} })
      await vi.advanceTimersByTimeAsync(100)
      panels[0].posted.length = 0

      // 10s 超时：不抢发 error（避免「超时」与「已保存」并存误导用户）
      await vi.advanceTimersByTimeAsync(10_000)
      expect(panels[0].posted).toEqual([])

      // 但也不永久锁死提交：超时即解锁，用户可重试
      panels[0].webview.__emit({ type: 'submit', draft: {} })
      await vi.advanceTimersByTimeAsync(100)
      expect(onSubmit).toHaveBeenCalledTimes(2)

      // 迟到的成功如实下发 submitAck（面板据此关闭并提示成功，而非无响应）
      settle!()
      await vi.advanceTimersByTimeAsync(100)
      expect(panels[0].posted).toEqual([{ type: 'submitAck', ok: true }])
    } finally {
      vi.useRealTimers()
    }
  })

  it('未配置 onSubmit 时回明确 error', async () => {
    const { deps, panels } = makeDeps()
    const controller = WebviewController.createOrShow('gallery', context, deps)
    await controller.ready
    panels[0].webview.__emit({ type: 'submit', draft: {} })
    await vi.waitFor(() => {
      expect(panels[0].posted).toEqual([
        { type: 'error', message: expect.stringContaining('未配置提交处理') },
      ])
    })
  })
})

describe('dispose 幂等', () => {
  it('编程式 dispose 只关一次面板，重复调用无副作用', async () => {
    const { deps, panels } = makeDeps()
    const controller = WebviewController.createOrShow('gallery', context, deps)
    await controller.ready
    controller.dispose()
    controller.dispose()
    expect(panels[0].disposeCalls).toBe(1)
    expect(WebviewController.get('gallery')).toBeUndefined()
  })

  it('用户关闭面板：只清理资源，不反向调用 panel.dispose', async () => {
    const { deps, panels } = makeDeps()
    const controller = WebviewController.createOrShow('gallery', context, deps)
    await controller.ready
    panels[0].__close()
    expect(panels[0].disposeCalls).toBe(0)
    expect(WebviewController.get('gallery')).toBeUndefined()

    // 关闭后再次 createOrShow 创建新面板
    const again = WebviewController.createOrShow('gallery', context, deps)
    await again.ready
    expect(panels).toHaveLength(2)
    controller.dispose()
    again.dispose()
  })
})
