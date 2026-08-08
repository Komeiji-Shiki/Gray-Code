/**
 * i18n Composable
 * 提供国际化翻译功能
 */

import { computed } from 'vue'
import { useSettingsStore } from '@/stores/settingsStore'
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

export function translate(lang: string, key: string, params?: Record<string, any>): string {
    const message = messages[lang] || messages['zh-CN']
    
    // 按点分割键名获取嵌套对象的值
    const keys = key.split('.')
    let value: any = message
    
    for (const k of keys) {
        if (value && typeof value === 'object' && k in value) {
            value = value[k]
        } else {
            // 键名不存在，返回键名本身
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