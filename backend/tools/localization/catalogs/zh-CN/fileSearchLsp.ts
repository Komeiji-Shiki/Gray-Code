/**
 * GrayCode - 中文工具说明：文件 / 搜索 / LSP
 *
 * 覆盖工具：
 * - write_file / list_files / delete_file / create_directory
 * - apply_diff / insert_code / delete_code
 * - search_in_files / find_files
 * - get_symbols / goto_definition / find_references
 *
 * 注意：
 * - read_file 是动态工具（多模态/渠道/工具模式/多根工作区），顶层说明由语言感知
 *   生成器负责，这里只配置 parameters（如需覆盖参数说明）；
 * - search_in_files 的 mode 说明在受限模式下由 resolver 覆盖，这里只覆盖
 *   非受限的静态部分；
 * - 高价值修正：delete_code 中 parameterMUST 的拼写问题（英文原文修正见
 *   en/overrides.ts，本目录提供正确的中文说明）；
 * - 强调数组参数必须传数组；search_in_files 的 search/replace 字段条件；
 *   apply_diff 的结构化 hunks、精确匹配和同轮多文件调用规则。
 */

import type { ToolDescriptionLocalization } from '../../types';

export const fileSearchLsp: Record<string, ToolDescriptionLocalization> = {
    // write_file: { description: '...', parameters: { path: '...' } },
};
