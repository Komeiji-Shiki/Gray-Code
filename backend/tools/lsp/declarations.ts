import type { ToolDeclaration } from '../types';
import { getActualLanguage } from '../../i18n';
import { resolveLocalizationLanguage } from '../localization/types';
import { SYMBOL_KIND_NAMES } from './symbolOutline';

export function createGetSymbolsToolDeclaration(options: { workspaces?: Array<{ name: string }>; language?: string } = {}): ToolDeclaration {
const workspaces = (options.workspaces ?? []);
const isMultiRoot = workspaces.length > 1;
const isZh = resolveLocalizationLanguage((options.language ?? getActualLanguage())) === 'zh-CN';
let description = isZh
        ? `获取一个或多个文件的简洁符号提纲（类、函数、变量等）。适用于：
- 在读取特定代码段之前先了解文件结构
- 查找你想查看的函数/类的行号
- 在不读取全部内容的情况下概览多个文件

默认 maxDepth=1，仅返回顶层符号；设为 2 可展开直接成员，更大值继续展开。按源位置排序，行列为 1-based。kinds 在深度限制内筛选，不会自动展开；未匹配父节点省略，匹配后代保留原始 depth 并挂到最近的已返回祖先。
SymbolInformation 平列表无可靠层级，返回 hierarchyAvailable=false，全部按第 1 层处理；可用 kinds 精简，不根据范围或 containerName 猜测父子关系。
每次最多 20 个文件、每文件最多返回 500 个符号（含子级）。symbolCount/totalSymbolCount 为实际返回数；availableSymbolCount 为提供器总数，collapsedSymbolCount 为深度折叠数，filteredSymbolCount 为深度内被类型筛掉的数量。节点 childCount 表示直接子符号总数，childrenCollapsed 表示可增加 maxDepth 展开。truncated 仅表示预算截断，不表示主动折叠或筛选。`
        : `Get a concise symbol outline (classes, functions, variables, etc.) in one or more files. This is useful for:
- Understanding file structure before reading specific sections
- Finding the line numbers of functions/classes you want to examine
- Getting an overview of multiple files without reading all content

Default maxDepth=1 returns only top-level symbols; 2 expands direct members, and larger values expand further. Results follow source order with 1-based lines/columns. kinds filters within that depth, never auto-expands; unmatched ancestors are omitted and matching descendants attach to the nearest returned ancestor while keeping their original depth.
Flat SymbolInformation has no reliable hierarchy: hierarchyAvailable=false and every symbol is treated as depth 1. Use kinds to narrow it; neither ranges nor containerName are used to guess parentage.
At most 20 files and 500 returned symbols per file (including children). symbolCount/totalSymbolCount count returned symbols; availableSymbolCount counts all provider symbols, collapsedSymbolCount counts depth-hidden symbols, and filteredSymbolCount counts kind exclusions within the depth limit. A node's childCount counts direct children; childrenCollapsed indicates that maxDepth can reveal more. truncated means budget exhaustion only, not deliberate folding or filtering.`;
const arrayFormatNote = isZh
        ? '\n\n**重要**：`paths` 参数必须是数组，即使只传一个文件。示例：`{"paths": ["file.ts"]}`，不要写成 `{"path": "file.ts"}`。'
        : '\n\n**IMPORTANT**: The `paths` parameter MUST be an array, even for a single file. Example: `{"paths": ["file.ts"]}`, NOT `{"path": "file.ts"}`.';
description += arrayFormatNote;
if (isMultiRoot) {
        description += isZh
            ? '\n\n多根工作区：使用 "workspace_name/path" 格式指定工作区。'
            : '\n\nMulti-root workspace: Use "workspace_name/path" format to specify the workspace.';
    }
let pathsDescription = isZh
        ? '文件路径数组（相对于工作区根目录）。即使只传一个文件也必须传数组，例如：["file.ts"]'
        : 'Array of file paths (relative to workspace root). MUST be an array even for single file, e.g., ["file.ts"]';
if (isMultiRoot) {
        pathsDescription = isZh
            ? `文件路径数组，使用 "workspace_name/path" 格式。即使只传一个文件也必须传数组。可用工作区：${workspaces.map(w => w.name).join(', ')}`
            : `Array of file paths, use "workspace_name/path" format. MUST be an array even for single file. Available workspaces: ${workspaces.map(w => w.name).join(', ')}`;
    }
return {
            name: 'get_symbols',
            readOnly: true,
            description,
            category: 'lsp',
            parameters: {
                type: 'object',
                properties: {
                    paths: {
                        type: 'array',
                        items: {
                            type: 'string'
                        },
                        description: pathsDescription
                    },
                    maxDepth: {
                        type: 'integer',
                        minimum: 1,
                        default: 1,
                        description: isZh
                            ? '最大原始符号层级。默认 1 仅顶层，2 含直接子级，依此类推；仍受每文件 500 个返回符号的总预算约束。'
                            : 'Maximum original symbol depth. Default 1 = top-level only, 2 includes direct children, etc.; the 500-symbol per-file output budget still applies.'
                    },
                    kinds: {
                        type: 'array',
                        items: { type: 'string', enum: [...SYMBOL_KIND_NAMES] },
                        description: isZh
                            ? '可选类型白名单；省略或 [] 表示所有类型。在 maxDepth 内筛选，不自动展开；省略未匹配父节点，但保留符合条件的后代及原始 depth。'
                            : 'Optional kind allowlist; omitted or [] means all kinds. Filters within maxDepth without expanding it; unmatched ancestors are omitted but matching descendants retain their original depth.'
                    }
                },
                required: ['paths']
            }
        };
}

