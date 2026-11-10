import { onBeforeUnmount, onMounted } from 'vue'
import { isHostMessage, type HostMessage, type WebviewMessage } from '../protocol'
import { useVsCodeApi } from './useVsCodeApi'

/**
 * Webview 页面消息编排的最小公共基座（17 方案阶段 3，P2-F1）：
 * 挂载时注册 message 监听并发送 ready，卸载时移除监听；宿主消息先过
 * isHostMessage 运行时守卫再分发（未知消息只被静默忽略，与协议约定一致）。
 * 页面编排（useConsolePage / useTaskPage）在此之上各留业务 switch；
 * post 全程类型化为 WebviewMessage（上行消息编译期校验）。
 */

/** window 的最小结构（本文件被根 tsconfig（lib 仅 ES2022，无 DOM）纳入类型检查，
 * 与 useConsolePage / useVsCodeApi 同款：经结构化 cast 访问浏览器全局）。 */
interface WebviewWindow {
  addEventListener(type: string, listener: (event: { data: unknown }) => void): void
  removeEventListener(type: string, listener: (event: { data: unknown }) => void): void
}

function webviewWindow(): WebviewWindow {
  return (globalThis as unknown as { window: WebviewWindow }).window
}

export function useHostMessages(onHostMessage: (message: HostMessage) => void): {
  post: (message: WebviewMessage) => void
} {
  const api = useVsCodeApi()

  const listener = (event: { data: unknown }): void => {
    const message: unknown = event.data
    if (isHostMessage(message)) {
      onHostMessage(message)
    }
  }

  onMounted(() => {
    webviewWindow().addEventListener('message', listener)
    api.postMessage({ type: 'ready' })
  })

  onBeforeUnmount(() => {
    webviewWindow().removeEventListener('message', listener)
  })

  const post = (message: WebviewMessage): void => {
    api.postMessage(message)
  }

  return { post }
}
