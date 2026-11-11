import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as vscode from 'vscode'
import {
  QuickCommandsService,
  type IQuickCommandsStore,
  type QuickCommandsData,
  type QuickCommandItem,
} from '../../../extension/features/quickCommands/quickCommandsService'
import { registerQuickCommandsCommands } from '../../../extension/commands/quickCommandsCommands'
import type { CommandRegistrar } from '../../../extension/commands/shared'
import { __resetStubs, __stubs } from '../stubs/vscode'

/**
 * 快捷命令命令壳（v3.5，16 方案 §6.2）：新增三步流程、选区捕获降级、
 * QuickPick 快速执行、编辑/分组管理；带参命令无参调用不抛错只提示。
 */

class FakeStore implements IQuickCommandsStore {
  data: QuickCommandsData = { groups: [], commands: [] }

  async load(): Promise<QuickCommandsData> {
    return JSON.parse(JSON.stringify(this.data)) as QuickCommandsData
  }

  async save(data: QuickCommandsData): Promise<void> {
    this.data = JSON.parse(JSON.stringify(data)) as QuickCommandsData
  }

  dataFileUri(): vscode.Uri {
    return vscode.Uri.file('/memory/quick-commands.json')
  }
}

/** 种子宽松形态：只填用例关心的字段，其余由辅助函数补默认值。 */
type GroupSeed = { id: string; name: string; createdAt?: string }
type ItemSeed = {
  id?: string
  name?: string
  command: string
  groupId?: string | null
  addedAt?: string
  useCount?: number
}

interface Host {
  service: QuickCommandsService
  registered: Map<string, (...args: unknown[]) => unknown>
  run: (id: string, ...args: unknown[]) => Promise<unknown>
}

function makeHost(data: { groups?: GroupSeed[]; commands?: ItemSeed[] } = {}): Host {
  const store = new FakeStore()
  store.data = {
    groups: (data.groups ?? []).map((group) => ({
      id: group.id,
      name: group.name,
      createdAt: group.createdAt ?? '2026-01-01T00:00:00.000Z',
    })),
    commands: (data.commands ?? []).map((item, index) => ({
      id: item.id ?? `seed-${index}`,
      name: item.name ?? item.command,
      command: item.command,
      groupId: item.groupId ?? null,
      addedAt: item.addedAt ?? '2026-01-01T00:00:00.000Z',
      ...(item.useCount !== undefined ? { useCount: item.useCount } : {}),
    })),
  }
  const service = new QuickCommandsService(store)
  const registered = new Map<string, (...args: unknown[]) => unknown>()
  const register: CommandRegistrar = (id, callback) => registered.set(id, callback)
  registerQuickCommandsCommands(register, { quickCommands: service })
  return {
    service,
    registered,
    run: (id, ...args) => Promise.resolve(registered.get(id)!(...args)),
  }
}

function recordedOf(kind: string): { kind: string; args: unknown[] }[] {
  return __stubs.recorded.filter((entry) => entry.kind === kind)
}

/** 立即注册 copySelection 行为（桥接用例）。 */
function stubCopySelection(behavior: () => void): void {
  __stubs.registeredCommands.set('workbench.action.terminal.copySelection', behavior)
}

const groupPick = (groupId: string | null) => ({ label: groupId ?? '未分组', groupId })
const createGroupPick = { label: '$(add) 新建分组…', create: true }

