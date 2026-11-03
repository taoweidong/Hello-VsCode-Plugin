import { describe, expect, it } from 'vitest'
import {
  isCommandHistoryWire,
  isHostMessage,
  isSerialServerWire,
  isWebviewMessage,
} from '../../../webview/protocol'

/** protocol.ts 运行时守卫（03 §5.5 / 05 T2.4）：逐字段窄化，非法样例一律拒绝。 */
describe('isWebviewMessage', () => {
  it.each([
    ['ready', { type: 'ready' }],
    ['dirty=true', { type: 'dirty', dirty: true }],
    ['dirty=false', { type: 'dirty', dirty: false }],
    ['submit', { type: 'submit', draft: { name: '任务A' } }],
    ['cancel', { type: 'cancel' }],
  ])('接受合法消息：%s', (_name, sample) => {
    expect(isWebviewMessage(sample)).toBe(true)
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['数组', [{ type: 'ready' }]],
    ['字符串', 'ready'],
    ['数字', 42],
    ['空对象', {}],
    ['缺 type', { dirty: true }],
    ['未知 type', { type: 'huge' }],
    ['dirty 缺字段', { type: 'dirty' }],
    ['dirty 类型错误', { type: 'dirty', dirty: 'yes' }],
    ['dirty 为 null', { type: 'dirty', dirty: null }],
    ['submit 缺 draft', { type: 'submit' }],
    ['submit.draft 为 null', { type: 'submit', draft: null }],
    ['submit.draft 为数组', { type: 'submit', draft: [{ key: 'x' }] }],
    ['submit.draft 为字符串', { type: 'submit', draft: 'x' }],
  ])('拒绝非法消息：%s', (_name, sample) => {
    expect(isWebviewMessage(sample)).toBe(false)
  })
})

describe('isHostMessage', () => {
  const field = { key: 'name', label: '名称', type: 'text' }

  it.each([
    [
      'init 完整',
      {
        type: 'init',
        page: 'serialConsole',
        schema: [field],
        value: null,
        extra: { mode: 'create' },
      },
    ],
    [
      'init 最小（无 extra，value 为 null）',
      { type: 'init', page: 'serialConsole', schema: [], value: null },
    ],
    ['submitAck', { type: 'submitAck', ok: true }],
    ['error 带 field', { type: 'error', message: '名称不能为空', field: 'name' }],
    ['error 不带 field', { type: 'error', message: '提交超时' }],
  ])('接受合法消息：%s', (_name, sample) => {
    expect(isHostMessage(sample)).toBe(true)
  })

  it.each([
    ['null', null],
    ['数组', [{ type: 'init' }]],
    ['字符串', 'init'],
    ['空对象', {}],
    ['未知 type', { type: 'restore' }],
    ['init 缺 page', { type: 'init', schema: [field], value: null }],
    ['init.page 非字符串', { type: 'init', page: 1, schema: [field], value: null }],
    ['init 缺 schema', { type: 'init', page: 'serialConsole', value: null }],
    ['init.schema 非数组', { type: 'init', page: 'serialConsole', schema: field, value: null }],
    [
      'init.schema 元素非对象',
      { type: 'init', page: 'serialConsole', schema: ['name'], value: null },
    ],
    [
      'init.schema 字段缺 key',
      {
        type: 'init',
        page: 'serialConsole',
        schema: [{ label: '名称', type: 'text' }],
        value: null,
      },
    ],
    [
      'init.schema 字段 key 非字符串',
      {
        type: 'init',
        page: 'serialConsole',
        schema: [{ key: 1, label: 'n', type: 'text' }],
        value: null,
      },
    ],
    ['init 缺 value', { type: 'init', page: 'serialConsole', schema: [] }],
    [
      'init.extra 非对象',
      { type: 'init', page: 'serialConsole', schema: [], value: null, extra: 'x' },
    ],
    ['submitAck 缺 ok', { type: 'submitAck' }],
    ['submitAck ok=false', { type: 'submitAck', ok: false }],
    ['error 缺 message', { type: 'error', field: 'name' }],
    ['error.message 非字符串', { type: 'error', message: 42 }],
    ['error.field 非字符串', { type: 'error', message: 'x', field: 3 }],
  ])('拒绝非法消息：%s', (_name, sample) => {
    expect(isHostMessage(sample)).toBe(false)
  })
})

/* ================= 分支编译构建任务消息守卫（v2.0 弹框改造） ================= */

const buildTask = {
  id: 'build-1',
  branch: 'release/1.0.0',
  buildType: 'full',
  status: 'running',
  progress: 42,
  createdAt: '2026-10-25T00:00:00.000Z',
}

describe('isWebviewMessage：构建任务消息', () => {
  it.each([['buildListRequest', { type: 'buildListRequest' }]])(
    '接受合法消息：%s',
    (_name, sample) => {
      expect(isWebviewMessage(sample)).toBe(true)
    }
  )
})

