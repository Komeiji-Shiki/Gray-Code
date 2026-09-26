import { createGetSymbolsToolDeclaration } from './declarations';
/**
 * 获取文件符号工具
 *
 * 使用 VSCode LSP 获取文件中的简洁符号提纲，支持批量查询和按层级展开。
 */

import * as vscode from 'vscode';
import type { Tool, ToolResult } from '../types';
import { parseArgs } from '../types';
import { resolveUri, getAllWorkspaces, mapWithConcurrency } from '../utils';
import {
    LSP_TIMEOUT_MS,
    LSP_RETRY_DELAY_MS,
    openDocumentWithGuard,
    executeLspCommandWithRetry
} from './lspLifecycle';
import { ensureOutsideWorkspaceAccessApproved } from '../file/outsideWorkspaceAccess';
import {
    createSymbolOutline, parseSymbolOutlineOptions, MAX_SYMBOL_PATHS,
    type SymbolOutline, type SymbolOutlineOptions
} from './symbolOutline';

// 兼容别名：既有调用方与测试从 get_symbols 导入这两个常量
// （超时/中止/瞬时重试的具体实现已上移到共享模块 lspLifecycle）
export const GET_SYMBOLS_TIMEOUT_MS = LSP_TIMEOUT_MS;
export const GET_SYMBOLS_RETRY_DELAY_MS = LSP_RETRY_DELAY_MS;

interface FileSymbolResult extends Partial<SymbolOutline> {
    path: string;
    success: boolean;
    error?: string;
}

interface GetSymbolsArgs {
    paths: string[];
    maxDepth?: unknown;
    kinds?: unknown;
}

async function getSymbolsForFile(filePath: string, options: SymbolOutlineOptions, abortSignal?: AbortSignal): Promise<FileSymbolResult> {
    const uri = resolveUri(filePath);
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

        return {
            path: filePath,
            success: true,
            ...createSymbolOutline(symbols ?? [], options, 0)
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
    return {
        declaration: createGetSymbolsToolDeclaration({ workspaces }),
        handler: async (args, context): Promise<ToolResult> => {
            const parsed = parseArgs<GetSymbolsArgs>(args);
            const pathList = parsed.paths;

            if (!Array.isArray(pathList) || pathList.length === 0 || pathList.some(file => typeof file !== 'string')) {
                return { success: false, error: 'paths is required and must be a non-empty array of file paths' };
            }
            let options: SymbolOutlineOptions;
            try {
                options = parseSymbolOutlineOptions(parsed);
            } catch (error) {
                return { success: false, error: error instanceof Error ? error.message : String(error) };
            }

            // 修改原因：get_symbols 接受绝对路径时可通过 LSP 读取工作区外文件内容，不受读策略管控。
            // 修改方式：与 read_file 一致，入口处校验 outside-workspace 读策略（deny/ask/allow）。
            // 使用真实工具名：服务层白名单（toolCallNeedsOutsideWorkspaceConfirmation）已包含 get_symbols，
            // ask 策略下确认弹窗可置位 approvedByToolConfirmation，本检查才能放行。
            const accessError = ensureOutsideWorkspaceAccessApproved('get_symbols', { paths: pathList }, context);
            if (accessError) {
                return { success: false, error: accessError };
            }

            // 上限保护：每个文件最多 20s LSP 超时，超限文件直接截断并在结果中提示，
            // 避免一次调用把整个工作区几千个文件全部串行扫一遍。
            const pathsTruncated = pathList.length > MAX_SYMBOL_PATHS;
            const pathsToProcess = pathsTruncated ? pathList.slice(0, MAX_SYMBOL_PATHS) : pathList;

            const results: FileSymbolResult[] = [];
            let successCount = 0;
            let failCount = 0;
            let totalSymbolCount = 0;

            // 受控并发（默认 4 个在飞），仍按输入顺序返回结果
            const processed = await mapWithConcurrency(
                pathsToProcess,
                4,
                async (filePath: string) => getSymbolsForFile(filePath, options, context?.abortSignal)
            );
            for (const result of processed) {
                results.push(result);

                if (result.success) {
                    successCount++;
                    totalSymbolCount += result.symbolCount || 0;
                } else {
                    failCount++;
                }
            }

            const allSuccess = failCount === 0;
            const anyTruncated = results.some(result => result.truncated === true) || pathsTruncated;
            const failedDetails = results
                .filter(result => !result.success)
                .map(result => `${result.path}: ${result.error || 'Unknown symbol provider error'}`)
                .join('; ');
            return {
                success: allSuccess,
                data: {
                    results,
                    ...options,
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
 * 注册获取符号工具
 */
export function registerGetSymbols(): Tool {
    return createGetSymbolsTool();
}
