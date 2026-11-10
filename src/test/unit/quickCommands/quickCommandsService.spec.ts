import { beforeEach, describe, expect, it } from 'vitest'
import * as vscode from 'vscode'
import {
  defaultAlias,
  MAX_QUICK_COMMAND_GROUPS,
  MAX_QUICK_COMMANDS,
  normalizeQuickCommandData,
  QUICK_COMMANDS_SCHEMA_VERSION,
  QuickCommandsService,
  type IQuickCommandsStore,
  type QuickCommandGroup,
  type QuickCommandsData,
} from '../../../extension/features/quickCommands/quickCommandsService'
import { __resetStubs, __setConfig, __stubs } from '../stubs/vscode'

/**
 * 快捷命令服务（v3.5，16 方案）：归一化守卫（信封读入 / 丢坏条 / 悬空分组引用 /
 * 分组重名 / 双上限裁剪）与默认别名规则；存储契约与业务方法见同文件后续 describe。
 */

function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { schemaVersion: QUICK_COMMANDS_SCHEMA_VERSION, groups: [], commands: [], ...overrides }
}

describe('normalizeQuickCommandData（v3.5 快捷命令守卫）', () => {
  beforeEach(() => {
    __resetStubs()
  })

  it('信封数据读入：分组与命令字段原样保留', () => {
    const warnings: string[] = []
    const data = normalizeQuickCommandData(
      envelope({
        groups: [{ id: 'g1', name: 'git', createdAt: '2026-01-01T00:00:00.000Z' }],
        commands: [
          {
            id: 'c1',
            name: 'push',
            command: 'git push origin main',
            groupId: 'g1',
            addedAt: '2026-01-02T00:00:00.000Z',
            lastUsedAt: '2026-01-03T00:00:00.000Z',
            useCount: 3,
          },
        ],
      }),
      (message) => warnings.push(message)
    )
    expect(data.groups).toEqual([{ id: 'g1', name: 'git', createdAt: '2026-01-01T00:00:00.000Z' }])
    expect(data.commands).toEqual([
      {
        id: 'c1',
        name: 'push',
        command: 'git push origin main',
        groupId: 'g1',
        addedAt: '2026-01-02T00:00:00.000Z',
        lastUsedAt: '2026-01-03T00:00:00.000Z',
        useCount: 3,
      },
    ])
    expect(warnings).toEqual([])
  })

  it.each([
    ['数字', 42],
    ['null', null],
    ['数组', [{ command: 'ls' }]],
    ['空对象（无数组字段）', {}],
  ])('非信封形态（%s）→ 警告 + 空数据', (_name, raw) => {
    const warnings: string[] = []
    const data = normalizeQuickCommandData(raw, (message) => warnings.push(message))
    expect(data).toEqual<QuickCommandsData>({ groups: [], commands: [] })
    expect(warnings.length).toBeGreaterThan(0)
  })

  it('信封缺 groups 数组（仅 commands）→ 宽容读取，groups 视为空', () => {
    const warnings: string[] = []
    const data = normalizeQuickCommandData(
      { schemaVersion: 1, commands: [{ command: 'ls' }] },
      (message) => warnings.push(message)
    )
    expect(data.groups).toEqual([])
    expect(data.commands).toHaveLength(1)
    expect(warnings).toEqual([])
  })

  it('schemaVersion 不一致 → 警告并尽力读取', () => {
    const warnings: string[] = []
    const data = normalizeQuickCommandData(
      { schemaVersion: 99, groups: [], commands: [{ command: 'ls' }] },
      (message) => warnings.push(message)
    )
    expect(data.commands).toHaveLength(1)
    expect(warnings.join('\n')).toContain('schemaVersion')
  })

  it('命令缺 command / command 为空白 → 整条丢弃并警告', () => {
    const warnings: string[] = []
    const data = normalizeQuickCommandData(
      envelope({ commands: [{ id: 'c9', name: '缺命令' }, { command: '   ' }] }),
      (message) => warnings.push(message)
    )
    expect(data.commands).toEqual([])
    expect(warnings.join('\n')).toContain('2 条')
  })

  it('command 原样存取仅 trim 首尾空白（A3）', () => {
    const data = normalizeQuickCommandData(envelope({ commands: [{ command: '  git status \n' }] }))
    expect(data.commands[0]!.command).toBe('git status')
  })

  it('name 缺省/空白 → defaultAlias(command)；提供则 trim 保留', () => {
    const data = normalizeQuickCommandData(
      envelope({
        commands: [{ command: 'git push' }, { command: 'npm run build', name: '  构建  ' }],
      })
    )
    expect(data.commands[0]!.name).toBe('git')
    expect(data.commands[1]!.name).toBe('构建')
  })

  it('id/addedAt 缺失 → 随机补齐；useCount/lastUsedAt 非法 → 丢弃字段', () => {
    const data = normalizeQuickCommandData(
      envelope({ commands: [{ command: 'ls', useCount: -1, lastUsedAt: 42 }] })
    )
    const item = data.commands[0]!
    expect(item.id.length).toBeGreaterThan(0)
    expect(item.addedAt.length).toBeGreaterThan(0)
    expect(item.useCount).toBeUndefined()
    expect(item.lastUsedAt).toBeUndefined()
  })

  it('悬空 groupId → 回落未分组并汇总警告（Review Focus 2）', () => {
    const warnings: string[] = []
    const data = normalizeQuickCommandData(
      envelope({
        groups: [{ id: 'g1', name: 'git', createdAt: 't1' }],
        commands: [
          { command: 'git push', groupId: 'g1' },
          { command: 'ls', groupId: 'gX' },
          { command: 'pwd', groupId: 'gY' },
        ],
      }),
      (message) => warnings.push(message)
    )
    expect(data.commands.map((item) => item.groupId)).toEqual(['g1', null, null])
    expect(warnings.join('\n')).toContain('回落')
    expect(warnings.join('\n')).toContain('2')
  })

  it('分组重名保留首个并警告；分组名空白整条丢弃', () => {
    const warnings: string[] = []
    const data = normalizeQuickCommandData(
      envelope({
        groups: [
          { id: 'g1', name: 'git', createdAt: 't1' },
          { id: 'g2', name: ' git ', createdAt: 't2' },
          { id: 'g3', name: '   ', createdAt: 't3' },
        ],
        commands: [{ command: 'ls', groupId: 'g1' }],
      }),
      (message) => warnings.push(message)
    )
    expect(data.groups).toEqual([{ id: 'g1', name: 'git', createdAt: 't1' }])
    expect(warnings.join('\n')).toContain('重名')
    expect(warnings.join('\n')).toContain('分组')
  })

  it(`命令超过 ${MAX_QUICK_COMMANDS} 条 → 保留前 ${MAX_QUICK_COMMANDS} 条并警告`, () => {
    const warnings: string[] = []
    const many = Array.from({ length: MAX_QUICK_COMMANDS + 1 }, (_, index) => ({
      command: `cmd-${index}`,
    }))
    const data = normalizeQuickCommandData(envelope({ commands: many }), (message) =>
      warnings.push(message)
    )
    expect(data.commands).toHaveLength(MAX_QUICK_COMMANDS)
    expect(data.commands[0]!.command).toBe('cmd-0')
    expect(warnings.join('\n')).toContain('超上限')
  })

  it(`分组超过 ${MAX_QUICK_COMMAND_GROUPS} 个 → 保留前 ${MAX_QUICK_COMMAND_GROUPS} 个并警告`, () => {
    const warnings: string[] = []
    const many = Array.from({ length: MAX_QUICK_COMMAND_GROUPS + 1 }, (_, index) => ({
      id: `g${index}`,
      name: `分组${index}`,
      createdAt: 't',
    }))
    const data = normalizeQuickCommandData(envelope({ groups: many }), (message) =>
      warnings.push(message)
    )
    expect(data.groups).toHaveLength(MAX_QUICK_COMMAND_GROUPS)
    expect(warnings.join('\n')).toContain('超上限')
  })
})

