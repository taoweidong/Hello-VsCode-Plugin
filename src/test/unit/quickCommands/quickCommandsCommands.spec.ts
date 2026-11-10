import { beforeEach, describe, expect, it } from 'vitest'
import * as vscode from 'vscode'
import {
  QuickCommandsService,
  type IQuickCommandsStore,
  type QuickCommandGroup,
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
}

interface Host {
  service: QuickCommandsService
  registered: Map<string, (...args: unknown[]) => unknown>
  run: (id: string, ...args: unknown[]) => Promise<unknown>
}

function makeHost(data: Partial<QuickCommandsData> = {}): Host {
  const store = new FakeStore()
  store.data = {
    groups: (data.groups ?? []).map((group) => ({ createdAt: '2026-01-01T00:00:00.000Z', ...group })),
    commands: (data.commands ?? []).map((item) => ({ addedAt: '2026-01-01T00:00:00.000Z', ...item })),
  }
  const service = new QuickCommandsService(store)
  const registered = new Map<string, (...args: unknown[]) => unknown>()
  const register: CommandRegistrar = (id, callback) => registered.set(id, callback)
  registerQuickCommandsCommands(register, { quickCommands: service })
  return { service, registered, run: (id, ...args) => registered.get(id)!(...args) }
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
      expect(items[0]).toMatchObject({ name: 'push', command: 'git push origin main', groupId: 'g1' })
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
    it('无活动终端 → 提示且不弹输入框（Review Focus 3）', async () => {
      const { service, run } = makeHost()
      await service.load()
      __stubs.activeTerminal = undefined

      await run('extStarter.captureTerminalSelection')

      expect(recordedOf('showInputBox')).toHaveLength(0)
      expect(service.listCommands()).toEqual([])
      expect(recordedOf('showInformationMessage')[0]!.args[0]).toMatchObject({
        message: expect.stringContaining('终端'),
      })
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

      expect(service.listCommands()[0]).toMatchObject({ command: 'git push origin main', groupId: 'g1' })
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
    const group: QuickCommandGroup = { id: 'g1', name: 'git', createdAt: 't' }

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