describe('isHostMessage：构建任务消息', () => {
  it.each([
    ['buildList 单任务', { type: 'buildList', tasks: [buildTask] }],
    ['buildList 空列表', { type: 'buildList', tasks: [] }],
    [
      'buildList 带可选字段',
      {
        type: 'buildList',
        tasks: [
          {
            ...buildTask,
            notes: '备注',
            message: '构建中',
            finishedAt: '2026-10-25T01:00:00.000Z',
          },
        ],
      },
    ],
  ])('接受合法消息：%s', (_name, sample) => {
    expect(isHostMessage(sample)).toBe(true)
  })

  it.each([
    ['buildList 缺 tasks', { type: 'buildList' }],
    ['buildList.tasks 非数组', { type: 'buildList', tasks: 'x' }],
    ['buildList 元素缺 id', { type: 'buildList', tasks: [{ branch: 'x' }] }],
    [
      'buildList.status 非法字面量',
      { type: 'buildList', tasks: [{ ...buildTask, status: 'done' }] },
    ],
    ['buildList.progress 非数字', { type: 'buildList', tasks: [{ ...buildTask, progress: '42' }] }],
    [
      'buildList.createdAt 非字符串',
      { type: 'buildList', tasks: [{ ...buildTask, createdAt: 1 }] },
    ],
    ['buildList.notes 非字符串', { type: 'buildList', tasks: [{ ...buildTask, notes: 1 }] }],
  ])('拒绝非法消息：%s', (_name, sample) => {
    expect(isHostMessage(sample)).toBe(false)
  })
})

/* ================= 串口命令控制台消息守卫（docs/superpowers/specs 2026-10-24 §5.4） ================= */

const serialServer = {
  id: 'srv-1',
  name: '服务器甲',
  serialPath: 'COM3',
  baudRate: 115200,
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
  flowControl: 'none',
  lineEnding: 'lf',
  autoLogin: false,
  username: '',
  description: '',
  createdAt: 1,
  updatedAt: 1,
}

const historyEntry = { id: 'h1', command: 'show version', lastUsedAt: 1, useCount: 2 }

describe('isWebviewMessage：串口控制台消息', () => {
  it.each([
    ['serialPortsRequest', { type: 'serialPortsRequest' }],
    ['serialServersRequest', { type: 'serialServersRequest' }],
    ['serialServerSave 最小', { type: 'serialServerSave', draft: { name: '甲' } }],
    [
      'serialServerSave 带密码',
      { type: 'serialServerSave', draft: { name: '甲' }, password: 'secret' },
    ],
    ['serialServerDelete', { type: 'serialServerDelete', id: 'srv-1' }],
    ['serialConnect', { type: 'serialConnect', serverId: 'srv-1' }],
    ['serialDisconnect', { type: 'serialDisconnect' }],
    ['serialSend', { type: 'serialSend', command: 'show version' }],
    ['commandHistoryRequest', { type: 'commandHistoryRequest' }],
    ['commandHistoryRemove', { type: 'commandHistoryRemove', id: 'h1' }],
    ['commandHistoryClear', { type: 'commandHistoryClear' }],
  ])('接受合法消息：%s', (_name, sample) => {
    expect(isWebviewMessage(sample)).toBe(true)
  })

  it.each([
    ['serialServerSave 缺 draft', { type: 'serialServerSave' }],
    ['serialServerSave.draft 非对象', { type: 'serialServerSave', draft: 'x' }],
    ['serialServerSave.password 非字符串', { type: 'serialServerSave', draft: {}, password: 42 }],
    ['serialServerDelete 缺 id', { type: 'serialServerDelete' }],
    ['serialServerDelete.id 非字符串', { type: 'serialServerDelete', id: 7 }],
    ['serialConnect 缺 serverId', { type: 'serialConnect' }],
    ['serialConnect.serverId null', { type: 'serialConnect', serverId: null }],
    ['serialSend 缺 command', { type: 'serialSend' }],
    ['serialSend.command 非字符串', { type: 'serialSend', command: [] }],
    ['commandHistoryRemove.id 非字符串', { type: 'commandHistoryRemove', id: true }],
  ])('拒绝非法消息：%s', (_name, sample) => {
    expect(isWebviewMessage(sample)).toBe(false)
  })
})

