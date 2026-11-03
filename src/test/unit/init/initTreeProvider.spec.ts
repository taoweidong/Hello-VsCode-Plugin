import { describe, expect, it, vi } from 'vitest'
import * as vscode from 'vscode'
import { __resetStubs } from '../stubs/vscode'
import { InitTreeProvider } from '../../../extension/features/init/initTreeProvider'
import type { StepState } from '../../../extension/features/init/initService'

/**
 * 环境初始化树视图（此前零覆盖）：状态图标 / 描述组合 / 单击执行命令绑定 /
 * refresh 触发事件 / 空列表。
 */

const states: StepState[] = [
  { id: 'workspace', title: '检查工作区', description: '', status: 'idle' },
  {
    id: 'envSnapshot',
    title: '写入环境快照',
    description: '',
    status: 'done',
    message: '快照已写入（3/3 项就绪）。',
    durationMs: 456,
  },
]

describe('InitTreeProvider', () => {
  it('getChildren：透传 getStates()；空列表返回空', async () => {
    __resetStubs()
    const getStates = vi.fn<() => StepState[]>().mockReturnValue(states)
    const p = new InitTreeProvider(getStates)
    expect(await p.getChildren()).toEqual(states)
    const empty = new InitTreeProvider(() => [])
    expect(await empty.getChildren()).toEqual([])
  })

  it('getTreeItem：状态图标与描述、单击执行命令携带步骤 id', () => {
    __resetStubs()
    const p = new InitTreeProvider(() => states)
    const idle = p.getTreeItem(states[0])
    expect(idle.label).toBe('检查工作区')
    expect((idle.iconPath as vscode.ThemeIcon).id).toBe('circle-large-outline')
    expect(idle.contextValue).toBe('initStep')
    expect(idle.command?.command).toBe('extStarter.runInitStep')
    expect(idle.command?.arguments).toEqual(['workspace'])

    const done = p.getTreeItem(states[1])
    expect((done.iconPath as vscode.ThemeIcon).id).toBe('check')
    expect(done.description).toContain('完成')
    expect(done.description).toContain('快照已写入')
  })

  it('refresh 触发 onDidChangeTreeData 事件', () => {
    __resetStubs()
    const p = new InitTreeProvider(() => states)
    const fired: unknown[] = []
    p.onDidChangeTreeData((event) => fired.push(event))
    p.refresh()
    expect(fired).toHaveLength(1)
  })
})
