/**
 * LimCode Backend - i18n 国际化模块
 * 
 * 支持语言切换和翻译
 * 两套独立语言包（后端与前端），需同步维护
 */

import type { SupportedLanguage, BackendLanguageMessages } from './types';
import zhCN from './langs/zh-CN';
import en from './langs/en';
import ja from './langs/ja';

/**
 * 语言包
 */
const messages: Record<Exclude<SupportedLanguage, 'auto'>, BackendLanguageMessages> = {
    'zh-CN': zhCN,
    'en': en,
    'ja': ja
};

/** 已告警过的缺失 key（去重：同一 key 只告警一次，避免缺失键在热路径每调刷屏） */
const warnedMissingKeys = new Set<string>();

/** 无参调用的翻译结果缓存（只缓存字符串结果；语言切换时清空） */
let cachedLanguage: Exclude<SupportedLanguage, 'auto'> | undefined;
const translationCache = new Map<string, string>();

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
export function getActualLanguage(): Exclude<SupportedLanguage, 'auto'> {
    if (currentLanguage === 'auto') {
        // 尝试匹配检测到的语言
        if (detectedLanguage === 'zh-CN' || detectedLanguage === 'en' || detectedLanguage === 'ja') {
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
        // 默认使用英文（未知语言的兜底；与前端 actualLanguage 一致，
        // 避免 webview 英文、后端中文的割裂——R2 M2）
        return 'en';
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

    if (lang === 'zh-CN' || lang === 'en' || lang === 'ja') {
        return messages[lang];
    }
    if (typeof lang === 'string' && lang.startsWith('zh')) return messages['zh-CN'];
    if (typeof lang === 'string' && lang.startsWith('en')) return messages['en'];
    if (typeof lang === 'string' && lang.startsWith('ja')) return messages['ja'];
    return messages['en']; // 未知语言兜底英文（与 getActualLanguage 一致）
}

/**
 * 设置语言
 */
export function setLanguage(lang: SupportedLanguage): void {
    currentLanguage = lang;
    // 语言变化后重置缺失 key 告警与翻译缓存（见 t() 顶部的缓存逻辑）
    warnedMissingKeys.clear();
    cachedLanguage = undefined;
    translationCache.clear();
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
    // 检测语言变化同样重置告警与翻译缓存
    warnedMissingKeys.clear();
    cachedLanguage = undefined;
    translationCache.clear();
}

/**
 * 翻译函数
 *
 * 使用点号分隔的路径获取翻译
 * 例如：t('core.registry.moduleAlreadyRegistered', { moduleId: 'config' })
 * 支持参数替换：{paramName} 格式的占位符
 */
export function t(key: string, params?: Record<string, string | number | boolean>): string {
    // 无参调用 + 语言未变化：命中缓存直接返回；语言切换后（缓存已清空）重新解析
    if (!params) {
        const lang = getActualLanguage();
        if (cachedLanguage === lang) {
            const cached = translationCache.get(key);
            if (cached !== undefined) {
                return cached;
            }
        } else {
            cachedLanguage = lang;
            translationCache.clear();
        }
    }

    const keys = key.split('.');
    let result: unknown = getCurrentMessages();

    for (const k of keys) {
        // 用 hasOwnProperty 判断，避免 k 命中对象原型链属性（如 constructor/toString）被误当成翻译键
        if (result && typeof result === 'object' && Object.prototype.hasOwnProperty.call(result, k)) {
            result = (result as Record<string, unknown>)[k];
        } else {
            // 找不到翻译，返回 key 本身（同一 key 只告警一次）
            if (!warnedMissingKeys.has(key)) {
                warnedMissingKeys.add(key);
                console.warn(`[i18n] Missing translation: ${key}`);
            }
            return key;
        }
    }

    if (typeof result === 'string') {
        // 如果有参数，替换占位符（null/undefined 保留原占位符，避免输出字面量 "null"）；
        // 带参数的结果不缓存（替换依赖每次传入的 params）
        if (params) {
            return result.replace(/\{([\w-]+)\}/g, (match, paramName: string) => {
                const value = params[paramName];
                return value != null ? String(value) : match;
            });
        }
        translationCache.set(key, result);
        return result;
    }

    // 路径解析结果不是字符串（指向对象/数组/数字等）：与缺失分支统一告警（节流）并返回 key 本身
    if (!warnedMissingKeys.has(key)) {
        warnedMissingKeys.add(key);
        console.warn(`[i18n] Missing translation (non-string result): ${key}`);
    }
    return key;
}

// 导出类型
export type { SupportedLanguage, BackendLanguageMessages } from './types';

export default {
    t,
    setLanguage,
    getLanguage,
    setDetectedLanguage,
    getMessagesForLanguage,
    getActualLanguage
};