/**
 * 扩展宿主构建脚本（esbuild）：src/extension/index.ts → dist/extension.js。
 * 由根目录 esbuild.js 迁移而来（行为等价），补充产物体积输出。
 *
 *   npx tsx scripts/build-extension.ts               开发构建（sourcemap）
 *   npx tsx scripts/build-extension.ts --production  生产构建（minify，无 sourcemap）
 *   npx tsx scripts/build-extension.ts --watch       监听模式（修改 src/ 后自动重建）
 */
import * as esbuild from 'esbuild'
import { statSync } from 'node:fs'
import * as path from 'node:path'

const production = process.argv.includes('--production')
const watch = process.argv.includes('--watch')
const outfile = 'dist/extension.js'

// 统一以仓库根为工作目录，entry/outfile 相对路径不再依赖调用方 cwd
process.chdir(path.resolve(__dirname, '..'))

async function main(): Promise<void> {
  const ctx = await esbuild.context({
    entryPoints: ['src/extension/index.ts'],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'es2022',
    outfile,
    // node_modules 解析（createRequire），.node 二进制由 vsix 随包分发
    external: ['vscode'],
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    logLevel: 'info',
  })
  if (watch) {
    await ctx.watch()
    process.stdout.write(`已启动监听（${production ? '生产' : '开发'}模式），Ctrl+C 退出\n`)
    return
  }
  await ctx.rebuild()
  await ctx.dispose()
  const size = statSync(path.join(process.cwd(), outfile)).size
  process.stdout.write(`产物 ${outfile}：${(size / 1024).toFixed(1)} KB\n`)
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
