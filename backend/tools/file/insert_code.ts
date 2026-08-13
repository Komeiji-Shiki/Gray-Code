/**
 * 插入代码工具
 *
 * 在文件的指定行前插入一段代码
 * 支持批量操作多个文件
 * 支持多工作区（Multi-root Workspaces）
 */

import * as fs from 'fs';
import type { Tool, ToolResult, ToolContext } from '../types';
import { parseArgs } from '../types';
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
 * 单个插入条目
 */
interface InsertCodeEntry {
    path: string;
    line: number;
    content: string;
}

/**
 * insert_code 的规范化参数形状。
 */
interface InsertCodeArgs {
    files: InsertCodeEntry[];
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
 * 在指定行前插入代码
 */
function insertAtLine(lines: string[], line: number, content: string): string {
    const insertLines = splitContentLines(content);
    const idx = line - 1; // 转为 0-based
    const newLines = [
        ...lines.slice(0, idx),
        ...insertLines,
        ...lines.slice(idx)
    ];
    return newLines.join('\n');
}

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
    lockHolder?: LockHolder
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
            return { path: filePath, success: false, error: `File not found: ${filePath}. Use write_file to create new files.` };
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

        // 等待用户处理并统一解析审阅终态（与 write_file/apply_diff/delete_code/replacePass 共用 helper）
        const outcome = await resolveDiffOutcome({
            pendingDiffId: pendingDiff.id,
            abortSignal,
            originalContent,
            newContent,
            filePath,
            actionLabel: 'Insert'
        });

        if (outcome.wasRejected) {
            // 用户显式拒绝：与取消区分，返回 status:'rejected' + 可读错误
            return {
                path: filePath,
                success: false,
                cancelled: false,
                line,
                insertedLines: insertedLineCount,
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
                line,
                insertedLines: insertedLineCount,
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
            line,
            insertedLines: insertedLineCount,
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
    // 模型声明语言：zh-CN → 中文，en/ja → 英文（ja 本阶段映射到英文说明）
    const isZh = resolveLocalizationLanguage(getActualLanguage()) === 'zh-CN';

    const arrayFormatNote = isZh
        ? '\n\n**重要**：`files` 参数必须是数组，即使只插入一个文件。示例：`{"files": [{"path": "file.ts", "line": 5, "content": "..."}]}`。'
        : '\n\n**IMPORTANT**: The `files` parameter MUST be an array, even for a single file. Example: `{"files": [{"path": "file.ts", "line": 5, "content": "..."}]}`.';

    let description = isZh
        ? '在一个或多个文件的指定行前插入代码。使用 `line = last_line + 1` 在文件末尾追加。执行前会展示 Diff 预览并等待用户确认。' + arrayFormatNote
        : 'Insert code before a specified line in one or more files. Use `line = last_line + 1` to append at the end. A Diff preview will be shown for user confirmation.' + arrayFormatNote;
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
                                    type: 'integer',
                                    minimum: 1,
                                    description: isZh
                                        ? '要插入到的行号（1-based）。使用 last_line + 1 在文件末尾追加。'
                                        : 'Line number (1-based) to insert before. Use last_line + 1 to append at end of file.'
                                },
                                content: {
                                    type: 'string',
                                    description: isZh ? '要插入的代码内容' : 'The code content to insert'
                                }
                            },
                            required: ['path', 'line', 'content']
                        },
                        description: isZh
                            ? '插入操作数组。每个元素指定一个文件、行号和要插入的内容。即使只插入一个文件也必须传数组。'
                            : 'Array of insert operations. Each element specifies a file, line number, and content to insert. MUST be an array even for a single file.'
                    }
                },
                required: ['files']
            }
        },
        handler: async (args, context?: ToolContext): Promise<ToolResult> => {
            const fileList = parseArgs<InsertCodeArgs>(args).files;
            if (!fileList || !Array.isArray(fileList) || fileList.length === 0) {
                return { success: false, error: 'files is required and must be a non-empty array' };
            }

            // 越权防护：拒绝在工作区之外插入代码（子代理/直调工具链路同样生效）
            const accessError = ensureOutsideWorkspaceAccessApproved('insert_code', args, context);
            if (accessError) {
                return { success: false, error: accessError };
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
                    ? 'Insert was cancelled by user'
                    : (allSuccess ? undefined : `${failCount} file(s) failed to insert`)
            };
        }
    };
}

/**
 * 注册 insert_code 工具
 */
export function registerInsertCode(): Tool {
    return createInsertCodeTool();
}
