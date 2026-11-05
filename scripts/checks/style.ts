/**
 * 门禁「Webview 样式门禁」检查（E-2 / 04 §9）：对 src/webview 页面源码执行样式规约校验，
 * 构建后再对 dist/webview 产物做 CSP 扫描。
 *
 * 对应 docs/需求与优化方案/04-VSCode原生设计系统.md §9 与 07 复审 R-E-4/R-E-5/R-E-12：
 *   1. 除 ui/tokens.css 外禁止硬编码颜色：`#[hex]` / `rgb(` / `hsl(`
 *      （检查 .vue 的 <style> 块与 .css 全文；.ts 模板字面量暂不扫，先宽后严）；
 *   2. 禁止 `v-html` / `innerHTML`（XSS 面；.vue 模板与 .ts 全文）；
 *   3. import 包名前缀白名单：仅 `vue` / `@vscode/codicons` 包族 / 项目内相对路径，
 *      禁止 `node:` 前缀与任何其他裸包名（UI 框架，04 §9.3；07 R-E-4 升级为
 *      「包名前缀 + 全 import 形态覆盖」）——`host/` 为宿主控制器目录，随扩展宿主编译、
 *      本就 import vscode 与 node: 内置模块，不参与页面 bundle 白名单；
 *   4. 尺寸令牌强制（07 R-U-4 升级）：`padding` / `margin` / `gap` / `border-radius` /
 *      `height` / `min-height` / `max-height` / `width` / `min-width` / `max-width` /
 *      `font-size` 声明中的 px 值必须走 `var(--ui-*)`
 *      ——升级前是「px 值 ∈ 刻度 {4,8,12,16,24} 即放行」的白名单制，`gap: 16px` 合法通过、
 *      圆角/高宽/字号根本不在覆盖内；升级后刻度白名单作废（现值已全部令牌化），
 *      新规格一律先在 ui/tokens.css 登记（04 §9.4）。
 *      负尺寸（如 -1px 焦点环对齐 / 视觉隐藏）不属尺寸刻度，仍不检查；
 *   5. dist 产物 CSP 扫描（07 R-E-5 / 04 §9.5）：构建后扫描 dist/webview/** 的
 *      js/css/html，禁 `eval(` / `new Function` / `unsafe-eval` / `unsafe-inline`；
 *   6. 禁止 .vue 模板静态 `style="..."` 属性（07 R-E-12 / 07 §2 残留风险 1）：
 *      宿主 CSP `style-src` 无 `'unsafe-inline'`，静态 style 属性会被静默拦截；
 *      `:style` / `v-bind:style` 绑定编译为 CSSOM（setProperty），不受影响、不误伤。
 *   7. dist 产物 CSS 禁止站点根绝对资源引用 `url(/…)`（09 方案 §4.2 F2）：
 *      webview 无 <base>、资源根是 dist/webview，`url(/assets/…)` 必 404
 *      （正是 v0.7.0 全图标不显示的病根）；红线锚在构建产物上防回归。
 *   8. 禁止 .vue / .ts 源码调用浏览器模态 `window.confirm / alert / prompt`
 *      （第五轮评估 P0：webview 沙箱 iframe 无 allow-modals，模态被静默忽略——
 *      confirm 恒返回 false，依赖它的删除 / 重置在真实产品里永远无法执行；
 *      确认交互一律改用页内两段式布防确认 composables/useTwoStepConfirm.ts
 *      或经宿主 showWarningMessage 模态，agent.md 硬性规约 9）。
 * 违规统一收集「文件:行」后一次性 assert 抛出（fail-fast 由门禁步骤捕获）。
 */
import assert from 'node:assert'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import * as path from 'node:path'

/**
 * 规则 4 的检查面（07 R-U-4）：间距之外，圆角 / 高度 / 宽度 / 字号 也必须是
 * `var(--ui-*)` —— 一轮只覆盖 padding/margin/gap，`border-radius: 2px` 之类
 * 几何规格散落在各组件与页面里，改设计系统时无从统一。
 */