describe('defaultAlias（默认别名）', () => {
  it.each([
    ['git push origin main', 'git'],
    ['  npm   run dev  ', 'npm'],
    ['x'.repeat(30), 'x'.repeat(20)],
  ])('%s → %s', (command, expected) => {
    expect(defaultAlias(command)).toBe(expected)
  })
})

/** 内存假存储：深拷贝隔离，save 后可断言落盘形态。 */
class FakeStore implements IQuickCommandsStore {
  data: QuickCommandsData = { groups: [], commands: [] }

  async load(): Promise<QuickCommandsData> {
    return JSON.parse(JSON.stringify(this.data)) as QuickCommandsData
  }

  async save(data: QuickCommandsData): Promise<void> {
    this.data = JSON.parse(JSON.stringify(data)) as QuickCommandsData
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
  lastUsedAt?: string
  useCount?: number
}

function makeService(data: { groups?: GroupSeed[]; commands?: ItemSeed[] } = {}): {
  service: QuickCommandsService
  store: FakeStore
} {
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
      ...(item.lastUsedAt !== undefined ? { lastUsedAt: item.lastUsedAt } : {}),
      ...(item.useCount !== undefined ? { useCount: item.useCount } : {}),
    })),
  }
  return { service: new QuickCommandsService(store), store }
}

