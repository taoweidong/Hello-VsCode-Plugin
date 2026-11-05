import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * E2E 静态服务器（零依赖，Node http）：
 * - 以 dist/webview 为根，静态产物**只**经 /webview/** 前缀路由（09 方案 §4.2 F3）；
 * - GET /harness/:pageId 动态生成加载壳：入口 script + 入口及其 import 链上的全部 css
 *   （解析逻辑对齐 src/webview/host/assetResolver.ts：入口键 → file + css + imports 链）；
 * - 加载壳注入与真实宿主一致的 CSP meta（镜像 src/webview/host/webviewHtml.ts，
 *   07 R-E-11）：harness 与宿主同策略，消除「harness 放行、宿主拦截」盲区
 *   （如静态 style 属性、unsafe-eval 在测试中放行而在真实宿主被拦）。
 *
 * 假绿消除（09 §4.2 F3）：v0.7.0 曾把静态路由挂在域根（/assets/** 直接命中），
 * 与 vite 默认 base '/' 改写出的站点根绝对 url(/assets/…) 恰好对齐——字体 404 在
 * e2e 中永远绿。现在产物一律走 /webview/** 子路径，CSS 内 url(/…) 解析到域根 ⇒ 404，
 * 配合 helpers.loadPage 的 document.fonts 断言即可捕获。
 *
 * 页面入口路径表镜像 src/webview/pages.ts（单一来源在该文件，此处为测试基建副本）。
 */

const PORT = Number(process.env.E2E_PORT || 3999)
const HOST = '127.0.0.1'
const ROOT = fileURLToPath(new URL('../../dist/webview/', import.meta.url))
/** 静态产物挂载前缀（模拟宿主 asWebviewUri 的「子路径资源根」语义）。 */
const STATIC_PREFIX = '/webview/'
/** harness 资源同源域（对应宿主 CSP 中的 cspSource）。 */
const CSP_ORIGIN = `http://${HOST}:${PORT}`

/**
 * CSP 策略（镜像 src/webview/host/webviewHtml.ts，07 R-E-11）。
 * 逐条对齐宿主，只把 cspSource 换成 harness 自身的同源域：
 * 若 harness 不设 CSP，静态 `style=""` 属性 / `eval()` 这类「宿主会拦、测试放行」的
 * 违例在 e2e 中永远发现不了（07 §2 盲区）。
 */
function buildCsp(nonce) {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}' ${CSP_ORIGIN}`,
    `style-src ${CSP_ORIGIN}`,
    `img-src ${CSP_ORIGIN} data:`,
    `font-src ${CSP_ORIGIN}`,
    "connect-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ')
}

/** 页面 id → Vite 入口源路径（src/webview/pages.ts 的镜像，用于 manifest 键匹配）。 */
const PAGE_ENTRY_PATHS = {
  gallery: 'src/webview/apps/gallery/main.ts',
  serialConsole: 'src/webview/apps/serialConsole/main.ts',
  taskManager: 'src/webview/apps/taskManager/main.ts',
}

const MIME_TYPES = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
}

