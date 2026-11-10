import { describe, expect, it } from 'vitest'
import {
  coerceServerDraft,
  SERVER_FIELD_DEFS,
} from '../../extension/features/serialConsole/serverSchema'

/** 服务器领域校验与清洗（保存路径宁严勿宽；password 不进 draft）。 */
describe('coerceServerDraft', () => {
  const valid = {
    name: '服务器甲',
    serialPath: 'COM3',
    baudRate: '115200',
    dataBits: '8',
    stopBits: '1',
    parity: 'none',
    flowControl: 'none',
    lineEnding: 'lf',
    autoLogin: 'false',
    username: '',
    description: '带外管理口',
  }

  it('合法输入：select 字符串转回领域类型，输出完整 SerialServerDraft', () => {
    const result = coerceServerDraft(valid)
    expect(result).toEqual({
      ok: true,
      draft: {
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
        description: '带外管理口',
      },
    })
  })

  it('name / serialPath 必填：空值返回 field 定位错误', () => {
    expect(coerceServerDraft({ ...valid, name: '  ' })).toMatchObject({
      ok: false,
      field: 'name',
    })
    expect(coerceServerDraft({ ...valid, serialPath: '' })).toMatchObject({
      ok: false,
      field: 'serialPath',
    })
  })

  it('自动登录开启时 username 必填', () => {
    const result = coerceServerDraft({ ...valid, autoLogin: 'true', username: '' })
    expect(result).toMatchObject({ ok: false, field: 'username' })
    const ok = coerceServerDraft({ ...valid, autoLogin: true, username: 'root' })
    expect(ok).toMatchObject({ ok: true })
    if (ok.ok) expect(ok.draft.autoLogin).toBe(true)
  })

  it('select 非法值直接报错，不静默回退', () => {
    expect(coerceServerDraft({ ...valid, baudRate: 12345 })).toMatchObject({
      ok: false,
      field: 'baudRate',
    })
    expect(coerceServerDraft({ ...valid, parity: 'mark' })).toMatchObject({
      ok: false,
      field: 'parity',
    })
    expect(coerceServerDraft({ ...valid, lineEnding: 'nl' })).toMatchObject({
      ok: false,
      field: 'lineEnding',
    })
  })

  it('number 形态的 select 值同样接受（表单外的程序化保存）', () => {
    const result = coerceServerDraft({ ...valid, baudRate: 9600, dataBits: 7, stopBits: 2 })
    expect(result).toMatchObject({ ok: true })
    if (result.ok) {
      expect(result.draft.baudRate).toBe(9600)
      expect(result.draft.dataBits).toBe(7)
      expect(result.draft.stopBits).toBe(2)
    }
  })

  it('password 永不进入 draft（即便混入输入）', () => {
    const result = coerceServerDraft({ ...valid, password: 'should-be-stripped' })
    expect(result.ok).toBe(true)
    if (result.ok) expect('password' in result.draft).toBe(false)
  })

  it('未知 string/number/boolean 字段透传保留', () => {
    const result = coerceServerDraft({ ...valid, rack: 'A01', slot: 3 })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.draft.rack).toBe('A01')
      expect(result.draft.slot).toBe(3)
    }
  })

  it('SERVER_FIELD_DEFS 与 coerce 处理字段闭合（password/hint 一致性）', () => {
    const keys = SERVER_FIELD_DEFS.map((def) => def.key)
    expect(keys).toContain('password')
    expect(keys).toEqual([
      'name',
      'serialPath',
      'baudRate',
      'dataBits',
      'stopBits',
      'parity',
      'flowControl',
      'lineEnding',
      'autoLogin',
      'username',
      'password',
      'description',
    ])
  })
})

describe('未知键透传与 secret-like 过滤（17 方案阶段 1，P2-B5）', () => {
  it('secret-like 键（userPassword / adminPassword 等变体）不透传到 draft，普通未知键保留', () => {
    const result = coerceServerDraft({
      ...validDraft,
      userPassword: 'leak',
      adminPassword: 'leak2',
      user_password: 'leak3',
      customNote: '保留',
    })
    expect(result).toMatchObject({ ok: true })
    if (!result.ok) return
    // webview 消息是不可信输入：任何 password 变体都不得明文落进数据文件
    expect(result.draft.userPassword).toBeUndefined()
    expect(result.draft.adminPassword).toBeUndefined()
    expect(result.draft.user_password).toBeUndefined()
    expect(result.draft.customNote).toBe('保留')
  })
})

/** 本文件内 describe 局部 valid 的模块级副本（追加分组的独立夹具）。 */
const validDraft = {
  name: '服务器甲',
  serialPath: 'COM3',
  baudRate: '115200',
  dataBits: '8',
  stopBits: '1',
  parity: 'none',
  flowControl: 'none',
  lineEnding: 'lf',
  autoLogin: 'false',
  username: '',
  description: '带外管理口',
}
