/**
 * Chat Store 通用工具函数
 */

import type { ChatStoreState } from './types'
import { translate, actualLanguage } from '../../composables/useI18n'
import { useSettingsStore } from '../settingsStore'

/**
 * 竞态统一守护：校验当前活跃会话是否仍是请求发起时的会话。
 *
 * 所有在 await 后需要写 state 的 async 函数都应在 await 后调用此函数进行归属校验。
 * 返回 false 表示会话已切换，调用方应中止后续写操作。
 */
export function validateSessionIdentity(
  state: ChatStoreState,
  expectedConversationId: string | null
): boolean {
  return state.currentConversationId.value === expectedConversationId
}

/**
 * 格式化时间
 */
export function formatTime(timestamp: number): string {
  const settingsStore = useSettingsStore()
  const lang = settingsStore.language || 'zh-CN'
  
  const now = Date.now()
  const diff = now - timestamp
  
  const minute = 60 * 1000
  const hour = 60 * minute
  const day = 24 * hour
  
  if (diff < minute) {
    return translate(lang, 'stores.chatStore.relativeTime.justNow')
  } else if (diff < hour) {
    const minutes = Math.floor(diff / minute)
    return translate(lang, 'stores.chatStore.relativeTime.minutesAgo', { minutes })
  } else if (diff < day) {
    const hours = Math.floor(diff / hour)
    return translate(lang, 'stores.chatStore.relativeTime.hoursAgo', { hours })
  } else if (diff < 7 * day) {
    const days = Math.floor(diff / day)
    return translate(lang, 'stores.chatStore.relativeTime.daysAgo', { days })
  } else {
    // 超过一周显示完整日期；传当前语言，避免日期格式与界面语言不一致。
    // 'auto'（跟随系统）不是合法 BCP 47 标签，先经 actualLanguage 归一化，
    // 否则 toLocaleDateString('auto') 会抛 RangeError 导致历史列表渲染崩溃。
    const resolved = lang === 'auto' ? actualLanguage.value : lang
    return new Date(timestamp).toLocaleDateString(resolved)
  }
}
