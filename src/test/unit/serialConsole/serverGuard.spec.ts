import { describe, expect, it, vi } from 'vitest'
import { normalizeSerialServerList } from '../../../extension/features/serialConsole/serverGuard'
import { DEFAULT_SERIAL_PARAMS } from '../../../extension/features/serialConsole/models'

/**
 * 加载守卫 serverGuard（此前仅经 store spec 间接触达）：
 * 坏条目跳过 + onWarning 上报、默认值补齐、重复 id、未知标量字段透传。
 */

const validServer = {
  id: 'srv-1',
  name: '甲',
  serialPath: 'COM3',
  baudRate: 9600,
  dataBits: 7,
  stopBits: 2,
  parity: 'even',
  flowControl: 'hardware',
  lineEnding: 'crlf',
  autoLogin: true,
  username: 'root',
  description: '备注',
  createdAt: 10,
  updatedAt: 20,
}

describe('normalizeSerialServerList', () => {
  it('合法条目全字段原样保留', () => {
    expect(normalizeSerialServerList([validServer])).toEqual([validServer])
  })

  it('非对象条目跳过并上报', () => {
    const onWarning = vi.fn()
    expect(normalizeSerialServerList([null, 'x', 42], onWarning)).toEqual([])
    expect(onWarning).toHaveBeenCalledTimes(3)
  })

  it.each([
    [{ name: '甲', serialPath: 'COM3' }, 'id'],
    [{ id: '', name: '甲', serialPath: 'COM3' }, 'id'],
    [{ id: 'a', serialPath: 'COM3' }, 'name'],
    [{ id: 'a', name: '', serialPath: 'COM3' }, 'name'],
    [{ id: 'a', name: '甲' }, 'serialPath'],
    [{ id: 'a', name: '甲', serialPath: '' }, 'serialPath'],
  ])('缺关键字段的条目（%#）跳过并上报', (entry, field) => {
    const onWarning = vi.fn()
    expect(normalizeSerialServerList([entry], onWarning)).toEqual([])
    expect(onWarning.mock.calls[0]?.[0]).toContain(field === 'id' ? 'id' : field)
  })

  it('重复 id 保留首个', () => {
    const onWarning = vi.fn()
    const first = { ...validServer, name: '首个' }
    const second = { ...validServer, name: '后到' }
    const servers = normalizeSerialServerList([first, second], onWarning)
    expect(servers).toEqual([first])
    expect(onWarning).toHaveBeenCalledWith(expect.stringContaining('重复'))
  })

  it('非法枚举 / 缺失参数补 DEFAULT_SERIAL_PARAMS；baudRate 非 number 补默认', () => {
    const servers = normalizeSerialServerList([
      {
        id: 'a',
        name: '甲',
        serialPath: 'COM3',
        baudRate: NaN,
        dataBits: 9,
        stopBits: 3,
        parity: 'weird',
        flowControl: 'auto',
        lineEnding: 'newline',
      },
    ])
    expect(servers[0]).toMatchObject({
      baudRate: DEFAULT_SERIAL_PARAMS.baudRate,
      dataBits: DEFAULT_SERIAL_PARAMS.dataBits,
      stopBits: DEFAULT_SERIAL_PARAMS.stopBits,
      parity: DEFAULT_SERIAL_PARAMS.parity,
      flowControl: DEFAULT_SERIAL_PARAMS.flowControl,
      lineEnding: DEFAULT_SERIAL_PARAMS.lineEnding,
      autoLogin: false,
      username: '',
      description: '',
      createdAt: 0,
      updatedAt: 0,
    })
  })

  it('autoLogin 仅 true 为真；username / description 非字符串归空；时间戳非 number 归 0', () => {
    const servers = normalizeSerialServerList([
      { ...validServer, autoLogin: 'yes', username: 42, description: null, createdAt: 'x' },
    ])
    expect(servers[0]).toMatchObject({
      autoLogin: false,
      username: '',
      description: '',
      createdAt: 0,
      updatedAt: 20,
    })
  })

  it('未知 string / number / boolean 字段透传；对象 / 数组字段不透传', () => {
    const servers = normalizeSerialServerList([
      {
        ...validServer,
        customTag: 'VIP',
        hopCount: 3,
        enabled: true,
        nested: { a: 1 },
        list: [1, 2],
      },
    ])
    const server = servers[0] as unknown as Record<string, unknown>
    expect(server.customTag).toBe('VIP')
    expect(server.hopCount).toBe(3)
    expect(server.enabled).toBe(true)
    expect('nested' in server).toBe(false)
    expect('list' in server).toBe(false)
  })
})
