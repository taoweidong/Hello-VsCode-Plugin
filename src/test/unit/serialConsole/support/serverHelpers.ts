import type { SerialServer } from '../../../../extension/features/serialConsole/models'

/** 构造合法 SerialServer（各串口 spec 共用的最小工厂）。 */
export function makeServer(overrides: Partial<SerialServer> = {}): SerialServer {
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