describe('快捷命令命令壳（v3.5）', () => {
  beforeEach(() => {
    __resetStubs()
  })

  describe('addQuickCommand（三步新增）', () => {
    it('全流程：命令 → 别名 → 选分组 → 入库并提示', async () => {
      const { service, run } = makeHost({ groups: [{ id: 'g1', name: 'git' }] })
      await service.load()
      __stubs.dialogQueue.push('git push origin main', 'push', groupPick('g1'))

      await run('extStarter.addQuickCommand')

      const items = service.listCommands()
      expect(items).toHaveLength(1)
      expect(items[0]).toMatchObject({
        name: 'push',
        command: 'git push origin main',
        groupId: 'g1',
      })
      expect(recordedOf('showInformationMessage').at(-1)!.args[0]).toMatchObject({
        message: expect.stringContaining('已收藏'),
      })
    })

    it('命令步骤取消 → 不入库且不再消费后续应答', async () => {
      const { service, run } = makeHost()
      await service.load()

      await run('extStarter.addQuickCommand') // 队列空 → InputBox 取消

      expect(service.listCommands()).toEqual([])
      expect(recordedOf('showInputBox')).toHaveLength(1)
      expect(recordedOf('showQuickPick')).toHaveLength(0) // 未进入分组步骤
    })

    it('组内「新建分组…」：输入新组名 → 建组并归组', async () => {
      const { service, run } = makeHost()
      await service.load()
      __stubs.dialogQueue.push('npm run build', 'build', createGroupPick, '构建')

      await run('extStarter.addQuickCommand')

      expect(service.listGroups().map((group) => group.name)).toEqual(['构建'])
      expect(service.listCommands()[0]!.groupId).toBe(service.listGroups()[0]!.id)
    })

    it('重复命令文本 → 提示已存在且不入库', async () => {
      const { service, run } = makeHost({
        commands: [{ id: 'c1', name: 'push', command: 'git push', groupId: null }],
      })
      await service.load()
      __stubs.dialogQueue.push('git push', 'push', groupPick(null))

      await run('extStarter.addQuickCommand')

      expect(service.listCommands()).toHaveLength(1)
      expect(recordedOf('showInformationMessage').at(-1)!.args[0]).toMatchObject({
        message: expect.stringContaining('已存在'),
      })
    })
  })

  describe('captureTerminalSelection（选区捕获）', () => {
    it('无活动终端 → 提示后降级粘贴输入框（Review Focus 3，评审修正）', async () => {
      const { service, run } = makeHost()
      await service.load()
      __stubs.activeTerminal = undefined
      // 首个应答被「无活动终端」toast 消费（桩的提示框同样读队列），随后进入降级流程
      __stubs.dialogQueue.push(undefined, 'ls -la', 'ls', groupPick(null))

      await run('extStarter.captureTerminalSelection')

      expect(recordedOf('showInformationMessage')[0]!.args[0]).toMatchObject({
        message: expect.stringContaining('终端'),
      })
      // 降级粘贴框 + 别名输入框共 2 次
      expect(recordedOf('showInputBox')).toHaveLength(2)
      expect(service.listCommands()[0]!.command).toBe('ls -la')
    })

    it('有终端 + 桥接成功 → 直接进入别名/分组流程入库', async () => {
      __stubs.workspaceFolders = [{ uri: vscode.Uri.file('/ws'), name: 'ws', index: 0 }]
      const { service, run } = makeHost({ groups: [{ id: 'g1', name: 'git' }] })
      await service.load()
      __stubs.activeTerminal = new (await import('../stubs/vscode')).Terminal('QuickCommand')
      stubCopySelection(() => {
        __stubs.clipboard = 'git push origin main'
      })
      __stubs.dialogQueue.push('push', groupPick('g1'))

      await run('extStarter.captureTerminalSelection')

      expect(service.listCommands()[0]).toMatchObject({
        command: 'git push origin main',
        groupId: 'g1',
      })
      expect(__stubs.clipboard).toBe('') // 备份（空）已恢复
    })

    it('有终端 + 桥接无选区 → 降级粘贴 InputBox（placeholder 提示）', async () => {
      const { service, run } = makeHost()
      await service.load()
      __stubs.activeTerminal = new (await import('../stubs/vscode')).Terminal('QuickCommand')
      stubCopySelection(() => {})
      __stubs.dialogQueue.push('ls -la', 'ls', groupPick(null))

      await run('extStarter.captureTerminalSelection')

      expect(recordedOf('showInputBox')[0]!.args[0]).toMatchObject({
        placeHolder: expect.stringContaining('粘贴'),
      })
      expect(service.listCommands()[0]!.command).toBe('ls -la')
    })
  })

  describe('quickRunCommands（QuickPick 快速执行）', () => {
    it('空列表 → 提示并返回', async () => {
      const { run } = makeHost()
      await run('extStarter.quickRunCommands')
      expect(recordedOf('showQuickPick')).toHaveLength(0)
      expect(recordedOf('showInformationMessage')).toHaveLength(1)
    })

    it('分组 Separator 分节；回车执行并回写 useCount', async () => {
      const { service, run } = makeHost({
        groups: [{ id: 'g1', name: 'git' }],
        commands: [{ id: 'c1', name: 'push', command: 'git push', groupId: 'g1' }],
      })
      await service.load()
      const item = service.get('c1')!
      __stubs.dialogQueue.push({ label: 'push', item })

      await run('extStarter.quickRunCommands')

      const pickRecord = recordedOf('showQuickPick')[0]!.args[0] as {
        items: { kind?: number; label?: string; item?: QuickCommandItem }[]
        options: { matchOnDescription?: boolean }
      }
      expect(pickRecord.items[0]).toMatchObject({ kind: -1, label: 'git' }) // Separator
      expect(pickRecord.options.matchOnDescription).toBe(true)
      expect(pickRecord.items.some((entry) => entry.item?.id === 'c1')).toBe(true)

      const sends = recordedOf('terminalSendText')
      expect(sends).toHaveLength(1)
      expect(sends[0]!.args[0]).toMatchObject({ text: 'git push', shouldExecute: true })
      expect(service.get('c1')!.useCount).toBe(1)
    })
  })

  describe('带参命令（守卫与主路径）', () => {
    const item: QuickCommandItem = {
      id: 'c1',
      name: 'push',
      command: 'git push',
      groupId: null,
      addedAt: '2026-01-01T00:00:00.000Z',
    }

    it('executeQuickCommand 无参 → 提示不抛错；带参 → 执行', async () => {
      const { service, run } = makeHost({ commands: [item] })
      await service.load()

      await run('extStarter.executeQuickCommand')
      expect(recordedOf('showInformationMessage')).toHaveLength(1)

      await run('extStarter.executeQuickCommand', service.get('c1'))
      expect(recordedOf('terminalSendText')).toHaveLength(1)
    })

    it('editQuickCommand：更新命令文本；与其他条目冲突 → 提示已存在', async () => {
      const { service, run } = makeHost({
        commands: [item, { ...item, id: 'c2', name: 'pwd', command: 'pwd' }],
      })
      await service.load()
      __stubs.dialogQueue.push('git pull --rebase')
      await run('extStarter.editQuickCommand', service.get('c1'))
      expect(service.get('c1')!.command).toBe('git pull --rebase')

      __stubs.dialogQueue.push('pwd')
      await run('extStarter.editQuickCommand', service.get('c1'))
      expect(recordedOf('showInformationMessage').at(-1)!.args[0]).toMatchObject({
        message: expect.stringContaining('已存在'),
      })
      expect(service.get('c1')!.command).toBe('git pull --rebase')
    })

    it('renameQuickCommand：更新别名；空名 → 提示', async () => {
      const { service, run } = makeHost({ commands: [item] })
      await service.load()
      __stubs.dialogQueue.push('推送')
      await run('extStarter.renameQuickCommand', service.get('c1'))
      expect(service.get('c1')!.name).toBe('推送')

      await run('extStarter.renameQuickCommand', service.get('c1')) // 队列空 → 取消
      expect(service.get('c1')!.name).toBe('推送')
    })

    it('moveQuickCommandToGroup：移动到选定分组', async () => {
      const { service, run } = makeHost({ groups: [{ id: 'g1', name: 'git' }], commands: [item] })
      await service.load()
      __stubs.dialogQueue.push(groupPick('g1'))
      await run('extStarter.moveQuickCommandToGroup', service.get('c1'))
      expect(service.get('c1')!.groupId).toBe('g1')
    })

    it('copyQuickCommand：命令文本进剪贴板', async () => {
      const { service, run } = makeHost({ commands: [item] })
      await service.load()
      await run('extStarter.copyQuickCommand', service.get('c1'))
      expect(__stubs.clipboard).toBe('git push')
    })

    it('removeQuickCommand：移除并提示', async () => {
      const { service, run } = makeHost({ commands: [item] })
      await service.load()
      await run('extStarter.removeQuickCommand', service.get('c1'))
      expect(service.listCommands()).toEqual([])
      expect(recordedOf('showInformationMessage').at(-1)!.args[0]).toMatchObject({
        message: expect.stringContaining('已删除'),
      })
    })

    it('createQuickCommandGroup：新建；重名 → 提示已存在', async () => {
      const { service, run } = makeHost({ groups: [{ id: 'g1', name: 'git' }] })
      await service.load()
      __stubs.dialogQueue.push('构建')
      await run('extStarter.createQuickCommandGroup')
      expect(service.listGroups().map((entry) => entry.name)).toEqual(['git', '构建'])

      __stubs.dialogQueue.push('git')
      await run('extStarter.createQuickCommandGroup')
      expect(service.listGroups()).toHaveLength(2)
      expect(recordedOf('showInformationMessage').at(-1)!.args[0]).toMatchObject({
        message: expect.stringContaining('已存在'),
      })
    })

    it('renameQuickCommandGroup：重命名', async () => {
      const { service, run } = makeHost({ groups: [{ id: 'g1', name: 'git' }] })
      await service.load()
      __stubs.dialogQueue.push('版本控制')
      await run('extStarter.renameQuickCommandGroup', service.getGroup('g1'))
      expect(service.listGroups()[0]!.name).toBe('版本控制')
    })

    it('removeQuickCommandGroup：模态确认后删除，组内命令回落未分组', async () => {
      const { service, run } = makeHost({
        groups: [{ id: 'g1', name: 'git' }],
        commands: [
          { id: 'c1', name: 'a', command: 'ls', groupId: 'g1' },
          { id: 'c2', name: 'b', command: 'pwd', groupId: 'g1' },
        ],
      })
      await service.load()
      __stubs.dialogQueue.push('删除')
      await run('extStarter.removeQuickCommandGroup', service.getGroup('g1'))

      expect(service.listGroups()).toEqual([])
      expect(service.get('c1')!.groupId).toBeNull()
      expect(service.get('c2')!.groupId).toBeNull()
      const warn = recordedOf('showWarningMessage')[0]!
      expect(warn.args[0]).toMatchObject({ message: expect.stringContaining('回落') })
    })

    it('removeQuickCommandGroup 取消 → 分组保留', async () => {
      const { service, run } = makeHost({
        groups: [{ id: 'g1', name: 'git' }],
        commands: [{ id: 'c1', name: 'a', command: 'ls', groupId: 'g1' }],
      })
      await service.load()
      await run('extStarter.removeQuickCommandGroup', service.getGroup('g1'))
      expect(service.listGroups()).toHaveLength(1)
    })

    it('全部带参命令无参调用 → 只提示不抛错', async () => {
      const { run } = makeHost()
      for (const id of [
        'extStarter.executeQuickCommand',
        'extStarter.editQuickCommand',
        'extStarter.renameQuickCommand',
        'extStarter.moveQuickCommandToGroup',
        'extStarter.copyQuickCommand',
        'extStarter.removeQuickCommand',
        'extStarter.renameQuickCommandGroup',
        'extStarter.removeQuickCommandGroup',
      ]) {
        await expect(run(id)).resolves.toBeUndefined()
      }
      expect(recordedOf('showInformationMessage').length).toBeGreaterThanOrEqual(8)
    })
  })
})

