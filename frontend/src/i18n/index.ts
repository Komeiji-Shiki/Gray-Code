/**
 * GrayCode - i18n 国际化模块
 * 
 * 支持语言切换和翻译
 */

import { ref, computed, readonly } from 'vue';
import type { SupportedLanguage, LanguageMessages, LanguageOption } from './types';
import zhCN from './langs/zh-CN';
import en from './langs/en';
import ja from './langs/ja';

/**
 * 支持的语言列表
 */
export const SUPPORTED_LANGUAGES: LanguageOption[] = [
    { value: 'auto', labelKey: 'components.settings.settingsPanel.language.followSystem', label: 'Auto', nativeLabel: 'Auto' },
    { value: 'zh-CN', label: '简体中文', nativeLabel: '简体中文' },
    { value: 'en', label: 'English', nativeLabel: 'English' },
    { value: 'ja', label: '日本語', nativeLabel: '日本語' }
];

/**
 * 语言包（按语言代码索引；composables/useI18n.ts re-export 此表供非组件上下文使用）
 */
export const messages: Record<string, LanguageMessages> = {
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
const detectedLanguage = ref<string>(
    typeof navigator === 'undefined' ? 'zh-CN' : (navigator.language || 'zh-CN')
);

/**
 * 获取实际使用的语言（导出供外部读取当前生效语言；useI18n() 同样返回该引用）
 */
export const actualLanguage = computed(() => {
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
        // 默认使用英文（未知语言的兜底；用户显式选择中文时走 currentLanguage 分支，不受影响）
        return 'en';
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
 * 无参数翻译结果缓存：t() 在消息列表/工具卡渲染中是高频调用（key.split + 逐层属性访问），
 * 命中后直接返回。语言切换（setLanguage / setDetectedLanguage）时整体清空。
 * 缺失 key 不缓存——console.warn 按 key 去重（warnedMissingKeys），同一缺失 key 只警告一次。
 */
const translationCache = new Map<string, string>();

/** 已输出过缺失警告的 key（防刷屏；语言切换时随 translationCache 一并清空） */
const warnedMissingKeys = new Set<string>();

/**
 * 设置语言
 */
export function setLanguage(lang: SupportedLanguage) {
    if (currentLanguage.value !== lang) {
        translationCache.clear();
        warnedMissingKeys.clear();
    }
    currentLanguage.value = lang;
    if (typeof document !== 'undefined') {
        document.documentElement.lang = actualLanguage.value;
    }
}

/**
 * 获取当前语言设置
 */
export function getLanguage(): SupportedLanguage {
    return currentLanguage.value;
}

/**
 * 设置检测到的语言。
 *
 * 生产环境无调用方：语言探测在模块初始化时按 navigator.language 完成（见 detectedLanguage 初始值），
 * 扩展侧偏好通过 setLanguage 注入。当前唯一调用方为测试环境（vitest.setup.ts 固定语言用），
 * 保留导出以兼容该调用。
 */
export function setDetectedLanguage(lang: string) {
    if (detectedLanguage.value !== lang) {
        translationCache.clear();
        warnedMissingKeys.clear();
    }
    detectedLanguage.value = lang;
    if (currentLanguage.value === 'auto' && typeof document !== 'undefined') {
        document.documentElement.lang = actualLanguage.value;
    }
}

/**
 * 独立翻译函数：显式指定语言（用于 Store 等非 Vue 组件上下文，如相对时间格式化）。
 *
 * 与 t() 的差异：语言由调用方显式传入而非当前生效语言。
 * 参数替换与 t() 同一语义：缺失参数保留占位符（不输出字面 "undefined"）。
 * lang='auto' 时按 actualLanguage 归一化，与 t() 同一口径。
 *
 * 行为说明（相对旧 composables/useI18n 实现的变化）：调用方（如 stores/chat/utils.ts 的
 * 相对时间格式化）传入 settingsStore.language，用户选「跟随系统」时该值为 'auto'。旧实现
 * 对无法命中的语言一律回退 zh-CN；现归一化到 actualLanguage——跟随 VS Code 检测语言，
 * 'auto' 不再固定回退中文。这是合理改进（显式选择语言时行为不变），保留现状，勿再改回。
 */
export function translate(lang: string, key: string, params?: Record<string, any>): string {
    const resolvedLang = lang === 'auto' ? actualLanguage.value : lang;
    const message = messages[resolvedLang] || messages['zh-CN'];

    const keys = key.split('.');
    let value: any = message;

    for (const k of keys) {
        if (value && typeof value === 'object' && k in value) {
            value = value[k];
        } else {
            // 键名不存在：与 t() 一致——按 key 去重输出缺失警告后返回键名本身
            if (!warnedMissingKeys.has(key)) {
                warnedMissingKeys.add(key);
                console.warn(`[i18n] Missing translation: ${key}`);
            }
            return key;
        }
    }

    if (typeof value !== 'string') {
        return key;
    }

    if (params) {
        return value.replace(/\{(\w+)\}/g, (match, paramName) => {
            return params[paramName] !== undefined ? String(params[paramName]) : match;
        });
    }
    return value;
}

/**
 * 翻译函数
 *
 * 使用点号分隔的路径获取翻译
 * 例如：t('settings.general.title')
 * 支持参数替换：t('message.error', { count: 5 })
 */
export function t(key: string, params?: Record<string, any>): string {
    // 无参数调用直接查缓存（命中即返回，跳过 split + 逐层属性访问）
    if (!params) {
        const cached = translationCache.get(key);
        if (cached !== undefined) return cached;
    }

    const keys = key.split('.');
    let result: any = currentMessages.value;
    
    for (const k of keys) {
        if (result && typeof result === 'object' && k in result) {
            result = result[k];
        } else {
            // 找不到翻译，返回 key 本身（不缓存；缺失警告按 key 去重，避免高频调用刷屏）
            if (!warnedMissingKeys.has(key)) {
                warnedMissingKeys.add(key);
                console.warn(`[i18n] Missing translation: ${key}`);
            }
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
        translationCache.set(key, result);
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
        // readonly 包装：currentLanguage 是模块级 ref，不允许调用方直写，语言切换统一走 setLanguage()
        currentLanguage: readonly(currentLanguage),
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