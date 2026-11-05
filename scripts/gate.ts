/**
 * 一键式质量门禁：任何代码/配置/文档改动后，收尾前必须整体执行并通过。
 *
 *   npm run gate                    完整门禁（含第⑧步宿主集成测试）
 *   npm run gate -- --fast          跳过第⑧步宿主集成测试（快速反馈）
 *   npm run gate -- --with-e2e      追加第⑩步 Webview E2E（可选，默认不执行）
 *
 * 步骤（07 复审 R-E-1/R-E-3/R-E-11/R-E-16 落地后排布）：
 *   ① Lint 与格式检查（eslint . / prettier --check .）
 *   → ② 类型检查（tsc --noEmit；存在 tsconfig.webview.json 时追加 vue-tsc）
 *   → ③ 宿主生产构建（scripts/build-extension.ts --production）
 *   → ④ Webview 构建（npx vite build，产出 dist/webview + manifest，供第⑥⑨步校验）
 *   → ⑤ 测试编译（tsc → out/）
 *   → ⑥ 静态一致性与样式门禁检查（清单/常量/视图/命令注册/特性开关/Webview manifest，
 *      见 scripts/checks/manifest.ts；Webview 样式规约见 scripts/checks/style.ts）
 *   → ⑦ 单元测试（npx vitest run --coverage，覆盖率阈值失败即红）
 *   → ⑧ 宿主集成测试（@vscode/test-electron，--fast 时跳过）。
 *   → ⑨ 打包内容与产物体积校验（vsce ls 黑白名单 + bundle 尺寸预算，07 R-E-3/R-E-16；
 *      位于构建步之后，--fast 模式下 dist 同样存在，两种模式都执行）。
 *   → ⑩ Webview E2E（Playwright，仅 --with-e2e 触发；依赖真实浏览器，默认不进门禁）。
 * **fail-fast：任一步骤失败立即停止后续步骤**，最终汇总表格并以非零码退出。
 * 首次运行第⑧步会自动下载测试用 VS Code（缓存在 .vscode-test/，已被 gitignore）。
 */
import { execSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import * as path from 'node:path'
import { checkManifestConsistency } from './checks/manifest'
import { checkWebviewStyle } from './checks/style'

const root = path.resolve(__dirname, '..')
process.chdir(root)

/** 统一 POSIX 风格路径（vsce ls 清单与错误信息可读）。 */
function toPosix(value: string): string {
  return value.split('\\').join('/')
}

const fast = process.argv.includes('--fast')
const withE2E = process.argv.includes('--with-e2e')

/** 默认命令超时（5 分钟） */
const DEFAULT_TIMEOUT_MS = 300000

/**
 * bundle 尺寸预算（07 R-E-16；阈值参考 06 §6.2 实测值留足余量）：
 * - 宿主 dist/extension.js：06 §6.2 实测 82.6 KB，本轮实测 83.5 KB → 上限 150 KB；
 * - 单个 webview chunk（dist/webview/** 的 js/css）：本轮实测最大 70.0 KB
 *   （Vue runtime 共享 chunk），含 codicons css 40.3 KB → 上限 100 KB。
 * 预算意在拦截「依赖链失控引入巨型产物」的回归，非精确容量规划。
 */
const HOST_BUNDLE_BUDGET_KB = 150
const WEBVIEW_CHUNK_BUDGET_KB = 100
/** vsix 内容总体积预算（serialport prebuild 全平台随包后实测约 3-4MB，留足余量）。 */
const VSIX_CONTENT_BUDGET_MB = 20

interface StepResult {
  name: string
  ok: boolean
  seconds: string
}

interface StepDef {
  name: string
  timeoutMs?: number
  /** 仅完整门禁执行（--fast 跳过；当前只有第⑧步宿主集成测试）。 */
  fullOnly?: boolean
  /** 仅显式开启时执行（--with-e2e；当前只有第⑩步 Webview E2E）。 */
  e2eOnly?: boolean
  /** 返回将打印的摘要输出（只保留末尾几行）；失败时抛错 */
  run: (timeoutMs: number) => string | undefined
}

const results: StepResult[] = []

function exec(command: string, timeoutMs: number): string {
  const env = { ...process.env, GCM_INTERACTIVE: 'never', GIT_TERMINAL_PROMPT: '0' }
  // 07 R-E-1：Agent 宿主进程会注入 ELECTRON_RUN_AS_NODE，@vscode/test-electron spawn 的
  // Code.exe 继承后会以 Node 模式运行、拒绝 --disable-extensions 等应用参数（exit 9，
  // 详见 06 §6.3）。进程内 delete 跨平台，替代 bash 专有的 `env -u` 包装。
  delete env.ELECTRON_RUN_AS_NODE
  return execSync(command, {
    cwd: root,
    stdio: 'pipe',
    encoding: 'utf8',
    timeout: timeoutMs,
    env,
  })
}

function errorText(err: unknown): string {
  if (err instanceof Error) {
    const e = err as Error & { stdout?: string; stderr?: string }
    return String(e.stdout ?? '') + String(e.stderr ?? '') + e.message
  }
  return String(err)
}

const steps: StepDef[] = [
  {
    name: '1/10 Lint 与格式检查（eslint / prettier）',
    run: (timeout) => {
      exec('npx eslint .', timeout)
      exec('npx prettier --check .', timeout)
      return 'eslint 零错误；prettier 格式全部合规'
    },
  },
  {
    name: '2/10 类型检查（tsc --noEmit，strict）',
    run: (timeout) => {
      exec('npx tsc -p tsconfig.node.json --noEmit', timeout)
      if (existsSync(path.join(root, 'tsconfig.webview.json'))) {
        exec('npx vue-tsc --noEmit -p tsconfig.webview.json', timeout)
        return 'tsc（node）与 vue-tsc（webview）均无类型错误'
      }
      return 'tsc 无类型错误（未发现 tsconfig.webview.json，跳过 vue-tsc）'
    },
  },
  {
    name: '3/10 宿主生产构建（build-extension --production）',
    run: (timeout) => exec('npx tsx scripts/build-extension.ts --production', timeout),
  },
  {
    name: '4/10 Webview 构建（vite build）',
    run: (timeout) =>
      exec('npx vite build', timeout)
        .split(/\r?\n/)
        .filter((line) => /built in|dist\/webview/.test(line))
        .join('\n'),
  },
  {
    name: '5/10 测试编译（tsc → out/）',
    run: (timeout) => exec('npx tsc -p tsconfig.node.json --outDir out', timeout),
  },
  {
    name: '6/10 静态一致性与样式门禁检查',
    run: () => {
      checkWebviewStyle(root)
      checkManifestConsistency(root)
      return 'Webview 样式门禁通过；清单、常量、视图 when、命令注册、特性开关、图标、Webview manifest 全部闭合'
    },
  },
  {
    name: '7/10 单元测试（vitest run --coverage）',
    // 第五轮：240s 曾紧于慢机 / CI 冷缓存下的实测墙钟（拆分双工程前 jsdom 环境开销
    // 就超过此值），表现为门禁「随机红」——放宽到 600s 与第⑧步一致留足余量
    timeoutMs: 600000,
    run: (timeout) => {
      const output = exec('npx vitest run --coverage', timeout)
      return (
        output
          // ANSI 转义序列本就是剥除目标（vitest 彩色输出），控制字符告警属预期
          // eslint-disable-next-line no-control-regex
          .replace(/\x1B\[[0-9;]*[A-Za-z]/g, '')
          .split(/\r?\n/)
          .filter((line) => /^\s*(Test Files|Tests)\b/.test(line))
          .join('\n')
      )
    },
  },
  {
    name: '8/10 宿主集成测试（@vscode/test-electron）',
    timeoutMs: 600000,
    fullOnly: true,
    run: (timeout) => {
      const output = exec('node out/test/runTest.js', timeout)
      return output
        .split(/\r?\n/)
        .filter((line) => /passing|failing|pending/.test(line))
        .join('\n')
    },
  },
  {
    name: '9/10 打包内容与产物体积校验（vsce ls + bundle 预算）',
    timeoutMs: 180000,
    run: (timeout) => {
      // ---- 打包内容黑白名单（07 R-E-3：vsce package 零警告不能替代内容校验）----
      // serialport（首个生产依赖，N-API prebuild）经 .vscodeignore 否定项随包分发，
      // 因此这里不再用 --no-dependencies，运行时依赖必须出现在清单中
      const listed = exec('npx vsce ls', timeout)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
      const forbidden = [
        /^(src|tests|out|scripts|docs|\.github)\//, // 源与工具链不该进包
        /\.map$/, // sourcemap（.vscodeignore 已挡，双保险；serialport 依赖树不含 .map）
        /^coverage\//, // 覆盖率报告（07 R-E-2）
        /\.vsix$/, // 旧的打包产物
        /(^|\/)agent\.md$/, // 代理约定文档
        /^\.ext-starter\//, // 运行期工件目录（环境快照）
        /^package\.bat$/, // Windows 开发者快捷入口
        /^tsconfig\.node\.json$/, // 开发期类型配置
        /^node_modules\/(?!serialport|@serialport|node-gyp-build|debug|ms)(\/|$)/, // 只放行 serialport 运行时依赖树
      ]
      const bad = listed.filter((file) => forbidden.some((re) => re.test(file)))
      if (bad.length > 0) {
        throw new Error(
          `vsix 含禁用文件（检查 .vscodeignore）：\n${bad.map((file) => '  ' + file).join('\n')}`
        )
      }
      for (const must of [
        'package.json',
        'dist/extension.js',
        'dist/webview/.vite/manifest.json',
        'media/icon.png',
        // serialport 运行时：入口 + 原生绑定 + 至少一个 N-API prebuild
        'node_modules/serialport/package.json',
        'node_modules/@serialport/bindings-cpp/package.json',
        'node_modules/@serialport/bindings-cpp/prebuilds/win32-x64/node.napi.node',
      ]) {
        if (!listed.includes(must)) {
          throw new Error(`vsix 缺少运行必需文件: ${must}（确认 ③④ 步构建与 .vscodeignore）`)
        }
      }

      // ---- vsix 内容总体积预算（prebuild 二进制随包后的膨胀防线）----
      const totalBytes = listed.reduce((sum, file) => {
        try {
          return sum + statSync(path.join(root, file)).size
        } catch {
          return sum // vsce 合成的虚拟条目（如 .vsixmanifest）不在磁盘上
        }
      }, 0)
      if (totalBytes > VSIX_CONTENT_BUDGET_MB * 1024 * 1024) {
        throw new Error(
          `vsix 内容超预算：${(totalBytes / 1024 / 1024).toFixed(1)} MB > ${VSIX_CONTENT_BUDGET_MB} MB`
        )
      }

      // ---- bundle 尺寸预算（07 R-E-16）----
      const hostSize = statSync(path.join(root, 'dist', 'extension.js')).size
      if (hostSize > HOST_BUNDLE_BUDGET_KB * 1024) {
        throw new Error(
          `宿主 bundle 超预算：dist/extension.js ${(hostSize / 1024).toFixed(1)} KB > ${HOST_BUNDLE_BUDGET_KB} KB`
        )
      }
      const assetsRoot = path.join(root, 'dist', 'webview')
      const oversized: string[] = []
      let chunkCount = 0
      let maxChunk = { file: '', size: 0 }
      const walkChunks = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const abs = path.join(dir, entry.name)
          if (entry.isDirectory()) {
            walkChunks(abs)
          } else if (/\.(js|css)$/.test(entry.name)) {
            // 字体 / 图片 / .map / json 不属 chunk 体积预算范畴
            const size = statSync(abs).size
            chunkCount += 1
            if (size > maxChunk.size) {
              maxChunk = { file: toPosix(path.relative(root, abs)), size }
            }
            if (size > WEBVIEW_CHUNK_BUDGET_KB * 1024) {
              oversized.push(`${toPosix(path.relative(root, abs))} ${(size / 1024).toFixed(1)} KB`)
            }
          }
        }
      }
      walkChunks(assetsRoot)
      if (oversized.length > 0) {
        throw new Error(
          `webview chunk 超预算（单 chunk ≤ ${WEBVIEW_CHUNK_BUDGET_KB} KB）：\n${oversized
            .map((file) => '  ' + file)
            .join('\n')}`
        )
      }
      return (
        `vsce ls 黑白名单通过（${listed.length} 项，含 serialport 运行时）；` +
        `vsix 内容 ${(totalBytes / 1024 / 1024).toFixed(1)} MB ≤ ${VSIX_CONTENT_BUDGET_MB} MB；` +
        `宿主 ${(hostSize / 1024).toFixed(1)} KB ` +
        `≤ ${HOST_BUNDLE_BUDGET_KB} KB；${chunkCount} 个 chunk，最大 ${maxChunk.file} ` +
        `${(maxChunk.size / 1024).toFixed(1)} KB ≤ ${WEBVIEW_CHUNK_BUDGET_KB} KB`
      )
    },
  },
  {
    name: '10/10 Webview E2E（Playwright，--with-e2e）',
    timeoutMs: 300000,
    e2eOnly: true,
    run: (timeout) =>
      exec('npm run test:e2e', timeout)
        .split(/\r?\n/)
        .filter((line) => /passed|failed|flaky|skipped/.test(line))
        .join('\n'),
  },
]

