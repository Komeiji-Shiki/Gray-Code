/**
 * GrayCode - 英文工具说明目录聚合
 *
 * 英文语言下，未被覆盖的工具保持原始英文声明；
 * overrides 只修正原文错误（如拼写）并统一风格。
 */

import type { ToolDescriptionLocalization } from '../../types';
import { overrides } from './overrides';

export const en: Record<string, ToolDescriptionLocalization> = {
    ...overrides
};
