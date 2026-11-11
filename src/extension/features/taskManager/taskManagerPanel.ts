import * as vscode from 'vscode'
import { CONFIG } from '../../constants'
import {
  WebviewController,
  type WebviewControllerDeps,
} from '../../../webview/host/webviewController'
import { deriveFormSchema, toFieldDefs } from '../../../webview/formSchema'
import { reasonOf } from '../../services/errors'
import type { TaskItemWire, TaskPageWire, TaskQueryWire } from '../../../webview/protocol'
import { TASK_FIELD_DEFS } from './taskSchema'
import {
  createTaskApiClient,
  type TaskApiClient,
  type TaskItem,
  type TaskQuery,
} from './taskApiClient'

/**
 * 任务管理控制台（v2.6 改造）：Webview 弹框——上部查询参数 + 下部任务表格 + 分页，
 * 表单支持增删改查。后端接口默认打桩模拟（`extStarter.taskApiBaseUrl` 留空），
 * 配置后切换真实 REST 接口——页面与协议层零改动（见 taskApiClient.ts）。
 *
 * 消息流（复用控制器通用提交生命周期 R-C-10）：
 * - 页面 `ready` → init（schema = TASK_FIELD_DEFS 派生）；
 * - 页面 `taskListRequest`（查询/分页）→ deps.onPageMessage → api.query → taskList 分页页；
 * - 页面 `submit`（draft.id 存在 = 编辑，否则 = 新建）→ deps.onSubmit → create/update → 重查；
 * - 页面 `taskDelete` → deps.onPageMessage → api.remove → 重查；
 * - 失败 → 控制器统一 error（err.field 定位表单控件）。
 */
export interface TaskManagerServices {
  api: TaskApiClient
  output: vscode.OutputChannel
  /** 任务变更回调：extension.ts 接到侧边栏树视图的 refresh，实现事件驱动即时刷新。 */
  onAfterChange?: () => void
}

/** 组装服务（extension.ts 调用一次；baseUrl 配置决定打桩 / 真实）。 */
export function createTaskManagerServices(output: vscode.OutputChannel): TaskManagerServices {
  const baseUrl = vscode.workspace
    .getConfiguration(CONFIG.section)
    .get<string>(CONFIG.taskApiBaseUrl, '')
  return {
    api: createTaskApiClient(baseUrl),
    output,
  }
}

/** TaskItem → 协议线类型（匿名字面量展开获得隐式索引签名，与 toServerWire 同理）。 */
export function toTaskItemWire(task: TaskItem): TaskItemWire {
  return { ...task }
}

/** TaskQuery → 协议线类型。 */
export function toTaskQueryWire(query: TaskQuery): TaskQueryWire {
  return { ...query }
}

/** TaskPage → 协议线类型。 */
export function toTaskPageWire(page: {
  items: TaskItem[]
  total: number
  page: number
  pageSize: number
}): TaskPageWire {
  return {
    items: page.items.map(toTaskItemWire),
    total: page.total,
    page: page.page,
    pageSize: page.pageSize,
  }
}

