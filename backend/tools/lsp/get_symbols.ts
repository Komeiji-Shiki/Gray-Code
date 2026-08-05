/**
 * 获取文件符号工具
 *
 * 使用 VSCode LSP 获取文件中的符号列表（类、函数、变量等）
 * 支持批量查询多个文件
 */

import * as vscode from 'vscode';
import type { Tool, ToolResult } from '../types';
import { resolveUri, getAllWorkspaces } from '../utils';
import {
    LSP_TIMEOUT_MS,
    LSP_RETRY_DELAY_MS,
    openDocumentWithGuard,
    executeLspCommandWithRetry
} from './lspLifecycle';

// 兼容别名：既有调用方与测试从 get_symbols 导入这两个常量
// （超时/中止/瞬时重试的具体实现已上移到共享模块 lspLifecycle）
export const GET_SYMBOLS_TIMEOUT_MS = LSP_TIMEOUT_MS;
export const GET_SYMBOLS_RETRY_DELAY_MS = LSP_RETRY_DELAY_MS;

/**
 * 符号类型映射
 */
const SymbolKindNames: Record<vscode.SymbolKind, string> = {
    [vscode.SymbolKind.File]: 'file',
    [vscode.SymbolKind.Module]: 'module',
    [vscode.SymbolKind.Namespace]: 'namespace',
    [vscode.SymbolKind.Package]: 'package',
    [vscode.SymbolKind.Class]: 'class',
    [vscode.SymbolKind.Method]: 'method',
    [vscode.SymbolKind.Property]: 'property',
    [vscode.SymbolKind.Field]: 'field',
    [vscode.SymbolKind.Constructor]: 'constructor',
    [vscode.SymbolKind.Enum]: 'enum',
    [vscode.SymbolKind.Interface]: 'interface',
    [vscode.SymbolKind.Function]: 'function',
    [vscode.SymbolKind.Variable]: 'variable',
    [vscode.SymbolKind.Constant]: 'constant',
    [vscode.SymbolKind.String]: 'string',
    [vscode.SymbolKind.Number]: 'number',
    [vscode.SymbolKind.Boolean]: 'boolean',
    [vscode.SymbolKind.Array]: 'array',
    [vscode.SymbolKind.Object]: 'object',
    [vscode.SymbolKind.Key]: 'key',
    [vscode.SymbolKind.Null]: 'null',
    [vscode.SymbolKind.EnumMember]: 'enum_member',
    [vscode.SymbolKind.Struct]: 'struct',
    [vscode.SymbolKind.Event]: 'event',
    [vscode.SymbolKind.Operator]: 'operator',
    [vscode.SymbolKind.TypeParameter]: 'type_parameter',
};

/**
 * 符号信息
 */
interface SymbolInfo {
    name: string;
    kind: string;
    line: number;        // 1-based
    endLine: number;     // 1-based
    detail?: string;
    children?: SymbolInfo[];
}

/**
 * 单文件符号数量上限：符号提供器对大型/生成文件可能返回海量符号
 *（含层级展开后的总数），超出后截断并在返回 JSON 中置 truncated 标记。
 */
const MAX_SYMBOLS_PER_FILE = 500;

/**
 * 符号转换预算：跨层级递归共享，超出后停止展开子树并置 truncated。
 */
interface SymbolBudget {
    remaining: number;
    truncated: boolean;
}

/**
 * 单个文件的符号结果
 */
interface FileSymbolResult {
    path: string;
    success: boolean;
    symbolCount?: number;
    symbols?: SymbolInfo[];
    error?: string;
    /** 符号数量超过上限被截断（调用方聚合到总结果中） */
    truncated?: boolean;
}

/**
 * 将 VSCode DocumentSymbol 转换为简化的符号信息（受预算约束，超限返回 undefined）。
 */
function convertDocumentSymbol(symbol: vscode.DocumentSymbol, budget: SymbolBudget): SymbolInfo | undefined {
    if (budget.remaining <= 0) {
        budget.truncated = true;
        return undefined;
    }
    budget.remaining--;

    const info: SymbolInfo = {
        name: symbol.name,
        kind: SymbolKindNames[symbol.kind] || 'unknown',
        line: symbol.range.start.line + 1,
        endLine: symbol.range.end.line + 1,
    };
    
    if (symbol.detail) {
        info.detail = symbol.detail;
    }
    
    if (symbol.children && symbol.children.length > 0) {
        const children: SymbolInfo[] = [];
        for (const child of symbol.children) {
            const converted = convertDocumentSymbol(child, budget);
            if (converted) {
                children.push(converted);
            }
            if (budget.remaining <= 0) {
                budget.truncated = true;
                break;
            }
        }
        if (children.length > 0) {
            info.children = children;
        }
    }
    
    return info;
}

/**
 * 将 VSCode SymbolInformation 转换为简化的符号信息
 */
function convertSymbolInformation(symbol: vscode.SymbolInformation): SymbolInfo {
    return {
        name: symbol.name,
        kind: SymbolKindNames[symbol.kind] || 'unknown',
        line: symbol.location.range.start.line + 1,
        endLine: symbol.location.range.end.line + 1,
    };
}

/**
 * 获取单个文件的符号
 */
