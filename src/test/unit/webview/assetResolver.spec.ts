import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type * as vscode from 'vscode'
import { Uri } from '../stubs/vscode'
import {
  loadWebviewManifest,
  resolveEntryAssets,
  webviewRootUri,
} from '../../../webview/host/assetResolver'

/** assetResolver（03 §5 / ADR-05）：manifest 读取缓存与入口资源解析。
 * 类型说明：运行时经 vitest alias，'vscode' 即测试桩；类型层的桩 Uri 与
 * @types/vscode 的 Uri 结构不同，跨边界统一经 unknown 断言。
 */
const tempDirs: string[] = []

const fakeUri = (path: string) => Uri.file(path) as unknown as vscode.Uri

function makeTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'webview-assets-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('loadWebviewManifest', () => {
  it('从 dist/webview/.vite/manifest.json 读取并解析', async () => {
    const root = makeTempRoot()
    mkdirSync(join(root, 'dist', 'webview', '.vite'), { recursive: true })
    writeFileSync(
      join(root, 'dist', 'webview', '.vite', 'manifest.json'),
      JSON.stringify({ gallery: { file: 'assets/g.js' } })
    )
    const manifest = await loadWebviewManifest(fakeUri(root))
    expect(manifest['gallery']).toEqual({ file: 'assets/g.js' })
  })

  it('文件缺失时抛清晰错误（提示执行构建），且失败不驻留缓存', async () => {
    const root = makeTempRoot()
    const extensionUri = fakeUri(root)
    await expect(loadWebviewManifest(extensionUri)).rejects.toThrow(/manifest 失败.*build:webview/)
    // 补建文件后同一 extensionUri 可重试成功（失败缓存已剔除）
    mkdirSync(join(root, 'dist', 'webview', '.vite'), { recursive: true })
    writeFileSync(
      join(root, 'dist', 'webview', '.vite', 'manifest.json'),
      JSON.stringify({ a: { file: 'a.js' } })
    )
    await expect(loadWebviewManifest(extensionUri)).resolves.toEqual({ a: { file: 'a.js' } })
  })
})

describe('webviewRootUri', () => {
  it('指向 dist/webview', () => {
    expect(webviewRootUri(fakeUri('E:/ext')).fsPath.replace(/\\/g, '/')).toBe('E:/ext/dist/webview')
  })
})

describe('resolveEntryAssets', () => {
  const webview = { asWebviewUri: (uri: unknown) => uri } as unknown as Pick<
    vscode.Webview,
    'asWebviewUri'
  >
  const root = fakeUri('E:/ext')
  const webviewRoot = webviewRootUri(root)

  it('按入口名（manifest 键 = 入口名）解析 script 与 css', () => {
    const manifest = {
      gallery: { file: 'assets/gallery-1.js', css: ['assets/gallery-1.css'] },
    }
    const assets = resolveEntryAssets(webview, manifest, 'gallery', webviewRoot)
    expect(assets.scriptUri.fsPath.replace(/\\/g, '/')).toBe(
      'E:/ext/dist/webview/assets/gallery-1.js'
    )
    expect(assets.styleUris.map((uri) => uri.fsPath.replace(/\\/g, '/'))).toEqual([
      'E:/ext/dist/webview/assets/gallery-1.css',
    ])
  })

  it('manifest 产物路径越界（..）→ 抛清晰错误（P3-09 纵深防御）', () => {
    const manifest = { gallery: { file: '../evil.js' } }
    expect(() => resolveEntryAssets(webview, manifest, 'gallery', webviewRoot)).toThrow('越界')
  })

  it('按入口源路径键解析（Vite 常见格式：键 = src 相对路径），并递归收集共享 chunk 的 css', () => {
    const manifest = {
      'src/webview/apps/serialConsole/main.ts': {
        file: 'assets/serialConsole-2.js',
        css: ['assets/serialConsole-2.css'],
        imports: ['__shared'],
      },
      __shared: {
        file: 'assets/shared-3.js',
        css: ['assets/tokens-4.css', 'assets/codicon-5.css'],
      },
    }
    const assets = resolveEntryAssets(webview, manifest, 'serialConsole', webviewRoot)
    expect(assets.scriptUri.fsPath).toContain('serialConsole-2.js')
    expect(assets.styleUris.map((uri) => uri.fsPath)).toEqual(
      expect.arrayContaining(
        ['serialConsole-2.css', 'tokens-4.css', 'codicon-5.css'].map((f) =>
          join(webviewRoot.fsPath, 'assets', f)
        )
      )
    )
  })

  it('共享 chunk 环形引用不死循环', () => {
    const manifest = {
      gallery: { file: 'assets/g.js', css: [], imports: ['a', 'gallery'] },
      a: { file: 'assets/a.js', css: ['assets/a.css'], imports: ['gallery'] },
    }
    const assets = resolveEntryAssets(webview, manifest, 'gallery', webviewRoot)
    expect(assets.styleUris).toHaveLength(1)
  })

  it('入口缺失时抛出带可用键清单的错误', () => {
    const manifest = { other: { file: 'assets/o.js' } }
    expect(() => resolveEntryAssets(webview, manifest, 'gallery', webviewRoot)).toThrow(
      /找不到入口「gallery」.*other/
    )
  })
})
