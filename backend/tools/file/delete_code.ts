/**
 * 删除代码工具
 *
 * 删除文件中指定行范围的代码
 * 支持批量操作多个文件
 * 支持多工作区（Multi-root Workspaces）
 */

import * as fs from 'fs';
import type { Tool, ToolResult, ToolContext } from '../types';
import { resolveUriWithInfo, getAllWorkspaces, normalizeLineEndingsToLF, formatFileSize } from '../utils';
import { getDiffManager } from '../../core/services/diffManager';
import { ensureOutsideWorkspaceAccessApproved } from './outsideWorkspaceAccess';
import { resolveDiffOutcome } from './diff/resolveDiffOutcome';
import type { LockHolder } from '../../core/fileWriteLockManager';
import { getActualLanguage } from '../../i18n';
import { resolveLocalizationLanguage } from '../localization/types';

// 文件大小护栏（与 read_file/search_in_files 的 5MB 上限一致）已统一收敛到 shared/fileSizeGuards
import { MAX_EDIT_FILE_BYTES } from '../shared/fileSizeGuards';

/**
 * 单个删除条目
 */
interface DeleteCodeEntry {
    path: string;
    start_line: number;
    end_line: number;
}

/**
 * 单个删除结果
 */
interface DeleteResult {
    path: string;
    success: boolean;
    start_line?: number;
    end_line?: number;
    deletedLines?: number;
    status?: 'accepted' | 'rejected' | 'pending';
    error?: string;
    cancelled?: boolean;
    diffContentId?: string;
    /** 自动保存失败原因；用于解释 rejected 的真实来源 */
    autoSaveError?: string;
    pendingDiffId?: string;
}

/**
 * 删除指定行范围
 */
function deleteLineRange(lines: string[], startLine: number, endLine: number): string {
    const newLines = [
        ...lines.slice(0, startLine - 1),
        ...lines.slice(endLine)
    ];
    return newLines.join('\n');
}

/**
 * 执行单个文件的删除
 */
