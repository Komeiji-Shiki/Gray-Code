/**
 * 插入代码工具
 *
 * 在文件的指定行前插入一段代码
 * 支持批量操作多个文件
 * 支持多工作区（Multi-root Workspaces）
 */

import * as fs from 'fs';
import type { Tool, ToolResult, ToolContext } from '../types';
import { resolveUriWithInfo, getAllWorkspaces, normalizeLineEndingsToLF, detectNonUtf8Encoding, formatFileSize } from '../utils';
import { getDiffManager, type DiffResolutionReason } from './diffManager';
import { getDiffStorageManager } from '../../modules/conversation';
import type { LockHolder } from '../../core/fileWriteLockManager';

// 文件大小护栏（与 read_file/search_in_files 的 5MB 上限一致）：
// 超大文件全量 readFileSync 会阻塞 extension host 并全量读入内存。
const MAX_EDIT_FILE_BYTES = 5 * 1024 * 1024;

/**
 * 单个插入条目
 */
interface InsertCodeEntry {
    path: string;
    line: number;
    content: string;
}

/**
 * 单个插入结果
 */
interface InsertResult {
    path: string;
    success: boolean;
    line?: number;
    insertedLines?: number;
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
 * 尾部空串（如 "a\nb\n" → ['a','b','']）。该空串不是真实行，行号映射与插入
 * 都必须以真实行计算，并保证幻影尾行始终位于文件末尾。
 *
 * 说明：数组本身无法区分「真实空行结尾」与「幻影尾行」，这里采用保守判定——
 * 仅当尾部空串的上一项非空（或数组只有一个元素，即空文件）时才视为幻影；
 * 连续空行结尾（"a\n\n"）时最后一项按真实空行处理，保持原有插入语义。
 */
function hasPhantomTailLine(lines: string[]): boolean {
    if (lines.length === 0) return false;
    if (lines[lines.length - 1] !== '') return false;
    if (lines.length === 1) return true;
    return lines[lines.length - 2] !== '';
}

/**
 * 在指定行前插入代码
 */
function insertAtLine(lines: string[], line: number, content: string): string {
    const insertLines = splitContentLines(content);
    // 幻影尾行存在时，插入位置不能越过幻影行（它必须始终位于文件末尾），
    // 否则 "a\nb\n" 末尾追加会变成 "a\nb\n\nX"（多余空行）。
    const maxIdx = hasPhantomTailLine(lines) ? lines.length - 1 : lines.length;
    const idx = Math.min(Math.max(0, line - 1), maxIdx);
    const newLines = [
        ...lines.slice(0, idx),
        ...insertLines,
        ...lines.slice(idx)
    ];
    return newLines.join('\n');
}

export { insertAtLine };

/**
 * content 以 \n 结尾时 split('\n') 会多出尾部空串：
 * 插入后产生多余空行，且 insertedLineCount 多计 1 导致 CodeLens 高亮偏移。
 * 去掉尾部空串后，结尾换行由 join('\n') 在插入点自然还原，行数统计正确。
 */
function splitContentLines(content: string): string[] {
    if (content === '') {
        return [];
    }
    const lines = content.split('\n');
    if (content.length > 0 && lines[lines.length - 1] === '') {
        lines.pop();
    }
    return lines;
}

/**
 * 执行单个文件的插入
 */
async function insertSingleFile(
    entry: InsertCodeEntry,
    toolId?: string,
    abortSignal?: AbortSignal,
    approvedByToolConfirmation?: boolean,
    conversationId?: string,
    checkpointReady?: Promise<unknown>,
    lockHolder?: LockHolder,
    activeWorkspaceUri?: string
): Promise<InsertResult> {
    const { path: filePath, line, content } = entry;

    // 参数校验
    if (!filePath || typeof filePath !== 'string') {
        return { path: filePath || '', success: false, error: 'path is required' };
    }
    if (typeof line !== 'number' || !Number.isInteger(line) || line < 1) {
        return { path: filePath, success: false, error: 'line must be a positive integer (1-based)' };
    }
    if (typeof content !== 'string') {
        return { path: filePath, success: false, error: 'content is required' };
    }

    const { uri } = resolveUriWithInfo(filePath, activeWorkspaceUri);
    if (!uri) {
        return { path: filePath, success: false, error: 'No workspace folder open' };
    }

    const absolutePath = uri.fsPath;
    if (!fs.existsSync(absolutePath)) {
        return { path: filePath, success: false, error: `File not found: ${filePath}. Use write_file to create new files.` };
    }

    // 文件大小护栏：超大文件全量 readFileSync 会阻塞 extension host，先 stat 拦截。
    try {
        const stat = fs.statSync(absolutePath);
        if (stat.size > MAX_EDIT_FILE_BYTES) {
            return {
                path: filePath,
                success: false,
                error: `File is too large (${formatFileSize(stat.size)}, limit ${formatFileSize(MAX_EDIT_FILE_BYTES)}). Editing files this large is not supported; use write_file to replace the whole file, or edit a smaller file.`
            };
        }
    } catch (e) {
        return { path: filePath, success: false, error: `Failed to stat file: ${e instanceof Error ? e.message : String(e)}` };
    }

    try {
        const rawBuffer = fs.readFileSync(absolutePath);
        // 编码防护：非 UTF-8 文件读-改-写会永久损坏原编码
        const encodingIssue = detectNonUtf8Encoding(rawBuffer);
        if (encodingIssue) {
            return { path: filePath, success: false, error: `Refusing to insert code: ${encodingIssue}. Convert the file to UTF-8 first.` };
        }
        const originalContent = normalizeLineEndingsToLF(
            rawBuffer.toString('utf8')
        );
        const originalLines = originalContent.split('\n');
        const totalLines = originalLines.length;

        // line 范围校验：1 ~ totalLines + 1
        if (line > totalLines + 1) {
            return {
                path: filePath,
                success: false,
                error: `Line ${line} is out of range. File has ${totalLines} lines. Use 1~${totalLines + 1}.`
            };
        }

        const newContent = insertAtLine(originalLines, line, content);

        if (originalContent === newContent) {
            return { path: filePath, success: true, line, insertedLines: 0, status: 'accepted' };
        }

        // 计算插入块的行范围（用于 CodeLens 高亮）
        const insertedLineCount = splitContentLines(content).length;
        const blocks = [{
            index: 0,
            startLine: line,
            endLine: line + insertedLineCount - 1
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
        const interruptReason = await waitForDiffResolution(
            diffManager, pendingDiff.id, abortSignal
        );

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
                line,
                insertedLines: insertedLineCount,
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
            line,
                insertedLines: insertedLineCount,
                status: 'rejected',
                error: interruptReason === 'abort'
                    ? 'Insert was cancelled by user'
                    : 'Insert was interrupted by user',
                diffContentId
            };
        }

        return {
            path: filePath,
            success: wasAccepted,
            line,
            insertedLines: insertedLineCount,
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
            error: `Failed to insert code: ${error instanceof Error ? error.message : String(error)}`
        };
    }
}

/**
 * 创建 insert_code 工具
 */
export function createInsertCodeTool(): Tool {
    const workspaces = getAllWorkspaces();
    const isMultiRoot = workspaces.length > 1;

    const arrayFormatNote = '\n\n**IMPORTANT**: The `files` parameter MUST be an array, even for a single file. Example: `{"files": [{"path": "file.ts", "line": 5, "content": "..."}]}`.';

    let description = 'Insert code before a specified line in one or more files. Use `line = last_line + 1` to append at the end. A Diff preview will be shown for user confirmation.' + arrayFormatNote;
    let pathDescription = 'File path (relative to workspace root)';

    if (isMultiRoot) {
        description += `\n\nMulti-root workspace: Must use "workspace_name/path" format. Available workspaces: ${workspaces.map(w => w.name).join(', ')}`;
        pathDescription = 'File path, must use "workspace_name/path" format';
    }

    return {
        declaration: {
            name: 'insert_code',
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
                                line: {
                                    type: 'number',
                                    description: 'Line number (1-based) to insert before. Use last_line + 1 to append at end of file.'
               },
                                content: {
                                    type: 'string',
                                    description: 'The code content to insert'
                                }
                            },
                            required: ['path', 'line', 'content']
                        },
                        description: 'Array of insert operations. Each element specifies a file, line number, and content to insert. MUST be an array even for a single file.'
                    }
                },
                required: ['files']
            }
        },
        handler: async (args, context?: ToolContext): Promise<ToolResult> => {
            const fileList = args.files as InsertCodeEntry[] | undefined;
            if (!fileList || !Array.isArray(fileList) || fileList.length === 0) {
                return { success: false, error: 'files is required and must be a non-empty array' };
            }

            const results: InsertResult[] = [];
            let successCount = 0;
            let failCount = 0;

            for (const entry of fileList) {
                const result = await insertSingleFile(
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
                    ? 'Insert was cancelled by user'
                    : (allSuccess ? undefined : `${failCount} file(s) failed to insert`)
            };
        }
    };
}

/**
 * 等待 DiffManager 中的 diff 被解决（接受/拒绝/中断）
 */
function waitForDiffResolution(
    diffManager: ReturnType<typeof getDiffManager>,
    diffId: string,
    abortSignal?: AbortSignal
): Promise<DiffResolutionReason> {
    return diffManager.waitForDiffResolution(diffId, abortSignal);
}

/**
 * 注册 insert_code 工具
 */
export function registerInsertCode(): Tool {
    return createInsertCodeTool();
}