async function getSymbolsForFile(filePath: string, abortSignal?: AbortSignal, activeWorkspaceUri?: string): Promise<FileSymbolResult> {
    const uri = resolveUri(filePath, activeWorkspaceUri);
    if (!uri) {
        return {
            path: filePath,
            success: false,
            error: 'Could not resolve file path. Make sure a workspace is open.'
        };
    }
    
    try {
        // 主动打开文档以激活对应语言服务。未在编辑器中打开的大型 TypeScript 文件尤其需要这一步。
        await openDocumentWithGuard(uri, abortSignal);

        // 超时/中止不重试，仅瞬时拒绝重试一次（共享模块 lspLifecycle 默认配置）
        const symbols = await executeLspCommandWithRetry<(vscode.DocumentSymbol | vscode.SymbolInformation)[]>(
            'vscode.executeDocumentSymbolProvider',
            [uri],
            { abortSignal }
        );

        if (!symbols || symbols.length === 0) {
            return {
                path: filePath,
                success: true,
                symbolCount: 0,
                symbols: []
            };
        }
        
        // 转换符号（带数量预算：超限截断并置 truncated）
        let convertedSymbols: SymbolInfo[];
        const budget: SymbolBudget = { remaining: MAX_SYMBOLS_PER_FILE, truncated: false };
        
        // 检查是 DocumentSymbol 还是 SymbolInformation
        if ('children' in symbols[0] || 'range' in symbols[0]) {
            // DocumentSymbol (更新的格式，有层级结构)
            const rawSymbols = symbols as vscode.DocumentSymbol[];
            const converted: SymbolInfo[] = [];
            for (const symbol of rawSymbols) {
                const convertedSymbol = convertDocumentSymbol(symbol, budget);
                if (convertedSymbol) {
                    converted.push(convertedSymbol);
                }
                if (budget.remaining <= 0) {
                    budget.truncated = true;
                    break;
                }
            }
            convertedSymbols = converted;
        } else {
            // SymbolInformation (旧格式，扁平结构)
            const rawSymbols = symbols as vscode.SymbolInformation[];
            convertedSymbols = rawSymbols
                .slice(0, MAX_SYMBOLS_PER_FILE)
                .map(convertSymbolInformation);
            budget.truncated = rawSymbols.length > MAX_SYMBOLS_PER_FILE;
        }
        
        return {
            path: filePath,
            success: true,
            symbolCount: countSymbols(convertedSymbols),
            symbols: convertedSymbols,
            truncated: budget.truncated
        };
    } catch (error) {
        return {
            path: filePath,
            success: false,
            error: error instanceof Error ? error.message : String(error)
        };
    }
}

/**
 * 创建获取符号工具
 */
export function createGetSymbolsTool(): Tool {
    const workspaces = getAllWorkspaces();
    const isMultiRoot = workspaces.length > 1;
    
    let description = `Get all symbols (classes, functions, variables, etc.) in one or more files. This is useful for:
- Understanding file structure before reading specific sections
- Finding the line numbers of functions/classes you want to examine
- Getting an overview of multiple files without reading all content

Returns hierarchical symbol list with name, kind, and line numbers.`;
    
    // 数组格式强调说明
    const arrayFormatNote = '\n\n**IMPORTANT**: The `paths` parameter MUST be an array, even for a single file. Example: `{"paths": ["file.ts"]}`, NOT `{"path": "file.ts"}`.';
    description += arrayFormatNote;
    
    if (isMultiRoot) {
        description += '\n\nMulti-root workspace: Use "workspace_name/path" format to specify the workspace.';
    }
    
    let pathsDescription = 'Array of file paths (relative to workspace root). MUST be an array even for single file, e.g., ["file.ts"]';
    if (isMultiRoot) {
        pathsDescription = `Array of file paths, use "workspace_name/path" format. MUST be an array even for single file. Available workspaces: ${workspaces.map(w => w.name).join(', ')}`;
    }
    
    return {
        declaration: {
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
        },
        handler: async (args, context): Promise<ToolResult> => {
            const pathList = args.paths as string[];
            
            if (!pathList || !Array.isArray(pathList) || pathList.length === 0) {
                return { success: false, error: 'paths is required and must be a non-empty array' };
            }
            
            const results: FileSymbolResult[] = [];
            let successCount = 0;
            let failCount = 0;
            let totalSymbolCount = 0;
            
            for (const filePath of pathList) {
                const result = await getSymbolsForFile(filePath, context?.abortSignal, context?.activeWorkspaceUri);
                results.push(result);
                
                if (result.success) {
                    successCount++;
                    totalSymbolCount += result.symbolCount || 0;
                } else {
                    failCount++;
                }
            }
            
            const allSuccess = failCount === 0;
            const anyTruncated = results.some(result => result.truncated === true);
            const failedDetails = results
                .filter(result => !result.success)
                .map(result => `${result.path}: ${result.error || 'Unknown symbol provider error'}`)
                .join('; ');
            return {
                success: allSuccess,
                data: {
                    results,
                    successCount,
                    failCount,
                    totalCount: pathList.length,
                    totalSymbolCount,
                    truncated: anyTruncated
                },
                error: allSuccess ? undefined : `${failCount} file(s) failed to get symbols: ${failedDetails}`
            };
        }
    };
}

/**
 * 递归计算符号总数
 */
function countSymbols(symbols: SymbolInfo[]): number {
    let count = symbols.length;
    for (const symbol of symbols) {
        if (symbol.children) {
            count += countSymbols(symbol.children);
        }
    }
    return count;
}

/**
 * 注册获取符号工具
 */
export function registerGetSymbols(): Tool {
    return createGetSymbolsTool();
}
