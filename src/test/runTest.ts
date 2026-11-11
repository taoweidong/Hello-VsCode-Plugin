import * as path from 'path'
import { runTests } from '@vscode/test-electron'

/**
 * 集成测试使用的 VS Code 版本（17 方案阶段 4 收尾，解决 12 号文档 P3-G2 留档项：
 * 不固定版本时每次 VS Code 新版发布会触发约 384MB 下载，内网 15s 请求超时直接
 * 让门禁第 ⑧ 步失败）。升级时改此常量（或设 VSCODE_TEST_VERSION 覆盖），
 * 首次使用新版本会下载并缓存到 .vscode-test/。
 */
const VSCODE_TEST_VERSION = process.env.VSCODE_TEST_VERSION ?? '1.145.3'

/** 下载/启动一个干净的 VSCode 实例并运行集成测试（首次运行会下载 VSCode，耗时较长）。 */
async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, '../..')
  const extensionTestsPath = path.resolve(__dirname, 'index.js')
  try {
    await runTests({
      version: VSCODE_TEST_VERSION,
      extensionDevelopmentPath,
      extensionTestsPath,
      // 打开仓库根作为工作区：草稿箱等「工作区数据落盘」流程需要真实 workspaceFolders
      // （数据文件已被 gitignore 覆盖，测试收尾自行清理）
      launchArgs: [extensionDevelopmentPath, '--disable-extensions'],
    })
  } catch (err) {
    console.error('集成测试运行失败：', err)
    process.exit(1)
  }
}

void main()
