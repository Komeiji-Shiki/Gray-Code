/**
 * i18n 模块行为测试
 *
 * 覆盖：
 * - 未知检测语言回退英文（en 兜底），不会落入缺失 key
 * - 缺失翻译 key 的 console.warn 按 key 去重（高频调用不刷屏）
 */
import { beforeEach, describe, expect, vi } from 'vitest'
import { t, actualLanguage, setDetectedLanguage, setLanguage } from '../index'

describe('i18n 未知语言兜底', () => {
  beforeEach(() => {
    // vitest.setup 已固定 zh-CN/auto；此处再显式复位，保证用例间隔离
    setDetectedLanguage('zh-CN')
    setLanguage('auto')
  })

  test('未知检测语言（非 zh/en/ja 前缀）回退英文，而不是返回 key 本身', () => {
    setDetectedLanguage('fr-FR')

    expect(actualLanguage.value).toBe('en')
    // 兜底语言中存在该 key → 返回英文文案
    expect(t('app.retryPanel.title')).toBe('Request failed, retrying automatically')
  })

  test('zh 前缀（如 zh-TW）归一为中文，en 前缀归一为英文', () => {
    setDetectedLanguage('zh-TW')
    expect(actualLanguage.value).toBe('zh-CN')

    setDetectedLanguage('en-GB')
    expect(actualLanguage.value).toBe('en')
  })
})

describe('i18n 缺失 key 警告去重', () => {
  beforeEach(() => {
    setDetectedLanguage('zh-CN')
    setLanguage('auto')
  })

  test('同一缺失 key 只警告一次；不同 key 各自警告一次', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const keyA = 'missing.warnDedup.keyA'
    const keyB = 'missing.warnDedup.keyB'

    expect(t(keyA)).toBe(keyA)
    expect(t(keyA)).toBe(keyA)
    expect(t(keyA)).toBe(keyA)
    expect(warn).toHaveBeenCalledTimes(1)

    expect(t(keyB)).toBe(keyB)
    expect(warn).toHaveBeenCalledTimes(2)

    warn.mockRestore()
  })
})