async function deleteSingleFile(
    entry: DeleteCodeEntry,
    toolId?: string,
    abortSignal?: AbortSignal,
    approvedByToolConfirmation?: boolean,
    conversationId?: string,
    checkpointReady?: Promise<unknown>,
    lockHolder?: LockHolder
): Promise<DeleteResult> {
    const { path: filePath, start_line: startLine, end_line: endLine } = entry;

    // 参数校验
    if (!filePath || typeof filePath !== 'string') {
        return { path: filePath || '', success: false, error: 'path is required' };
    }
    if (typeof startLine !== 'number' || !Number.isInteger(startLine) || startLine < 1) {
        return { path: filePath, success: false, error: 'start_line must be a positive integer (1-based)' };
    }
    if (typeof endLine !== 'number' || !Number.isInteger(endLine) || endLine < 1) {
        return { path: filePath, success: false, error: 'end_line must be a positive integer (1-based)' };
    }
    if (startLine > endLine) {
        return { path: filePath, success: false, error: `start_line (${startLine}) must be <= end_line (${endLine})` };
    }

    const { uri } = resolveUriWithInfo(filePath);
    if (!uri) {
        return { path: filePath, success: false, error: 'No workspace folder open' };
    }

    const absolutePath = uri.fsPath;

    // 文件存在性 + 大小护栏：单次 stat 即可（ENOENT 归为文件不存在）
    let fileStat;
    try {
        fileStat = await fs.promises.stat(absolutePath);
    } catch (e: any) {
        if (e?.code === 'ENOENT') {
            return { path: filePath, success: false, error: `File not found: ${filePath}` };
        }
        return { path: filePath, success: false, error: `Failed to stat file: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (fileStat.size > MAX_EDIT_FILE_BYTES) {
        return {
            path: filePath,
            success: false,
            error: `File is too large (${formatFileSize(fileStat.size)}, limit ${formatFileSize(MAX_EDIT_FILE_BYTES)}). Editing files this large is not supported; use write_file to replace the whole file, or edit a smaller file.`
        };
    }

    try {
        const originalContent = normalizeLineEndingsToLF(
            await fs.promises.readFile(absolutePath, 'utf8')
        );
        // PERF：提前预热目标文档（openTextDocument），与行计算/块定位并行，
        // 首次打开 diff 视图时读盘 + 语言服务初始化不再阻塞 UI。
        getDiffManager()?.prewarmDocument?.(uri);
        const originalLines = originalContent.split('\n');
        const totalLines = originalLines.length;

        // 范围校验
        if (startLine > totalLines) {
            return {
                path: filePath,
                success: false,
                error: `start_line ${startLine} is out of range. File has ${totalLines} lines.`
            };
        }
        if (endLine > totalLines) {
            return {
                path: filePath,
                success: false,
                error: `end_line ${endLine} is out of range. File has ${totalLines} lines.`
            };
        }

        const newContent = deleteLineRange(originalLines, startLine, endLine);
        const deletedCount = endLine - startLine + 1;

        if (originalContent === newContent) {
            return { path: filePath, success: true, start_line: startLine, end_line: endLine, deletedLines: 0, status: 'accepted' };
        }

        // 删除操作的 blocks：在新内容中标记被删除区域的前后交界处。
        // clamp 保证 endLine >= startLine：删除到文件末尾（或整文件删除）时
        // totalLines - deletedCount 会小于 startLine，倒置区间会让 vscode.Range 抛 Illegal argument。
        const blockStart = Math.max(1, startLine - 1);
        const blockEnd = Math.min(startLine, totalLines - deletedCount);
        const blocks = [{
            index: 0,
            startLine: blockStart,
            endLine: Math.max(blockEnd, blockStart)
        }];

        // 创建 pending diff 等待用户确认
        const diffManager = getDiffManager();
        const pendingDiff = await diffManager.createPendingDiff(
            filePath,
            absolutePath,
            originalContent,
            newContent,
            blocks,
            undefined,
            toolId,
            { confirmedByToolConfirmation: approvedByToolConfirmation === true, conversationId, checkpointReady, lockHolder }
        );

        // 等待用户处理并统一解析审阅终态（与 write_file/apply_diff/insert_code/replacePass 共用 helper）
        const outcome = await resolveDiffOutcome({
            pendingDiffId: pendingDiff.id,
            abortSignal,
            originalContent,
            newContent,
            filePath,
            actionLabel: 'Delete'
        });

        if (outcome.wasRejected) {
            // 用户显式拒绝：与取消区分，返回 status:'rejected' + 可读错误
            return {
                path: filePath,
                success: false,
                cancelled: false,
                start_line: startLine,
                end_line: endLine,
                deletedLines: deletedCount,
                status: 'rejected',
                error: outcome.rejectedMessage,
                diffContentId: outcome.diffContentId,
                pendingDiffId: outcome.pendingDiffId
            };
        }

        if (outcome.wasInterrupted) {
            return {
                path: filePath,
                success: false,
                cancelled: true,
                start_line: startLine,
                end_line: endLine,
                deletedLines: deletedCount,
                status: 'rejected',
                error: outcome.interruptKind === 'abort'
                    ? outcome.abortMessage
                    : outcome.interruptMessage,
                diffContentId: outcome.diffContentId,
                pendingDiffId: outcome.pendingDiffId
            };
        }

        return {
            path: filePath,
            success: outcome.wasAccepted,
            start_line: startLine,
            end_line: endLine,
            deletedLines: deletedCount,
            status: outcome.wasAccepted ? 'accepted' : 'rejected',
            error: outcome.wasAccepted ? undefined : (outcome.autoSaveError || outcome.rejectedMessage),
            autoSaveError: outcome.autoSaveError,
            diffContentId: outcome.diffContentId,
            pendingDiffId: outcome.pendingDiffId
        };
    } catch (error) {
        return {
            path: filePath,
            success: false,
            error: `Failed to delete code: ${error instanceof Error ? error.message : String(error)}`
        };
    }
}

/**
 * 创建 delete_code 工具
 */
export function createDeleteCodeTool(): Tool {
    const workspaces = getAllWorkspaces();
    const isMultiRoot = workspaces.length > 1;
    // 模型声明语言：zh-CN → 中文，en/ja → 英文（ja 本阶段映射到英文说明）
    const isZh = resolveLocalizationLanguage(getActualLanguage()) === 'zh-CN';

    // 修复历史拼写问题：parameterMUST → parameter MUST（中英文同时修复）
    const arrayFormatNote = isZh
        ? '\n\n**重要**：`files` 参数必须是数组，即使只删除一个文件。示例：`{"files": [{"path": "file.ts", "start_line": 10, "end_line": 20}]}`。'
        : '\n\n**IMPORTANT**: The `files` parameter MUST be an array, even for a single file. Example: `{"files": [{"path": "file.ts", "start_line": 10, "end_line": 20}]}`.';

    let description = isZh
        ? '从一个或多个文件中删除指定行范围（两端都包含）的代码。执行前会展示 Diff 预览并等待用户确认。' + arrayFormatNote
        : 'Delete a range of lines (inclusive on both ends) from one or more files. A Diff preview will be shown for user confirmation.' + arrayFormatNote;
    let pathDescription = isZh
        ? '文件路径（相对于工作区根目录）'
        : 'File path (relative to workspace root)';

    if (isMultiRoot) {
        description += isZh
            ? `\n\n多根工作区：必须使用 "workspace_name/path" 格式。可用工作区：${workspaces.map(w => w.name).join(', ')}`
            : `\n\nMulti-root workspace: Must use "workspace_name/path" format. Available workspaces: ${workspaces.map(w => w.name).join(', ')}`;
        pathDescription = isZh
            ? '文件路径，必须使用 "workspace_name/path" 格式'
            : 'File path, must use "workspace_name/path" format';
    }

    return {
        declaration: {
            name: 'delete_code',
            description,
            category: 'file',
            parameters: {
                type: 'object',
                properties: {
                    files: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                path: {
                                    type: 'string',
                                    description: pathDescription
                                },
                                start_line: {
                                    type: 'integer',
                                    minimum: 1,
                                    description: isZh ? '起始行号（1-based，包含）' : 'Start line number (1-based, inclusive)'
                                },
                                end_line: {
                                    type: 'integer',
                                    minimum: 1,
                                    description: isZh ? '结束行号（1-based，包含）' : 'End line number (1-based, inclusive)'
                                }
                            },
                            required: ['path', 'start_line', 'end_line']
                        },
                        description: isZh
                            ? '删除操作数组。每个元素指定一个文件和要删除的行范围。即使只删除一个文件也必须传数组。'
                            : 'Array of delete operations. Each element specifies a file and line range to delete. MUST be an array even for a single file.'
                    }
                },
                required: ['files']
            }
        },
        handler: async (args, context?: ToolContext): Promise<ToolResult> => {
            const fileList = args.files as DeleteCodeEntry[] | undefined;
            if (!fileList || !Array.isArray(fileList) || fileList.length === 0) {
                return { success: false, error: 'files is required and must be a non-empty array' };
            }

            // 越权防护：拒绝在工作区之外删除代码（子代理/直调工具链路同样生效）
            const accessError = ensureOutsideWorkspaceAccessApproved('delete_code', args, context);
            if (accessError) {
                return { success: false, error: accessError };
            }

            const results: DeleteResult[] = [];
            let successCount = 0;
            let failCount = 0;

            for (const entry of fileList) {
                const result = await deleteSingleFile(
                    entry,
                    context?.toolId,
                    context?.abortSignal,
                    context?.approvedByToolConfirmation,
                    context?.conversationId,
                    // checkpointReady 由 ToolExecutionService 注入（ToolContext 索引签名透传）
                    context?.checkpointReady as Promise<unknown> | undefined,
                    // PERF-CP：deferred 模式写盘锁持有者身份（ToolContext 索引签名透传）
                    context?.lockHolder as LockHolder | undefined
                );
               results.push(result);
                if (result.success) {
                    successCount++;
                } else {
                    failCount++;
                }
            }

            const anyCancelled = results.some(r => r.cancelled);
            const allSuccess = failCount === 0 && !anyCancelled;

            return {
                success: allSuccess,
                cancelled: anyCancelled,
                data: {
                    results,
                    successCount,
                    failCount,
                    totalCount: fileList.length
                },
                error: anyCancelled
                    ? 'Delete was cancelled by user'
                    : (allSuccess ? undefined : `${failCount} file(s) failed to delete`)
            };
        }
    };
}

/**
 * 注册 delete_code 工具
 */
export function registerDeleteCode(): Tool {
    return createDeleteCodeTool();
}