describe('命令序列（v5.1.0：剪贴板多行新增 / 逐条执行条目）', () => {
  const NL = String.fromCharCode(10)

  it('addQuickCommandSequence：剪贴板多行 → 单条目保存（保留换行）+ 别名 + 分组', async () => {
    const { service, run } = makeHost({ groups: [{ id: 'g1', name: '构建' }] })
    await service.load()
    __stubs.clipboard = ['npm ci', 'npm run build', 'npm test'].join(NL)
    __stubs.dialogQueue.push('build-all', groupPick('g1'))

    await run('extStarter.addQuickCommandSequence')

    const items = service.listCommands()
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      name: 'build-all',
      groupId: 'g1',
      command: ['npm ci', 'npm run build', 'npm test'].join(NL),
    })
    expect(recordedOf('showInformationMessage').at(-1)!.args[0]).toMatchObject({
      message: expect.stringContaining('命令序列'),
    })
  })

  it('addQuickCommandSequence：剪贴板为空 → 信息提示且不弹任何输入框', async () => {
    const { service, run } = makeHost()
    await service.load()
    __stubs.clipboard = '   '
    await run('extStarter.addQuickCommandSequence')
    expect(service.listCommands()).toEqual([])
    expect(recordedOf('showInputBox')).toHaveLength(0)
    expect(recordedOf('showInformationMessage').at(-1)!.args[0]).toMatchObject({
      message: expect.stringContaining('剪贴板为空'),
    })
  })

  it('addQuickCommandSequence：超过 50 条上限 → 告警且不入库', async () => {
    const { service, run } = makeHost()
    await service.load()
    __stubs.clipboard = Array.from({ length: 51 }, (_, index) => `cmd-${index}`).join(NL)
    await run('extStarter.addQuickCommandSequence')
    expect(service.listCommands()).toEqual([])
    expect(recordedOf('showWarningMessage').at(-1)!.args[0]).toMatchObject({
      message: expect.stringContaining('最多 50 条'),
    })
  })

  it('editQuickCommand：命令序列经剪贴板替换（弹确认 QuickPick）；空剪贴板不改动', async () => {
    const { service, run } = makeHost({
      commands: [{ id: 'c1', name: 'build', command: ['a', 'b'].join(NL) }],
    })
    await service.load()
    __stubs.dialogQueue.push('从剪贴板替换命令序列')
    __stubs.clipboard = ['a', 'c', 'd'].join(NL)
    await run('extStarter.editQuickCommand', service.get('c1')!)
    expect(service.get('c1')!.command).toBe(['a', 'c', 'd'].join(NL))

    __stubs.dialogQueue.push('从剪贴板替换命令序列')
    __stubs.clipboard = ''
    await run('extStarter.editQuickCommand', service.get('c1')!)
    expect(service.get('c1')!.command).toBe(['a', 'c', 'd'].join(NL))
    expect(recordedOf('showWarningMessage').at(-1)!.args[0]).toMatchObject({
      message: expect.stringContaining('剪贴板为空'),
    })
  })
})

