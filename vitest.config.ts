import vue from '@vitejs/plugin-vue'
import path from 'node:path'
import { defineConfig } from 'vitest/config'

/**
 * 单元 / 组件测试配置（NFR-07 / docs/需求与优化方案/03 §6）：
 * - `vscode` 模块统一替换为 src/test/unit/stubs/vscode.ts（双工程共用同一别名）；
 * - **双工程拆分（第五轮基建）**：仅 `src/test/unit/webview/**`（约 29 个组件 / 页面
 *   用例）需要 jsdom；其余宿主侧用例在 node 环境跑——此前 jsdom 全局一刀切，
 *   64 个文件各自实例化 jsdom（实测占整轮耗时的 93%+），拆分后宿主侧零环境开销；
 * - setupFiles 全局清理：stubs 与 vscode api 单例在每个用例后复位（上收此前
 *   26 个 spec 手工调用的 `__resetStubs` 纪律），保证文件间零状态依赖；
 * - 覆盖率：v8 provider，阈值见 coverage.thresholds（12 方案阶段 4 全量统计面）。
 */

/** 全局清理脚本（双工程共享）。 */
const SETUP_FILE = path.resolve(__dirname, 'src/test/unit/setup.ts')

/** 测试桩别名：宿主侧 spec 与 webview 侧 spec 都可能 import 到 vscode 模块。 */
const VSCODE_ALIAS = [
  { find: /^vscode$/, replacement: path.resolve(__dirname, 'src/test/unit/stubs/vscode.ts') },
]

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'], // json-summary：机器可读，供趋势比对与阈值校准
      // R-E-6：此前只有 4 个 glob——commands / providers / features / webview 下约 200 个
      // 用例完全不计入任何阈值，「整体 93%」名不副实。纳入「无需宿主即可测」的纯逻辑：
      // 协议收窄层、表单 schema 派生、字段适配、稳定序列化、命令注册工具、HTML 外壳。
      // 09 方案阶段 2：src/models/** 与 src/domain/** 随条目领域删除，移出统计面。
      // 12 方案阶段 4（2026-11）：统计面扩至全部可测模块（宿主命令/功能/任务/视图层、
      // webview 全量），仅排除 src/extension/index.ts（激活装配，仅宿主集成测试可达）。
      include: [
        'src/extension/commands/**',
        'src/extension/features/**',
        'src/extension/providers/**',
        'src/extension/services/**',
        'src/extension/tasks/**',
        'src/ui/**',
        'src/webview/**',
      ],
      // 排除不可测 / 非统计对象：激活装配（仅宿主集成可达）、类型纯模块（无运行时代码）、
      // Webview 构建入口（3 行 createApp 装配）、测试支撑与声明文件。
      exclude: [
        'src/extension/index.ts',
        'src/extension/tasks/types.ts',
        'src/webview/apps/*/main.ts',
        'src/webview/vscode.d.ts',
        'src/webview/shared/env.d.ts',
        'src/test/**',
      ],
      // 阈值为实测值减约 1pt 余量（12 方案阶段 4 实测：整体 92.13S/85.73B/90.89F/92.62L；
      // 见 docs/需求与优化方案/12-代码质量评估报告与分阶段优化方案.md §6）。
      // 新增模块原则上应达到全局阈值；taskManager / webview-host 两组历史缺口单独设线防回退。
      thresholds: {
        lines: 91.5,
        functions: 90,
        statements: 91,
        branches: 84.5,
        'src/extension/services/**': { lines: 90, functions: 90, statements: 90, branches: 85 },
        'src/webview/protocol.ts': { lines: 100, functions: 100, statements: 100, branches: 100 },
        'src/extension/features/taskExplorer/**': {
          lines: 90,
          functions: 90,
          statements: 90,
          branches: 85,
        },
        'src/extension/features/taskManager/**': {
          lines: 90,
          functions: 90,
          statements: 90,
          branches: 85,
        },
        'src/webview/host/**': { lines: 88, functions: 83, statements: 88, branches: 77 },
        // 17 方案阶段 5（v5.1.1）：两大树+存储域单独设线防回退（阈值 = 实测减约 1pt）
        'src/extension/features/quickCommands/**': { lines: 87.5, branches: 85.5 },
        'src/extension/features/favorites/**': { lines: 78, branches: 69 },
      },
    },
    projects: [
      {
        // Webview 侧：组件 / 页面用例需要 DOM（@vue/test-utils + vue 插件编译 SFC）
        test: {
          name: 'webview',
          environment: 'jsdom',
          include: ['src/test/unit/webview/**/*.spec.ts'],
          setupFiles: [SETUP_FILE],
        },
        plugins: [vue()],
        resolve: { alias: VSCODE_ALIAS },
      },
      {
        // 宿主侧：纯逻辑 + vscode 测试桩，node 环境零 DOM 开销
        test: {
          name: 'host',
          environment: 'node',
          include: ['src/test/unit/**/*.spec.ts'],
          exclude: ['src/test/unit/webview/**'],
          setupFiles: [SETUP_FILE],
        },
        resolve: { alias: VSCODE_ALIAS },
      },
    ],
  },
})
