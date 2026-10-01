import type { ToolDeclaration } from '../types';
import { getActualLanguage } from '../../i18n';
import { resolveLocalizationLanguage } from '../localization/types';
import { SYMBOL_KIND_NAMES } from './symbolOutline';

export function createGetSymbolsToolDeclaration(options: { workspaces?: Array<{ name: string }>; language?: string } = {}): ToolDeclaration {
const workspaces = (options.workspaces ?? []);
const isMultiRoot = workspaces.length > 1;
const isZh = resolveLocalizationLanguage((options.language ?? getActualLanguage())) === 'zh-CN';
// 多根工作区的格式和可用名称只写在路径参数里，主说明不重复。
const description = isZh
        ? `获取一个或多个文件的符号提纲（类、函数、变量等）。适合在读取具体代码前了解文件结构、查找函数或类所在的行号，或在不读全文的情况下概览多个文件。

默认 maxDepth=1，只返回顶层符号；设为 2 会展开直接成员，更大的值继续向下展开。函数、方法和构造器内部的局部变量、常量及其子节点会被省略，顶层变量、类成员和嵌套声明会保留。结果按源码位置排序，行号和列号都从 1 开始。kinds 只在 maxDepth 范围内筛选，不会自动加深；不匹配的父节点会被省略，匹配的后代保留原来的 depth，挂到最近一个已返回的祖先下。如果某个文件拿不到可靠的层级信息，会返回 hierarchyAvailable=false，所有符号都按第 1 层处理，不会猜测父子关系，这时可以用 kinds 缩小结果。

每次最多 20 个文件，每个文件最多返回 500 个符号（含子级）。symbolCount 和 totalSymbolCount 是实际返回的数量，availableSymbolCount 是文件中可用的符号总数，collapsedSymbolCount 是因深度限制没有展开的数量，filteredSymbolCount 是深度范围内因 kinds 或局部数据被省略的数量。节点的 childCount 是直接子符号数（不含局部数据），childrenCollapsed 表示增大 maxDepth 还能看到更多。truncated 只表示输出上限用尽，不表示主动折叠或筛选。`
        : `Get a symbol outline (classes, functions, variables and so on) for one or more files. Use it to learn a file's structure before reading specific code, to find the line numbers of functions or classes, or to survey several files without reading them in full.

The default maxDepth=1 returns only top-level symbols; 2 also expands direct members, and larger values go deeper. Local variables, constants and their children inside functions, methods and constructors are left out, while top-level variables, class members and nested declarations are kept. Results follow source order, with 1-based lines and columns. kinds filters within maxDepth and never makes it deeper; parents that do not match are omitted, and matching descendants keep their original depth and attach to the nearest returned ancestor. If a file has no reliable hierarchy, the result has hierarchyAvailable=false and every symbol is treated as depth 1 without guessing parents; use kinds to narrow such results.

Each call accepts up to 20 files and returns at most 500 symbols per file, including children. symbolCount and totalSymbolCount count the returned symbols, availableSymbolCount counts all symbols in the file, collapsedSymbolCount counts symbols hidden by the depth limit, and filteredSymbolCount counts symbols within that depth left out by kinds or as local data. A node's childCount is its number of direct children, excluding local data, and childrenCollapsed means a larger maxDepth would show more. truncated only means the output limit was reached, not deliberate folding or filtering.`;
let pathsDescription = isZh
        ? '文件路径数组，相对于工作区根目录。即使只有一个文件也要传数组，例如 ["file.ts"]。'
        : 'Array of file paths relative to the workspace root. Pass an array even for a single file, for example ["file.ts"].';
if (isMultiRoot) {
        pathsDescription = isZh
            ? `文件路径数组。当前是多根工作区，请使用 "workspace_name/path" 格式。即使只有一个文件也要传数组。可用工作区：${workspaces.map(w => w.name).join(', ')}。`
            : `Array of file paths. This is a multi-root workspace, so use the "workspace_name/path" format. Pass an array even for a single file. Available workspaces: ${workspaces.map(w => w.name).join(', ')}.`;
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
                            ? '要展开到的最大符号层级，默认 1。'
                            : 'Deepest symbol level to include; default 1.'
                    },
                    kinds: {
                        type: 'array',
                        items: { type: 'string', enum: [...SYMBOL_KIND_NAMES] },
                        description: isZh
                            ? '可选，只保留这些类型的符号；省略或传 [] 表示所有类型。'
                            : 'Optional list of symbol kinds to keep; omit it or pass [] for all kinds.'
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
const description = isZh
        ? `找到符号的定义，并返回带行号的定义代码，适合查看函数、类或变量定义在哪里以及如何实现。

存在多处定义时按原始顺序返回。默认 maxResults=500、offset=0，每页代码合计最多 60000 字符。返回 nextOffset 时，把它作为 offset 传入即可读取下一页，其他参数保持不变；文件变化后从 offset=0 重新查询。单条定义过长时会标记 contentTruncated，可以用 read_file 按 path、line、endLine 读取被省略的部分。definitionCount 是本页数量，totalCount 是全部定义数。`
        : `Find a symbol's definition and return its code with line numbers. Use it to see where a function, class or variable is defined and how it is implemented.

When there are several definitions, they come back in their original order. Defaults are maxResults=500 and offset=0, with at most 60000 characters of code per page. When nextOffset is returned, pass it as offset to read the next page, keeping the other parameters unchanged; restart from offset 0 if files change. A definition that is too long is marked contentTruncated; use read_file with its path, line and endLine to read the omitted part. definitionCount is the number on this page, and totalCount is the number of all definitions.`;
let pathDescription = isZh
        ? '文件路径，相对于工作区根目录。'
        : 'File path relative to the workspace root.';
if (isMultiRoot) {
        pathDescription = isZh
            ? `文件路径。当前是多根工作区，请使用 "workspace_name/path" 格式。可用工作区：${workspaces.map(w => w.name).join(', ')}。`
            : `File path. This is a multi-root workspace, so use the "workspace_name/path" format. Available workspaces: ${workspaces.map(w => w.name).join(', ')}.`;
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
                        description: isZh ? '符号所在的行号，从 1 开始。' : '1-based line number of the symbol.'
                    },
                    column: {
                        type: 'integer',
                        minimum: 1,
                        description: isZh
                            ? '符号起始的列号，从 1 开始，默认第 1 列。'
                            : '1-based column where the symbol starts; defaults to column 1.'
                    },
                    symbol: {
                        type: 'string',
                        description: isZh ? '可选，符号名称，仅用于说明，不影响查找结果。' : 'Optional symbol name, for readability only; it does not affect the lookup.'
                    },
                    maxResults: {
                        type: 'integer', minimum: 1, maximum: 500, default: 500,
                        description: isZh ? '每页最多返回的定义数；代码长度达到上限时实际可能更少。' : 'Maximum definitions per page; fewer may be returned when the code-size limit is reached.'
                    },
                    offset: {
                        type: 'integer', minimum: 0, default: 0,
                        description: isZh ? '要跳过的定义数，用于分页。' : 'Number of definitions to skip, used for paging.'
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
const description = isZh
        ? `查找文件中某个位置上的符号在整个代码库中的全部引用，适合了解它的用法、重构时找出需要修改的位置，或评估改动的影响范围。

结果按文件分组，带行号和代码片段，并按路径、行、列排序后分页。默认 maxResults=500、offset=0，每页最多 500 条、代码片段合计最多 60000 字符。返回 nextOffset 时，把它作为 offset 传入即可读取下一页，其他参数保持不变；文件变化后从 offset=0 重新查询。

countOnly=true 只返回统计数字，不返回引用内容。totalCount 和 totalFileCount 是全部引用数和文件数，returnedCount 和 fileCount 是本页的数量。truncated 只表示条数或代码长度达到了上限，countOnly 模式主动不返回内容不算截断。单条片段过长时会标记 contentTruncated，可以用 read_file 按对应路径和行号查看。`
        : `Find every reference in the codebase to the symbol at a given position in a file. Use it to see how something is used, to find all the places a refactor must touch, or to judge the impact of a change.

References are grouped by file with line numbers and code snippets, sorted by path, line and column before paging. Defaults are maxResults=500 and offset=0, with at most 500 references and 60000 characters of snippets per page. When nextOffset is returned, pass it as offset to read the next page, keeping the other parameters unchanged; restart from offset 0 if files change.

countOnly=true returns only the counts, without reference content. totalCount and totalFileCount cover all references and files, while returnedCount and fileCount cover this page. truncated only means the count or snippet-size limit was reached; leaving out content in countOnly mode does not count as truncation. A snippet that is too long is marked contentTruncated; use read_file at its path and line to see the rest.`;
let pathDescription = isZh
        ? '文件路径，相对于工作区根目录。'
        : 'File path relative to the workspace root.';
if (isMultiRoot) {
        pathDescription = isZh
            ? `文件路径。当前是多根工作区，请使用 "workspace_name/path" 格式。可用工作区：${workspaces.map(w => w.name).join(', ')}。`
            : `File path. This is a multi-root workspace, so use the "workspace_name/path" format. Available workspaces: ${workspaces.map(w => w.name).join(', ')}.`;
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
                        description: isZh ? '符号所在的行号，从 1 开始。' : '1-based line number of the symbol.'
                    },
                    column: {
                        type: 'integer',
                        minimum: 1,
                        description: isZh
                            ? '符号起始的列号，从 1 开始，默认第 1 列。'
                            : '1-based column where the symbol starts; defaults to column 1.'
                    },
                    symbol: {
                        type: 'string',
                        description: isZh ? '可选，符号名称，仅用于说明，不影响查找结果。' : 'Optional symbol name, for readability only; it does not affect the lookup.'
                    },
                    context: {
                        type: 'number',
                        description: isZh
                            ? '每条引用前后各带几行上下文，默认 2，0 表示只返回引用所在行，最大 10，更大的值按 10 处理。'
                            : 'Context lines before and after each reference; default 2, 0 for the reference line only, maximum 10 (larger values are treated as 10).'
                    },
                    maxResults: {
                        type: 'integer', minimum: 1, maximum: 500, default: 500,
                        description: isZh ? '每页最多返回的引用数；代码长度达到上限时实际可能更少。' : 'Maximum references per page; fewer may be returned when the snippet-size limit is reached.'
                    },
                    offset: {
                        type: 'integer', minimum: 0, default: 0,
                        description: isZh ? '要跳过的引用数，用于分页。' : 'Number of references to skip, used for paging.'
                    },
                    countOnly: {
                        type: 'boolean', default: false,
                        description: isZh ? '只统计全部引用数和文件数；此时忽略分页参数，references 为空。' : 'Only count all references and files; paging parameters are ignored and references is empty.'
                    }
                },
                required: ['path', 'line']
            }
        };
}
