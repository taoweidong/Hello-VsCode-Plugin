import { createRequire } from 'node:module'
import { reasonOf } from '../../services/errors'
import type { Parity } from './models'

/**
 * 串口传输抽象（docs/superpowers/specs/2026-10-24-serial-command-console-design.md §5.3）。
 *
 * 业务与测试只依赖本接口：单测注入 Fake 实现，CI 与单元测试不加载原生模块；
 * 生产实现 createNodeSerialPortFactory 惰性 require('serialport')（esbuild external，
 * 运行时从扩展 node_modules 解析），加载失败抛可操作的 SerialPortUnavailableError。
 */

export interface SerialPortInfoLike {
  path: string
  manufacturer?: string
}

export interface SerialPortOpenOptions {
  path: string
  baudRate: number
  dataBits: 8 | 7 | 6 | 5
  stopBits: 1 | 2
  parity: Parity
  /** 是否启用硬件流控（RTS/CTS）。 */
  flowControl: boolean
}

/** 串口流的最小结构面（对齐 serialport 的 SerialPortStream 事件子集）。 */
export interface SerialPortLike {
  write(data: string): void
  close(cb?: (err?: Error) => void): void
  on(event: 'data', cb: (chunk: Buffer) => void): void
  on(event: 'close', cb: () => void): void
  on(event: 'error', cb: (err: Error) => void): void
}

export interface SerialPortFactory {
  /** 枚举本机串口（页面的「检测串口」）。 */
  list(): Promise<SerialPortInfoLike[]>
  /** 打开串口；失败（不存在 / 被占用 / 无权限）以 rejected Promise 返回。 */
  open(options: SerialPortOpenOptions): Promise<SerialPortLike>
}

/** serialport 模块加载失败（未安装 / 平台缺预编译二进制），扩展其余功能不受影响。 */
export class SerialPortUnavailableError extends Error {
  constructor(cause: unknown) {
    super(
      '无法加载串口模块 serialport' +
        `（${reasonOf(cause)}）。` +
        '请确认扩展依赖完整安装，且当前平台存在预编译二进制（win32-x64 / linux-x64 等）。'
    )
    this.name = 'SerialPortUnavailableError'
  }
}

/** serialport 的 SerialPort 构造器结构面：实例方法 + v12 的静态 list（模块级不导出 list）。 */
interface SerialPortCtor {
  new (options: Record<string, unknown>): SerialPortStreamLike
  list(): Promise<SerialPortInfoLike[]>
}

/** serialport 模块的最小结构面（类型本地声明，避免静态 import 原生包）。 */
interface SerialPortModule {
  SerialPort: SerialPortCtor
}

interface SerialPortStreamLike {
  write(data: string, cb?: (err?: Error | null) => void): unknown
  close(cb?: (err?: Error | null) => void): unknown
  on(event: string, cb: (...args: never[]) => void): unknown
}

export type SerialPortModuleLoader = () => SerialPortModule

/** 默认加载器：惰性 require（cjs 产物中 __filename 可用，据此定位扩展根 node_modules）。 */
function defaultLoadModule(): SerialPortModule {
  const requireFromHere = createRequire(__filename)
  try {
    return requireFromHere('serialport') as unknown as SerialPortModule
  } catch (err) {
    throw new SerialPortUnavailableError(err)
  }
}

/** 生产工厂：包装 serialport v12 流式 API（N-API 预编译，跨 Node 版本 ABI 稳定）。 */
export function createNodeSerialPortFactory(
  loadModule: SerialPortModuleLoader = defaultLoadModule
): SerialPortFactory {
  return {
    async list(): Promise<SerialPortInfoLike[]> {
      return loadModule().SerialPort.list()
    },

    async open(options: SerialPortOpenOptions): Promise<SerialPortLike> {
      const { SerialPort } = loadModule()
      return await new Promise<SerialPortLike>((resolve, reject) => {
        let settled = false
        const port = new SerialPort({
          path: options.path,
          baudRate: options.baudRate,
          dataBits: options.dataBits,
          stopBits: options.stopBits,
          parity: options.parity,
          flowControl: options.flowControl,
          autoOpen: true,
        })
        port.on('open', () => {
          settled = true
          resolve(port as unknown as SerialPortLike)
        })
        port.on('error', (err: unknown) => {
          if (!settled) {
            settled = true
            reject(err instanceof Error ? err : new Error(String(err)))
          }
        })
      })
    },
  }
}
