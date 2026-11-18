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

/**
 * 服务状态矩阵与错误分支（17 方案阶段 5 补测：命令壳分支 71% → 补齐）。
 * 用最小假服务驱动 service 各返回状态 / 抛错路径，专测命令壳的分发与提示逻辑。
 */
describe('快捷命令命令壳：服务状态矩阵与错误分支', () => {
  const err = new Error('EIO: store unavailable')
  let calls: Record<string, unknown[]> = {}

  function makeFakeHost(overrides: Record<string, (...args: unknown[]) => unknown> = {}): Host {
    calls = {}
    const record =
      (name: string) =>
      (...args: unknown[]) => {
        calls[name] = args
        return undefined
      }
    const item: QuickCommandItem = {
      id: 'c1',
      name: 'push',
      command: 'git push',
      groupId: null,
      addedAt: '2026-01-01T00:00:00.000Z',
    }
    const methods: Record<string, (...args: unknown[]) => unknown> = {
      load: async () => ({ groups: [], commands: [] }),
      listCommands: () => [] as QuickCommandItem[],
      listGroups: () => [] as never[],
      addCommand: async () => ({ status: 'added', item }),
      execute: () => undefined,
      updateCommandText: async () => 'updated',
      renameCommand: async () => true,
      moveCommandToGroup: async () => true,
      removeCommand: async () => true,
      createGroup: async () => ({
        status: 'created',
        group: { id: 'gn', name: '新组', createdAt: '2026-01-01T00:00:00.000Z' },
      }),
      renameGroup: async () => 'renamed',
      removeGroup: async () => true,
      ensureDataFile: () => undefined,
      dataFileUri: () => vscode.Uri.file('/memory/quick-commands.json'),
    }
    // 全部方法（含覆写）统一「先录制再委托」，calls 可断言
    const wrapped = Object.fromEntries(
      Object.entries({ ...methods, ...overrides }).map(([name, fn]) => [
        name,
        (...args: unknown[]) => {
          record(name)(...args)
          return fn(...args)
        },
      ])
    )
    const service = wrapped as unknown as QuickCommandsService
    const registered = new Map<string, (...args: unknown[]) => unknown>()
    const register: CommandRegistrar = (id, callback) => registered.set(id, callback)
    registerQuickCommandsCommands(register, { quickCommands: service })
    return {
      service,
      registered,
      run: (id, ...args) => Promise.resolve(registered.get(id)!(...args)),
    }
  }

  const recordedOf = (kind: string) => __stubs.recorded.filter((entry) => entry.kind === kind)
  const groupNode = {
    kind: 'group' as const,
    group: { id: 'g1', name: 'git', createdAt: '2026-01-01T00:00:00.000Z' },
    children: [],
  }
  const itemNode = {
    kind: 'command' as const,
    item: {
      id: 'c1',
      name: 'push',
      command: 'git push',
      groupId: null,
      addedAt: '2026-01-01T00:00:00.000Z',
    } satisfies QuickCommandItem,
    group: null,
  }

  beforeEach(() => {
    __resetStubs()
    void vscode.commands.registerCommand('vscode.open', () => undefined)
  })

  describe('addQuickCommand（别名 / 分组步骤取消与状态分支）', () => {
    it('命令文本全空白 → 告警且不进入别名步骤', async () => {
      const { run } = makeFakeHost()
      __stubs.dialogQueue.push('   ')
      await run('extStarter.addQuickCommand')
      expect(calls['addCommand']).toBeUndefined()
      expect(recordedOf('showWarningMessage').at(-1)?.args[0]).toMatchObject({
        message: expect.stringContaining('命令文本不能为空'),
      })
    })

    it('别名步骤取消 → 不进入分组选择', async () => {
      const { run } = makeFakeHost()
      __stubs.dialogQueue.push('git push', undefined)
      await run('extStarter.addQuickCommand')
      expect(recordedOf('showQuickPick')).toHaveLength(0)
      expect(calls['addCommand']).toBeUndefined()
    })

    it('addCommand 返回 cap → 告警上限且不入库', async () => {
      const { run } = makeFakeHost({ addCommand: async () => ({ status: 'cap' }) })
      __stubs.dialogQueue.push('git push', 'push', groupPick(null))
      await run('extStarter.addQuickCommand')
      expect(recordedOf('showWarningMessage').at(-1)?.args[0]).toMatchObject({
        message: expect.stringContaining('上限'),
      })
    })

    it('addCommand 抛错 → showError', async () => {
      const { run } = makeFakeHost({ addCommand: async () => Promise.reject(err) })
      __stubs.dialogQueue.push('git push', 'push', groupPick(null))
      await expect(run('extStarter.addQuickCommand')).resolves.toBeUndefined()
      expect(recordedOf('showErrorMessage').at(-1)?.args[0]).toMatchObject({
        message: expect.stringContaining('EIO'),
      })
    })
  })

  describe('pickGroup（新建分组的四个返回状态）', () => {
    it('duplicate → 提示已存在并直接使用既有分组', async () => {
      const { run } = makeFakeHost({
        createGroup: async () => ({
          status: 'duplicate',
          existing: { id: 'g1', name: 'git', createdAt: '2026-01-01T00:00:00.000Z' },
        }),
      })
      __stubs.dialogQueue.push('git push', 'push', createGroupPick, 'git')
      await run('extStarter.addQuickCommand')
      expect(
        recordedOf('showInformationMessage').some((entry) =>
          String((entry.args[0] as { message?: string }).message).includes('已存在')
        )
      ).toBe(true)
      expect(calls['addCommand']?.[0]).toMatchObject({ groupId: 'g1' })
    })

    it('invalid（空白名）→ 取消建组，不入库', async () => {
      const { run } = makeFakeHost()
      __stubs.dialogQueue.push('git push', 'push', createGroupPick, '   ')
      await run('extStarter.addQuickCommand')
      expect(calls['createGroup']).toBeUndefined()
      expect(calls['addCommand']).toBeUndefined()
    })

    it('cap → 告警分组上限且不入库', async () => {
      const { run } = makeFakeHost({ createGroup: async () => ({ status: 'cap' }) })
      __stubs.dialogQueue.push('git push', 'push', createGroupPick, '构建')
      await run('extStarter.addQuickCommand')
      expect(recordedOf('showWarningMessage').at(-1)?.args[0]).toMatchObject({
        message: expect.stringContaining('上限'),
      })
      expect(calls['addCommand']).toBeUndefined()
    })
  })

  describe('addQuickCommandSequence（剪贴板读取失败）', () => {
    it('clipboard.readText 抛错 → showError 且不弹输入框', async () => {
      const { run } = makeFakeHost()
      const readSpy = vi.spyOn(vscode.env.clipboard, 'readText').mockRejectedValue(err)
      try {
        await run('extStarter.addQuickCommandSequence')
      } finally {
        readSpy.mockRestore()
      }
      expect(recordedOf('showErrorMessage').at(-1)?.args[0]).toMatchObject({
        message: expect.stringContaining('EIO'),
      })
      expect(recordedOf('showInputBox')).toHaveLength(0)
    })
  })

  describe('quickRunCommands / executeQuickCommand（取消与执行失败）', () => {
    it('QuickPick 取消 → 不执行', async () => {
      const { run } = makeFakeHost({
        listCommands: () => [itemNode.item],
      })
      __stubs.dialogQueue.push(undefined)
      await run('extStarter.quickRunCommands')
      expect(calls['execute']).toBeUndefined()
    })

    it('quickRunCommands：execute 抛错 → showError', async () => {
      const { run } = makeFakeHost({
        listCommands: () => [itemNode.item],
        execute: async () => Promise.reject(err),
      })
      __stubs.dialogQueue.push({ label: 'push', item: itemNode.item })
      await run('extStarter.quickRunCommands')
      expect(recordedOf('showErrorMessage').at(-1)?.args[0]).toMatchObject({
        message: expect.stringContaining('EIO'),
      })
    })

    it('executeQuickCommand：execute 抛错 → showError', async () => {
      const { run } = makeFakeHost({ execute: async () => Promise.reject(err) })
      await run('extStarter.executeQuickCommand', itemNode.item)
      expect(recordedOf('showErrorMessage').at(-1)?.args[0]).toMatchObject({
        message: expect.stringContaining('EIO'),
      })
    })
  })

  describe('editQuickCommand（序列替换取消 / 剪贴板失败 / 结果状态）', () => {
    const NL = String.fromCharCode(10)
    const seqItem = {
      kind: 'command' as const,
      item: {
        id: 'c1',
        name: 'build',
        command: ['a', 'b'].join(NL),
        groupId: null,
        addedAt: '2026-01-01T00:00:00.000Z',
      } satisfies QuickCommandItem,
      group: null,
    }

    it('替换确认 QuickPick 选「取消」→ 不改动', async () => {
      const { run } = makeFakeHost()
      __stubs.dialogQueue.push('取消')
      await run('extStarter.editQuickCommand', seqItem)
      expect(calls['updateCommandText']).toBeUndefined()
    })

    it('序列替换：clipboard.readText 抛错 → showError', async () => {
      const { run } = makeFakeHost()
      __stubs.dialogQueue.push('从剪贴板替换命令序列')
      const readSpy = vi.spyOn(vscode.env.clipboard, 'readText').mockRejectedValue(err)
      try {
        await run('extStarter.editQuickCommand', seqItem)
      } finally {
        readSpy.mockRestore()
      }
      expect(recordedOf('showErrorMessage').at(-1)?.args[0]).toMatchObject({
        message: expect.stringContaining('EIO'),
      })
      expect(calls['updateCommandText']).toBeUndefined()
    })

    it('序列替换：超过 50 条上限 → 告警且不改动', async () => {
      const { run } = makeFakeHost()
      __stubs.dialogQueue.push('从剪贴板替换命令序列')
      __stubs.clipboard = Array.from({ length: 51 }, (_, index) => `cmd-${index}`).join(NL)
      await run('extStarter.editQuickCommand', seqItem)
      expect(recordedOf('showWarningMessage').at(-1)?.args[0]).toMatchObject({
        message: expect.stringContaining('最多 50 条'),
      })
      expect(calls['updateCommandText']).toBeUndefined()
    })

    it('单条编辑：updateCommandText 返回 empty / notfound 各给提示', async () => {
      const { run } = makeFakeHost({ updateCommandText: async () => 'empty' as const })
      __stubs.dialogQueue.push('   ')
      await run('extStarter.editQuickCommand', itemNode)
      expect(recordedOf('showWarningMessage').at(-1)?.args[0]).toMatchObject({
        message: expect.stringContaining('命令文本不能为空'),
      })

      const notfound = makeFakeHost({ updateCommandText: async () => 'notfound' as const })
      __stubs.dialogQueue.push('git pull')
      await notfound.run('extStarter.editQuickCommand', itemNode)
      expect(recordedOf('showInformationMessage').at(-1)?.args[0]).toMatchObject({
        message: expect.stringContaining('已不存在'),
      })
    })

    it('单条编辑：updateCommandText 抛错 → showError', async () => {
      const { run } = makeFakeHost({ updateCommandText: async () => Promise.reject(err) })
      __stubs.dialogQueue.push('git pull')
      await run('extStarter.editQuickCommand', itemNode)
      expect(recordedOf('showErrorMessage').at(-1)?.args[0]).toMatchObject({
        message: expect.stringContaining('EIO'),
      })
    })
  })

  describe('带参命令状态矩阵（false → 静默或提示 / 抛错 → showError）', () => {
    it('renameQuickCommand：renamed=false → 提示别名无效', async () => {
      const { run } = makeFakeHost({ renameCommand: async () => false })
      __stubs.dialogQueue.push('新名')
      await run('extStarter.renameQuickCommand', itemNode)
      expect(recordedOf('showInformationMessage').at(-1)?.args[0]).toMatchObject({
        message: expect.stringContaining('别名不能为空'),
      })
    })

    it('moveQuickCommandToGroup：分组不存在（moved=false）→ 提示；抛错 → showError', async () => {
      const { run } = makeFakeHost({ moveCommandToGroup: async () => false })
      __stubs.dialogQueue.push(groupPick('gone'))
      await run('extStarter.moveQuickCommandToGroup', itemNode)
      expect(recordedOf('showInformationMessage').at(-1)?.args[0]).toMatchObject({
        message: expect.stringContaining('分组不存在'),
      })

      const failing = makeFakeHost({ moveCommandToGroup: async () => Promise.reject(err) })
      __stubs.dialogQueue.push(groupPick('g1'))
      await failing.run('extStarter.moveQuickCommandToGroup', itemNode)
      expect(recordedOf('showErrorMessage').at(-1)?.args[0]).toMatchObject({
        message: expect.stringContaining('EIO'),
      })
    })

    it('copyQuickCommand：clipboard.writeText 抛错 → showError', async () => {
      const { run } = makeFakeHost()
      const writeSpy = vi
        .spyOn(vscode.env.clipboard, 'writeText')
        .mockRejectedValue(new Error('clipboard denied'))
      try {
        await run('extStarter.copyQuickCommand', itemNode)
      } finally {
        writeSpy.mockRestore()
      }
      expect(recordedOf('showErrorMessage').at(-1)?.args[0]).toMatchObject({
        message: expect.stringContaining('clipboard denied'),
      })
    })

    it('removeQuickCommand：removed=false → 静默；抛错 → showError', async () => {
      const { run } = makeFakeHost({ removeCommand: async () => false })
      await run('extStarter.removeQuickCommand', itemNode)
      expect(recordedOf('showInformationMessage')).toHaveLength(0)

      const failing = makeFakeHost({ removeCommand: async () => Promise.reject(err) })
      await failing.run('extStarter.removeQuickCommand', itemNode)
      expect(recordedOf('showErrorMessage').at(-1)?.args[0]).toMatchObject({
        message: expect.stringContaining('EIO'),
      })
    })
  })

  describe('分组管理命令（create / rename / remove 全状态）', () => {
    it('createQuickCommandGroup：空白名直接返回；invalid → 提示；cap → 告警；抛错 → showError', async () => {
      const { run } = makeFakeHost()
      __stubs.dialogQueue.push('   ')
      await run('extStarter.createQuickCommandGroup')
      expect(calls['createGroup']).toBeUndefined()

      const invalid = makeFakeHost({ createGroup: async () => ({ status: 'invalid' }) })
      __stubs.dialogQueue.push('构建')
      await invalid.run('extStarter.createQuickCommandGroup')
      expect(recordedOf('showInformationMessage').at(-1)?.args[0]).toMatchObject({
        message: expect.stringContaining('分组名不能为空'),
      })

      const cap = makeFakeHost({ createGroup: async () => ({ status: 'cap' }) })
      __stubs.dialogQueue.push('构建')
      await cap.run('extStarter.createQuickCommandGroup')
      expect(recordedOf('showWarningMessage').at(-1)?.args[0]).toMatchObject({
        message: expect.stringContaining('上限'),
      })

      const failing = makeFakeHost({ createGroup: async () => Promise.reject(err) })
      __stubs.dialogQueue.push('构建')
      await failing.run('extStarter.createQuickCommandGroup')
      expect(recordedOf('showErrorMessage').at(-1)?.args[0]).toMatchObject({
        message: expect.stringContaining('EIO'),
      })
    })

    it('renameQuickCommandGroup：取消 / duplicate / notfound / 抛错', async () => {
      const { run } = makeFakeHost()
      await run('extStarter.renameQuickCommandGroup', groupNode) // 队列空 → 取消
      expect(calls['renameGroup']).toBeUndefined()

      const duplicate = makeFakeHost({ renameGroup: async () => 'duplicate' as const })
      __stubs.dialogQueue.push('git')
      await duplicate.run('extStarter.renameQuickCommandGroup', groupNode)
      expect(recordedOf('showInformationMessage').at(-1)?.args[0]).toMatchObject({
        message: expect.stringContaining('同名'),
      })

      const notfound = makeFakeHost({ renameGroup: async () => 'notfound' as const })
      __stubs.dialogQueue.push('git')
      await notfound.run('extStarter.renameQuickCommandGroup', groupNode)
      expect(recordedOf('showInformationMessage').at(-1)?.args[0]).toMatchObject({
        message: expect.stringContaining('不存在'),
      })

      const failing = makeFakeHost({ renameGroup: async () => Promise.reject(err) })
      __stubs.dialogQueue.push('git')
      await failing.run('extStarter.renameQuickCommandGroup', groupNode)
      expect(recordedOf('showErrorMessage').at(-1)?.args[0]).toMatchObject({
        message: expect.stringContaining('EIO'),
      })
    })

    it('removeQuickCommandGroup：分组已不存在（removed=false）→ 静默；抛错 → showError', async () => {
      const { run } = makeFakeHost({ removeGroup: async () => false })
      __stubs.dialogQueue.push('删除')
      await run('extStarter.removeQuickCommandGroup', groupNode)
      expect(recordedOf('showInformationMessage')).toHaveLength(0)

      const failing = makeFakeHost({ removeGroup: async () => Promise.reject(err) })
      __stubs.dialogQueue.push('删除')
      await failing.run('extStarter.removeQuickCommandGroup', groupNode)
      expect(recordedOf('showErrorMessage').at(-1)?.args[0]).toMatchObject({
        message: expect.stringContaining('EIO'),
      })
    })
  })

  describe('openQuickCommandsDataFile（非 Error 抛错）', () => {
    it('抛出非 Error 值 → 「操作失败：」前缀呈现', async () => {
      const { run } = makeFakeHost({ ensureDataFile: async () => Promise.reject('字符串错误') })
      await run('extStarter.openQuickCommandsDataFile')
      expect(recordedOf('showErrorMessage').at(-1)?.args[0]).toMatchObject({
        message: expect.stringContaining('操作失败'),
      })
      expect(recordedOf('executeCommand')).toHaveLength(0)
    })
  })
})
