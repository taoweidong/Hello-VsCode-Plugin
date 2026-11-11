import { describe, expect, it, vi } from 'vitest'
import * as vscode from 'vscode'
import { registerTreeView } from '../../../extension/services/treeViewRegistration'
import { __resetStubs, __stubs, createExtensionContextStub } from '../stubs/vscode'

/**
 * 树视图注册助手（v5.0.1）：单视图注册失败降级——记录输出通道 + 可操作告警，
 * 其余视图与功能继续装配（旧包 vscode-starter-template 并存时的典型容错路径）。
 */

function makeProvider(): vscode.TreeDataProvider<unknown> {
  return { getTreeItem: () => new vscode.TreeItem('x'), getChildren: () => [] }
}

function makeOutputChannel(): vscode.OutputChannel {
  return { appendLine: vi.fn() } as unknown as vscode.OutputChannel
}

describe('registerTreeView', () => {
  it('成功：返回视图并加入 subscriptions', () => {
    __resetStubs()
    const fakeView = { visible: true, dispose: vi.fn() } as unknown as vscode.TreeView<unknown>
    const spy = vi.spyOn(vscode.window, 'createTreeView').mockReturnValue(fakeView as never)
    try {
      const context = createExtensionContextStub() as unknown as vscode.ExtensionContext
      const view = registerTreeView(
        context,
        makeOutputChannel(),
        'extStarter.demoView',
        makeProvider()
      )
      expect(view).toBe(fakeView)
      expect(context.subscriptions).toContain(fakeView)
    } finally {
      spy.mockRestore()
    }
  })

  it('注册失败（视图 ID 冲突）：返回 undefined、告警 + 输出通道留痕、不抛错', () => {
    __resetStubs()
    const spy = vi.spyOn(vscode.window, 'createTreeView').mockImplementation(() => {
      throw new Error('No view is registered with id: extStarter.demoView')
    })
    const output = makeOutputChannel()
    try {
      const context = createExtensionContextStub() as unknown as vscode.ExtensionContext
      let view: unknown
      expect(() => {
        view = registerTreeView(context, output, 'extStarter.demoView', makeProvider())
      }).not.toThrow()
      expect(view).toBeUndefined()
      expect(output.appendLine).toHaveBeenCalledWith(
        expect.stringContaining('extStarter.demoView 注册失败')
      )
      const warning = __stubs.recorded.find((entry) => entry.kind === 'showWarningMessage')
      expect(warning).toBeDefined()
      expect(warning?.args[0]).toMatchObject({
        message: expect.stringContaining('卸载后重载窗口'),
      })
    } finally {
      spy.mockRestore()
    }
  })
})
