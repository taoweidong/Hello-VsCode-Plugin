import type {
  SerialPortFactory,
  SerialPortInfoLike,
  SerialPortLike,
  SerialPortOpenOptions,
} from '../../../../extension/features/serialConsole/serialPortFactory'

/**
 * 串口测试替身（单测/CI 不加载原生模块）：
 * - FakeSerialPort：记录写入、可手动触发 data/close/error 事件；
 * - FakeSerialPortFactory：可编程 list/open 行为（延迟 open、打开失败）。
 */
export class FakeSerialPort implements SerialPortLike {
  readonly written: string[] = []
  closeCount = 0
  private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>()

  write(data: string): void {
    this.written.push(data)
  }

  close(cb?: (err?: Error) => void): void {
    this.closeCount += 1
    cb?.()
    this.emit('close')
  }

  on(event: string, cb: (...args: never[]) => void): void {
    const set = this.listeners.get(event) ?? new Set()
    set.add(cb as (...args: unknown[]) => void)
    this.listeners.set(event, set)
  }

  emit(event: 'data' | 'close' | 'error', ...args: unknown[]): void {
    for (const cb of this.listeners.get(event) ?? []) cb(...args)
  }
}

export class FakeSerialPortFactory implements SerialPortFactory {
  readonly openCalls: SerialPortOpenOptions[] = []
  /** 最近一次 open 返回的端口实例（供测试手动触发 data/close/error）。 */
  lastPort: FakeSerialPort | undefined
  /** 全部已打开端口（按 open 顺序，与 openCalls 一一对应；多连接交错场景用）。 */
  readonly opened: FakeSerialPort[] = []
  knownPorts: SerialPortInfoLike[] = []
  failOpenMessage: string | undefined
  /** open 前等待的闸门（模拟慢打开 / 连接中取消场景）。 */
  gate: Promise<void> | undefined

  async list(): Promise<SerialPortInfoLike[]> {
    return this.knownPorts
  }

  async open(options: SerialPortOpenOptions): Promise<SerialPortLike> {
    if (this.gate) await this.gate
    if (this.failOpenMessage) throw new Error(this.failOpenMessage)
    this.openCalls.push(options)
    const port = new FakeSerialPort()
    this.lastPort = port
    this.opened.push(port)
    return port
  }
}
