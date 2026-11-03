import { describe, expect, it } from 'vitest'
import { ICON_NAMES, iconClass } from '../../../webview/ui/iconNames'

/**
 * 语义图标映射（此前零覆盖）：codicon 类名拼装、语义名唯一性。
 * （此前零覆盖：codicon 类名拼装、语义名唯一性。）
 */
describe('iconNames', () => {
  it('iconClass 产出完整 codicon 类（基类 + 语义名映射）', () => {
    expect(iconClass('delete')).toBe('codicon codicon-trash')
    expect(iconClass('chevronDown')).toBe('codicon codicon-chevron-down')
    expect(iconClass('add')).toBe('codicon codicon-add')
  })

  it('语义名唯一且 codicon 名唯一（同一概念全插件同图标的前提）', () => {
    const semanticNames = Object.keys(ICON_NAMES)
    expect(new Set(semanticNames).size).toBe(semanticNames.length)
    const codiconNames = Object.values(ICON_NAMES)
    expect(new Set(codiconNames).size).toBe(codiconNames.length)
  })

  it('关键语义名在表中（页面与组件使用的公共面）', () => {
    for (const name of ['send', 'refresh', 'save', 'server', 'plug', 'terminal', 'history']) {
      expect(ICON_NAMES).toHaveProperty(name)
    }
  })
})
