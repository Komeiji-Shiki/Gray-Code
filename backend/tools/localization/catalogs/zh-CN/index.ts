/**
 * GrayCode - 中文工具说明目录聚合
 *
 * 按工具类别拆分数据文件，避免单文件过长：
 * - fileSearchLsp：文件 / 搜索 / LSP；
 * - workflow：TODO / Design / Plan / Progress / Review；
 * - auxiliary：记忆 / 活动统计 / 通知。
 */

import type { ToolDescriptionLocalization } from '../../types';
import { fileSearchLsp } from './fileSearchLsp';
import { workflow } from './workflow';
import { auxiliary } from './auxiliary';

export const zhCN: Record<string, ToolDescriptionLocalization> = {
    ...fileSearchLsp,
    ...workflow,
    ...auxiliary
};
