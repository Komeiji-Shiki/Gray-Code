/**
 * LimCode Backend - i18n 国际化模块
 * 
 * 支持语言切换和翻译
 * 与前端共享相同的语言配置
 */

import type { SupportedLanguage, BackendLanguageMessages } from './types';
import zhCN from './langs/zh-CN';
import en from './langs/en';
import ja from './langs/ja';

/**
 * 语言包
 */
const messages: Record<string, BackendLanguageMessages> = {
    'zh-CN': zhCN,
    'en': en,
    'ja': ja
};

/**
 * 拍平后的语言包：key 为点号连接的路径（如 'core.registry.moduleAlreadyRegistered'）。
 * 加载时一次性递归拍平，t() 直接 Map 查找，避免每次调用都逐层走对象属性访问。
 */
const flattenedMessages: Record<string, Map<string, string>> = {};

/** 递归拍平嵌套语言对象（仅收集字符串叶子；数组/其他类型与旧 t() 语义一致视为缺失返回 key） */
function flattenMessages(obj: Record<string, unknown>, prefix: string, target: Map<string, string>): void {
    for (const [key, value] of Object.entries(obj)) {
        const fullKey = prefix ? `${prefix}.${key}` : key;
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            flattenMessages(value as Record<string, unknown>, fullKey, target);
        } else if (typeof value === 'string') {
            target.set(fullKey, value);
        }
    }
}

for (const [lang, msgs] of Object.entries(messages)) {
    const map = new Map<string, string>();
    flattenMessages(msgs as unknown as Record<string, unknown>, '', map);
    flattenedMessages[lang] = map;
}

/** 已告警过的缺失 key（去重：同一 key 只告警一次，避免缺失键在热路径每调刷屏） */
const warnedMissingKeys = new Set<string>();

/**
 * 当前语言设置
 */
let currentLanguage: SupportedLanguage = 'zh-CN';

/**
 * 检测到的语言（从 VS Code 获取）
 */
let detectedLanguage: string = 'zh-CN';

/**
 * 获取实际使用的语言
 */
export function getActualLanguage(): string {
    if (currentLanguage === 'auto') {
        // 尝试匹配检测到的语言
        if (detectedLanguage && messages[detectedLanguage]) {
            return detectedLanguage;
        }
        // 如果检测的语言包含 zh，使用中文
        if (detectedLanguage && detectedLanguage.startsWith('zh')) {
            return 'zh-CN';
        }
        // 如果检测的语言包含 en，使用英文
        if (detectedLanguage && detectedLanguage.startsWith('en')) {
            return 'en';
        }
        // 如果检测的语言包含 ja，使用日文
        if (detectedLanguage && detectedLanguage.startsWith('ja')) {
            return 'ja';
        }
        // 默认使用中文
        return 'zh-CN';
    }
    return currentLanguage;
}

/**
 * 获取当前语言的消息对象
 */
function getCurrentMessages(): BackendLanguageMessages {
    const lang = getActualLanguage();
    return messages[lang] || messages['zh-CN'];
}

/**
 * 获取指定语言的消息对象
 *
 * 当传入 auto 或空值时，返回当前实际语言对应的消息对象。
 */
export function getMessagesForLanguage(lang?: SupportedLanguage | string): BackendLanguageMessages {
    if (!lang || lang === 'auto') {
        return getCurrentMessages();
    }

    if (typeof lang === 'string' && messages[lang]) return messages[lang];
    if (typeof lang === 'string' && lang.startsWith('zh')) return messages['zh-CN'];
    if (typeof lang === 'string' && lang.startsWith('en')) return messages['en'];
    if (typeof lang === 'string' && lang.startsWith('ja')) return messages['ja'];
    return messages['zh-CN'];
}

/**
 * 设置语言
 */
export function setLanguage(lang: SupportedLanguage): void {
    currentLanguage = lang;
}

/**
 * 获取当前语言设置
 */
export function getLanguage(): SupportedLanguage {
    return currentLanguage;
}

/**
 * 设置检测到的语言（从 VS Code 获取）
 */
export function setDetectedLanguage(lang: string): void {
    detectedLanguage = lang;
}

/**
 * 翻译函数
 *
 * 使用点号分隔的路径获取翻译
 * 例如：t('core.registry.moduleAlreadyRegistered', { moduleId: 'config' })
 * 支持参数替换：{paramName} 格式的占位符
 */
export function t(key: string, params?: Record<string, any>): string {
    const map = flattenedMessages[getActualLanguage()] || flattenedMessages['zh-CN'];
    const result = map.get(key);
    if (result === undefined) {
        // 找不到翻译，返回 key 本身；同一 key 只告警一次（缺失键可能在热路径被高频调用）
        if (!warnedMissingKeys.has(key)) {
            warnedMissingKeys.add(key);
            console.warn(`[i18n] Missing translation: ${key}`);
        }
        return key;
    }

    // 如果有参数，替换占位符
    if (params) {
        return result.replace(/\{(\w+)\}/g, (match, paramName) => {
            // hasOwnProperty 防护：{toString} 这类占位符不得访问原型链方法
            return Object.prototype.hasOwnProperty.call(params, paramName)
                ? String(params[paramName])
                : match;
        });
    }
    return result;
}

// 导出类型
export type { SupportedLanguage, BackendLanguageMessages } from './types';

export default {
    t,
    setLanguage,
    getLanguage,
    setDetectedLanguage,
    getMessagesForLanguage
};