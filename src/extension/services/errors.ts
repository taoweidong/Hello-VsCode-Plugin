/**
 * 错误消息提取（跨 feature 共用的最小助手，P3-C1 收敛）：
 * Error 取 message，其他值 String 化——降级提示 / 输出通道 / 协议 error 的统一语义。
 */
export function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
