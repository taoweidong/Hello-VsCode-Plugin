/**
 * 轻量 JSONC 扫描：在 `.vscode/tasks.json` 文本中定位任务 `"label"` 键的偏移
 * （v2.3，10 方案 §4.3 方案 D）。
 *
 * 设计约束（只读辅助能力，失败可降级为打开文件顶部）：
 * - 只认双引号字符串、行注释与块注释、反斜杠转义；不构建完整 AST、不校验
 *   JSON 合法性——BOM、尾逗号、注释、截断文件一律容忍，绝不抛异常；
 * - 只把「字符串后紧跟冒号」的 token 当作键处理，命令/注释中的 `label` 字样
 *   不会误命中（正则方案 F 的缺陷）；
 * - 值按 JSON 转义（`\" \\ \/ \b \f \n \r \t \uXXXX`）解码后与任务名全等比较；
 * - 重复 label（VS Code 本身会报歧义）取第一个匹配。
 */

interface StringToken {
  /** 解码后的内容（不含两端引号） */
  value: string
  /** 结束位置（闭引号之后，或文本末尾——容忍未闭合字符串） */
  end: number
}

function isWs(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r'
}

/** 从 start（开引号）读取一个字符串 token；内容保留转义序列原文，由 decode 解码 */
function readStringToken(text: string, start: number): StringToken {
  let i = start + 1
  let raw = ''
  while (i < text.length) {
    const ch = text[i]
    if (ch === '\\') {
      raw += ch
      if (i + 1 < text.length) {
        raw += text[i + 1]
        i += 2
      } else {
        i += 1 // 截断的转义：容忍，循环自然结束
      }
    } else if (ch === '"') {
      return { value: decodeEscapes(raw), end: i + 1 }
    } else {
      raw += ch
      i += 1
    }
  }
  return { value: decodeEscapes(raw), end: text.length }
}

/** 解码 `\" \\ \/ \b \f \n \r \t \uXXXX`；未知转义丢弃反斜杠（宽松，不抛异常） */
function decodeEscapes(raw: string): string {
  let result = ''
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]
    if (ch !== '\\' || i + 1 >= raw.length) {
      result += ch
      continue
    }
    const next = raw[i + 1]
    i += 1
    switch (next) {
      case '"':
        result += '"'
        break
      case '\\':
        result += '\\'
        break
      case '/':
        result += '/'
        break
      case 'b':
        result += '\b'
        break
      case 'f':
        result += '\f'
        break
      case 'n':
        result += '\n'
        break
      case 'r':
        result += '\r'
        break
      case 't':
        result += '\t'
        break
      case 'u': {
        const hex = raw.slice(i + 1, i + 5)
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          result += String.fromCharCode(parseInt(hex, 16))
          i += 4
        } else {
          result += next // 截断的 \u：按字面保留
        }
        break
      }
      default:
        result += next
        break
    }
  }
  return result
}

/**
 * 返回任务 `"label"` 键（开引号）在文本中的偏移；找不到返回 undefined。
 * @param text 文件全文（可为任意 JSONC）
 * @param taskName 任务名（`task.name`，与 label 值解码后全等比较）
 */
export function locateTaskLabel(text: string, taskName: string): number | undefined {
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') {
        i += 1
      }
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end === -1 ? text.length : end + 2
    } else if (ch === '"') {
      const start = i
      const token = readStringToken(text, i)
      i = token.end
      // 只有「后随冒号」的字符串是键——值字符串/注释中的 label 字样在此被排除
      let j = i
      while (j < text.length && isWs(text[j])) {
        j += 1
      }
      if (text[j] === ':' && token.value === 'label') {
        let k = j + 1
        while (k < text.length && isWs(text[k])) {
          k += 1
        }
        if (text[k] === '"' && readStringToken(text, k).value === taskName) {
          return start
        }
      }
    } else {
      i += 1
    }
  }
  return undefined
}
