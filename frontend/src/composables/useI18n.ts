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

// 参数占位符正则缓存：translate 在消息列表/工具卡渲染中是高频调用，
// 每次都 new RegExp 有编译开销；按转义后的参数键缓存 RegExp 实例。
const paramRegexCache = new Map<string, RegExp>()

function getParamRegex(escapedKey: string): RegExp {
    let regex = paramRegexCache.get(escapedKey)
    if (!regex) {
        regex = new RegExp(`\\{${escapedKey}\\}`, 'g')
        paramRegexCache.set(escapedKey, regex)
    }
    return regex
}

/**
 * 把用户配置的语言解析为可用的语言包 key。
 * 'auto'（跟随系统）按浏览器语言解析，与核心 i18n 模块的解析规则保持一致。
 */
function resolveLang(lang: string): string {
    if (messages[lang]) return lang
    if (lang === 'auto' || lang === '' || !lang) {
        const detected = typeof navigator !== 'undefined' ? navigator.language : 'zh-CN'
        if (detected.startsWith('zh')) return 'zh-CN'
        if (detected.startsWith('ja')) return 'ja'
        if (detected.startsWith('en')) return 'en'
        return 'zh-CN'
    }
    return 'zh-CN'
}

/**
 * 独立的翻译函数，可在 Store 等非 Vue setup 上下文中使用
 * @param lang 语言代码
 * @param key 翻译键
 * @param params 参数对象
 */
export function translate(lang: string, key: string, params?: Record<string, any>): string {
    const message = messages[resolveLang(lang)] || messages['zh-CN']
    
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
    
    // 替换参数（参数键先转义正则元字符，防止 {key} 含特殊字符时替换异常或 ReDoS）
    if (params) {
        return Object.keys(params).reduce((result, paramKey) => {
            const escapedKey = paramKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            return result.replace(getParamRegex(escapedKey), String(params[paramKey]))
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
        return resolveLang(settingsStore.language || 'zh-CN')
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