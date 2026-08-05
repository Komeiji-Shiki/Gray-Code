/**
 * useI18n.translate 参数替换回归测试：
 * - 替换值使用函数形式，参数值中的 $&/$1/$' 等不再被 String.replace 当作替换模式解释
 *   （如文件名 price$1.txt 曾会变成 price.txt）
 * - 参数键转义后正常替换（{key} 含正则元字符不异常、不 ReDoS）
 */
import { describe, it, expect } from 'vitest'
import { translate } from '@/composables/useI18n'

describe('useI18n.translate 参数替换', () => {
  it('参数值含 $ 替换模式字符时原样输出（函数替换，不解释 $&/$1/$\'）', () => {
    // stores.chatStore.relativeTime.minutesAgo 含 {minutes} 占位符
    const result = translate('zh-CN', 'stores.chatStore.relativeTime.minutesAgo', { minutes: 'price$1.txt' })
    expect(result).not.toContain('price.txt')
    expect(result).toContain('price$1.txt')
  })

  it('参数值含 $& / $1 时不被替换模式解释', () => {
    expect(translate('zh-CN', 'stores.chatStore.relativeTime.minutesAgo', { minutes: 'a$&b' })).toContain('a$&b')
    expect(translate('zh-CN', 'stores.chatStore.relativeTime.minutesAgo', { minutes: 'a$1b' })).toContain('a$1b')
    expect(translate('zh-CN', 'stores.chatStore.relativeTime.minutesAgo', { minutes: 'a$\'b' })).toContain('a$\'b')
  })

  it('参数键含正则元字符时仍能替换且不异常', () => {
    const result = translate('zh-CN', 'stores.chatStore.relativeTime.minutesAgo', { 'min[u]tes': 'x' })
    expect(typeof result).toBe('string')
  })

  it('无参数时保持原文，键不存在时返回键名', () => {
    expect(translate('zh-CN', 'stores.chatStore.relativeTime.minutesAgo', {})).toBeTruthy()
    expect(translate('zh-CN', 'no.such.key', { a: 1 })).toBe('no.such.key')
  })
})