describe('QuickCommandsService（业务服务）', () => {
  beforeEach(() => {
    __resetStubs()
  })

  it('load：成功后 listCommands/listGroups 反映数据并触发变更', async () => {
    const { service } = makeService({
      groups: [{ id: 'g1', name: 'git' }],
      commands: [{ id: 'c1', name: 'push', command: 'git push', groupId: 'g1' }],
    })
    await service.load()
    expect(service.listGroups().map((group) => group.name)).toEqual(['git'])
    expect(service.listCommands().map((item) => item.name)).toEqual(['push'])
  })

  it('load：失败置 loadError 并保留空数据（info 节点呈现）', async () => {
    const failing = new (class implements IQuickCommandsStore {
      async load(): Promise<QuickCommandsData> {
        throw new Error('磁盘炸了')
      }
      async save(): Promise<void> {}
    })()
    const service = new QuickCommandsService(failing)
    await service.load()
    expect(service.loadError).toBe('磁盘炸了')
    expect(service.listCommands()).toEqual([])
  })

  it('addCommand：新增成功（返回条目并落盘），别名缺省 defaultAlias', async () => {
    const { service, store } = makeService()
    await service.load()
    const result = await service.addCommand({ command: '  git status  ', groupId: null })
    expect(result.status).toBe('added')
    if (result.status !== 'added') return
    expect(result.item.command).toBe('git status')
    expect(result.item.name).toBe('git')
    expect(store.data.commands).toHaveLength(1)
  })

  it('addCommand：插入所在分组顶部（组内既有条目之前）', async () => {
    const { service } = makeService({
      groups: [{ id: 'g1', name: 'git' }],
      commands: [{ id: 'c-old', name: 'old', command: 'git old', groupId: 'g1' }],
    })
    await service.load()
    await service.addCommand({ command: 'git new', name: 'new', groupId: 'g1' })
    expect(
      service
        .listCommands()
        .filter((item) => item.groupId === 'g1')
        .map((i) => i.name)
    ).toEqual(['new', 'old'])
  })

  it('addCommand：重复命令文本仅提示（既有条目字段不变，Review Focus 5）', async () => {
    const { service } = makeService({
      commands: [
        {
          id: 'c1',
          name: 'push',
          command: 'git push',
          groupId: null,
          useCount: 7,
        },
      ],
    })
    await service.load()
    const result = await service.addCommand({ command: 'git push', name: '别名覆盖尝试' })
    expect(result.status).toBe('duplicate')
    if (result.status !== 'duplicate') return
    expect(result.existing.id).toBe('c1')
    expect(result.existing.name).toBe('push')
    expect(result.existing.useCount).toBe(7)
  })

  it('addCommand：空/空白命令 → invalid；非法 groupId → invalid', async () => {
    const { service } = makeService({ groups: [{ id: 'g1', name: 'git' }] })
    await service.load()
    expect((await service.addCommand({ command: '   ', groupId: null })).status).toBe('invalid')
    expect((await service.addCommand({ command: 'ls', groupId: 'gX' })).status).toBe('invalid')
  })

  it('addCommand：达到命令上限 → cap', async () => {
    const full = Array.from({ length: MAX_QUICK_COMMANDS }, (_, index) => ({
      id: `c${index}`,
      name: `n${index}`,
      command: `cmd-${index}`,
      groupId: null,
    }))
    const { service } = makeService({ commands: full })
    await service.load()
    expect((await service.addCommand({ command: 'another', groupId: null })).status).toBe('cap')
  })

  it('renameCommand：成功 / 空名 false / 不存在 false', async () => {
    const { service } = makeService({ commands: [{ id: 'c1', name: 'a', command: 'ls' }] })
    await service.load()
    expect(await service.renameCommand('c1', '  新别名  ')).toBe(true)
    expect(service.get('c1')!.name).toBe('新别名')
    expect(await service.renameCommand('c1', '   ')).toBe(false)
    expect(await service.renameCommand('cX', 'x')).toBe(false)
  })

  it('updateCommandText：updated / duplicate / notfound / empty', async () => {
    const { service } = makeService({
      commands: [
        { id: 'c1', name: 'a', command: 'ls' },
        { id: 'c2', name: 'b', command: 'pwd' },
      ],
    })
    await service.load()
    expect(await service.updateCommandText('c1', '  git status  ')).toBe('updated')
    expect(service.get('c1')!.command).toBe('git status')
    expect(await service.updateCommandText('c1', 'pwd')).toBe('duplicate')
    expect(await service.updateCommandText('cX', 'ls')).toBe('notfound')
    expect(await service.updateCommandText('c1', '  ')).toBe('empty')
  })

  it('moveCommandToGroup：移入分组 / 回到未分组 / 非法分组或条目 false', async () => {
    const { service } = makeService({
      groups: [{ id: 'g1', name: 'git' }],
      commands: [{ id: 'c1', name: 'a', command: 'ls', groupId: null }],
    })
    await service.load()
    expect(await service.moveCommandToGroup('c1', 'g1')).toBe(true)
    expect(service.get('c1')!.groupId).toBe('g1')
    expect(await service.moveCommandToGroup('c1', null)).toBe(true)
    expect(service.get('c1')!.groupId).toBeNull()
    expect(await service.moveCommandToGroup('c1', 'gX')).toBe(false)
    expect(await service.moveCommandToGroup('cX', 'g1')).toBe(false)
  })

  it('createGroup：created / duplicate（返回既有组）/ cap', async () => {
    const manyGroups: QuickCommandGroup[] = Array.from(
      { length: MAX_QUICK_COMMAND_GROUPS },
      (_, index) => ({ id: `g${index}`, name: `组${index}`, createdAt: 't' })
    )
    const { service } = makeService({ groups: manyGroups.slice(0, 1) })
    await service.load()
    const created = await service.createGroup(' 构建 ')
    expect(created.status).toBe('created')
    if (created.status !== 'created') return
    expect(created.group.name).toBe('构建')
    const duplicate = await service.createGroup('构建')
    expect(duplicate.status).toBe('duplicate')

    const full = new QuickCommandsService(
      new (class implements IQuickCommandsStore {
        async load(): Promise<QuickCommandsData> {
          return { groups: manyGroups, commands: [] }
        }
        async save(): Promise<void> {}
      })()
    )
    await full.load()
    expect((await full.createGroup('新组')).status).toBe('cap')
  })

  it('renameGroup：renamed / duplicate / notfound', async () => {
    const { service } = makeService({
      groups: [
        { id: 'g1', name: 'git' },
        { id: 'g2', name: 'build' },
      ],
    })
    await service.load()
    expect(await service.renameGroup('g1', '  版本控制 ')).toBe('renamed')
    expect(service.listGroups()[0]!.name).toBe('版本控制')
    expect(await service.renameGroup('g1', 'build')).toBe('duplicate')
    expect(await service.renameGroup('gX', 'x')).toBe('notfound')
  })

  it('removeGroup：组内命令回落未分组；不存在 false', async () => {
    const { service, store } = makeService({
      groups: [{ id: 'g1', name: 'git' }],
      commands: [
        { id: 'c1', name: 'a', command: 'ls', groupId: 'g1' },
        { id: 'c2', name: 'b', command: 'pwd', groupId: null },
      ],
    })
    await service.load()
    expect(await service.removeGroup('g1')).toBe(true)
    expect(service.listGroups()).toEqual([])
    expect(service.get('c1')!.groupId).toBeNull()
    expect(store.data.groups).toEqual([])
    expect(await service.removeGroup('gX')).toBe(false)
  })

  it('removeCommand：移除成功 / 不存在 false', async () => {
    const { service } = makeService({ commands: [{ id: 'c1', name: 'a', command: 'ls' }] })
    await service.load()
    expect(await service.removeCommand('c1')).toBe(true)
    expect(service.listCommands()).toEqual([])
    expect(await service.removeCommand('c1')).toBe(false)
  })

  it('recordExecution：回写 lastUsedAt/useCount 并落盘', async () => {
    const { service, store } = makeService({
      commands: [{ id: 'c1', name: 'a', command: 'ls', useCount: 2 }],
    })
    await service.load()
    await service.recordExecution('c1')
    const item = service.get('c1')!
    expect(item.useCount).toBe(3)
    expect(typeof item.lastUsedAt).toBe('string')
    expect(store.data.commands[0]!.useCount).toBe(3)
  })

  it('每次成功持久化触发 onDidChange', async () => {
    const { service } = makeService()
    await service.load()
    let fired = 0
    service.onDidChange(() => {
      fired += 1
    })
    await service.addCommand({ command: 'ls', groupId: null })
    expect(fired).toBeGreaterThan(0)
  })
})

