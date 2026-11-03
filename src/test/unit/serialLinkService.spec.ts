import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SerialServer } from '../../extension/features/serialConsole/models'
import {
  SERIAL_DATA_BATCH_MS,
  createSerialLinkService,
  type LinkState,
} from '../../extension/features/serialConsole/serialLinkService'
import { FakeSerialPort, FakeSerialPortFactory } from './serialConsole/support/fakeSerialPort'

function makeServer(overrides: Partial<SerialServer> = {}): SerialServer {
  return {
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
    ...overrides,
  }
}

/** 串口链路：状态机 / 数据批处理 / 写换行 / 断开清理（Review Focus #2）。 */
describe('SerialLinkService', () => {
  let factory: FakeSerialPortFactory
  let states: Array<{ state: LinkState; error?: string }>
  let dataEvents: Array<{ text: string; seq: number }>

  beforeEach(() => {
    vi.useFakeTimers()
    factory = new FakeSerialPortFactory()
    states = []
    dataEvents = []
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  const makeLink = () =>
    createSerialLinkService(factory, {
      onState: (state, error) => states.push({ state, error }),
      onData: (text, seq) => dataEvents.push({ text, seq }),
    })

  // ---------------- 连接状态机 ----------------

  it('connect 成功：connecting → connected；open 参数来自服务器串口配置', async () => {
    const link = makeLink()
    await link.connect(makeServer())
    expect(states.map((s) => s.state)).toEqual(['connecting', 'connected'])
    expect(link.state()).toBe('connected')
    expect(link.connectedServerId()).toBe('srv-1')
    expect(factory.openCalls).toEqual([
      {
        path: 'COM3',
        baudRate: 115200,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
        flowControl: false,
      },
    ])
  })

  it('open 失败：reject + onState(error)，之后可再次连接成功', async () => {
    factory.failOpenMessage = 'COM3 不存在'
    const link = makeLink()
    await expect(link.connect(makeServer())).rejects.toThrow('COM3 不存在')
    expect(link.state()).toBe('error')
    expect(states.at(-1)).toMatchObject({ state: 'error', error: expect.stringContaining('COM3') })

    factory.failOpenMessage = undefined
    await link.connect(makeServer())
    expect(link.state()).toBe('connected')
    expect(states.at(-1)?.state).toBe('connected')
  })

  it('flowControl=hardware 时 open 参数传 true', async () => {
    const link = makeLink()
    await link.connect(makeServer({ flowControl: 'hardware' }))
    expect(factory.openCalls[0]?.flowControl).toBe(true)
  })

  it('正在连接时再次 connect 拒绝并发', async () => {
    let release!: () => void
    factory.gate = new Promise<void>((resolve) => (release = resolve))
    const link = makeLink()
    const connecting = link.connect(makeServer())
    await expect(link.connect(makeServer({ id: 'srv-2' }))).rejects.toThrow('正在建立')
    release()
    await expect(connecting).resolves.toBeUndefined()
  })

  it('连接中 disconnect：open 迟到 resolve 后不进入 connected，端口被关闭', async () => {
    let release!: () => void
    factory.gate = new Promise<void>((resolve) => (release = resolve))
    const link = makeLink()
    const connecting = link.connect(makeServer())
    link.disconnect()
    expect(link.state()).toBe('disconnected')
    release()
    await connecting
    expect(link.state()).toBe('disconnected')
    expect(states.some((s) => s.state === 'connected')).toBe(false)
    expect(factory.lastPort?.closeCount).toBe(1)
  })

  it('切换服务器：connect 新服务器时自动断开旧端口', async () => {
    const link = makeLink()
    await link.connect(makeServer())
    const firstPort = factory.lastPort
    await link.connect(makeServer({ id: 'srv-2', serialPath: 'COM4' }))
    expect(firstPort?.closeCount).toBe(1)
    expect(link.connectedServerId()).toBe('srv-2')
  })

  // ---------------- 数据批处理 ----------------

  it('批处理窗口内的多次 data 合并为一次 onData（seq 从 1 递增）', async () => {
    const link = makeLink()
    await link.connect(makeServer())
    const port = factory.lastPort as FakeSerialPort
    port.emit('data', Buffer.from('Ubuntu '))
    port.emit('data', Buffer.from('22.04'))
    await vi.advanceTimersByTimeAsync(SERIAL_DATA_BATCH_MS)
    expect(dataEvents).toEqual([{ text: 'Ubuntu 22.04', seq: 1 }])
    port.emit('data', Buffer.from('$ '))
    await vi.advanceTimersByTimeAsync(SERIAL_DATA_BATCH_MS)
    expect(dataEvents).toEqual([
      { text: 'Ubuntu 22.04', seq: 1 },
      { text: '$ ', seq: 2 },
    ])
  })

  it('disconnect 前先 flush 残留数据，再进入 disconnected', async () => {
    const link = makeLink()
    await link.connect(makeServer())
    factory.lastPort?.emit('data', Buffer.from('tail'))
    link.disconnect()
    expect(dataEvents).toEqual([{ text: 'tail', seq: 1 }])
    expect(states.map((s) => s.state)).toEqual(['connecting', 'connected', 'disconnected'])
  })

  it('多字节 UTF-8 字符跨 data 包拆分：按字节缓冲解码不产生乱码（P2-B1）', async () => {
    const link = makeLink()
    await link.connect(makeServer())
    const port = factory.lastPort as FakeSerialPort
    // 「中」的 UTF-8 为 3 字节，拆到两个 chunk；拆分点落在字符中间
    const full = Buffer.from('日志中')
    port.emit('data', full.subarray(0, 5))
    port.emit('data', full.subarray(5))
    await vi.advanceTimersByTimeAsync(SERIAL_DATA_BATCH_MS)
    expect(dataEvents).toEqual([{ text: '日志中', seq: 1 }])
  })

  // ---------------- 命令下发 ----------------

  it('send：按服务器 lineEnding 追加换行写入（lf 与 crlf）', async () => {
    const link = makeLink()
    await link.connect(makeServer())
    link.send('show version')
    link.send('ls')
    expect(factory.lastPort?.written).toEqual(['show version\n', 'ls\n'])

    await link.connect(makeServer({ id: 'srv-2', lineEnding: 'crlf' }))
    link.send('dir')
    expect(factory.lastPort?.written).toEqual(['dir\r\n'])
  })

  it('未连接 send 抛错', () => {
    const link = makeLink()
    expect(() => link.send('ls')).toThrow('未连接')
  })

  // ---------------- 断开与异常 ----------------

  it('disconnect 幂等：重复断开不重复通知', async () => {
    const link = makeLink()
    await link.connect(makeServer())
    link.disconnect()
    link.disconnect()
    const disconnectedCount = states.filter((s) => s.state === 'disconnected').length
    expect(disconnectedCount).toBe(1)
  })

  it('端口 close 事件（拔线/占用消失）→ disconnected', async () => {
    const link = makeLink()
    await link.connect(makeServer())
    factory.lastPort?.emit('close')
    expect(link.state()).toBe('disconnected')
    expect(states.at(-1)?.state).toBe('disconnected')
  })

  it('端口 error 事件（连接后 I/O 错误）→ error 状态', async () => {
    const link = makeLink()
    await link.connect(makeServer())
    factory.lastPort?.emit('error', new Error('I/O failure'))
    expect(link.state()).toBe('error')
    expect(states.at(-1)).toMatchObject({ state: 'error', error: expect.stringContaining('I/O') })
  })
})
