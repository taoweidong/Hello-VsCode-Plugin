import { describe, expect, it } from 'vitest'
import { locateTaskLabel } from '../../../extension/features/taskExplorer/tasksJsonLocator'

/**
 * 轻量 JSONC 扫描定位 label 行（10 方案 §4.3 方案 D，§11.2 用例 ①-⑪）。
 * 核心约束：只有「字符串后随冒号」的 token 是键——命令/注释中的 label 字样不误命中。
 */

const lineOf = (text: string, offset: number): number =>
  text.slice(0, offset).split('\n').length - 1

describe('locateTaskLabel（JSONC 扫描定位）', () => {
  it('① 简单 label 定位到键所在行', () => {
    const text =
      '{\n  "version": "2.0.0",\n  "tasks": [\n    {\n      "label": "build"\n    }\n  ]\n}'
    const offset = locateTaskLabel(text, 'build')
    expect(offset).toBeDefined()
    expect(lineOf(text, offset!)).toBe(4)
    // 返回 label 键（开引号）的偏移
    expect(text.slice(offset!, offset! + 7)).toBe('"label"')
  })

  it('② 前后有注释不干扰', () => {
    const text = [
      '{',
      '  // 找 label？',
      '  /* label: "fake" */',
      '  "tasks": [',
      '    { "label": "build" } // label: "after"',
      '  ]',
      '}',
    ].join('\n')
    const offset = locateTaskLabel(text, 'build')
    expect(lineOf(text, offset!)).toBe(4)
  })

  it('③ 命令字符串内含 label 字样不误命中', () => {
    const text = [
      '{',
      '  "tasks": [',
      '    {',
      '      "command": "echo \\"label\\" done",',
      '      "label": "real"',
      '    }',
      '  ]',
      '}',
    ].join('\n')
    const offset = locateTaskLabel(text, 'real')
    expect(lineOf(text, offset!)).toBe(4)
    expect(locateTaskLabel(text, '"label\\" done')).toBeUndefined()
  })

  it('④ 转义引号/反斜杠解码后比较', () => {
    const text = '{ "tasks": [{ "label": "a \\"quote\\" \\\\ path" }] }'
    expect(locateTaskLabel(text, 'a "quote" \\ path')).toBeDefined()
    expect(locateTaskLabel(text, 'a \\"quote\\" path')).toBeUndefined()
  })

  it('⑤ \\uXXXX 解码后比较', () => {
    const text = '{ "tasks": [{ "label": "\\u4efb\\u52a1\\u4e00" }] }'
    expect(locateTaskLabel(text, '任务一')).toBeDefined()
  })

  it('⑥ 重复 label 取第一个', () => {
    const text = '{ "tasks": [{ "label": "build" }, { "label": "build" }] }'
    const offset = locateTaskLabel(text, 'build')
    expect(offset).toBe(text.indexOf('"label"'))
  })

  it('⑦ 缺失 label → undefined', () => {
    const text = '{ "tasks": [{ "command": "echo hi" }] }'
    expect(locateTaskLabel(text, 'echo hi')).toBeUndefined()
  })

  it('⑧ 截断/非法 JSON 不抛异常', () => {
    expect(() => locateTaskLabel('{ "tasks": [{ "label": "buil', 'other-task')).not.toThrow()
    expect(locateTaskLabel('{ "tasks": [{ "label": "buil', 'other-task')).toBeUndefined()
    expect(locateTaskLabel('', 'x')).toBeUndefined()
    expect(locateTaskLabel('///', 'x')).toBeUndefined()
    expect(locateTaskLabel('{ "a": "unclosed', 'x')).toBeUndefined()
  })

  it('⑨ BOM 开头容忍', () => {
    const text = `\uFEFF{ "tasks": [{ "label": "build" }] }`
    expect(locateTaskLabel(text, 'build')).toBeDefined()
  })

  it('⑩ 尾逗号容忍', () => {
    const text = '{ "tasks": [{ "label": "build", },], }'
    expect(locateTaskLabel(text, 'build')).toBeDefined()
  })

  it('⑪ label 键与值跨行/多余空白', () => {
    const text = '{\n  "tasks": [\n    {\n      "label"\n        :\n      "build"\n    }\n  ]\n}'
    const offset = locateTaskLabel(text, 'build')
    expect(lineOf(text, offset!)).toBe(3)
  })

  it('全部转义序列解码（b/f/n/r/t/未知转义/截断 u 转义/尾部反斜杠）', () => {
    const text = '{ "tasks": [{ "label": "a\\bb\\fc\\nd\\re\\tf\\/g\\qh\\u12i\\"" }] }'
    expect(locateTaskLabel(text, 'a\bb\fc\nd\re\tf/gqhu12i"')).toBeDefined()
    expect(locateTaskLabel('{ "tasks": [{ "label": "x\\', 'x')).toBeUndefined()
  })

  it('非字符串值（数字）跳过继续扫描', () => {
    const text = '{ "tasks": [{ "label": 42 }, { "label": "build" }] }'
    expect(locateTaskLabel(text, 'build')).toBeDefined()
  })
})
