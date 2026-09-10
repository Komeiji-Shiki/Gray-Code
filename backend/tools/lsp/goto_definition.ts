import { findBlockEnd } from './definitionRange';
import { createGotoDefinitionToolDeclaration } from './declarations';
/**
 * 跳转到定义工具
 *
 * 使用 VSCode LSP 查找符号的定义位置，并直接返回完整的定义代码
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
import { getActualLanguage } from '../../i18n';
import { resolveLocalizationLanguage } from '../localization/types';

/**
 * 定义位置信息
 */
interface DefinitionLocation {
    path: string;
    line: number;       // 1-based
    endLine: number;    // 1-based
    content: string;    // 定义处的代码内容（带行号）
    lineCount: number;  // 返回的代码行数
}

/**
 * 创建跳转到定义工具
 */
export function createGotoDefinitionTool(): Tool {
    const workspaces = getAllWorkspaces();
    const isMultiRoot = workspaces.length > 1;
    return {
        declaration: createGotoDefinitionToolDeclaration({ workspaces }),
        handler: async (args, context): Promise<ToolResult> => {
            const filePath = args.path as string;
            const line = args.line as number;
            // column 校验：仅接受有限正整数（负数/小数/NaN 构造 Position 会抛 Illegal argument），
            // 非法或缺失时回退默认 1（与 find_references 行为一致）
            const rawColumn = args.column;
            const column = (typeof rawColumn === 'number' && Number.isInteger(rawColumn) && rawColumn >= 1)
                ? rawColumn
                : 1;
            const symbolName = args.symbol as string | undefined;
            
            if (!filePath) {
                return { success: false, error: 'path is required' };
            }
            // line 校验：仅接受有限正整数（NaN/小数/Infinity 会穿透旧的 line < 1 检查）
            if (typeof line !== 'number' || !Number.isInteger(line) || line < 1) {
                return { success: false, error: 'line must be a positive integer (1-based)' };
            }
            
            // 修改原因：goto_definition 接受绝对路径时可通过 LSP 读取工作区外文件内容，不受读策略管控。
            // 修改方式：与 read_file 一致，入口处校验 outside-workspace 读策略（deny/ask/allow）。
            // 使用真实工具名：服务层白名单已包含 goto_definition，ask 策略下确认弹窗可正常放行。
            const accessError = ensureOutsideWorkspaceAccessApproved('goto_definition', { path: filePath }, context);
            if (accessError) {
                return { success: false, error: accessError };
            }
            
            const uri = resolveUri(filePath);
            if (!uri) {
                return { success: false, error: 'Could not resolve file path. Make sure a workspace is open.' };
            }
            
            try {
                // 创建位置（转换为 0-based）
                const position = new vscode.Position(line - 1, column - 1);
                // 主动打开文档以激活对应语言服务（带超时/中止保护）
                await openDocumentWithGuard(uri, context?.abortSignal);

                // 使用 VSCode 的 executeDefinitionProvider 命令（超时/中止保护 + 瞬时重试）
                const definitions = await executeLspCommandWithRetry<(vscode.Location | vscode.LocationLink)[]>(
                    'vscode.executeDefinitionProvider',
                    [uri, position],
                    { abortSignal: context?.abortSignal }
                );
                
                if (!definitions || definitions.length === 0) {
                    return {
                        success: true,
                        data: {
                            path: filePath,
                            line,
                            column,
                            symbol: symbolName,
                            definitions: [],
                            message: 'No definition found. The symbol may not have a definition, or no language server is available.'
                        }
                    };
                }
                
                // 转换定义位置并获取完整定义代码
                const convertedDefinitions: DefinitionLocation[] = [];
                
                for (const def of definitions) {
                    let targetUri: vscode.Uri;
                    let targetRange: vscode.Range;
                    
                    if ('targetUri' in def) {
                        // LocationLink
                        targetUri = def.targetUri;
                        targetRange = def.targetRange;
                    } else {
                        // Location
                        targetUri = def.uri;
                        targetRange = def.range;
                    }
                    
                    // 获取相对路径
                    const workspaceFolder = vscode.workspace.getWorkspaceFolder(targetUri);
                    let relativePath: string;
                    if (workspaceFolder) {
                        relativePath = vscode.workspace.asRelativePath(targetUri, isMultiRoot);
                    } else {
                        relativePath = targetUri.fsPath;
                    }
                    
                    // 读取完整定义代码（带超时/中止保护）
                    try {
                        const doc = await withTimeoutAndAbort(
                            vscode.workspace.openTextDocument(targetUri),
                            LSP_TIMEOUT_MS,
                            context?.abortSignal
                        );
                        
                        // 使用 LSP 返回的定义范围
                        let startLine = targetRange.start.line;  // 0-based
                        let endLine = targetRange.end.line;      // 0-based
                        
                        // 如果定义范围太小（可能只是符号名称），尝试扩展到完整的代码块
                        // 通过查找匹配的括号来确定完整范围
                        if (endLine - startLine < 2) {
                            const expandedEnd = findBlockEnd(doc, startLine);
                            if (expandedEnd > endLine) {
                                endLine = expandedEnd;
                            }
                        }
                        
                        // 确保不超过文件范围
                        const totalLines = doc.lineCount;
                        if (endLine >= totalLines) {
                            endLine = totalLines - 1;
                        }
                        
                        // 提取代码并添加行号
                        const lines: string[] = [];
                        for (let i = startLine; i <= endLine; i++) {
                            const lineText = doc.lineAt(i).text;
                            const lineNum = i + 1; // 转换为 1-based
                            lines.push(`${lineNum.toString().padStart(4)} | ${lineText}`);
                        }
                        
                        convertedDefinitions.push({
                            path: relativePath,
                            line: startLine + 1,     // 1-based
                            endLine: endLine + 1,    // 1-based
                            content: lines.join('\n'),
                            lineCount: lines.length
                        });
                    } catch (e) {
                        // 无法读取文件，返回基本信息
                        convertedDefinitions.push({
                            path: relativePath,
                            line: targetRange.start.line + 1,
                            endLine: targetRange.end.line + 1,
                            content: '(Unable to read file content)',
                            lineCount: 0
                        });
                    }
                }
                
                return {
                    success: true,
                    data: {
                        path: filePath,
                        line,
                        column,
                        symbol: symbolName,
                        definitionCount: convertedDefinitions.length,
                        definitions: convertedDefinitions
                    }
                };
            } catch (error) {
                return {
                    success: false,
                    error: error instanceof Error ? error.message : String(error)
                };
            }
        }
    };
}

/**
 * 注册跳转到定义工具
 */
export function registerGotoDefinition(): Tool {
    return createGotoDefinitionTool();
}
