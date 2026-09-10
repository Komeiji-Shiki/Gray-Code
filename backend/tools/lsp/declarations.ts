import type { ToolDeclaration } from '../types';
import { getActualLanguage } from '../../i18n';
import { resolveLocalizationLanguage } from '../localization/types';

export function createGetSymbolsToolDeclaration(options: { workspaces?: Array<{ name: string }>; language?: string } = {}): ToolDeclaration {
const workspaces = (options.workspaces ?? []);
const isMultiRoot = workspaces.length > 1;
const isZh = resolveLocalizationLanguage((options.language ?? getActualLanguage())) === 'zh-CN';
let description = isZh
        ? `获取一个或多个文件中的全部符号（类、函数、变量等）。适用于：
- 在读取特定代码段之前先了解文件结构
- 查找你想查看的函数/类的行号
- 在不读取全部内容的情况下概览多个文件

返回带名称、类型和行号的分层符号列表。`
        : `Get all symbols (classes, functions, variables, etc.) in one or more files. This is useful for:
- Understanding file structure before reading specific sections
- Finding the line numbers of functions/classes you want to examine
- Getting an overview of multiple files without reading all content

Returns hierarchical symbol list with name, kind, and line numbers.`;
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

