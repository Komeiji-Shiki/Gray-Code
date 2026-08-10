/**
 * 忙时投递（U1）的轻量回显通知（从 messageActions.ts 拆出）。
 *
 * 模块级可变状态（recentInterruptDeliveries / interruptNoticeSeq）随本模块迁移并保持单例：
 * 所有引用方（sendMessageFlow / MessageList / 测试）经 messageActions 壳 re-export 得到同一实例。
 */

import { shallowRef } from 'vue'

/**
 * 用户消息插入（U1）单条文本长度上限（与后端 mailbox 约定一致）
 */
export const INTERRUPT_MESSAGE_MAX_LENGTH = 4000

/**
 * U1（用户消息插入）投递结果的轻量回显状态（M3-1）。
 *
 * 忙时投递只把用户消息写入主会话 inbox，窗口内不落任何痕迹、不推 chunk；
 * 这里记录「最近投递 / 投递失败」状态，由 MessageList 在消息区给出轻量提示：
 * - ① 投递成功：提示「已投递，将在当前回合结束后处理」，避免用户看不到结果；
 * - ③ 投递失败（如 INTERRUPT_MESSAGE_RATE_LIMITED）：给出可见错误反馈，
 *   不写 state.error（避免打断进行中的回合）。
 */
export interface InterruptDeliveryNotice {
  conversationId: string
  text: string
  kind: 'delivered' | 'error'
  errorCode?: string
  errorMessage?: string
  createdAt: number
  /** 单调递增序号：TTL 到期按序号精确移除，避免同 tick（createdAt 相同）的其它会话提示被误删 */
  seq?: number
}

/** 提示保留时长：超过后自动从列表中移除 */
export const INTERRUPT_NOTICE_TTL_MS = 10_000
/** 同一时刻最多保留的投递提示条数（防御性兜底） */
export const INTERRUPT_NOTICE_MAX = 3

export const recentInterruptDeliveries = shallowRef<InterruptDeliveryNotice[]>([])

let interruptNoticeSeq = 0

/** 记录一条投递提示：同一会话同类型只保留最新一条；超出上限丢弃最旧；TTL 后自动移除 */
export function recordInterruptDelivery(notice: Omit<InterruptDeliveryNotice, 'createdAt'>): void {
  const full: InterruptDeliveryNotice = { ...notice, createdAt: Date.now(), seq: interruptNoticeSeq++ }
  const filtered = recentInterruptDeliveries.value.filter(
    n => !(n.conversationId === full.conversationId && n.kind === full.kind)
  )
  recentInterruptDeliveries.value = [full, ...filtered].slice(0, INTERRUPT_NOTICE_MAX)
  setTimeout(() => {
    // 按 seq 精确移除：多条提示 createdAt 可能相同（同一 tick 的并发投递），
    // 按 createdAt 过滤会误删仍在 TTL 内的其它会话提示
    recentInterruptDeliveries.value = recentInterruptDeliveries.value.filter(n => n.seq !== full.seq)
  }, INTERRUPT_NOTICE_TTL_MS)
}

/** 清除指定会话的投递提示（当前回合结束时由 MessageList 调用） */
export function clearInterruptDeliveries(conversationId: string): void {
  recentInterruptDeliveries.value = recentInterruptDeliveries.value.filter(n => n.conversationId !== conversationId)
}
