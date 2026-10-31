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
      include: [
        'src/extension/services/**',
        'src/extension/features/taskExplorer/**',
        'src/webview/protocol.ts',
        'src/webview/formSchema.ts',
        'src/webview/components/fieldAdapter.ts',
        'src/webview/host/webviewHtml.ts',
        'src/webview/shared/stableStringify.ts',
        'src/extension/commands/shared.ts',
      ],
      // 阈值为实测值减约 1pt 余量（2026-10 实测：整体 93.2L/88.85B/94.06F/93.36S；
      // services 92.5L、protocol 100）。09 方案阶段 2 后统计面缩小，以当轮实测复核为准。
      // v2.3：新增 taskExplorer 统计面（10 方案 §11.2：新增模块行覆盖率 ≥ 90%）。
      thresholds: {
        lines: 92,
        functions: 93,
        statements: 92,
        branches: 87,
        'src/extension/services/**': { lines: 90, functions: 90, statements: 90, branches: 85 },
        'src/webview/protocol.ts': { lines: 100, functions: 100, statements: 100, branches: 100 },
        'src/extension/features/taskExplorer/**': {
          lines: 90,
          functions: 90,
          statements: 90,
          branches: 85,
        },
      },
    },
  },
})
