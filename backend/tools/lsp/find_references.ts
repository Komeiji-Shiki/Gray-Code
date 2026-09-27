import { createFindReferencesToolDeclaration } from './declarations';
/**
 * 查找引用工具：使用 VSCode LSP 查找符号引用，分页仅限制读取和输出，不限制 provider 查询。
 */
import * as vscode from 'vscode';
import type { Tool, ToolResult } from '../types';
import { resolveUri, getAllWorkspaces } from '../utils';
import {
    LSP_TIMEOUT_MS,
    openDocumentWithGuard,
    executeLspCommandWithRetry,
    withTimeoutAndAbort
} from './lspLifecycle';
import { ensureOutsideWorkspaceAccessApproved } from '../file/outsideWorkspaceAccess';
import { createReferencePage, parseReferencePageOptions, referenceSnippet } from './referencePage';

/** context 参数允许的最大上下文行数（防止引用多时响应体暴涨） */
const MAX_CONTEXT_LINES = 10;

/** 创建查找引用工具。 */
export function createFindReferencesTool(): Tool {
    const workspaces = getAllWorkspaces();
    const isMultiRoot = workspaces.length > 1;
    return {
        declaration: createFindReferencesToolDeclaration({ workspaces }),
        handler: async (args, context): Promise<ToolResult> => {
            const filePath = args.path as string;
            const line = args.line as number;
            // column 校验：仅接受有限正整数（负数/小数构造 Position 会抛 Illegal argument）
            const rawColumn = args.column;
            const column = (typeof rawColumn === 'number' && Number.isInteger(rawColumn) && rawColumn >= 1)
                ? rawColumn
                : 1;
            const symbolName = args.symbol as string | undefined;
            // context 仍沿用旧的 clamp 语义；分页参数独立校验，不能把无效 offset 当第一页。
            const rawContextLines = typeof args.context === 'number' ? args.context : 2;
            const contextLines = Number.isFinite(rawContextLines)
                ? Math.min(MAX_CONTEXT_LINES, Math.max(0, Math.floor(rawContextLines)))
                : 2;

            if (!filePath) {
                return { success: false, error: 'path is required' };
            }
            if (typeof line !== 'number' || !Number.isInteger(line) || line < 1) {
                return { success: false, error: 'line must be a positive integer (1-based)' };
            }

            // 与 read_file 一致，入口校验 outside-workspace 读策略（deny/ask/allow）。
            const accessError = ensureOutsideWorkspaceAccessApproved('find_references', { path: filePath }, context);
            if (accessError) {
                return { success: false, error: accessError };
            }
            const uri = resolveUri(filePath);
            if (!uri) {
                return { success: false, error: 'Could not resolve file path. Make sure a workspace is open.' };
            }

            try {
                const options = parseReferencePageOptions(args);
                const position = new vscode.Position(line - 1, column - 1);
                await openDocumentWithGuard(uri, context?.abortSignal);
                const references = await executeLspCommandWithRetry<vscode.Location[]>(
                    'vscode.executeReferenceProvider',
                    [uri, position],
                    { abortSignal: context?.abortSignal }
                ) ?? [];
                const locations = references.map(ref => ({
                    path: vscode.workspace.getWorkspaceFolder(ref.uri)
                        ? vscode.workspace.asRelativePath(ref.uri, isMultiRoot) : ref.uri.fsPath,
                    line: ref.range.start.line + 1,
                    column: ref.range.start.character + 1,
                    uri: ref.uri
                }));
                const docCache = new Map<string, vscode.TextDocument>();
                const page = await createReferencePage(locations, options, async ref => {
                    try {
                        // countOnly 不会调用本回调；分页仅打开当前页需要的引用文档。
                        let doc = docCache.get(ref.uri.toString());
                        if (!doc) {
                            doc = await withTimeoutAndAbort(
                                vscode.workspace.openTextDocument(ref.uri), LSP_TIMEOUT_MS, context?.abortSignal
                            );
                            docCache.set(ref.uri.toString(), doc);
                        }
                        return referenceSnippet(doc.lineCount, index => doc!.lineAt(index).text, ref.line - 1, contextLines);
                    } catch (error) {
                        // 用户中止不是“文件不可读”，不可吞掉后继续遍历后续引用。
                        if (context?.abortSignal?.aborted) throw error;
                        return { content: '(Unable to read file content)' };
                    }
                });
                return {
                    success: true,
                    data: {
                        path: filePath, line, column, symbol: symbolName, ...page,
                        ...(references.length === 0 ? { message: 'No references found. The symbol may not be used, or no language server is available.' } : {})
                    }
                };
            } catch (error) {
                return { success: false, error: error instanceof Error ? error.message : String(error) };
            }
        }
    };
}

/** 注册查找引用工具。 */
export function registerFindReferences(): Tool {
    return createFindReferencesTool();
}
