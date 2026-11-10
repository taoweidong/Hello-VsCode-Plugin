import { passwordKey, type SerialServer } from './models'
import type { SerialLinkService } from './serialLinkService'
import type { IServerStore } from './serverStore'
import { reasonOf } from '../../services/errors'

/**
 * 串口服务器删除的单一实现（17 方案阶段 1，收敛 P2-B2）。
 *
 * 此前「load → 过滤 → 落盘 → 清理 SecretStorage → 联动断开」在控制器（树右键）
 * 与面板（webview serialDelete）两条路径各写一份且错误契约分叉：面板路径密码
 * 清理失败有上报，控制器路径连 try/catch 都没有。收敛后两条路径只负责各自的
 * 呈现（控制器：post + 树刷新 + 告警；面板：pushServers + 页内 error）。
 */

/** 删除结果：missing = 目标不存在；deleted 携带删除后的完整列表与可选的密码清理错误。 */
export type ServerRemovalResult =
  { status: 'missing' } | { status: 'deleted'; rest: SerialServer[]; secretError?: string }

export interface ServerRemovalDeps {
  store: IServerStore
  /** SecretStorage 最小结构面（与 serialConsolePanel.SecretStorageLike 同构）。 */
  secrets: { delete(key: string): Thenable<void> }
  /** 共享串口链路（删除当前连接目标时联动断开）。 */
  link: Pick<SerialLinkService, 'connectedServerId' | 'disconnect'>
  /** 诊断日志出口（输出通道）；密码等敏感值绝不打印。 */
  logger?: (message: string) => void
}

/**
 * 从存储、SecretStorage 与活动连接中移除指定服务器：
 * - 目标不存在 → { status: 'missing' }（调用方自行决定提示语）；
 * - 落盘失败向上抛（调用方各自呈现；此时密码与连接均未动）；
 * - 密码清理失败不阻断删除（secretError 如实上报，对齐面板路径既有语义）。
 */
export async function removeServerEverywhere(
  deps: ServerRemovalDeps,
  id: string
): Promise<ServerRemovalResult> {
  const servers = await deps.store.load()
  const target = servers.find((server) => server.id === id)
  if (!target) {
    return { status: 'missing' }
  }
  const rest = servers.filter((server) => server.id !== id)
  await deps.store.save(rest)
  let secretError: string | undefined
  try {
    await deps.secrets.delete(passwordKey(id))
  } catch (err) {
    secretError = `服务器已删除，但清理保存的密码失败：${reasonOf(err)}`
  }
  if (deps.link.connectedServerId() === id) {
    deps.link.disconnect()
  }
  deps.logger?.(`串口服务器已删除：${target.name}`)
  return { status: 'deleted', rest, secretError }
}
