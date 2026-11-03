import vue from '@vitejs/plugin-vue'
import path from 'node:path'
import { defineConfig } from 'vitest/config'

/**
 * 单元 / 组件测试配置（NFR-07 / docs/需求与优化方案/03 §6）：
 * - 不依赖 VSCode 宿主：`vscode` 模块统一替换为 src/test/unit/stubs/vscode.ts；
 * - jsdom 环境：既可跑纯逻辑，也可跑 Vue 组件（@vue/test-utils + vue 插件编译 SFC）；
 * - 覆盖率：v8 provider，阈值见 coverage.thresholds（M2 起步 60%，M6 提至 70/85）。
 */
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: [
      { find: /^vscode$/, replacement: path.resolve(__dirname, 'src/test/unit/stubs/vscode.ts') },
    ],
  },
  test: {
    environment: 'jsdom',
    include: ['src/test/unit/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
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
      // 新增模块原则上应达到全局阈值；build / webview-host 两组历史缺口单独设线防回退。
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
        'src/extension/features/build/**': {
          lines: 85,
          functions: 89,
          statements: 85,
          branches: 70,
        },
        'src/webview/host/**': { lines: 88, functions: 83, statements: 88, branches: 77 },
      },
    },
  },
})