const GEOMETRY_DECL_RE =
  /(?:^|[{;])\s*((?:min-|max-)?(?:padding|margin|gap|border-radius|height|width|font-size))[a-z-]*\s*:([^;{}]*)/g
/** 负尺寸（-1px 焦点环对齐 / 视觉隐藏）不是尺寸刻度，豁免（与升级前一致）。 */
const NEGATIVE_PX_RE = /(?<![\w-])(\d+)px/g

/**
 * 规则 1：硬编码颜色判定（07 R-E-9 收紧误伤面）。
 * 升级前用裸正则整行匹配，`url(#gradient)`、`content: "#123"`、CSS 选择器 `#app`
 * 里的非颜色 `#` 一律误报；这里先剔除 url() 与字符串字面量，再要求 `#hex`
 * 处于**值位置**（前一有效字符是 `:` / `,` / `(`），才判定为颜色。
 */
function hasHardcodedColor(raw: string): boolean {
  const stripped = raw
    .replace(/url\([^)]*\)/g, '') // url(#…) 是 SVG 引用，不是颜色
    .replace(/(['"])[^'"]*\1/g, '') // 字符串字面量（content: "#123"）不是颜色
  for (const match of stripped.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
    const before = stripped.slice(0, match.index).trimEnd()
    // 值位置：紧跟在属性冒号 / 逗号（回退值）/ 左括号之后才是颜色
    if (/[:,(]$/.test(before)) {
      return true
    }
  }
  return /rgb\(/.test(stripped) || /hsl\(/.test(stripped)
}
/** import 包名前缀白名单（04 §9.3 + 07 R-E-4：UI 框架仅 vue / @vscode/codicons 包族）。 */
const ALLOWED_IMPORT_PACKAGES = new Set(['vue', '@vscode/codicons'])
/** 唯一允许出现颜色回退值的令牌文件（相对 src/webview，POSIX 风格）。 */
const TOKENS_FILE = 'ui/tokens.css'
/** 宿主控制器目录名（import 白名单豁免，见文件头第 3 条说明）。 */
const HOST_DIR = 'host'
/** dist 产物 CSP 扫描根目录（相对仓库根；07 R-E-5）。 */
const DIST_WEBVIEW_DIR = ['dist', 'webview']
/** dist 产物中禁用的 CSP 危险形态（07 R-E-5 / 04 §9.5）。 */
const DIST_FORBIDDEN_RE = /\beval\s*\(|new Function|unsafe-eval|unsafe-inline/
/** dist 产物 CSS 中禁用的站点根绝对资源引用（09 方案 §4.2 F2）。 */
const DIST_ROOT_ABSOLUTE_URL_RE = /url\(\s*['"]?\//
/** 模板静态 style 属性（07 R-E-12；`:style` / `v-bind:style` 前缀字符排除，不误伤 CSSOM 绑定）。 */
const STATIC_STYLE_ATTR_RE = /(?<![:\w-])style\s*=\s*['"]/
/** 浏览器模态调用（第五轮评估 P0 / agent.md 硬性规约 9；webview 沙箱下恒被忽略）。 */
const BROWSER_MODAL_RE = /\bwindow\s*\.\s*(?:confirm|alert|prompt)\s*\(/

interface WebviewSourceFile {
  /** 相对 src/webview 的 POSIX 路径（用于错误信息与豁免判定）。 */
  rel: string
  abs: string
}

function toPosix(value: string): string {
  return value.split('\\').join('/')
}

/** 递归收集 src/webview 下的 .vue / .css / .ts 源文件（rel 始终相对根目录，保证豁免判定稳定）。 */
function collectSourceFiles(rootDir: string): WebviewSourceFile[] {
  const out: WebviewSourceFile[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(abs)
      } else if (/\.(vue|css|ts)$/.test(entry.name)) {
        out.push({ rel: toPosix(path.relative(rootDir, abs)), abs })
      }
    }
  }
  walk(rootDir)
  return out
}

/** 提取 .vue 中 <style>…</style> 区间内的行（简单状态机；单行开闭块同样支持）。 */
function vueStyleLines(lines: string[]): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = []
  let inStyle = false
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]
    const opens = /<style[\s>]/.test(text)
    const closes = /<\/style>/.test(text)
    if (inStyle || opens) {
      out.push({ line: i + 1, text })
    }
    if (opens && !closes) {
      inStyle = true
    } else if (closes) {
      inStyle = false
    }
  }
  return out
}

/** 提取 .vue 中 <template>…</template> 区间内的行（与 vueStyleLines 对称，供第 6 条扫描）。 */
function vueTemplateLines(lines: string[]): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = []
  let inTemplate = false
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]
    const opens = /<template[\s>]/.test(text)
    const closes = /<\/template>/.test(text)
    if (inTemplate || opens) {
      out.push({ line: i + 1, text })
    }
    if (opens && !closes) {
      inTemplate = true
    } else if (closes) {
      inTemplate = false
    }
  }
  return out
}

/**
 * 归一化 import 说明符为包名（07 R-E-4）：
 * - 相对 / 绝对路径返回 null（放行）；
 * - 作用域包取前两段（`@scope/name/sub` → `@scope/name`），普通包取第一段；
 * - 先剥掉 query / hash（`pkg?query` / `pkg#hash`）。
 */
function pkgName(spec: string): string | null {
  if (spec.startsWith('.') || spec.startsWith('/')) {
    return null
  }
  const clean = spec.replace(/[?#].*$/, '')
  const parts = clean.split('/')
  return clean.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

/**
 * 覆盖全部 import 形态（07 R-E-4）：副作用 import / 带 from 的 import·export
 * （含多行声明、`import type`）/ `export … from` / 动态 `import()`。
 * 静态分支行首锚定（`m` 标志）：避免字符串 / 注释里的 "import from …" 文本误报；
 * 动态 import() 可出现于任意表达式位置，不做锚定。
 * 捕获组 1 为静态说明符，捕获组 2 为动态 import() 说明符。
 */
const IMPORT_RE =
  /^[ \t]*(?:import|export)\s+(?:[^'"]*?\s*from\s*)?['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/gm

/**
 * 第 5 条：构建后扫描 dist/webview 产物中的 CSP 危险形态（07 R-E-5）。
 * 门禁第 ③④ 步之后产物必然存在；直跑脚本时容错跳过。
 */
function checkDistCsp(root: string): void {
  const distDir = path.join(root, ...DIST_WEBVIEW_DIR)
  if (!existsSync(distDir)) {
    return
  }
  const violations: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(abs)
      } else if (/\.(js|css|html)$/.test(entry.name)) {
        // 字体 / 图片 / .map / json 不扫（二进制或非执行面）
        const text = readFileSync(abs, 'utf8')
        if (DIST_FORBIDDEN_RE.test(text)) {
          violations.push(
            `${toPosix(path.relative(root, abs))} 含禁用 CSP 形态（eval( / new Function / unsafe-eval / unsafe-inline，04 §9.5）`
          )
        }
        // 规则 7（09 §4.2 F2）：站点根绝对 url(/…) 在 webview 下必 404
        if (entry.name.endsWith('.css')) {
          const hitLine = text
            .split(/\r?\n/)
            .findIndex((line) => DIST_ROOT_ABSOLUTE_URL_RE.test(line))
          if (hitLine >= 0) {
            violations.push(
              `${toPosix(path.relative(root, abs))}:${hitLine + 1} 含站点根绝对资源引用 url(/…)（webview 下 404，09 §4.2 F2；请在 vite.config.ts 设置 base: './'）`
            )
          }
        }
      }
    }
  }
  walk(distDir)
  assert(
    violations.length === 0,
    `Webview 构建产物扫描未通过（共 ${violations.length} 处）：\n${violations
      .map((v) => `  - ${v}`)
      .join('\n')}`
  )
}

/**
 * 执行 Webview 样式门禁，任一违规即抛错（由门禁第 ⑥ 步捕获）。
 * @param root 仓库根目录
 */
export function checkWebviewStyle(root: string): void {
  const webviewRoot = path.join(root, 'src', 'webview')
  const violations: string[] = []

  for (const file of collectSourceFiles(webviewRoot)) {
    const source = readFileSync(file.abs, 'utf8')
    const lines = source.split(/\r?\n/)
    const isTokens = file.rel === TOKENS_FILE
    // 规则 1 / 4 的检查面：.css 全文；.vue 取 <style> 块
    const styleLines = file.rel.endsWith('.css')
      ? lines.map((text, i) => ({ line: i + 1, text }))
      : vueStyleLines(lines)

    // ---- 规则 1：硬编码颜色（令牌文件豁免）----
    if (!isTokens) {
      for (const { line, text } of styleLines) {
        if (hasHardcodedColor(text)) {
          violations.push(
            `${file.rel}:${line} 硬编码颜色（#[hex] / rgb( / hsl(），请改用 --ui-* 语义令牌（04 §9.1 / 07 R-E-9）`
          )
        }
      }
    }

    // ---- 规则 2：v-html / innerHTML ----
    if (file.rel.endsWith('.vue') || file.rel.endsWith('.ts')) {
      for (let i = 0; i < lines.length; i++) {
        if (/v-html/.test(lines[i])) {
          violations.push(`${file.rel}:${i + 1} 禁止 v-html（XSS 面，04 §9.2）`)
        }
        if (/\binnerHTML\b/.test(lines[i])) {
          violations.push(`${file.rel}:${i + 1} 禁止 innerHTML 赋值（XSS 面，04 §9.2）`)
        }
        // 规则 8：浏览器模态在 webview 沙箱下恒被静默忽略（第五轮评估 P0）
        if (BROWSER_MODAL_RE.test(lines[i])) {
          violations.push(
            `${file.rel}:${i + 1} 禁止浏览器模态 confirm/alert/prompt（webview 沙箱下恒被忽略，` +
              `确认交互改用 useTwoStepConfirm 两段式布防或宿主 showWarningMessage；agent.md 规约 9）`
          )
        }
      }
    }

    // ---- 规则 3：import 包名前缀白名单（宿主控制器目录 host/ 豁免；07 R-E-4）----
    if (
      (file.rel.endsWith('.vue') || file.rel.endsWith('.ts')) &&
      !file.rel.startsWith(`${HOST_DIR}/`)
    ) {
      // 全文扫描 + 由 match 索引回推行号：覆盖多行 import / 副作用 import / 动态 import()
      for (const match of source.matchAll(IMPORT_RE)) {
        const specifier = match[1] ?? match[2]
        if (!specifier) {
          continue
        }
        const pkg = pkgName(specifier)
        if (pkg === null || ALLOWED_IMPORT_PACKAGES.has(pkg)) {
          continue
        }
        const line = source.slice(0, match.index).split(/\r?\n/).length
        violations.push(
          `${file.rel}:${line} 违规 import「${specifier}」：仅允许 vue / @vscode/codicons 包族 / 项目内相对路径（04 §9.3 / 07 R-E-4）`
        )
      }
    }

    // ---- 规则 4：间距 / 圆角 / 高宽 / 字号（07 R-U-4 升级的检查面）----
    for (const { line, text } of styleLines) {
      for (const decl of text.matchAll(GEOMETRY_DECL_RE)) {
        const prop = decl[1]
        const value = decl[2] ?? ''
        // 负向前瞻排除负值（-1px 焦点环对齐 / 视觉隐藏，非尺寸刻度）
        const literals = [...value.matchAll(NEGATIVE_PX_RE)].map((match) => `${match[1]}px`)
        if (literals.length === 0) {
          continue // 纯百分比 / em / 0 / var() 等写法放行
        }
        if (!value.includes('var(')) {
          violations.push(
            `${file.rel}:${line} ${prop} 尺寸值 ${literals.join(' / ')} 未走令牌：` +
              `padding/margin/gap/border-radius/height/width/font-size 必须整条 var(--ui-*)` +
              `（新规格先在 ui/tokens.css 登记，04 §9.4 / 07 R-U-4）`
          )
        }
      }
    }

    // ---- 规则 6：.vue 模板静态 style 属性（07 R-E-12）----
    if (file.rel.endsWith('.vue')) {
      for (const { line, text } of vueTemplateLines(lines)) {
        if (STATIC_STYLE_ATTR_RE.test(text)) {
          violations.push(
            `${file.rel}:${line} 禁止模板静态 style 属性（宿主 CSP style-src 会静默拦截；改用 :style 绑定（CSSOM）或 class，07 R-E-12 / 07 §2）`
          )
        }
      }
    }
  }

  // ---- 规则 5：dist 产物 CSP 扫描（07 R-E-5，构建后执行）----
  checkDistCsp(root)

  assert(
    violations.length === 0,
    `Webview 样式门禁未通过（共 ${violations.length} 处违规）：\n${violations
      .map((v) => `  - ${v}`)
      .join('\n')}`
  )
}
