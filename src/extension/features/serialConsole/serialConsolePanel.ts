import * as vscode from 'vscode'
import { deriveFormSchema, toFieldDefs } from '../../../webview/formSchema'
import type { HostMessage, SerialServerWire, WebviewMessage } from '../../../webview/protocol'
import {
  WebviewController,
  type WebviewControllerDeps,
} from '../../../webview/host/webviewController'
import type { CommandHistoryService } from './commandHistoryService'
import type { SerialServer } from './models'
import { createServerId, passwordKey } from './models'
import type { SerialPortFactory } from './serialPortFactory'
import {
  createSerialLinkService,
  type LinkState,
  type SerialLinkService,
} from './serialLinkService'
import { coerceServerDraft, SERVER_FIELD_DEFS } from './serverSchema'
import type { IServerStore } from './serverStore'
import { removeServerEverywhere, type ServerRemovalResult } from './serverRemoval'
import { reasonOf } from '../../services/errors'

/**
 * 串口命令控制台面板（宿主侧编排）。
 *
 * 职责：
 * - init 下发表单 Schema（SERVER_FIELD_DEFS 派生）+ 服务器列表 + 命令历史；
 * - serialServerSave：coerceServerDraft 校验 → 存储；**password 剥离进 SecretStorage**，
 *   任何路径都不落数据文件（编辑留空 = 保持已存密码）；
 * - serialConnect / serialDisconnect / serialSend：经 SerialLinkService；
 *   自动登录（可选）：连接后延时发送用户名与密码（凭据不进命令历史）；
 * - 面板销毁（onDispose）自动断开串口。
 */

/** SecretStorage 的最小结构面（测试可注入内存实现）。 */
export interface SecretStorageLike {
  get(key: string): Thenable<string | undefined>
  store(key: string, value: string): Thenable<void>
  delete(key: string): Thenable<void>
}

export interface SerialConsoleServices {
  store: IServerStore
  history: CommandHistoryService
  portFactory: SerialPortFactory
  secrets: SecretStorageLike
  /**
   * 共享串口链路（extension.ts 的 SerialConsoleController 注入）：
   * 提供时面板复用该链路，串口消息推送由其 hooks 负责（面板不再自建）；
   * 缺省时面板自建（单测场景），行为等价。
   */
  link?: SerialLinkService
  /** 连接状态快照（树视图读取；面板/控制器更新）。 */
  linkStatus?: LinkStatusSnapshot
  /** 面板发起连接前通知（控制器记录目标服务器，供 serialState/树视图关联）。 */
  onBeforeConnect?: (serverId: string) => void
  /** 服务器增删改后通知（extension.ts 接树视图刷新）。 */
  onServersChanged?: () => void
  /** 诊断日志出口（输出通道）；密码等敏感值绝不打印。 */
  logger?: (message: string) => void
}

/** 树视图 / 控制器读取的连接状态快照（serverId 为空表示无关联目标）。 */
export interface LinkStatusSnapshot {
  serverId: string | undefined
  state: LinkState
}

/** 自动登录时序（设计文档 §7：连接后 800ms 发用户名，再 500ms 发密码；测试可注入短延时）。 */
export const AUTO_LOGIN_USERNAME_DELAY_MS = 800
export const AUTO_LOGIN_PASSWORD_DELAY_MS = 500

/** 旧键拼接用的后缀（现行键的拼接已统一到 models.passwordKey）。 */
const PASSWORD_KEY_SUFFIX = '.password'

/**
 * 旧前缀（v0.7.0，09 方案阶段 5 改名前的 SecretStorage 键）。
 * SecretStorage 无法枚举，密码迁移采用惰性搬迁：读新键未命中时读旧键，
 * 命中则写新键、删旧键并返回（下次起走新键）。
 */
const LEGACY_SECRET_PREFIX = 'crudStarter.serialServer.'

