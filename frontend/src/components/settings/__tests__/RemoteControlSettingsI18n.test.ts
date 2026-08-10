/**
 * RemoteControlSettings 组件 i18n 键完整性回归测试
 *
 * 背景：远程控制设置页曾把组件文案键写成 components.settings.remoteControlSettings.*，
 * 而语言包中的实际层级是 components.settings.settingsPanel.remoteControlSettings.*——
 * t() 找不到翻译时返回 key 本身，设置页整页显示原始键名（「键名全是漏的」）。
 * 本测试静态提取组件内全部 t('...') 键，逐一校验三语言包中均存在且为字符串。
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import zhCN from '@/i18n/langs/zh-CN'
import en from '@/i18n/langs/en'
import ja from '@/i18n/langs/ja'

const COMPONENT_PATH = path.resolve(process.cwd(), 'src/components/settings/RemoteControlSettings.vue')

/** 沿点路径取值；缺失返回 undefined */
function resolveMessage(messages: Record<string, unknown>, key: string): unknown {
  let result: unknown = messages
  for (const part of key.split('.')) {
    if (result && typeof result === 'object' && part in (result as Record<string, unknown>)) {
      result = (result as Record<string, unknown>)[part]
    } else {
      return undefined
    }
  }
  return result
}

describe('RemoteControlSettings i18n 键完整性', () => {
  const source = readFileSync(COMPONENT_PATH, 'utf8')

  // 提取组件中所有 t('...') 键（script 与 template 通吃）
  const keys = [...new Set(
    Array.from(source.matchAll(/t\('([^']+)'\)/g), (m) => m[1])
  )]

  it('组件中确实使用了 i18n 键（防止测试因匹配不到而空转）', () => {
    expect(keys.length).toBeGreaterThan(10)
  })

  it('全部 t() 键在 zh-CN / en / ja 三语言包中存在且为字符串', () => {
    const langs: Array<[string, Record<string, unknown>]> = [
      ['zh-CN', zhCN as unknown as Record<string, unknown>],
      ['en', en as unknown as Record<string, unknown>],
      ['ja', ja as unknown as Record<string, unknown>]
    ]
    const missing: string[] = []
    for (const key of keys) {
      for (const [lang, messages] of langs) {
        const value = resolveMessage(messages, key)
        if (typeof value !== 'string') {
          missing.push(`${lang}: ${key}`)
        }
      }
    }
    expect(missing).toEqual([])
  })
})
