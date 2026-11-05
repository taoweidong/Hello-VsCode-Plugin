import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WEBVIEW_PAGES, findWebviewPage } from '../../../webview/pages'

/**
 * Webview 页面注册表（此前仅间接触达）：单一来源的数据不变式——
 * id 唯一、入口文件真实存在（Vite 多入口与宿主解析的共同前提）。
 */
describe('WEBVIEW_PAGES', () => {
  it('注册表恰为 3 页且 id 唯一', () => {
    expect(WEBVIEW_PAGES.map((page) => page.id)).toEqual([
      'gallery',
      'serialConsole',
      'taskManager',
    ])
    expect(new Set(WEBVIEW_PAGES.map((page) => page.id)).size).toBe(WEBVIEW_PAGES.length)
  })

  it('每页 entry 指向真实存在的入口文件', () => {
    for (const page of WEBVIEW_PAGES) {
      expect(existsSync(join(process.cwd(), page.entry)), page.entry).toBe(true)
    }
  })

  it('findWebviewPage：命中返回定义；未知 id 返回 undefined', () => {
    expect(findWebviewPage('taskManager')).toEqual({
      id: 'taskManager',
      title: '任务管理',
      entry: 'src/webview/apps/taskManager/main.ts',
    })
    expect(findWebviewPage('nope')).toBeUndefined()
  })
})
