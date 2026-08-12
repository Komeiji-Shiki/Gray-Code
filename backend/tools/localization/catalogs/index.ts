/**
 * GrayCode - 模型工具声明本地化目录聚合
 *
 * 语言选择：
 * - zh-CN 使用中文目录；
 * - en 使用英文目录；
 * - ja 由 resolveLocalizationLanguage 映射到英文目录（本阶段日文暂用英文模型说明）。
 */

import type { LocalizationLanguage, ToolDescriptionLocalization } from '../types';
import { zhCN } from './zh-CN/index';
import { en } from './en/index';

const catalogs: Record<LocalizationLanguage, Record<string, ToolDescriptionLocalization>> = {
    'zh-CN': zhCN,
    'en': en
};

/**
 * 按语言与工具名取本地化说明；未配置时返回 undefined（调用方保留原说明）。
 */
export function getToolDescriptionLocalization(
    lang: LocalizationLanguage,
    toolName: string
): ToolDescriptionLocalization | undefined {
    return catalogs[lang]?.[toolName];
}