export function createTaskManagerDeps(services: TaskManagerServices): WebviewControllerDeps {
  const { api, output } = services
  const { onAfterChange } = services

  // 记住页面当前查询条件：增删改后按原条件重查（而非固定回到第 1 页）。
  let lastQuery: TaskQuery = { page: 1, pageSize: 10 }
  /** 查询序号：页面轮询 / 树视图刷新 / 手动刷新并发时，慢的过期应答不覆盖新结果。 */
  let querySeq = 0

  async function pushQuery(query: TaskQuery): Promise<void> {
    lastQuery = query
    const seq = ++querySeq
    const page = await api.query(query)
    if (seq !== querySeq) {
      // 已有更新的查询发出：过期应答不入页面（仅记日志，页面无需感知）
      output.appendLine(`[任务管理] 丢弃过期的任务列表应答（seq=${seq}，最新=${querySeq}）`)
      return
    }
    await WebviewController.get('taskManager')?.post({
      type: 'taskList',
      page: toTaskPageWire(page),
    })
  }

  /** 写操作后的重查：新建后回到第 1 页（新任务置顶），其余沿用原查询。 */
  function refreshAfterWrite(created: boolean): Promise<void> {
    if (created) {
      lastQuery = { ...lastQuery, page: 1 }
    }
    return pushQuery(lastQuery)
  }

  /** 删除后的重查：原页码可能因删除越界（返回空页），按最新 total 钳制回有效页。 */
  async function refreshAfterDelete(): Promise<void> {
    const probe = await api.query(lastQuery)
    const maxPage = Math.max(1, Math.ceil(probe.total / probe.pageSize))
    await pushQuery(lastQuery.page > maxPage ? { ...lastQuery, page: maxPage } : lastQuery)
  }

  return {
    buildInit: () => ({
      schema: toFieldDefs(deriveFormSchema(TASK_FIELD_DEFS)),
      value: {},
      extra: { mode: 'taskManager' },
    }),

    // 通用提交生命周期：resolve → 控制器回 submitAck；抛错 → error（err.field 随行）
    onSubmit: async (draft) => {
      const id = typeof draft.id === 'string' ? draft.id : undefined
      const name = typeof draft.name === 'string' ? draft.name.trim() : ''
      const branch = typeof draft.branch === 'string' ? draft.branch.trim() : ''
      const buildType = draft.buildType === 'incremental' ? 'incremental' : 'full'
      const notes = typeof draft.notes === 'string' ? draft.notes : undefined
      if (!name) {
        throw Object.assign(new Error('任务名称不能为空。'), { field: 'name' })
      }
      if (!branch) {
        throw Object.assign(new Error('分支名不能为空。'), { field: 'branch' })
      }
      output.appendLine(
        `[任务管理] ${id ? '编辑' : '新建'}任务：${name}（${branch} / ${buildType}）`
      )
      if (id) {
        const updated = await api.update(id, { name, branch, buildType, notes })
        output.appendLine(`[任务管理] 任务已更新：${updated.id}（${updated.status}）`)
        // 列表刷新失败不影响编辑结论：只记日志，避免「假失败」诱发重复提交
        await refreshAfterWrite(false).catch((err: unknown) => {
          output.appendLine(`[任务管理] 更新成功但任务列表刷新失败：${reasonOf(err)}`)
        })
        // 写成功即驱动侧边栏树刷新（纯读查询不触发——避免页面轮询放大请求量）
        onAfterChange?.()
      } else {
        const created = await api.create({ name, branch, buildType, notes })
        output.appendLine(`[任务管理] 任务已创建：${created.id}（${created.status}）`)
        await refreshAfterWrite(true).catch((err: unknown) => {
          output.appendLine(`[任务管理] 创建成功但任务列表刷新失败：${reasonOf(err)}`)
        })
        onAfterChange?.()
      }
    },

    onPageMessage: (message) => {
      switch (message.type) {
        case 'taskListRequest': {
          const query = {
            keyword: typeof message.query.keyword === 'string' ? message.query.keyword : '',
            status: message.query.status ?? 'all',
            buildType: message.query.buildType ?? 'all',
            page: message.query.page,
            pageSize: message.query.pageSize,
          }
          // 查询失败如实反馈（此前 void 静默：真实接口异常时页面停留在旧数据且无任何提示）
          void pushQuery(query).catch((err: unknown) => {
            output.appendLine(`[任务管理] 任务列表拉取失败：${reasonOf(err)}`)
            void WebviewController.get('taskManager')?.post({
              type: 'error',
              message: `任务列表刷新失败：${reasonOf(err)}`,
            })
          })
          break
        }
        case 'taskDelete': {
          output.appendLine(`[任务管理] 删除任务：${message.id}`)
          void api
            .remove(message.id)
            .then(() => refreshAfterDelete())
            .then(() => onAfterChange?.())
            .catch((err: unknown) => {
              output.appendLine(`[任务管理] 删除任务失败：${reasonOf(err)}`)
              void WebviewController.get('taskManager')?.post({
                type: 'error',
                message: `删除任务失败：${reasonOf(err)}`,
              })
            })
          break
        }
        default:
          break
      }
    },

    log: (message) => output.appendLine(`[任务管理] ${message}`),
  }
}

/** 面板单例包装（模式对齐 WebviewController 的页面面板：单例 + 序列化恢复）。 */
export class TaskManagerPanel {
  private static context: vscode.ExtensionContext | undefined
  private static outputChannel: vscode.OutputChannel | undefined

  /** extension.ts 组装时注入扩展上下文与诊断输出通道（P3-17：诊断不再走 console）。 */
  static configure(context: vscode.ExtensionContext, outputChannel?: vscode.OutputChannel): void {
    TaskManagerPanel.context = context
    TaskManagerPanel.outputChannel = outputChannel
  }

  /**
   * 打开（或复用）任务管理弹框。
   * `extraDeps` 仅用于单测注入面板桩（生产走 vscode 默认 createPanel）。
   */
  static createOrShow(
    services: TaskManagerServices,
    extraDeps?: Partial<WebviewControllerDeps>
  ): void {
    const context = TaskManagerPanel.context
    if (!context) {
      const message = '[taskManager] createOrShow 早退：扩展上下文未注入（configure 未调用）'
      if (TaskManagerPanel.outputChannel) {
        TaskManagerPanel.outputChannel.appendLine(message)
      } else {
        console.warn(message)
      }
      void vscode.window.showErrorMessage(
        '任务管理面板未完成装配（缺少扩展上下文），请重新加载窗口。'
      )
      return
    }
    WebviewController.createOrShow('taskManager', context, {
      ...createTaskManagerDeps(services),
      ...extraDeps,
    })
  }
}
