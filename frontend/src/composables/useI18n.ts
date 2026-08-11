/**
 * i18n Composable
 * 提供国际化翻译功能
 */

import { computed } from 'vue'
import { useSettingsStore } from '@/stores/settingsStore'
import { actualLanguage } from '@/i18n'
import type { LanguageMessages } from '@/i18n/types'
import zhCN from '@/i18n/langs/zh-CN'
import en from '@/i18n/langs/en'
import ja from '@/i18n/langs/ja'

const messages: Record<string, LanguageMessages> = {
    'zh-CN': zhCN,
    'en': en,
    'ja': ja
}

// 导出 messages 对象供外部使用
export { messages }

/**
 * 独立的翻译函数，可在 Store 等非 Vue setup 上下文中使用
 * @param lang 语言代码
 * @param key 翻译键
 * @param params 参数对象
 */
function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 已输出过缺失警告的 key（防刷屏；缺失行为与 i18n/index.ts 的 t() 对齐） */
const warnedMissingKeys = new Set<string>()

export function translate(lang: string, key: string, params?: Record<string, any>): string {
    // lang='auto'（跟随系统）时复用 i18n/index.ts 的 actualLanguage 归一化：
    // 按 navigator.language 探测 zh/en/ja、未知回退 en，与 i18n 版 t() 同一口径；
    // 避免 messages['auto'] 不存在而恒回退 zh-CN，导致界面与系统探测语言混杂。
    const resolvedLang = lang === 'auto' ? actualLanguage.value : lang
    const message = messages[resolvedLang] || messages['zh-CN']
    
    // 按点分割键名获取嵌套对象的值
    const keys = key.split('.')
    let value: any = message
    
    for (const k of keys) {
        if (value && typeof value === 'object' && k in value) {
            value = value[k]
        } else {
            // 键名不存在：与 i18n/index.ts 的 t() 对齐——按 key 去重输出缺失警告后返回键名本身
            if (!warnedMissingKeys.has(key)) {
                warnedMissingKeys.add(key)
                console.warn(`[i18n] Missing translation: ${key}`)
            }
            return key
        }
    }
    
    // 如果值不是字符串，返回键名
    if (typeof value !== 'string') {
        return key
    }
    
    // 替换参数
    if (params) {
        return Object.keys(params).reduce((result, paramKey) => {
            return result.replace(new RegExp(`\\{${escapeRegExp(paramKey)}\\}`, 'g'), String(params[paramKey]))
        }, value)
    }
    
    return value
}

/**
 * Vue Composable - 在组件中使用
 */
export function useI18n() {
    const settingsStore = useSettingsStore()
    
    // 当前语言
    const currentLanguage = computed(() => {
        return settingsStore.language || 'zh-CN'
    })
    
    // 翻译函数
    function t(key: string, params?: Record<string, any>): string {
        return translate(currentLanguage.value, key, params)
    }
    
    return {
        t,
        currentLanguage
    }
}