async function getPasswordWithMigration(
  secrets: SecretStorageLike,
  serverId: string
): Promise<string | undefined> {
  const key = passwordKey(serverId)
  const current = await secrets.get(key)
  if (current !== undefined) {
    return current
  }
  const legacyKey = `${LEGACY_SECRET_PREFIX}${serverId}${PASSWORD_KEY_SUFFIX}`
  const legacy = await secrets.get(legacyKey)
  if (legacy === undefined) {
    return undefined
  }
  await secrets.store(key, legacy)
  await secrets.delete(legacyKey)
  return legacy
}

/**
 * SerialServer → 协议线类型（接口缺隐式索引签名，经对象字面量展开获得；
 * 与 formSchema.toFieldDefs 的匿名字面量拷贝同理）。
 */
export function toServerWire(server: SerialServer): SerialServerWire {
  return { ...server }
}

export interface SerialConsolePanelOptions {
  /** 连接目标（树视图「连接并打开控制台」进入时预选）；每次打开取一次。 */
  getInitialServerId?: () => string | undefined
  /** 测试注入的自动登录时序。 */
  usernameDelayMs?: number
  passwordDelayMs?: number
}

/**
 * 串口控制台的宿主依赖工厂（页面消息分发见类注释；post 经控制器注册表，
 * 面板不存在时为 no-op）。
 */
