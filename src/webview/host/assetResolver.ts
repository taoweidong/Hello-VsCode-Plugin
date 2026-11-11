import * as vscode from 'vscode'
import { findWebviewPage, type WebviewPageId } from '../pages'

/**
 * Webview 资源解析（docs/需求与优化方案/03 §5 / ADR-05）。
 *
 * Vite 构建产物带 hash 文件名，宿主不猜测文件名，
 * 统一读 dist/webview/.vite/manifest.json 解析每个入口的 script 与 css。
 */

/** manifest 中单个 chunk 的最小结构（宽松类型，字段逐个校验）。 */
interface ManifestChunk {
  file?: unknown
  css?: unknown
  imports?: unknown
  name?: unknown
  src?: unknown
}

export interface WebviewAssets {
  scriptUri: vscode.Uri
  styleUris: vscode.Uri[]
}

/** dist/webview 根目录（localResourceRoots 与资源解析的基准）。 */
export function webviewRootUri(extensionUri: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(extensionUri, 'dist', 'webview')
}

/** manifest 内存缓存：key 为 extensionUri.toString()，失败时剔除以便重试。 */
const manifestCache = new Map<string, Promise<Record<string, unknown>>>()

export function loadWebviewManifest(extensionUri: vscode.Uri): Promise<Record<string, unknown>> {
  const cacheKey = extensionUri.toString()
  const cached = manifestCache.get(cacheKey)
  if (cached) {
    return cached
  }
  const manifestUri = vscode.Uri.joinPath(webviewRootUri(extensionUri), '.vite', 'manifest.json')
  const pending = Promise.resolve(
    vscode.workspace.fs
      .readFile(manifestUri)
      .then(
        (bytes) => JSON.parse(new TextDecoder('utf-8').decode(bytes)) as Record<string, unknown>
      )
  ).catch((err: unknown) => {
    manifestCache.delete(cacheKey)
    const reason = err instanceof Error ? err.message : String(err)
    throw new Error(
      `读取 Webview manifest 失败（${manifestUri.fsPath}）：${reason}。请先执行 npm run build:webview。`
    )
  })
  manifestCache.set(cacheKey, pending)
  return pending
}

function isManifestChunk(v: unknown): v is ManifestChunk {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function findEntryChunk(
  manifest: Record<string, unknown>,
  entryId: string
): ManifestChunk | undefined {
  const page = findWebviewPage(entryId)
  // manifest 键可能是入口名，也可能是相对仓库根的入口源路径（取决于 Vite 版本），两者都尝试。
  const candidateKeys = [entryId, ...(page ? [page.entry] : [])]
  for (const key of candidateKeys) {
    const chunk = manifest[key]
    if (isManifestChunk(chunk)) {
      return chunk
    }
  }
  // 回退：按 chunk 的 name / src 字段匹配。
  for (const chunk of Object.values(manifest)) {
    if (
      isManifestChunk(chunk) &&
      (chunk.name === entryId || (page !== undefined && chunk.src === page.entry))
    ) {
      return chunk
    }
  }
  return undefined
}

/** 递归收集入口及其静态 import 链上的全部 css（共享 chunk 的样式挂在被 import 的 chunk 上）。 */
function collectCssFiles(
  manifest: Record<string, unknown>,
  chunk: ManifestChunk,
  visited: Set<string>
): string[] {
  const files: string[] = []
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
      if (isManifestChunk(imported)) {
        files.push(...collectCssFiles(manifest, imported, visited))
      }
    }
  }
  return files
}

/**
 * 解析指定入口的 script 与 css 资源，并转换为 webview 可用 URI。
 * 入口缺失时抛出带可用键清单的清晰错误。
 */
export function resolveEntryAssets(
  webview: Pick<vscode.Webview, 'asWebviewUri'>,
  manifest: Record<string, unknown>,
  entryId: WebviewPageId | string,
  webviewRoot: vscode.Uri
): WebviewAssets {
  const chunk = findEntryChunk(manifest, entryId)
  if (!chunk || typeof chunk.file !== 'string') {
    const available =
      Object.keys(manifest)
        .filter((key) => isManifestChunk(manifest[key]))
        .join('、') || '（空）'
    throw new Error(
      `Webview manifest 中找不到入口「${entryId}」的产物。manifest 可用键：${available}`
    )
  }
  const scriptUri = webview.asWebviewUri(resolveInsideRoot(webviewRoot, chunk.file))
  const styleUris = collectCssFiles(manifest, chunk, new Set([entryId])).map((cssFile) =>
    webview.asWebviewUri(resolveInsideRoot(webviewRoot, cssFile))
  )
  return { scriptUri, styleUris }
}

/**
 * 产物路径越界断言（17 方案阶段 4，P3-09 纵深防御）：manifest 的 file 字段
 * 不应包含 `..` 等越界段；joinPath 结果必须仍在 webviewRoot 内
 * （localResourceRoots 已兜底，此处防御 manifest 被篡改的纵深）。
 */
function resolveInsideRoot(webviewRoot: vscode.Uri, relativeFile: string): vscode.Uri {
  const resolved = vscode.Uri.joinPath(webviewRoot, relativeFile)
  const root = webviewRoot.fsPath.replace(/[\\/]+$/, '')
  const inside =
    resolved.fsPath === root ||
    resolved.fsPath.startsWith(`${root}\\`) ||
    resolved.fsPath.startsWith(`${root}/`)
  if (!inside) {
    throw new Error(`Webview manifest 产物路径越界：${relativeFile}`)
  }
  return resolved
}
