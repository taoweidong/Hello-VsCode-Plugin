import { onBeforeUnmount, ref } from 'vue'

/**
 * 两段式布防确认：首点布防，`timeoutMs` 内再点同一目标才算确认，超时自动解除。
 *
 * 取代浏览器模态 confirm——VS Code webview 沙箱（iframe 无 allow-modals）下
 * confirm 恒被忽略而返回 false，依赖它的按钮在真实产品里永远无法执行
 * （第五轮评估 P0）。key 支持两种用法：
 * - 「每行独立布防」：列表删除传行 id（原 ServerList 实现）；
 * - 「单目标布防」：清空 / 重置传固定 key（原 HistoryPanel 实现）。
 * 同一时间至多一个 key 处于布防态（对齐原实现的互斥语义）。
 */
export interface TwoStepConfirm {
  /** 目标当前是否处于布防态（模板中用于切换按钮文案 / 样式）。 */
  isArmed(key: string): boolean
  /**
   * 点击处理：目标已布防则解除并返回 true（调用方据此执行敏感操作）；
   * 否则布防 key 并启动超时，返回 false。
   */
  confirm(key: string): boolean
  /** 手动解除（目标从列表消失、开始新编辑等场景；省略 key 时解除任意布防）。 */
  disarm(key?: string): void
}

export function useTwoStepConfirm(timeoutMs = 3_000): TwoStepConfirm {
  const armedKey = ref<string | undefined>(undefined)
  let disarmTimer: ReturnType<typeof setTimeout> | undefined

  function stopTimer(): void {
    if (disarmTimer !== undefined) {
      clearTimeout(disarmTimer)
      disarmTimer = undefined
    }
  }

  function disarm(key?: string): void {
    if (key !== undefined && armedKey.value !== key) return
    stopTimer()
    armedKey.value = undefined
  }

  function isArmed(key: string): boolean {
    return armedKey.value === key
  }

  function confirm(key: string): boolean {
    if (armedKey.value === key) {
      disarm()
      return true
    }
    stopTimer()
    armedKey.value = key
    disarmTimer = setTimeout(() => {
      armedKey.value = undefined
      disarmTimer = undefined
    }, timeoutMs)
    return false
  }

  onBeforeUnmount(() => {
    stopTimer()
    armedKey.value = undefined
  })

  return { isArmed, confirm, disarm }
}
