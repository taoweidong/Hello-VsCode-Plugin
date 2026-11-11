import { describe, expect, it } from 'vitest'
import { reasonOf } from '../../../extension/services/errors'

/**
 * 错误消息提取（P3-C1 收敛后的统一语义）：Error 取 message，其他值 String 化。
 * 降级提示 / 输出通道 / 协议 error 的文案都以它为准。
 */
describe('reasonOf', () => {
  it('Error 实例取 message', () => {
    expect(reasonOf(new Error('磁盘已满'))).toBe('磁盘已满')
  })

  it('Error 子类同样取 message', () => {
    expect(reasonOf(new TypeError('not a function'))).toBe('not a function')
  })

  it.each([
    ['字符串原样返回', 'plain text'],
    ['数字 String 化', 42],
    ['布尔 String 化', false],
    ['null', null],
    ['undefined', undefined],
    ['对象 JSON 化', { code: 1 }],
  ])('非 Error 值（%s）String 化', (_name, value) => {
    expect(reasonOf(value)).toBe(String(value))
  })

  it('message 为空的 Error 返回空字符串（不伪装成其他文案）', () => {
    expect(reasonOf(new Error(''))).toBe('')
  })
})
