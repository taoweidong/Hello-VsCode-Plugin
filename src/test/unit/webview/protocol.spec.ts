import { describe, expect, it, vi } from 'vitest'
import {
  isHostMessage,
  isTaskItemWire,
  isWebviewMessage,
  sanitizeWireList,
} from '../../../webview/protocol'

/**
 * protocol.ts 运行时守卫（03 §5.5 / 05 T2.4）：逐字段窄化，非法样例一律拒绝。
 * v4.0.0 串口功能下线后消息面收敛为 8 条 = 宿主→页面 4（init / submitAck / error /
 * taskList）+ 页面→宿主 4（ready / submit / taskListRequest / taskDelete）；
 * 串口消息（serialPorts / serialServers / serialState / serialData / commandHistory /
 * serialConnect …）已不再是合法消息（负例表锁定）。
 */

const taskItem = {
  id: 'task-1',
  name: '任务甲',
  branch: 'release/1.0.0',
  buildType: 'full',
  status: 'success',
  progress: 100,
  createdAt: '2026-10-25T00:00:00.000Z',
}

const page = (overrides: Record<string, unknown> = {}) => ({
  items: [taskItem],
  total: 1,
  page: 1,
  pageSize: 10,
  ...overrides,
})

/* ================= 页面 → 宿主（isWebviewMessage） ================= */

describe('isWebviewMessage', () => {
  it.each([
    ['ready', { type: 'ready' }],
    ['submit', { type: 'submit', draft: { name: 'x' } }],
    ['taskListRequest', { type: 'taskListRequest', query: { page: 1, pageSize: 10 } }],
    [
      'taskListRequest 带过滤条件',
      {
        type: 'taskListRequest',
        query: { page: 1, pageSize: 20, keyword: 'a', status: 'all', buildType: 'full' },
      },
    ],
    ['taskDelete', { type: 'taskDelete', id: 'task-1' }],
  ])('接受合法消息：%s', (_name, sample) => {
    expect(isWebviewMessage(sample)).toBe(true)
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['空对象', {}],
    ['未知 type', { type: 'unknown' }],
    ['submit 缺 draft', { type: 'submit' }],
    ['submit.draft 非对象', { type: 'submit', draft: 'x' }],
    ['taskListRequest 缺 query', { type: 'taskListRequest' }],
    ['taskListRequest.query 缺 page', { type: 'taskListRequest', query: { pageSize: 10 } }],
    [
      'taskListRequest.query.pageSize 非数字',
      { type: 'taskListRequest', query: { page: 1, pageSize: '10' } },
    ],
    [
      'taskListRequest.query.status 非法字面量',
      { type: 'taskListRequest', query: { page: 1, pageSize: 10, status: 'done' } },
    ],
    [
      'taskListRequest.query.buildType 非法字面量',
      { type: 'taskListRequest', query: { page: 1, pageSize: 10, buildType: 'patch' } },
    ],
    [
      'taskListRequest.query.keyword 非字符串',
      { type: 'taskListRequest', query: { page: 1, pageSize: 10, keyword: 1 } },
    ],
    ['taskDelete 缺 id', { type: 'taskDelete' }],
    ['taskDelete.id 非字符串', { type: 'taskDelete', id: 1 }],
  ])('拒绝非法消息：%s', (_name, sample) => {
    expect(isWebviewMessage(sample)).toBe(false)
  })

  it.each([
    ['serialPortsRequest', { type: 'serialPortsRequest' }],
    ['serialServerSave', { type: 'serialServerSave', draft: {} }],
    ['serialServerDelete', { type: 'serialServerDelete', id: 'srv-1' }],
    ['serialConnect', { type: 'serialConnect', serverId: 'srv-1' }],
    ['serialDisconnect', { type: 'serialDisconnect' }],
    ['serialSend', { type: 'serialSend', command: 'ls' }],
    ['commandHistoryRemove', { type: 'commandHistoryRemove', id: 'h1' }],
    ['commandHistoryClear', { type: 'commandHistoryClear' }],
  ])('串口消息已随功能下线（不再合法）：%s', (_name, sample) => {
    expect(isWebviewMessage(sample)).toBe(false)
  })
})

/* ================= 宿主 → 页面（isHostMessage） ================= */