// ---- 步骤编排（fail-fast：任一步失败立即停止后续步骤）----
const planned = steps.filter((step) => {
  if (fast && step.fullOnly) return false // --fast 跳过第⑧步
  if (!withE2E && step.e2eOnly) return false // 第⑩步仅 --with-e2e 执行
  return true
})
let failed = false

for (const step of planned) {
  process.stdout.write(`\n▶ ${step.name}\n`)
  const startedAt = Date.now()
  try {
    const output = step.run(step.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1)
    if (typeof output === 'string' && output.trim()) {
      process.stdout.write(output.trim().split(/\r?\n/).slice(-3).join('\n') + '\n')
    }
    results.push({ name: step.name, ok: true, seconds })
  } catch (err) {
    failed = true
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1)
    results.push({ name: step.name, ok: false, seconds })
    process.stdout.write(
      '  ✗ 失败（' +
        seconds +
        's），输出末尾：\n' +
        '  ' +
        errorText(err).trim().split(/\r?\n/).slice(-12).join('\n  ') +
        '\n'
    )
    break
  }
}

// ---- 汇总 ----
const width = 52
process.stdout.write('\n┌' + '─'.repeat(width) + '┐\n')
for (const result of results) {
  const mark = result.ok ? '✓' : '✗'
  const label = `${mark} ${result.name}`.slice(0, width - 9)
  process.stdout.write(
    '│ ' + label.padEnd(width - 9, ' ') + ` ${result.ok ? '通过' : '失败'} ${result.seconds}s │\n`
  )
}
process.stdout.write('└' + '─'.repeat(width) + '┘\n')

if (failed) {
  process.stdout.write('\n✗ 门禁未通过：请修复失败步骤后重跑 npm run gate\n')
  process.exit(1)
}
if (fast) {
  process.stdout.write('\n✓ 门禁（--fast）全部通过，已跳过第 ⑧ 步（宿主集成测试）\n')
} else {
  process.stdout.write('\n✓ 门禁全部通过，可以提交/推送\n')
}