describe('QuickCommandsService.execute（专用终端，v3.5）', () => {
  beforeEach(() => {
    __resetStubs()
  })

  function recordedOf(kind: string): { kind: string; args: unknown[] }[] {
    return __stubs.recorded.filter((entry) => entry.kind === kind)
  }

  it('首次执行：创建专用终端（cwd=工作区首目录）→ show → sendText 原样执行 → 回写 useCount', async () => {
    __stubs.workspaceFolders = [{ uri: vscode.Uri.file('/ws-root'), name: 'ws', index: 0 }]
    const { service } = makeService({
      commands: [{ id: 'c1', name: 'a', command: 'git push --force-with-lease' }],
    })
    await service.load()
    await service.execute(service.get('c1')!)

    const creates = recordedOf('createTerminal')
    expect(creates).toHaveLength(1)
    const options = creates[0]!.args[0] as { name?: string; cwd?: { fsPath: string } }
    expect(options.name).toBe('QuickCommand')
    expect(options.cwd?.fsPath).toContain('ws-root')

    const shows = recordedOf('terminalShow')
    expect(shows).toHaveLength(1)

    const sends = recordedOf('terminalSendText')
    expect(sends).toHaveLength(1)
    expect(sends[0]!.args[0]).toMatchObject({
      name: 'QuickCommand',
      text: 'git push --force-with-lease',
      shouldExecute: true,
    })
    expect(service.get('c1')!.useCount).toBe(1)
    expect(typeof service.get('c1')!.lastUsedAt).toBe('string')
  })

  it('二次执行复用既有终端（仅一次 createTerminal；Review Focus 4 的正常面）', async () => {
    __stubs.workspaceFolders = [{ uri: vscode.Uri.file('/ws-root'), name: 'ws', index: 0 }]
    const { service } = makeService({ commands: [{ id: 'c1', name: 'a', command: 'ls' }] })
    await service.load()
    await service.execute(service.get('c1')!)
    await service.execute(service.get('c1')!)
    expect(recordedOf('createTerminal')).toHaveLength(1)
    expect(recordedOf('terminalSendText')).toHaveLength(2)
  })

  it('终端被用户关闭（exitStatus 置值）后再次执行 → 自动重建', async () => {
    __stubs.workspaceFolders = [{ uri: vscode.Uri.file('/ws-root'), name: 'ws', index: 0 }]
    const { service } = makeService({ commands: [{ id: 'c1', name: 'a', command: 'ls' }] })
    await service.load()
    await service.execute(service.get('c1')!)
    __stubs.terminals[0]!.exitStatus = { reason: 'closed' }
    await service.execute(service.get('c1')!)
    expect(recordedOf('createTerminal')).toHaveLength(2)
    expect(recordedOf('terminalSendText')).toHaveLength(2)
  })

  it('配置 quickCommandReuseTerminal=false → 每次执行新建终端', async () => {
    __stubs.workspaceFolders = [{ uri: vscode.Uri.file('/ws-root'), name: 'ws', index: 0 }]
    __setConfig('extStarter', 'quickCommandReuseTerminal', false)
    const { service } = makeService({ commands: [{ id: 'c1', name: 'a', command: 'ls' }] })
    await service.load()
    await service.execute(service.get('c1')!)
    await service.execute(service.get('c1')!)
    expect(recordedOf('createTerminal')).toHaveLength(2)
  })

  it('getReuseTerminal 注入 false → 每次新建（不读配置）', async () => {
    const store = new FakeStore()
    store.data = {
      groups: [],
      commands: [{ id: 'c1', name: 'a', command: 'ls', groupId: null, addedAt: 't' }],
    }
    const service = new QuickCommandsService(store, { getReuseTerminal: () => false })
    await service.load()
    await service.execute(service.get('c1')!)
    await service.execute(service.get('c1')!)
    expect(recordedOf('createTerminal')).toHaveLength(2)
  })

  it('无工作区 → createTerminal 的 cwd 为 undefined（VSCode 默认位置）', async () => {
    __stubs.workspaceFolders = undefined
    const { service } = makeService({ commands: [{ id: 'c1', name: 'a', command: 'ls' }] })
    await service.load()
    await service.execute(service.get('c1')!)
    const options = recordedOf('createTerminal')[0]!.args[0] as { cwd?: unknown }
    expect(options.cwd).toBeUndefined()
  })
})