describe('isHostMessage', () => {
  const initMessage = {
    type: 'init',
    page: 'taskManager',
    schema: [{ key: 'name', label: '名称', type: 'text' }],
    value: {},
    extra: { mode: 'taskManager' },
  }

  it.each([
    ['init', initMessage],
    ['init 无 extra', { ...initMessage, extra: undefined }],
    ['submitAck', { type: 'submitAck', ok: true }],
    ['error', { type: 'error', message: '名称不能为空。' }],
    ['error 带 field', { type: 'error', message: 'x', field: 'name' }],
    ['taskList', { type: 'taskList', page: page() }],
    ['taskList 空列表', { type: 'taskList', page: page({ items: [], total: 0 }) }],
  ])('接受合法消息：%s', (_name, sample) => {
    expect(isHostMessage(sample)).toBe(true)
  })

  it.each([
    ['null', null],
    ['空对象', {}],
    ['未知 type', { type: 'unknown' }],
    ['init 缺 page', { ...initMessage, page: undefined }],
    ['init.schema 非数组', { ...initMessage, schema: 'x' }],
    ['init.schema 元素非对象', { ...initMessage, schema: ['x'] }],
    ['init 缺 value', { ...initMessage, value: undefined }],
    ['init.extra 非对象', { ...initMessage, extra: 'x' }],
    ['submitAck ok=false', { type: 'submitAck', ok: false }],
    ['error 缺 message', { type: 'error' }],
    ['error.field 非字符串', { type: 'error', message: 'x', field: 1 }],
    ['taskList 缺 page', { type: 'taskList' }],
    ['taskList.page 非对象', { type: 'taskList', page: 'x' }],
    [
      'taskList.page.items 非数组',
      { type: 'taskList', page: { items: 'x', total: 1, page: 1, pageSize: 10 } },
    ],
    [
      'taskList.page.total 非数字',
      { type: 'taskList', page: { items: [], total: '1', page: 1, pageSize: 10 } },
    ],
  ])('拒绝非法消息：%s', (_name, sample) => {
    expect(isHostMessage(sample)).toBe(false)
  })

  it.each([
    ['serialPorts', { type: 'serialPorts', ports: [] }],
    ['serialServers', { type: 'serialServers', servers: [] }],
    ['serialState', { type: 'serialState', serverId: null, state: 'connected' }],
    ['serialData', { type: 'serialData', seq: 1, text: 'x' }],
    ['commandHistory', { type: 'commandHistory', entries: [] }],
  ])('串口消息已随功能下线（不再合法）：%s', (_name, sample) => {
    expect(isHostMessage(sample)).toBe(false)
  })
})

/* ================= 任务元素守卫与列表清洗 ================= */

describe('isTaskItemWire（元素级守卫）', () => {
  it('合法任务通过；缺字段 / 类型不符 / 枚举越界拒绝', () => {
    expect(isTaskItemWire(taskItem)).toBe(true)
    expect(isTaskItemWire({ ...taskItem, status: 'done' })).toBe(false)
    expect(isTaskItemWire({ ...taskItem, buildType: 'patch' })).toBe(false)
    expect(isTaskItemWire({ ...taskItem, progress: '42' })).toBe(false)
    expect(isTaskItemWire({ name: 'x' })).toBe(false)
    expect(isTaskItemWire(null)).toBe(false)
  })

  it('可选字段缺省合法；可选字段类型非法拒绝', () => {
    const minimal = { ...taskItem }
    delete (minimal as { notes?: string }).notes
    expect(isTaskItemWire(minimal)).toBe(true)
    expect(isTaskItemWire({ ...taskItem, notes: 1 })).toBe(false)
    expect(isTaskItemWire({ ...taskItem, finishedAt: 1 })).toBe(false)
  })
})

describe('sanitizeWireList（容器放行 + 坏元素过滤，宿主新增枚举值时旧页面降级而非白屏化）', () => {
  it('好元素保留、坏元素丢弃并告警', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const clean = sanitizeWireList(
        [taskItem, { ...taskItem, id: 42 }, taskItem],
        isTaskItemWire,
        '任务列表'
      )
      expect(clean).toHaveLength(2)
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('1 条畸形元素'))
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('全好元素：零丢弃零告警；空列表安全', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      expect(sanitizeWireList([taskItem], isTaskItemWire, '任务列表')).toHaveLength(1)
      expect(sanitizeWireList([], isTaskItemWire, '任务列表')).toEqual([])
      expect(warnSpy).not.toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('枚举扩展场景：新状态任务被丢弃而非整条拒绝（前向兼容口径）', () => {
    expect(
      sanitizeWireList([{ ...taskItem, status: 'cancelled' }], isTaskItemWire, '任务列表')
    ).toEqual([])
    expect(
      sanitizeWireList([{ ...taskItem, buildType: 'incremental' }], isTaskItemWire, '任务列表')
    ).toEqual([{ ...taskItem, buildType: 'incremental' }])
  })
})
