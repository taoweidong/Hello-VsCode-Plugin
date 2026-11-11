import { describe, expect, it, vi } from 'vitest'
import * as vscode from 'vscode'
import { registerCommands, type CommandDeps } from '../../extension/commands'
import { notifySuccess } from '../../extension/commands/shared'
import { COMMAND } from '../../extension/constants'
import {
  __resetStubs,
  __stubs,
  commands as vscodeCommands,
  createExtensionContextStub,
} from './stubs/vscode'

/**
 * 命令层单测（09 方案阶段 2 后）：
 * - 锁定 registerCommands 的注册完整性（与 COMMAND 常量一一对应，
 *   门禁第 ⑥ 步静态校验的单测镜像）；
 * - notifySuccess（特性开关退场后一律提示，S 列表）。
 */

describe('notifySuccess（特性开关退场后：一律提示）', () => {
  it('直接弹「已…」信息条', () => {
    __resetStubs()
    notifySuccess('已删除「A」。')
    expect(
      __stubs.recorded.some(
        (entry) =>
          entry.kind === 'showInformationMessage' &&
          (entry.args[0] as { message: string }).message === '已删除「A」。'
      )
    ).toBe(true)
  })
})

describe('registerCommands（注册完整性）', () => {
  it('注册键与 COMMAND 常量一一对应（16 个：12 保留 + 4 草稿箱）', () => {
    __resetStubs()
    const context = createExtensionContextStub()
    registerCommands(context as unknown as vscode.ExtensionContext, {} as CommandDeps)
    const registered = [...__stubs.registeredCommands.keys()]
    expect(registered.slice().sort()).toEqual(Object.values(COMMAND).slice().sort())
    expect(registered).toHaveLength(Object.keys(COMMAND).length)
  })
})

describe('registerCommands 容错（v5.0.1：命令 ID 冲突降级）', () => {
  it('单条命令注册失败：不抛错、输出通道留痕、告警一次、其余命令继续注册', () => {
    __resetStubs()
    const context = createExtensionContextStub()
    const output = { appendLine: vi.fn() } as unknown as vscode.OutputChannel
    const original = vscodeCommands.registerCommand
    let failed = false
    const spy = vi.spyOn(vscodeCommands, 'registerCommand').mockImplementation(((
      command: string,
      callback: (...args: unknown[]) => unknown
    ) => {
      if (!failed && command === COMMAND.openGallery) {
        failed = true
        throw new Error(`command '${command}' already exists.`)
      }
      return original(command, callback)
    }) as typeof vscodeCommands.registerCommand)
    try {
      expect(() =>
        registerCommands(
          context as unknown as vscode.ExtensionContext,
          {
            outputChannel: output,
          } as unknown as CommandDeps
        )
      ).not.toThrow()
      expect(output.appendLine).toHaveBeenCalledWith(
        expect.stringContaining(`${COMMAND.openGallery} 注册失败`)
      )
      const warnings = __stubs.recorded.filter((entry) => entry.kind === 'showWarningMessage')
      expect(warnings).toHaveLength(1)
      expect(warnings[0]?.args[0]).toMatchObject({
        message: expect.stringContaining('卸载旧扩展后重载窗口'),
      })
      // 其余命令全部注册（冲突的 1 条除外）
      expect(__stubs.registeredCommands.size).toBe(Object.keys(COMMAND).length - 1)
    } finally {
      spy.mockRestore()
    }
  })
})

describe('runInitStep（inline 树节点入参归一化，评审修复）', () => {
  it('view/item/context 传入 StepState 对象时按 { id } 执行该步骤，不再回落 QuickPick', async () => {
    __resetStubs()
    const runStep = vi.fn(async () => undefined)
    const context = createExtensionContextStub()
    registerCommands(
      context as unknown as vscode.ExtensionContext,
      {
        initService: { runStep, getStates: () => [] },
      } as unknown as CommandDeps
    )
    const handler = __stubs.registeredCommands.get('extStarter.runInitStep')
    expect(handler).toBeDefined()

    await handler?.({ id: 'artifactDir', title: '创建构建产物目录', status: 'idle' })
    expect(runStep).toHaveBeenCalledWith('artifactDir')

    // 字符串入参（树节点单击）保持原行为
    await handler?.('workspace')
    expect(runStep).toHaveBeenCalledWith('workspace')
  })
})
