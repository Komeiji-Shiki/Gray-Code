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
    { value: 'auto', labelKey: 'components.settings.settingsPanel.language.followSystem', label: 'Auto', nativeLabel: 'Auto' },
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
 * 界面语言持久化缓存（localStorage）。
 *
 * 启动即恢复上次界面语言：getSettings 往返（可能数百 ms）完成前，渲染层
 * 首帧就会用当前语言渲染（工作区选择器/欢迎面板等）。若等 getSettings 回来
 * 才 setLanguage，已保存「English」的用户会在首帧看到中文界面——与
 * gc-splash-disabled（settingsStore）同一模式的同步缓存，零异步开销。
 */
const UI_LANGUAGE_CACHE_KEY = 'gc-ui-language';

const CACHED_LANGUAGES: ReadonlySet<string> = new Set(['auto', 'zh-CN', 'en', 'ja']);

function restoreCachedLanguage(): void {
  try {
    const cached = localStorage.getItem(UI_LANGUAGE_CACHE_KEY);
    if (cached && CACHED_LANGUAGES.has(cached)) {
      currentLanguage.value = cached as SupportedLanguage;
    }
  } catch {
    // localStorage 不可用（受限环境/测试）：保持默认 auto
  }
}
restoreCachedLanguage();

/**
 * 保存当前界面语言到缓存（语言成功应用后调用，与设置持久化同步）。
 */
export function persistUILanguage(lang: SupportedLanguage): void {
  try {
    localStorage.setItem(UI_LANGUAGE_CACHE_KEY, lang);
  } catch {
    // 同上：不可用时静默跳过
  }
}

/**
 * VS Code 检测到的语言
 */
const detectedLanguage = ref<string>(
    typeof navigator === 'undefined' ? 'zh-CN' : (navigator.language || 'zh-CN')
);

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
 * 无参数翻译结果缓存：t() 在消息列表/工具卡渲染中是高频调用（key.split + 逐层属性访问），
 * 命中后直接返回。语言切换（setLanguage / setDetectedLanguage）时整体清空。
 * 缺失 key 不缓存——每次仍走 fallback 输出 console.warn，保持既有调试行为。
 */
const translationCache = new Map<string, string>();

/**
 * 设置语言
 */
export function setLanguage(lang: SupportedLanguage) {
    if (currentLanguage.value !== lang) {
        translationCache.clear();
    }
    currentLanguage.value = lang;
    if (typeof document !== 'undefined') {
        document.documentElement.lang = actualLanguage.value;
    }
    persistUILanguage(lang);
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
    if (detectedLanguage.value !== lang) {
        translationCache.clear();
    }
    detectedLanguage.value = lang;
    if (currentLanguage.value === 'auto' && typeof document !== 'undefined') {
        document.documentElement.lang = actualLanguage.value;
    }
}

/**
 * 翻译函数
 *
 * 使用点号分隔的路径获取翻译
 * 例如：t('settings.general.title')
 * 支持参数替换：t('message.error', { count: 5 })
 */
export function t(key: string, params?: Record<string, any>): string {
    // 先触碰响应式依赖：即使命中缓存也必须读取 currentMessages，
    // 否则计算属性首次求值若走缓存短路，会丢失对语言切换的响应式依赖——
    // 之后无论语言怎么切，该计算属性（如工作区选择器的标签）都不会再更新
    // （缓存值不断变化但 UI 冻结在首帧语言）。读取开销为一次 computed getter，
    // currentMessages 只在语言变化时重算，热路径无额外负担。
    const msgs = currentMessages.value;
    // 无参数调用直接查缓存（命中即返回，跳过 split + 逐层属性访问）
    if (!params) {
        const cached = translationCache.get(key);
        if (cached !== undefined) return cached;
    }

    const keys = key.split('.');
    let result: any = msgs;
    
    for (const k of keys) {
        if (result && typeof result === 'object' && k in result) {
            result = result[k];
        } else {
            // 找不到翻译，返回 key 本身（不缓存，保留每次调用的缺失警告）
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