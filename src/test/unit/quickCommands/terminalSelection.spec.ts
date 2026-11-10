import { beforeEach, describe, expect, it } from 'vitest'
import {
  readTerminalSelectionViaClipboard,
  TERMINAL_COPY_SELECTION_COMMAND,
} from '../../../extension/features/quickCommands/terminalSelection'
import { __resetStubs, __stubs } from '../stubs/vscode'

/**
 * 终端选区剪贴板桥接（v3.5，16 方案 §4.2）：备份剪贴板 → 内部命令 copySelection →
 * 读出 → finally 恢复；异常一律返回 undefined（不抛给用户），由壳层降级 InputBox。
 *
 * 驱动方式：__stubs.clipboard 假剪贴板 + 注册内部命令 handler 模拟「选区 → 剪贴板」。
 */

function registerCopySelection(behavior: () => void): void {
  __stubs.registeredCommands.set(TERMINAL_COPY_SELECTION_COMMAND, behavior)
}

describe('readTerminalSelectionViaClipboard（剪贴板桥接）', () => {
  beforeEach(() => {
    __resetStubs()
  })

  it('正常路径：备份 → copySelection → 读出 → 恢复原剪贴板', async () => {
    __stubs.clipboard = '原本复制过的内容'
    registerCopySelection(() => {
      __stubs.clipboard = 'git push origin main'
    })

    const text = await readTerminalSelectionViaClipboard()

    expect(text).toBe('git push origin main')
    expect(__stubs.clipboard).toBe('原本复制过的内容')
    expect(
      __stubs.recorded.some(
        (entry) =>
          entry.kind === 'executeCommand' &&
          (entry.args[0] as { command?: string })?.command === TERMINAL_COPY_SELECTION_COMMAND
      )
    ).toBe(true)
  })

  it('无选区（copySelection 未改剪贴板）→ undefined', async () => {
    __stubs.clipboard = ''
    registerCopySelection(() => {})

    expect(await readTerminalSelectionViaClipboard()).toBeUndefined()
  })

  it('读出内容与备份相同（无法区分复制成功与否）→ undefined（16 方案 §4.2）', async () => {
    __stubs.clipboard = 'git status'
    registerCopySelection(() => {
      __stubs.clipboard = 'git status'
    })

    expect(await readTerminalSelectionViaClipboard()).toBeUndefined()
  })

  it('空白选区 → undefined', async () => {
    __stubs.clipboard = ''
    registerCopySelection(() => {
      __stubs.clipboard = '   \n '
    })

    expect(await readTerminalSelectionViaClipboard()).toBeUndefined()
  })

  it('内部命令抛错 → 捕获返回 undefined，且剪贴板已恢复（Review Focus 3 前置）', async () => {
    __stubs.clipboard = '宝贵内容'
    registerCopySelection(() => {
      throw new Error('命令不存在')
    })

    expect(await readTerminalSelectionViaClipboard()).toBeUndefined()
    expect(__stubs.clipboard).toBe('宝贵内容')
  })

  it('恢复剪贴板环节抛错 → 不外溢，仍返回读到的命令文本', async () => {
    const vscodeStub = await import('../stubs/vscode')
    const originalWrite = vscodeStub.env.clipboard.writeText
    registerCopySelection(() => {
      __stubs.clipboard = 'git push'
    })
    vscodeStub.env.clipboard.writeText = async (): Promise<void> => {
      throw new Error('恢复失败')
    }
    try {
      expect(await readTerminalSelectionViaClipboard()).toBe('git push')
    } finally {
      vscodeStub.env.clipboard.writeText = originalWrite
    }
  })
})
