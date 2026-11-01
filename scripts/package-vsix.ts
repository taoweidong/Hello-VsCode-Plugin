/**
 * 一键打包 .vsix 并归档到 release/（跨平台：纯 Node 实现，Linux / Windows 通用，无 shell 语法）。
 *
 *   npm run package:vsix             完整构建 + 打包 → release/<name>-<version>.vsix
 *   npm run package:vsix -- --clean  打包前清空 release/ 归档目录（重新归档）
 *
 * 职责：
 * 1. release/ 归档目录就绪（--clean 时先清空）；
 * 2. 完整构建（check-types + 宿主 + Webview，等价 npm run package，失败即中止）；
 * 3. vsce 打包（-o 直接产出到 release/，vsce 来自 devDependencies 免全局安装）；
 * 4. 产物校验：存在性 + **逐条目解压 CRC**（零依赖，见 checks/vsixIntegrity；
 *    v2.3.0 实测产物曾静默损坏且清单类检查全通过，只有解压比对能拦截）+ 归档摘要。
 */
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import * as path from 'node:path'
import { verifyZipEntries } from './checks/vsixIntegrity'

const root = path.resolve(__dirname, '..')
process.chdir(root)

/** 归档目录（相对仓库根；.gitignore 与 .vscodeignore 均已排除）。 */
const RELEASE_DIR = 'release'
const clean = process.argv.includes('--clean')

interface PackageJson {
  name: string
  version: string
}

function main(): void {
  // ---- 1) 归档目录就绪 ----
  if (clean && existsSync(RELEASE_DIR)) {
    rmSync(RELEASE_DIR, { recursive: true, force: true })
  }
  mkdirSync(RELEASE_DIR, { recursive: true })

  // ---- 2) 完整构建（类型检查 + 宿主 + Webview；stdio 直通，构建失败即中止）----
  execSync('npm run package', { cwd: root, stdio: 'inherit' })

  // ---- 3) vsce 打包：-o 指定归档路径（正斜杠路径 vsce 在双平台都能解析）----
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as PackageJson
  const outName = `${pkg.name}-${pkg.version}.vsix`
  const outPath = `${RELEASE_DIR}/${outName}`
  execSync(`npx vsce package -o ${outPath}`, { cwd: root, stdio: 'inherit' })

  // ---- 4) 产物校验：存在 + 逐条目 CRC ----
  if (!existsSync(path.join(root, outPath))) {
    throw new Error(`打包完成但未找到产物：${outPath}（检查 vsce 输出）`)
  }
  const verify = verifyZipEntries(path.join(root, outPath))
  if (verify.failed.length > 0) {
    throw new Error(
      `产物损坏（${verify.failed.length}/${verify.total} 条目校验失败，疑似写入被干扰）：\n` +
        verify.failed
          .slice(0, 5)
          .map((name) => `  ${name}`)
          .join('\n') +
        `\n请删除 ${outPath} 后重新打包，并排查磁盘/杀毒软件对 release 目录的写入干扰。`
    )
  }
  const sizeMb = statSync(path.join(root, outPath)).size / 1024 / 1024
  const archives = readdirSync(RELEASE_DIR).filter((name) => name.endsWith('.vsix'))
  process.stdout.write(
    `\n✅ 打包完成：${outPath}（${sizeMb.toFixed(1)} MB，${verify.total} 条目逐条 CRC 校验通过）\n` +
      `   release/ 归档现有 ${archives.length} 个 .vsix：\n` +
      archives.map((name) => `   - ${name}`).join('\n') +
      '\n'
  )
}

try {
  main()
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
}