describe('树节点包装解包（v4.0.1：inline / 右键按钮传入节点而非裸条目）', () => {
  const groupSeed = { id: 'g1', name: 'git', createdAt: '2026-01-01T00:00:00.000Z' }
  const nodeOf = (item: QuickCommandItem) => ({ kind: 'command' as const, item, group: null })

  it('executeQuickCommand / editQuickCommand 经节点包装生效', async () => {
    const { service, run } = makeHost({
      groups: [groupSeed],
      commands: [{ id: 'c1', name: 'push', command: 'git push', groupId: 'g1' }],
    })
    await service.load()
    await run('extStarter.executeQuickCommand', nodeOf(service.get('c1')!))
    expect(recordedOf('terminalSendText')).toHaveLength(1)

    __stubs.dialogQueue.push('git pull')
    await run('extStarter.editQuickCommand', nodeOf(service.get('c1')!))
    expect(service.get('c1')!.command).toBe('git pull')
  })

  it('renameQuickCommand / removeQuickCommand 经节点包装生效', async () => {
    const { service, run } = makeHost({ commands: [{ id: 'c1', name: 'x', command: 'ls' }] })
    await service.load()
    __stubs.dialogQueue.push('列目录')
    await run('extStarter.renameQuickCommand', nodeOf(service.get('c1')!))
    expect(service.get('c1')!.name).toBe('列目录')
    await run('extStarter.removeQuickCommand', nodeOf(service.get('c1')!))
    expect(service.get('c1')).toBeUndefined()
  })

  it('renameQuickCommandGroup / removeQuickCommandGroup 经分组节点包装生效', async () => {
    const { service, run } = makeHost({ groups: [groupSeed] })
    await service.load()
    __stubs.dialogQueue.push('版本控制')
    const groupNode = { kind: 'group' as const, group: service.getGroup('g1')!, children: [] }
    await run('extStarter.renameQuickCommandGroup', groupNode)
    expect(service.getGroup('g1')!.name).toBe('版本控制')

    __stubs.dialogQueue.push('删除')
    await run('extStarter.removeQuickCommandGroup', groupNode)
    expect(service.getGroup('g1')).toBeUndefined()
  })
})