describe('isHostMessage：串口控制台消息', () => {
  it.each([
    [
      'serialPorts',
      { type: 'serialPorts', ports: [{ path: 'COM3' }, { path: 'COM4', manufacturer: 'USB' }] },
    ],
    ['serialPorts 空数组', { type: 'serialPorts', ports: [] }],
    ['serialServers', { type: 'serialServers', servers: [serialServer] }],
    ['serialState 已连接', { type: 'serialState', serverId: 'srv-1', state: 'connected' }],
    [
      'serialState 断开（serverId=null）',
      { type: 'serialState', serverId: null, state: 'disconnected' },
    ],
    [
      'serialState 带错误',
      { type: 'serialState', serverId: 'srv-1', state: 'error', error: 'COM 被占用' },
    ],
    ['serialData', { type: 'serialData', seq: 1, text: 'Ubuntu 22.04' }],
    ['commandHistory', { type: 'commandHistory', entries: [historyEntry] }],
    ['commandHistory 空数组', { type: 'commandHistory', entries: [] }],
  ])('接受合法消息：%s', (_name, sample) => {
    expect(isHostMessage(sample)).toBe(true)
  })

  it.each([
    ['serialPorts 缺 ports', { type: 'serialPorts' }],
    ['serialPorts.ports 非数组', { type: 'serialPorts', ports: 'COM3' }],
    ['serialPorts.ports 元素缺 path', { type: 'serialPorts', ports: [{ manufacturer: 'USB' }] }],
    ['serialServers.ports 元素缺 name', { type: 'serialServers', servers: [{ id: '1' }] }],
    [
      'serialServers 元素 baudRate 非数字',
      { type: 'serialServers', servers: [{ ...serialServer, baudRate: '115200' }] },
    ],
    [
      'serialServers 元素 autoLogin 非布尔',
      { type: 'serialServers', servers: [{ ...serialServer, autoLogin: 1 }] },
    ],
    ['serialState 缺 state', { type: 'serialState', serverId: 'srv-1' }],
    ['serialState.state 非法字面量', { type: 'serialState', serverId: 'srv-1', state: 'open' }],
    ['serialState.serverId 数字', { type: 'serialState', serverId: 1, state: 'connected' }],
    [
      'serialState.error 非字符串',
      { type: 'serialState', serverId: null, state: 'error', error: 42 },
    ],
    ['serialData 缺 seq', { type: 'serialData', text: 'x' }],
    ['serialData.seq 非数字', { type: 'serialData', seq: '1', text: 'x' }],
    ['serialData.text 非字符串', { type: 'serialData', seq: 1, text: null }],
    [
      'commandHistory 元素缺 useCount',
      { type: 'commandHistory', entries: [{ id: 'h1', command: 'x', lastUsedAt: 1 }] },
    ],
    [
      'commandHistory 元素 command 非字符串',
      { type: 'commandHistory', entries: [{ id: 'h1', command: 1, lastUsedAt: 1, useCount: 1 }] },
    ],
  ])('拒绝非法消息：%s', (_name, sample) => {
    expect(isHostMessage(sample)).toBe(false)
  })
})

/* ================= 元素级守卫导出（P2-F4：init.extra 元素过滤共用） ================= */

describe('isSerialServerWire / isCommandHistoryWire（元素级守卫）', () => {
  const validServer = {
    id: 'srv-1',
    name: '甲',
    serialPath: 'COM3',
    baudRate: 115200,
    dataBits: 8,
    stopBits: 1,
    parity: 'none',
    flowControl: 'none',
    lineEnding: 'lf',
    autoLogin: false,
    username: '',
    description: '',
    createdAt: 1,
    updatedAt: 1,
  }

  it('合法 SerialServerWire 通过；缺字段 / 类型不符 / 非对象一律拒绝', () => {
    expect(isSerialServerWire(validServer)).toBe(true)
    expect(isSerialServerWire({ ...validServer, id: 42 })).toBe(false)
    expect(isSerialServerWire({ ...validServer, baudRate: '115200' })).toBe(false)
    expect(isSerialServerWire({ ...validServer, name: undefined })).toBe(false)
    expect(isSerialServerWire(null)).toBe(false)
    expect(isSerialServerWire([validServer])).toBe(false)
    expect(isSerialServerWire('srv-1')).toBe(false)
  })

  it('合法 CommandHistoryWire 通过；缺字段 / 类型不符拒绝', () => {
    expect(isCommandHistoryWire({ id: 'h1', command: 'ls', lastUsedAt: 1, useCount: 2 })).toBe(true)
    expect(isCommandHistoryWire({ id: 'h1', command: 'ls', lastUsedAt: '1', useCount: 2 })).toBe(
      false
    )
    expect(isCommandHistoryWire({ id: 'h1', command: 'ls' })).toBe(false)
    expect(isCommandHistoryWire(undefined)).toBe(false)
  })

  it('列表场景：filter(isSerialServerWire) 只保留合法元素（useConsolePage 的 init.extra 过滤语义）', () => {
    const mixed = [validServer, { id: 'bad' }, null, validServer]
    expect(mixed.filter(isSerialServerWire)).toHaveLength(2)
  })
})
