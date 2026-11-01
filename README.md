# Hello VSCode Plugin（VSCode 扩展开发模板）

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![VSCode](https://img.shields.io/badge/VSCode-%E2%89%A51.85-007ACC?logo=visualstudiocode&logoColor=white)](package.json)
[![Node](https://img.shields.io/badge/Node.js-%E2%89%A520.19-339933?logo=node.js&logoColor=white)](package.json)

一个 **VSCode 插件初始化项目（模板）**：收敛为「5 个可抄的示例 + 1 套自洽基座」——
可插拔环境探针、任务编排、HTTP 弹框对接（分支编译）、真实业务（串口控制台）、
任务管理器（Task API 投影）五种典型模式，配 Webview 页面框架（Vue 3）与
VSCode 原生设计系统。克隆后照着示例加功能，全程不碰基座。

## ✨ 功能特性

| 视图（5）  | 模式         | 一句话说明                                              | 文档                                             |
| ---------- | ------------ | ------------------------------------------------------- | ------------------------------------------------ |
| 环境信息   | ① 可插拔探针 | 探针注册表，单击任一条目单独重检，新增语言 = 加一条数据 | [01](docs/功能介绍/01-启动脚本与环境信息.md)     |
| 环境初始化 | ③ 任务编排   | 步骤注册表：单步超时裁决、互斥、失败不阻断              | [02](docs/功能介绍/02-环境初始化.md)             |
| 串口服务器 | ② 真实业务   | 服务器管理（密码进 SecretStorage）、下发命令、实时输出  | [04](docs/功能介绍/04-串口控制台.md)             |
| 任务管理器 | ③ API 投影   | 工作区 tasks.json 任务树：运行/停止/收藏/定位（v2.3+）  | [07](docs/功能介绍/07-TaskExplorer任务管理器.md) |
| 构建任务   | ③ HTTP 对接  | 侧边栏任务列表实时轮询，与分支编译弹框同源数据（v2.1）  | [03](docs/功能介绍/03-分支编译.md)               |

| Webview 页面（3） | 一句话说明                                 |
| ----------------- | ------------------------------------------ |
| 组件画廊          | 设计系统视觉验收基准，新页面的最佳抄写起点 |
| 串口控制台        | 真实业务：表单 / 命令输入 / 输出流 / 历史  |
| 分支编译          | HTTP 弹框：SchemaForm 提交 → 任务列表轮询  |

> 右键菜单（草稿箱 8 条入口 / 拷贝示例 3 条入口）与 28 条命令的完整对照表见
> [docs/功能介绍/README.md](docs/功能介绍/README.md)。

## 🚀 快速开始

环境要求：Node.js ≥ 20.19、VSCode ≥ 1.85。

```bash
git clone https://github.com/taoweidong/Hello-VsCode-Plugin.git
cd Hello-VsCode-Plugin
npm install
npm run gate      # 一键质量门禁：lint/类型/双构建/静态一致性/单测(覆盖率)/集成
```

用 VSCode 打开项目文件夹按 **F5** 启动调试窗口：装了即生效——启动脚本 + 环境检测
自动执行（输出通道可见），活动栏出现「Hello VSCode 插件」与 5 个视图。

**常用脚本**：`npm run watch`（构建监听）· `npm run test:unit`（秒级单测）·
`npm run package:vsix`（打包离线 vsix）——完整脚本清单与逐步操作见
[docs/操作指导/](docs/操作指导/README.md)。

## 📚 文档

四层结构，总入口 [docs/README.md](docs/README.md)（含「我想做什么」快速路由）：

| 文档分层        | 目录                                                  | 面向               | 什么时候读                        |
| --------------- | ----------------------------------------------------- | ------------------ | --------------------------------- |
| 一 · 上手与调试 | [docs/操作指导/](docs/操作指导/README.md)             | 第一次接触项目的人 | 克隆之后、动手之前（30 分钟跑通） |
| 二 · 功能介绍   | [docs/功能介绍/](docs/功能介绍/README.md)             | 使用者 / 评估者    | 每个功能是什么、怎么用            |
| 三 · 二次开发   | [docs/开发指南/](docs/开发指南/README.md)             | 开发者 / AI 代理   | 加功能、写测试、打包              |
| 四 · 设计与决策 | [docs/需求与优化方案/](docs/需求与优化方案/README.md) | 想了解来龙去脉的人 | 评审设计、理解历史方案            |

> AI 编码代理请先读 [agent.md](agent.md)（门禁 / 测试 / 版本号规约等强制约定）。

## 🧭 如何扩展（速查）

| 我想…                      | 抄哪个样板                            | 文档                                                 |
| -------------------------- | ------------------------------------- | ---------------------------------------------------- |
| 加环境探针 / 启动脚本      | `probes.ts` / `taskRegistry.ts`       | [指南 01](docs/开发指南/01-启动任务与环境探针.md)    |
| 加初始化步骤               | `initSteps.ts`                        | [指南 02](docs/开发指南/02-环境初始化.md)            |
| 对接构建 HTTP 接口         | `buildConsolePanel.ts`                | [指南 03](docs/开发指南/03-分支编译.md)              |
| 加串口 / 右键登记 / 拷贝   | `serialConsole/` / `draftCommands.ts` | [指南 04/05](docs/开发指南/05-草稿箱与右键菜单.md)   |
| 加任务管理器类视图         | `features/taskExplorer/`              | [指南 09](docs/开发指南/09-任务管理器.md)            |
| 加 Webview 页面 / 表单领域 | `apps/gallery/` / `serverSchema.ts`   | [指南 06](docs/开发指南/06-Webview页面与表单基座.md) |
| 加命令 / 视图 / 改文案     | `commands/` + constants               | [指南 07](docs/开发指南/07-命令视图与i18n.md)        |

架构与目录、三条边界规则（`src/extension/**` 只碰 `vscode`、`src/webview/**`
不碰 `vscode`、跨侧契约唯一在 `protocol.ts`）与完整脚本说明：
[docs/开发指南/00-架构与目录.md](docs/开发指南/00-架构与目录.md)。

## 📄 说明

- 运行时依赖仅 `serialport`（N-API 预编译跨平台）；Webview 为 Vue 3 + 自研
  VSCode 原生设计系统，未引入通用 UI 框架；
- 完整 `npm run gate` 首次运行会下载测试用 VS Code（约 1GB，缓存在 `.vscode-test/`
  复用）；其余已知限制见 [架构与开发须知](docs/开发指南/00-架构与目录.md)；
- 打包发布：`npm run package:vsix` → `release/*.vsix`，发布到市场需 publisher
  账号 + PAT（`npx vsce publish`），详见[开发指南 08](docs/开发指南/08-测试门禁与打包.md)。

## 🤝 贡献

欢迎 Issue / PR：提交前请跑 `npm run gate`（全绿为准），按
[agent.md](agent.md) 的版本号规约升版本并记 [CHANGELOG](CHANGELOG.md)。

## License

[MIT](LICENSE)