export function createSerialConsoleDeps(
  services: SerialConsoleServices,
  options: SerialConsolePanelOptions = {}
): WebviewControllerDeps {
  const usernameDelay = options.usernameDelayMs ?? AUTO_LOGIN_USERNAME_DELAY_MS
  const passwordDelay = options.passwordDelayMs ?? AUTO_LOGIN_PASSWORD_DELAY_MS

  /** 当前连接目标（serialState 推送时标识；断开不清除，便于页面关联错误信息）。 */
  let activeServerId: string | undefined

  /** 注入共享链路时消息推送与状态同步由其 hooks 负责；否则面板自建（单测场景）。 */
  const syncStatus = (state: LinkState): void => {
    if (services.linkStatus) {
      services.linkStatus.state = state
      services.linkStatus.serverId = activeServerId
    }
  }

  const link =
    services.link ??
    createSerialLinkService(services.portFactory, {
      onData: (text, seq) => void post({ type: 'serialData', seq, text }),
      onState: (state, error) => {
        syncStatus(state)
        void post({ type: 'serialState', serverId: activeServerId ?? null, state, error })
      },
    })

  async function post(message: HostMessage): Promise<void> {
    WebviewController.get('serialConsole')?.post(message)
  }

  async function pushServers(next: SerialServer[]): Promise<void> {
    await post({ type: 'serialServers', servers: next.map(toServerWire) })
    services.onServersChanged?.()
  }

  /**
   * 写前重读：store 是服务器列表的唯一真值源（P1-1）。
   * 树视图删除 / 手改数据文件不经过面板 deps，任何变更操作前必须从 store
   * 重读，避免基于陈旧内存列表整体覆写（复活已删除的服务器）。
   */
  async function loadServersOrPostError(): Promise<SerialServer[] | undefined> {
    try {
      return await services.store.load()
    } catch (err) {
      await post({ type: 'error', message: `加载服务器列表失败：${reasonOf(err)}` })
      return undefined
    }
  }

  async function pushHistory(): Promise<void> {
    await post({ type: 'commandHistory', entries: await services.history.list() })
  }

  const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

  /** 自动登录：连接后按序发送用户名 / 密码（凭据不经命令历史，不回显到日志）。
   * 代际守卫（P1-2）：等待期间连接被切换 / 断开时立即终止，凭据绝不写入
   * 其他服务器的端口（link.send 只校验「已连接」，不校验端口归属）。 */
  async function maybeAutoLogin(server: SerialServer): Promise<void> {
    if (!server.autoLogin || server.username.length === 0) return
    const stillCurrent = (): boolean =>
      link.state() === 'connected' && link.connectedServerId() === server.id
    if (!stillCurrent()) return
    const password = await getPasswordWithMigration(services.secrets, server.id)
    if (!password) {
      await post({
        type: 'error',
        message: '未保存登录密码：请编辑服务器并填写密码后再使用自动登录。',
      })
      return
    }
    if (!stillCurrent()) return
    await wait(usernameDelay)
    if (!stillCurrent()) return
    link.send(server.username)
    await wait(passwordDelay)
    if (!stillCurrent()) return
    link.send(password)
  }

  async function saveServer(draft: Record<string, unknown>, password?: string): Promise<void> {
    const coerced = coerceServerDraft(draft)
    if (!coerced.ok) {
      await post({ type: 'error', message: coerced.message, field: coerced.field })
      return
    }
    const servers = await loadServersOrPostError()
    if (!servers) {
      return
    }
    const now = Date.now()
    const existingId = typeof draft.id === 'string' ? draft.id : undefined
    const existing = existingId ? servers.find((server) => server.id === existingId) : undefined
    const id = existing?.id ?? createServerId()
    const next: SerialServer = {
      ...coerced.draft,
      id,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    const rest = servers.filter((server) => server.id !== id)
    try {
      // 先落盘成功再推 UI / 写密码：失败时页面与存储保持一致
      await services.store.save([...rest, next])
    } catch (err) {
      await post({ type: 'error', message: `保存服务器失败：${reasonOf(err)}` })
      return
    }
    if (password !== undefined && password.length > 0) {
      // SecretStorage 在 keychain 锁定等场景会 reject（P2-B3）：显式上报，
      // 不让「服务器已保存但密码没存」静默发生，也不产生未处理拒绝
      try {
        await services.secrets.store(passwordKey(id), password)
      } catch (err) {
        await post({ type: 'error', message: `服务器已保存，但写入登录密码失败：${reasonOf(err)}` })
      }
    }
    services.logger?.(`串口服务器已保存：${next.name}（${next.serialPath}）`)
    await pushServers([...rest, next])
  }

  async function deleteServer(id: string): Promise<void> {
    // 核心逻辑收敛到 removeServerEverywhere（与树右键路径同实现，17 方案阶段 1）
    let result: ServerRemovalResult
    try {
      result = await removeServerEverywhere(
        { store: services.store, secrets: services.secrets, link, logger: services.logger },
        id
      )
    } catch (err) {
      await post({ type: 'error', message: `删除服务器失败：${reasonOf(err)}` })
      return
    }
    if (result.status === 'missing') {
      await post({ type: 'error', message: '要删除的服务器不存在，可能已被删除，请刷新列表。' })
      return
    }
    if (result.secretError) {
      await post({ type: 'error', message: result.secretError })
    }
    await pushServers(result.rest)
  }

  async function connectServer(serverId: string): Promise<void> {
    const servers = await loadServersOrPostError()
    if (!servers) {
      return
    }
    const target = servers.find((server) => server.id === serverId)
    if (!target) {
      await post({ type: 'error', message: '要连接的服务器不存在，可能已被删除，请刷新列表。' })
      return
    }
    activeServerId = serverId
    services.onBeforeConnect?.(serverId)
    syncStatus('connecting')
    try {
      await link.connect(target)
      await maybeAutoLogin(target)
    } catch {
      // 状态与错误经 onState → serialState 推送，这里不重复报错
    }
  }

  async function sendCommand(command: string): Promise<void> {
    if (link.state() !== 'connected') {
      await post({ type: 'error', message: '串口未连接，请先连接服务器。' })
      return
    }
    try {
      link.send(command)
    } catch (err) {
      await post({ type: 'error', message: reasonOf(err) })
      return
    }
    await services.history.record(command)
    await pushHistory()
  }

  return {
    buildInit: async () => {
      let servers: SerialServer[]
      try {
        servers = await services.store.load()
      } catch (err) {
        services.logger?.(`加载服务器列表失败：${reasonOf(err)}`)
        servers = []
      }
      const initialServerId = options.getInitialServerId?.()
      return {
        schema: toFieldDefs(deriveFormSchema(SERVER_FIELD_DEFS)),
        value: null,
        extra: {
          servers: servers.map(toServerWire),
          history: await services.history.list(),
          initialServerId: initialServerId ?? null,
        },
      }
    },
    onPageMessage: (message: WebviewMessage) => {
      // 页面消息处理器均为 fire-and-forget：统一兜底 catch（P2-B3），
      // 处理器内部的错误已各自就地处理，这里只兜未预见的 rejection
      const swallow = (task: Promise<unknown>): void => {
        void task.catch((err: unknown) => services.logger?.(`[未处理] ${reasonOf(err)}`))
      }
      switch (message.type) {
        case 'serialPortsRequest':
          void services.portFactory
            .list()
            .then((ports) => post({ type: 'serialPorts', ports }))
            .catch((err: unknown) =>
              post({ type: 'error', message: `检测串口失败：${reasonOf(err)}` })
            )
          break
        case 'serialServerSave':
          swallow(saveServer(message.draft, message.password))
          break
        case 'serialServerDelete':
          swallow(deleteServer(message.id))
          break
        case 'serialConnect':
          swallow(connectServer(message.serverId))
          break
        case 'serialDisconnect':
          link.disconnect()
          break
        case 'serialSend':
          swallow(sendCommand(message.command))
          break
        case 'commandHistoryRemove':
          swallow(services.history.remove(message.id).then(() => pushHistory()))
          break
        case 'commandHistoryClear':
          swallow(services.history.clear().then(() => pushHistory()))
          break
        default:
          break // ready/submit 由控制器处理
      }
    },
    onDispose: () => {
      // 面板关闭即断开串口：COM 口是独占资源，不能随面板潜伏
      link.disconnect()
    },
  }
}

/** 面板单例包装（模式对齐 ItemFormPanel / ImportWizardPanel）。 */
export class SerialConsolePanel {
  private static context: vscode.ExtensionContext | undefined
  private static current: SerialConsolePanel | undefined

  /** extension.ts 组装时注入扩展上下文。 */
  static configure(context: vscode.ExtensionContext): void {
    SerialConsolePanel.context = context
  }

  /** 打开（或复用）控制台页面；initialServerId 预选并自动连接（每次打开取一次）。 */
  static createOrShow(
    services: SerialConsoleServices,
    initialServerId?: string,
    extraDeps?: Partial<WebviewControllerDeps>,
    options?: Omit<SerialConsolePanelOptions, 'getInitialServerId'>
  ): void {
    const context = SerialConsolePanel.context
    if (!context) {
      void vscode.window.showErrorMessage(
        '串口控制台面板未完成装配（缺少扩展上下文），请重新加载窗口。'
      )
      return
    }
    const existing = SerialConsolePanel.current
    if (existing && WebviewController.get('serialConsole')) {
      existing.controller?.reveal()
      if (initialServerId) {
        existing.initialServerId = initialServerId
        existing.controller?.sendInit()
      }
      return
    }
    SerialConsolePanel.current = new SerialConsolePanel(
      context,
      services,
      initialServerId,
      extraDeps,
      options
    )
  }

  private controller: WebviewController | undefined
  /** 预选连接目标（buildInit 消费一次后清空，避免序列化恢复时意外重连）。 */
  private initialServerId: string | undefined

  private constructor(
    context: vscode.ExtensionContext,
    services: SerialConsoleServices,
    initialServerId: string | undefined,
    extraDeps?: Partial<WebviewControllerDeps>,
    options?: Omit<SerialConsolePanelOptions, 'getInitialServerId'>
  ) {
    this.initialServerId = initialServerId
    const baseDeps = createSerialConsoleDeps(services, {
      ...options,
      getInitialServerId: () => {
        const id = this.initialServerId
        this.initialServerId = undefined
        return id
      },
    })
    this.controller = WebviewController.createOrShow('serialConsole', context, {
      ...baseDeps,
      ...extraDeps,
      // 面板关闭时清空单例引用（P3-D5）：下次 createOrShow 走全新装配而非悬挂引用
      onDispose: () => {
        SerialConsolePanel.current = undefined
        baseDeps.onDispose?.()
        extraDeps?.onDispose?.()
      },
    })
  }
}
