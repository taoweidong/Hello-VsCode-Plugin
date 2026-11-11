import { describe, expect, it } from 'vitest'
import { requireTreeItem, showError, statusIcon } from '../../../extension/commands/shared'
import { __resetStubs, __stubs } from '../stubs/vscode'

/**
 * commands/shared.ts（09 方案阶段 2 后）：条目相关符号已删，
 * 剩 statusIcon / notifySuccess（见 commands.spec.ts）/ showError。
 */

describe('statusIcon：初始化步骤状态图标', () => {
  it.each([
    ['done', '$(check)'],
    ['failed', '$(error)'],
    ['running', '$(sync)'],
    ['idle', '$(circle-outline)'],
  ])('%s → %s', (status, expected) => {
    expect(statusIcon(status as 'done' | 'failed' | 'running' | 'idle')).toBe(expected)
  })
})

describe('showError：错误文案分流', () => {
  it('Error → 展示 message（不再有条目领域校验错误类型）', () => {
    __resetStubs()
    showError(new Error('ENOENT'))
    const error = __stubs.recorded.find((entry) => entry.kind === 'showErrorMessage')
    expect((error?.args[0] as { message: string }).message).toBe('ENOENT')
  })

  it('非 Error 值 → 统一加「操作失败：」前缀', () => {
    __resetStubs()
    showError('磁盘已满')
    const error = __stubs.recorded.find((entry) => entry.kind === 'showErrorMessage')
    expect((error?.args[0] as { message: string }).message).toBe('操作失败：磁盘已满')
  })
})

describe('requireTreeItem：树节点入参归一（v4.0.1 修复 inline 按钮不生效）', () => {
  type Item = { id: string; command: string }
  const isItem = (value: unknown): value is Item =>
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Item).id === 'string' &&
    typeof (value as Item).command === 'string'
  type Group = { id: string; name: string }
  const isGroup = (value: unknown): value is Group =>
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Group).id === 'string' &&
    typeof (value as Group).name === 'string' &&
    typeof (value as { command?: unknown }).command !== 'string'

  it('裸条目直接通过', () => {
    const item = { id: 'c1', command: 'ls' }
    expect(requireTreeItem(item, isItem, 'hint')).toBe(item)
  })

  it('命令节点包装（{ kind, item }）解包后通过', () => {
    const item = { id: 'c1', command: 'ls' }
    const node = { kind: 'command', item, group: null }
    expect(requireTreeItem(node, isItem, 'hint')).toBe(item)
  })

  it('分组节点包装（{ kind, group }）解包后通过', () => {
    const group = { id: 'g1', name: 'git' }
    const node = { kind: 'group', group, children: [] }
    expect(requireTreeItem(node, isGroup, 'hint')).toBe(group)
  })

  it('无法识别的值 → undefined 且提示一次', () => {
    __resetStubs()
    expect(requireTreeItem({ kind: 'info', text: 'x' }, isItem, '请从视图操作。')).toBeUndefined()
    const info = __stubs.recorded.filter((entry) => entry.kind === 'showInformationMessage')
    expect(info).toHaveLength(1)
    expect(info[0]?.args[0]).toMatchObject({ message: '请从视图操作。' })
  })
})