describe('openQuickCommandsDataFile（17 方案阶段 4）', () => {
  it('确保数据文件存在后用编辑器打开（注册 + 行为）', async () => {
    const { service, registered, run } = makeHost()
    await service.load()
    expect(registered.has('extStarter.openQuickCommandsDataFile')).toBe(true)
    void vscode.commands.registerCommand('vscode.open', () => undefined)
    await run('extStarter.openQuickCommandsDataFile')
    const opens = recordedOf('executeCommand').filter(
      (entry) => (entry.args[0] as { command?: string }).command === 'vscode.open'
    )
    expect(opens).toHaveLength(1)
    const openedUri = (opens[0]!.args[0] as { args: unknown[] }).args[0] as vscode.Uri
    expect(openedUri.fsPath).toBe(vscode.Uri.file('/memory/quick-commands.json').fsPath)
  })
})

describe('openQuickCommandsDataFile 错误路径（v5.1.1）', () => {
  it('ensureDataFile 失败（非 FileNotFound）→ showError 且不打开', async () => {
    __resetStubs()
    const { service, run } = makeHost()
    await service.load()
    const statSpy = vi
      .spyOn(vscode.workspace.fs, 'stat')
      .mockRejectedValue(Object.assign(new Error('EACCES'), { code: 'EACCES' }))
    try {
      await run('extStarter.openQuickCommandsDataFile')
    } finally {
      statSpy.mockRestore()
    }
    expect(recordedOf('showErrorMessage').length).toBeGreaterThanOrEqual(1)
    expect(recordedOf('executeCommand')).toHaveLength(0)
  })
})
