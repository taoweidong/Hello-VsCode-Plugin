import { describe, expect, it } from 'vitest'
import {
  BAUD_RATES,
  DEFAULT_SERIAL_PARAMS,
  LINE_ENDINGS,
  LINE_ENDING_CHARS,
  createServerId,
  isDataBits,
  isFlowControl,
  isLineEnding,
  isParity,
  isStopBits,
} from '../../../extension/features/serialConsole/models'

/**
 * 串口数据模型（此前无专属 spec）：换行符映射 / 默认参数 / id 生成 /
 * 五个类型守卫的完整正反例。
 */

describe('models：常量与映射', () => {
  it('LINE_ENDING_CHARS 覆盖全部 LINE_ENDINGS 且映射正确', () => {
    expect(LINE_ENDING_CHARS).toEqual({ lf: '\n', crlf: '\r\n', cr: '\r' })
    expect(Object.keys(LINE_ENDING_CHARS).sort()).toEqual([...LINE_ENDINGS].sort())
  })

  it('BAUD_RATES 有序且包含默认值', () => {
    expect(BAUD_RATES).toContain(DEFAULT_SERIAL_PARAMS.baudRate)
    expect([...BAUD_RATES]).toEqual([...BAUD_RATES].sort((a, b) => a - b))
  })

  it('DEFAULT_SERIAL_PARAMS 为 115200 8N1 无流控', () => {
    expect(DEFAULT_SERIAL_PARAMS).toMatchObject({
      baudRate: 115200,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      flowControl: 'none',
      lineEnding: 'lf',
      autoLogin: false,
    })
  })

  it('createServerId 生成 UUID 形态且不重复', () => {
    const a = createServerId()
    const b = createServerId()
    expect(a).toMatch(/^[0-9a-f-]{36}$/)
    expect(a).not.toBe(b)
  })
})

describe('models：类型守卫', () => {
  it('isLineEnding / isParity / isFlowControl：正反例', () => {
    expect(isLineEnding('lf') && isLineEnding('crlf') && isLineEnding('cr')).toBe(true)
    expect(isLineEnding('LF')).toBe(false)
    expect(isLineEnding('newline')).toBe(false)
    expect(isParity('none') && isParity('even') && isParity('odd')).toBe(true)
    expect(isParity('random')).toBe(false)
    expect(isFlowControl('none') && isFlowControl('hardware')).toBe(true)
    expect(isFlowControl('software')).toBe(false)
  })

  it('isDataBits / isStopBits：仅声明值通过', () => {
    expect([8, 7, 6, 5].every(isDataBits)).toBe(true)
    expect(isDataBits(9)).toBe(false)
    expect(isDataBits('8')).toBe(false)
    expect(isStopBits(1) && isStopBits(2)).toBe(true)
    expect(isStopBits(0)).toBe(false)
  })
})
