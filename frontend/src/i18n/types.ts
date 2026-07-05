/**
 * LimCode - i18n 类型定义
 *
 * LanguageMessages 由简体中文语言包（基准语言）自动推导。
 * 新增/删除翻译键只需修改 langs/zh-CN.ts，en/ja 语言包因带有
 * LanguageMessages 类型标注，结构不一致时会直接在 typecheck 阶段报错。
 */

import type zhCN from './langs/zh-CN';

/**
 * 支持的语言
 */
export type SupportedLanguage = 'auto' | 'zh-CN' | 'en' | 'ja';

/**
 * 语言选项
 */
export interface LanguageOption {
    value: SupportedLanguage;
    label: string;
    nativeLabel: string;
}

/**
 * 语言翻译对象
 * 以 zh-CN 语言包结构为准自动推导
 */
export type LanguageMessages = typeof zhCN;
