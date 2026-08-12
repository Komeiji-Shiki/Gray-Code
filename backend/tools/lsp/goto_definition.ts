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
    // 模型声明语言：zh-CN → 中文，en/ja → 英文（ja 本阶段映射到英文说明）
    const isZh = resolveLocalizationLanguage(getActualLanguage()) === 'zh-CN';
    
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
        declaration: {
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
                        type: 'number',
                        description: isZh ? '符号所在的行号（1-based）' : 'Line number (1-based) where the symbol is located'
                    },
                    column: {
                        type: 'number',
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
        },
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
            const accessError = ensureOutsideWorkspaceAccessApproved('read_file', { path: filePath }, context);
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
 * 查找代码块的结束位置
 * 通过跟踪括号匹配来确定函数/类的完整范围
 *
 * 修改原因：旧实现只做纯括号计数，字符串/注释/模板字面量内的 } 也会被计入，
 * 导致定义块被提前截断（如字符串里含 "}"）或过度扩展。
 * 修改方式：先用词法感知扫描（跳过行注释/块注释/单双引号字符串/模板字面量），
 * 未找到匹配时回退到原始的纯括号计数兜底（findBlockEndNaive），保证不回归旧行为。
 */
function findBlockEnd(doc: vscode.TextDocument, startLine: number): number {
    const lexicalEnd = findBlockEndWithLexicalState(doc, startLine);
    if (lexicalEnd > startLine) {
        return lexicalEnd;
    }
    // 词法扫描未找到平衡括号（代码不平衡或含无法解析的语法如正则字面量），
    // 回退原逻辑，尽量保持旧行为兜底。
    return findBlockEndNaive(doc, startLine);
}

/**
 * 词法感知的块结束扫描：跳过字符串/注释/模板字面量中的括号后再计数。
 *
 * 维护最小化词法状态：行注释（//）、块注释（/* ... *\/）、单/双引号字符串（支持 \\ 转义）、
 * 模板字面量（`...`，整体视为不透明）。
 *
 * 已知边界（不会造成提前截断的回归）：
 * - 正则字面量未专门识别（与除法难以区分），其中的括号按普通代码计数；
 * - 模板字面量整体不透明，${...} 插值内的括号不会被计数。
 * 这两种情况只会导致“未找到匹配 → 回退朴素逻辑”，不会把字符串/注释里的 } 误当块结束。
 *
 * @returns 匹配的结束行号（0-based）；未找到返回 -1
 */
function findBlockEndWithLexicalState(doc: vscode.TextDocument, startLine: number): number {
    let braceCount = 0;
    let foundOpenBrace = false;
    const totalLines = doc.lineCount;

    // 最小化词法状态
    let inBlockComment = false;  // /* ... */
    let inSingleQuote = false;   // '...'（支持 \\ 转义）
    let inDoubleQuote = false;   // "..."（支持 \\ 转义）
    let inTemplate = false;      // `...`（整体不透明）
    let escaped = false;         // 字符串/模板内的反斜杠转义

    for (let i = startLine; i < totalLines; i++) {
        const lineText = doc.lineAt(i).text;
        // 行注释只到行尾，每行重新判定
        let inLineComment = false;

        for (let j = 0; j < lineText.length; j++) {
            const char = lineText[j];
            const next = j + 1 < lineText.length ? lineText[j + 1] : '';

            // 代码区才能开始注释；字符串/模板/块注释内不判定注释起始
            if (!inBlockComment && !inSingleQuote && !inDoubleQuote && !inTemplate) {
                if (char === '/' && next === '/') {
                    inLineComment = true;
                    break; // 行注释直到行尾
                }
                if (char === '/' && next === '*') {
                    inBlockComment = true;
                    j++; // 跳过 '*'
                    continue;
                }
            }

            if (inBlockComment) {
                if (char === '*' && next === '/') {
                    inBlockComment = false;
                    j++; // 跳过 '/'
                }
                continue;
            }

            if (inLineComment) {
                break;
            }

            // 字符串/模板内的转义：下一个字符不参与判定
            if (escaped) {
                escaped = false;
                continue;
            }
            if ((inSingleQuote || inDoubleQuote || inTemplate) && char === '\\') {
                escaped = true;
                continue;
            }

            // 进入/退出字符串或模板字面量
            if (!inSingleQuote && !inDoubleQuote && !inTemplate && char === "'") {
                inSingleQuote = true;
                continue;
            }
            if (!inSingleQuote && !inDoubleQuote && !inTemplate && char === '"') {
                inDoubleQuote = true;
                continue;
            }
            if (!inSingleQuote && !inDoubleQuote && !inTemplate && char === '`') {
                inTemplate = true;
                continue;
            }
            if (inSingleQuote && char === "'") {
                inSingleQuote = false;
                continue;
            }
            if (inDoubleQuote && char === '"') {
                inDoubleQuote = false;
                continue;
            }
            if (inTemplate && char === '`') {
                inTemplate = false;
                continue;
            }

            // 代码区：括号计数
            if (char === '{') {
                braceCount++;
                // 仅当计数由非正转正时才视为“块开始”，避免起始行在块外时
                // “先见 } 后见 {”回升到 0 被误判为匹配
                if (!foundOpenBrace && braceCount > 0) {
                    foundOpenBrace = true;
                }
            } else if (char === '}') {
                braceCount--;
                if (foundOpenBrace && braceCount === 0) {
                    return i;
                }
                // 已见开括号却计数为负：起始行不在块内或代码不平衡，
                // 返回 -1 交给调用方回退朴素逻辑
                if (foundOpenBrace && braceCount < 0) {
                    return -1;
                }
            }
        }

        // 防止无限循环，最多查找 500 行
        if (i - startLine > 500) {
            break;
        }
    }

    // 没找到匹配的括号
    return -1;
}

/**
 * 原始的纯括号计数实现（回退用）
 * 不区分字符串/注释中的括号，行为与旧版 findBlockEnd 完全一致。
 */
function findBlockEndNaive(doc: vscode.TextDocument, startLine: number): number {
    let braceCount = 0;
    let foundOpenBrace = false;
    const totalLines = doc.lineCount;
    
    for (let i = startLine; i < totalLines; i++) {
        const lineText = doc.lineAt(i).text;
        
        for (const char of lineText) {
            if (char === '{') {
                braceCount++;
                foundOpenBrace = true;
            } else if (char === '}') {
                braceCount--;
                if (foundOpenBrace && braceCount === 0) {
                    return i;
                }
            }
        }
        
        // 防止无限循环，最多查找 500 行
        if (i - startLine > 500) {
            break;
        }
    }
    
    // 如果没找到匹配的括号，返回起始行
    return startLine;
}

/**
 * 注册跳转到定义工具
 */
export function registerGotoDefinition(): Tool {
    return createGotoDefinitionTool();
}
