/**
 * 删除代码工具
 *
 * 删除文件中指定行范围的代码
 * 支持批量操作多个文件
 * 支持多工作区（Multi-root Workspaces）
 */

import * as fs from 'fs';
import type { Tool, ToolResult, ToolContext } from '../types';
import { resolveUriWithInfo, getAllWorkspaces, normalizeLineEndingsToLF, detectNonUtf8Encoding, formatFileSize } from '../utils';
import { getDiffManager, type DiffResolutionReason } from '../../core/services/diffManager';
import { getDiffStorageManager } from '../../modules/conversation';
import { ensureOutsideWorkspaceAccessApproved } from './outsideWorkspaceAccess';
import type { LockHolder } from '../../core/fileWriteLockManager';

// 文件大小护栏（与 read_file/search_in_files 的 5MB 上限一致）：
// 超大文件全量 readFileSync 会阻塞 extension host 并全量读入内存。
const MAX_EDIT_FILE_BYTES = 5 * 1024 * 1024;

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
 * 判断 lines 是否带「幻影尾行」：文件内容以 '\n' 结尾时，split('\n') 会多出一个
 * 尾部空串（如 "a\nb\n" → ['a','b','']）。该空串不是真实行，行号映射与删除
 * 都必须以真实行计算，否则模型按 totalLines 删除时删的是幻影行：
 * 表现为“假成功”（deletedLines 有值但一行未删）或把文件末尾换行吞掉。
 * 判定规则与 insert_code 的 hasPhantomTailLine 保持一致。
 */
function hasPhantomTailLine(lines: string[]): boolean {
    if (lines.length === 0) return false;
    if (lines[lines.length - 1] !== '') return false;
    if (lines.length === 1) return true;
    return lines[lines.length - 2] !== '';
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
    lockHolder?: LockHolder,
    activeWorkspaceUri?: string
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

    const { uri } = resolveUriWithInfo(filePath, activeWorkspaceUri);
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
        const rawBuffer = await fs.promises.readFile(absolutePath);
        // 编码防护：非 UTF-8 文件读-改-写会永久损坏原编码
        const encodingIssue = detectNonUtf8Encoding(rawBuffer);
        if (encodingIssue) {
            return { path: filePath, success: false, error: `Refusing to delete code: ${encodingIssue}. Convert the file to UTF-8 first.` };
        }
        const originalContent = normalizeLineEndingsToLF(
            rawBuffer.toString('utf8')
        );
        // PERF：提前预热目标文档（openTextDocument），与行计算/块定位并行，
        // 首次打开 diff 视图时读盘 + 语言服务初始化不再阻塞 UI。
        getDiffManager()?.prewarmDocument?.(uri);
        const originalLines = originalContent.split('\n');
        // 幻影尾行不是真实行：范围校验与删除计数都以真实行为准
        const totalLines = hasPhantomTailLine(originalLines)
            ? originalLines.length - 1
            : originalLines.length;

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

        // 等待用户处理
        // 修改原因：本地 waitForDiffResolution 包装只是透传，删除重复包装直接调用。
        const interruptReason = await diffManager.waitForDiffResolution(pendingDiff.id, abortSignal);

        // 用户“拒绝”（rejected）与“中断/取消”（abort/user）分开处理：
        // rejected → status:'rejected' + 可读错误（不标记 cancelled）；abort/user → cancelled: true
        const wasRejected = interruptReason === 'rejected';
        const wasInterrupted = interruptReason === 'abort' || interruptReason === 'user';
        const finalDiff = diffManager.getDiff(pendingDiff.id);
        // 由 waitForDiffResolution 的终态语义判定：'rejected'（含被 FIFO 淘汰后留痕的拒绝）
        // 一律不算接受，避免被拒绝的 diff 被淘汰后 !finalDiff 误报"写入成功"。
        const wasAccepted = interruptReason === 'none';
        const autoSaveError = finalDiff?.autoSaveError;

        // 保存 diff 内容供前端按需加载
        const diffStorageManager = getDiffStorageManager();
        let diffContentId: string | undefined;
        if (diffStorageManager) {
            try {
        const diffRef = await diffStorageManager.saveGlobalDiff({
            originalContent,
            newContent,
            filePath
        }, undefined, conversationId);
                diffContentId = diffRef.diffId;
            } catch (e) {
                console.warn('Failed to save diff content to storage:', e);
            }
        }

        if (wasRejected) {
            // 用户显式拒绝：与取消区分，返回 status:'rejected' + 可读错误
            return {
                path: filePath,
                success: false,
                cancelled: false,
                start_line: startLine,
                end_line: endLine,
                deletedLines: deletedCount,
                status: 'rejected',
                error: 'Diff was rejected by user',
                diffContentId
            };
        }

        if (wasInterrupted) {
            return {
           path: filePath,
                success: false,
                cancelled: true,
                start_line: startLine,
                end_line: endLine,
                deletedLines: deletedCount,
                status: 'rejected',
                error: interruptReason === 'abort'
                    ? 'Delete was cancelled by user'
                    : 'Delete was interrupted by user',
                diffContentId
            };
        }

        return {
            path: filePath,
            success: wasAccepted,
            start_line: startLine,
            end_line: endLine,
            deletedLines: deletedCount,
            status: wasAccepted ? 'accepted' : 'rejected',
            error: wasAccepted ? undefined : (autoSaveError || 'Diff was rejected'),
            autoSaveError,
            diffContentId,
            pendingDiffId: pendingDiff.id
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

    const arrayFormatNote = '\n\n**IMPORTANT**: The `files` parameterMUST be an array, even for a single file. Example: `{"files": [{"path": "file.ts", "start_line": 10, "end_line": 20}]}`.';

    let description = 'Delete a range of lines (inclusive on both ends) from one or more files. A Diff preview will be shown for user confirmation.' + arrayFormatNote;
    let pathDescription = 'File path (relative to workspace root)';

    if (isMultiRoot) {
        description += `\n\nMulti-root workspace: Must use "workspace_name/path" format. Available workspaces: ${workspaces.map(w => w.name).join(', ')}`;
        pathDescription = 'File path, must use "workspace_name/path" format';
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
                                    type: 'number',
                         description: 'Start line number (1-based, inclusive)'
                                },
                                end_line: {
                                    type: 'number',
                                    description: 'End line number (1-based, inclusive)'
                                }
                            },
                            required: ['path', 'start_line', 'end_line']
                        },
                        description: 'Array of delete operations. Each element specifies a file and line range to delete. MUST be an array even for a single file.'
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
                    context?.lockHolder as LockHolder | undefined,
                    context?.activeWorkspaceUri
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