function isChunk(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 与 assetResolver.findEntryChunk 同策略：入口名 / 入口源路径 / chunk.name / chunk.src。 */
function findEntryChunk(manifest, pageId) {
  const candidateKeys = [pageId, PAGE_ENTRY_PATHS[pageId]].filter(Boolean)
  for (const key of candidateKeys) {
    const chunk = manifest[key]
    if (isChunk(chunk)) {
      return chunk
    }
  }
  for (const chunk of Object.values(manifest)) {
    if (
      isChunk(chunk) &&
      (chunk.name === pageId ||
        chunk.src === PAGE_ENTRY_PATHS[pageId] ||
        (chunk.isEntry && chunk.name === pageId))
    ) {
      return chunk
    }
  }
  return undefined
}

/** 递归收集入口及静态 import 链上的全部 css（共享 chunk 样式挂在被 import 的 chunk 上）。 */
function collectCssFiles(manifest, chunk, visited) {
  const files = []
  if (Array.isArray(chunk.css)) {
    for (const css of chunk.css) {
      if (typeof css === 'string' && !files.includes(css)) {
        files.push(css)
      }
    }
  }
  if (Array.isArray(chunk.imports)) {
    for (const key of chunk.imports) {
      if (typeof key !== 'string' || visited.has(key)) {
        continue
      }
      visited.add(key)
      const imported = manifest[key]
      if (isChunk(imported)) {
        files.push(...collectCssFiles(manifest, imported, visited))
      }
    }
  }
  return files
}

async function buildHarnessHtml(pageId) {
  const manifest = JSON.parse(await readFile(resolve(ROOT, '.vite/manifest.json'), 'utf8'))
  const chunk = findEntryChunk(manifest, pageId)
  if (!chunk || typeof chunk.file !== 'string') {
    return { status: 404, body: `manifest 中找不到入口「${pageId}」的产物` }
  }
  const cssFiles = collectCssFiles(manifest, chunk, new Set([pageId]))
  // F3：链接走 /webview/ 前缀（非域根）——CSS 内部相对 url 正常解析、站点根绝对 url(/…) 404
  const cssLinks = cssFiles
    .map((file) => `<link rel="stylesheet" href="/webview/${file}">`)
    .join('\n    ')
  // 与宿主一致：每帧重新生成 nonce（宿主侧见 webviewController.renderHtml）
  const nonce = randomBytes(16).toString('hex')
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="${buildCsp(nonce)}">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>E2E harness: ${pageId}</title>
    ${cssLinks}
</head>
<body>
  <div id="app" data-page="${pageId}"></div>
  <script type="module" nonce="${nonce}" src="/webview/${chunk.file}"></script>
</body>
</html>`
  return { status: 200, body: html, contentType: MIME_TYPES['.html'] }
}

/**
 * 解析 /webview/... 前缀的静态请求到 ROOT 内的真实文件；越界或未带前缀返回 undefined。
 * 域根路径（如 /assets/...）不再路由 ⇒ CSS 内站点根绝对 url 会 404（F3 假绿消除）。
 */
function resolveStaticPath(pathname) {
  let decoded
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return undefined
  }
  if (!decoded.startsWith(STATIC_PREFIX)) {
    return undefined
  }
  const filePath = resolve(ROOT, `.${decoded.slice(STATIC_PREFIX.length - 1)}`)
  const rootWithSep = ROOT.endsWith(sep) ? ROOT : ROOT + sep
  if (filePath !== ROOT && !filePath.startsWith(rootWithSep)) {
    return undefined
  }
  return filePath
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${HOST}:${PORT}`)
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' }).end('method not allowed')
      return
    }

    // 就绪探测 / 索引页
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const links = Object.keys(PAGE_ENTRY_PATHS).map(
        (id) => `<li><a href="/harness/${id}">${id}</a></li>`
      )
      res
        .writeHead(200, { 'content-type': MIME_TYPES['.html'] })
        .end(
          `<!DOCTYPE html><html><body><h1>webview e2e harness</h1><ul>${links.join('')}</ul></body></html>`
        )
      return
    }

    // 动态加载壳
    const harnessMatch = url.pathname.match(/^\/harness\/([A-Za-z0-9_-]+)\/?$/)
    if (harnessMatch) {
      const result = await buildHarnessHtml(harnessMatch[1])
      res
        .writeHead(result.status, {
          'content-type': result.contentType || 'text/plain; charset=utf-8',
        })
        .end(result.body)
      return
    }

    // 静态产物（仅 /webview/** 前缀，限制在 ROOT 内；域根请求一律 404）
    const filePath = resolveStaticPath(url.pathname)
    if (!filePath) {
      res
        .writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        .end(`not found: ${url.pathname}`)
      return
    }
    let body
    try {
      body = await readFile(filePath)
    } catch {
      res
        .writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        .end(`not found: ${url.pathname}`)
      return
    }
    res
      .writeHead(200, {
        'content-type': MIME_TYPES[extname(filePath).toLowerCase()] || 'application/octet-stream',
      })
      .end(body)
  } catch (error) {
    res
      .writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      .end(`server error: ${String(error)}`)
  }
})

server.listen(PORT, HOST, () => {
  process.stdout.write(`[e2e-server] http://${HOST}:${PORT} root=${ROOT}\n`)
})
