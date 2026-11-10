import { beforeEach, describe, expect, it } from 'vitest'
import {
  defaultAlias,
  MAX_QUICK_COMMAND_GROUPS,
  MAX_QUICK_COMMANDS,
  normalizeQuickCommandData,
  QUICK_COMMANDS_SCHEMA_VERSION,
  type QuickCommandsData,
} from '../../../extension/features/quickCommands/quickCommandsService'
import { __resetStubs } from '../stubs/vscode'

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