export function createGotoDefinitionToolDeclaration(options: { workspaces?: Array<{ name: string }>; language?: string } = {}): ToolDeclaration {
const workspaces = (options.workspaces ?? []);
const isMultiRoot = workspaces.length > 1;
const isZh = resolveLocalizationLanguage((options.language ?? getActualLanguage())) === 'zh-CN';
let description = isZh
        ? `跳转到符号的定义位置并返回完整的定义代码。适用于：
- 查找函数/类/变量的定义位置并查看完整实现
- 无需额外的 read_file 调用即可了解符号的实现方式

返回带行号的完整定义代码。`
        : `Go to the definition of a symbol and return the complete definition code. This is useful for:
- Finding where a function/class/variable is defined and seeing its full implementation
- Understanding how a symbol is implemented without additional read_file calls

Returns the complete definition code with line numbers.`;
if (isMultiRoot) {
        description += isZh
            ? '\n\n多根工作区：使用 "workspace_name/path" 格式指定工作区。'
            : '\n\nMulti-root workspace: Use "workspace_name/path" format to specify the workspace.';
    }
let pathDescription = isZh
        ? '文件路径（相对于工作区根目录）'
        : 'File path (relative to workspace root)';
if (isMultiRoot) {
        pathDescription = isZh
            ? `文件路径，使用 "workspace_name/path" 格式。可用工作区：${workspaces.map(w => w.name).join(', ')}`
            : `File path, use "workspace_name/path" format. Available workspaces: ${workspaces.map(w => w.name).join(', ')}`;
    }
return {
            name: 'goto_definition',
            readOnly: true,
            description,
            category: 'lsp',
            parameters: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: pathDescription
                    },
                    line: {
                        type: 'integer',
                        minimum: 1,
                        description: isZh ? '符号所在的行号（1-based）' : 'Line number (1-based) where the symbol is located'
                    },
                    column: {
                        type: 'integer',
                        minimum: 1,
                        description: isZh
                            ? '符号起始的列号（1-based）。未指定时使用第 1 列。'
                            : 'Column number (1-based) where the symbol starts. If not specified, uses column 1.'
                    },
                    symbol: {
                        type: 'string',
                        description: isZh ? '要查找的符号名称（可选，仅用于说明）' : 'The symbol name to find (optional, for documentation purposes)'
                    }
                },
                required: ['path', 'line']
            }
        };
}

export function createFindReferencesToolDeclaration(options: { workspaces?: Array<{ name: string }>; language?: string } = {}): ToolDeclaration {
const workspaces = (options.workspaces ?? []);
const isMultiRoot = workspaces.length > 1;
const isZh = resolveLocalizationLanguage((options.language ?? getActualLanguage())) === 'zh-CN';
let description = isZh
        ? `查找文件中指定位置符号的全部引用。适用于：
- 了解函数/类/变量在整个代码库中的使用情况
- 重构时找出所有需要修改的位置
- 了解改动的影响范围

返回按文件分组的引用，带行号和代码内容。`
        : `Find all references to a symbol at a specific position in a file. This is useful for:
- Understanding how a function/class/variable is used across the codebase
- Finding all places that need to be updated when refactoring
- Understanding the impact of changes

Returns references grouped by file, with line numbers and code content.`;
if (isMultiRoot) {
        description += isZh
            ? '\n\n多根工作区：使用 "workspace_name/path" 格式指定工作区。'
            : '\n\nMulti-root workspace: Use "workspace_name/path" format to specify the workspace.';
    }
let pathDescription = isZh
        ? '文件路径（相对于工作区根目录）'
        : 'File path (relative to workspace root)';
if (isMultiRoot) {
        pathDescription = isZh
            ? `文件路径，使用 "workspace_name/path" 格式。可用工作区：${workspaces.map(w => w.name).join(', ')}`
            : `File path, use "workspace_name/path" format. Available workspaces: ${workspaces.map(w => w.name).join(', ')}`;
    }
return {
            name: 'find_references',
            readOnly: true,
            description,
            category: 'lsp',
            parameters: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: pathDescription
                    },
                    line: {
                        type: 'integer',
                        minimum: 1,
                        description: isZh ? '符号所在的行号（1-based）' : 'Line number (1-based) where the symbol is located'
                    },
                    column: {
                        type: 'integer',
                        minimum: 1,
                        description: isZh
                            ? '符号起始的列号（1-based）。未指定时使用第 1 列。'
                            : 'Column number (1-based) where the symbol starts. If not specified, uses column 1.'
                    },
                    symbol: {
                        type: 'string',
                        description: isZh ? '要查找引用的符号名称（可选，仅用于说明）' : 'The symbol name to find references for (optional, for documentation purposes)'
                    },
                    context: {
                        type: 'number',
                        description: isZh
                            ? '每个引用前后要包含的上下文行数。默认：2。0 表示仅单行。最大：10（超过会被截断）。'
                            : 'Number of context lines to include before and after each reference. Default: 2. Use 0 for single line only. Max: 10 (values above are clamped).'
                    }
                },
                required: ['path', 'line']
            }
        };
}

