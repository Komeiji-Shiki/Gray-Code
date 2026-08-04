/**
 * GrayCode - i18n 国际化模块
 * 
 * 支持语言切换和翻译
 */

import { ref, computed } from 'vue';
import type { SupportedLanguage, LanguageMessages, LanguageOption } from './types';
import zhCN from './langs/zh-CN';
import en from './langs/en';
import ja from './langs/ja';

/**
 * 支持的语言列表
 */
export const SUPPORTED_LANGUAGES: LanguageOption[] = [
    { value: 'auto', label: '跟随系统', nativeLabel: 'Auto' },
    { value: 'zh-CN', label: '简体中文', nativeLabel: '简体中文' },
    { value: 'en', label: 'English', nativeLabel: 'English' },
    { value: 'ja', label: '日本語', nativeLabel: '日本語' }
];

/**
 * 语言包
 */
const messages: Record<string, LanguageMessages> = {
    'zh-CN': zhCN,
    'en': en,
    'ja': ja
};

/**
 * 当前语言设置
 */
const currentLanguage = ref<SupportedLanguage>('auto');

/**
 * VS Code 检测到的语言
 */
const detectedLanguage = ref<string>('zh-CN');

/**
 * 获取实际使用的语言
 */
const actualLanguage = computed(() => {
    if (currentLanguage.value === 'auto') {
        // 尝试匹配检测到的语言
        const detected = detectedLanguage.value;
        if (detected && messages[detected]) {
            return detected;
        }
        // 如果检测的语言包含 zh，使用中文
        if (detected && detected.startsWith('zh')) {
            return 'zh-CN';
        }
        // 如果检测的语言包含 en，使用英文
        if (detected && detected.startsWith('en')) {
            return 'en';
        }
        // 如果检测的语言包含 ja，使用日文
        if (detected && detected.startsWith('ja')) {
            return 'ja';
        }
        // 默认使用中文
        return 'zh-CN';
    }
    return currentLanguage.value;
});

/**
 * 当前语言的消息对象
 */
const currentMessages = computed(() => {
    return messages[actualLanguage.value] || messages['zh-CN'];
});

/**
 * 设置语言
 */
export function setLanguage(lang: SupportedLanguage) {
    currentLanguage.value = lang;
}

/**
 * 获取当前语言设置
 */
export function getLanguage(): SupportedLanguage {
    return currentLanguage.value;
}

/**
 * 设置检测到的语言（由后端传入）
 */
export function setDetectedLanguage(lang: string) {
    detectedLanguage.value = lang;
}

/**
 * 翻译函数
 *
 * 使用点号分隔的路径获取翻译
 * 例如：t('settings.general.title')
 * 支持参数替换：t('message.error', { count: 5 })
 */
export function t(key: string, params?: Record<string, any>): string {
    const keys = key.split('.');
    let result: any = currentMessages.value;
    
    for (const k of keys) {
        if (result && typeof result === 'object' && k in result) {
            result = result[k];
        } else {
            // 找不到翻译，返回 key 本身
            console.warn(`[i18n] Missing translation: ${key}`);
            return key;
        }
    }
    
    if (typeof result === 'string') {
        // 如果有参数，替换占位符
        if (params) {
            return result.replace(/\{(\w+)\}/g, (match, paramName) => {
                return params[paramName] !== undefined ? String(params[paramName]) : match;
            });
        }
        return result;
    }
    
    return key;
}

/**
 * 检查翻译 key 是否存在（静默，不输出缺失警告）。
 *
 * 用于“可选翻译”场景：如动态工具名的本地化（toolLocalization），
 * 缺失时需要回退机械转换/原文，而不是让 t() 为每个缺失 key 刷一条 console.warn。
 */
export function hasMessage(key: string): boolean {
    const keys = key.split('.');
    let result: any = currentMessages.value;

    for (const k of keys) {
        if (result && typeof result === 'object' && k in result) {
            result = result[k];
        } else {
            return false;
        }
    }

    return typeof result === 'string';
}

/**
 * 组合式函数 - 在组件中使用
 */
export function useI18n() {
    return {
        t,
        currentLanguage,
        actualLanguage,
        setLanguage,
        getLanguage,
        setDetectedLanguage,
        SUPPORTED_LANGUAGES
    };
}

export default {
    t,
    setLanguage,
    getLanguage,
    setDetectedLanguage,
    useI18n,
    SUPPORTED_LANGUAGES
};