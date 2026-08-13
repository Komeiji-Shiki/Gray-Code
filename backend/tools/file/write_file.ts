/**
 * 写入文件工具
 *
 * 支持写入单个文件
 * 支持多工作区（Multi-root Workspaces）
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import type { Tool, ToolResult, ToolContext } from '../types';
import { resolveFileToolPathWithInfo, getAllWorkspaces, normalizeLineEndingsToLF } from '../utils';
import { getDiffManager } from '../../core/services/diffManager';
import { ensureOutsideWorkspaceAccessApproved } from './outsideWorkspaceAccess';
import { resolveDiffOutcome } from './diff/resolveDiffOutcome';
import { fileWriteLockManager, type LockHolder } from '../../core/fileWriteLockManager';
import { getActualLanguage } from '../../i18n';
import { resolveLocalizationLanguage } from '../localization/types';

/**
 * 单个文件写入配置
 */
interface WriteFileEntry {
    path: string;
    content: string;
}

/**
 * 单个文件写入结果
 * 简化版：AI 已经知道写入的内容，不需要重复返回
 */
interface WriteResult {
    path: string;
    success: boolean;
    action?: 'created' | 'modified' | 'unchanged';
    status?: 'accepted' | 'rejected' | 'pending';
    error?: string;
    /** 是否被用户取消（终止/中断） */
    cancelled?: boolean;
    /** 前端按需加载 diff 内容用 */
    diffContentId?: string;
    /**
     * 自动保存失败原因。
     * 为什么新增：DiffManager 现在会在 autoSave 失败时终结 pending diff，并把失败原因传回工具结果。
     * 怎么改：在写文件结果类型中允许该字段，避免运行时代码和 TypeScript 契约不一致。
     * 目的：让自动确认失败能明确显示原因，同时不再卡住等待链路。
     */
    autoSaveError?: string;
    /** 新文件拒绝/取消后残留清理失败原因 */
    cleanupError?: string;
    /** Pending diff ID，用于确认/拒绝（历史字段，尽量避免再依赖） */
    pendingDiffId?: string;
}

/**
 * 写入单个文件
 * @param entry 文件条目
 * @param isMultiRoot 是否是多工作区模式
 * @param toolId 工具调用 ID
 * 始终等待 diff 被处理（保存或拒绝）
 */
async function writeSingleFile(
    entry: WriteFileEntry,
    isMultiRoot: boolean,
    toolId?: string,
    abortSignal?: AbortSignal,
    approvedByToolConfirmation?: boolean,
    conversationId?: string,
    checkpointReady?: Promise<unknown>,
    lockHolder?: LockHolder
): Promise<WriteResult> {
    const { path: filePath, content: rawContent } = entry;
    // 修改原因：originalContent 已做 LF 归一化而 content 未归一化——模型给出 CRLF 内容时
    //          unchanged 判定失效（实际相同的内容被误报 modified），diff 预览出现双重换行。
    // 修改方式：content 与 originalContent 使用同一 LF 归一化规则（diff 与落盘内容保持一致）。
    // 修改目的：换行符差异不再产生虚假 diff。
    const content = normalizeLineEndingsToLF(rawContent);
    
    const { uri, workspace, error } = resolveFileToolPathWithInfo(filePath);
    if (!uri) {
        return {
            path: filePath,
            success: false,
            error: error || 'No workspace folder open'
        };
    }

    const absolutePath = uri.fsPath;
    const workspaceName = isMultiRoot ? workspace?.name : undefined;

    try {
        // 检查文件是否存在并获取原始内容
        let originalContent = '';
        let fileExists = false;
        let newFileCreatedDirectoryRoot: string | undefined;
        
        try {
            await vscode.workspace.fs.stat(uri);
            fileExists = true;
        } catch {
            // 文件不存在（或 stat 失败），原始内容为空
            fileExists = false;
            originalContent = '';
        }

        if (fileExists) {
            try {
                const contentBytes = await vscode.workspace.fs.readFile(uri);
                originalContent = normalizeLineEndingsToLF(new TextDecoder().decode(contentBytes));
            } catch (error) {
                // 修改原因：文件存在但读取失败（权限/IO 错误）之前被并入“文件不存在”分支，
                // 会把现有文件误判为新文件——下方预写空文件 writeFile('') 直接截断原文件（数据丢失）。
                // 修改方式：存在但读不到的文件直接返回错误，不再进入“新建文件”分支。
                return {
                    path: filePath,
                    success: false,
                    error: `Failed to read existing file: ${error instanceof Error ? error.message : String(error)}`
                };
            }
        }

        // 如果内容相同且文件已存在，无需修改。
        // 注意：目标是不存在的新文件且 content === '' 时不能走 unchanged 早退——
        // 空内容新建文件必须落入下方 !fileExists 分支完成创建（mkdir + 预写空文件）。
        if (fileExists && originalContent === content) {
            return {
                path: filePath,
                success: true,
                action: 'unchanged'
            };
        }

        // 如果文件不存在，需要先创建目录
        // 异步 IO：避免在 extension host 主线程上做同步磁盘操作；
        // mkdir recursive 幂等，无需先 existsSync 探测
        if (!fileExists) {
            const dirPath = path.dirname(absolutePath);
            // recursive mkdir 会返回本次创建的最高层目录；把该安全边界交给 DiffManager，
            // 拒绝/取消时只会向上删除这次新建且仍为空的目录，不触碰既有父目录。
            newFileCreatedDirectoryRoot = await fs.promises.mkdir(dirPath, { recursive: true });
            // checkpoint 写盘屏障：预写空文件也是落盘，必须在 checkpoint 就绪后执行，
            // 否则批量工具并行写盘可能先于盘点落盘（并发化后 checkpoint 记录会丢失）。
            if (checkpointReady) {
                await checkpointReady;
            }
            // PERF-CP：deferred 模式入口不持锁，预写空文件前临时获取目标路径锁，
            // 防止并行 agent 同时创建同一新文件；写盘锁由 DiffManager 在审阅期间持有。
            let prewriteLocked = false;
            if (lockHolder) {
                const lockResult = fileWriteLockManager.tryAcquire([absolutePath], lockHolder);
                if (!lockResult.acquired) {
                    return {
                        path: filePath,
                        success: false,
                        error: 'File write conflict: the target file is currently being created by another writer. Work on other parts first, then retry.'
                    };
                }
                prewriteLocked = true;
            }
            try {
                // 创建空文件以便 DiffManager 可以操作。这是确认前的既有预创建行为；
                // 拒绝/取消后 DiffManager 会删除该文件与本次创建的空父目录，清理失败会
                // 通过 cleanupError 返回给调用方。未来改用虚拟文档 diff 后可移除此预写。
                await fs.promises.writeFile(absolutePath, '', 'utf8');
            } catch (error) {
                // H2：预创建空文件失败时清理可能残留的空文件（仅当确认是本次创建的空文件，
                // 避免误删其它并发写入者刚写入的真实内容）。
                try {
                    const stat = await fs.promises.stat(absolutePath);
                    if (stat.size === 0) {
                        await fs.promises.unlink(absolutePath);
                    }
                } catch {
                    // 文件不存在或删除失败：无需/无法清理
                }
                throw error;
            } finally {
                if (prewriteLocked) {
                    fileWriteLockManager.release([absolutePath], lockHolder!);
                }
            }
        }

        // 使用 DiffManager 创建待审阅的 diff
        const diffManager = getDiffManager();
        // PERF：预热目标文档（openTextDocument），与 blocks 计算 / checkDiffGuard 并行，
        // 首次打开 diff 视图时读盘 + 语言服务初始化不再阻塞 UI。
        diffManager.prewarmDocument?.(uri);
        
        // 计算新内容的行数，作为一个完整的 block
        const newContentLines = content.split('\n').length;
        const blocks = [{
            index: 0,
            startLine: 1,
            endLine: newContentLines
        }];
        
        const pendingDiff = await diffManager.createPendingDiff(
            filePath,
            absolutePath,
            originalContent,
            content,
            blocks,  // 传递 blocks 信息以启用 CodeLens 和 inline decorations
            undefined,  // diffs
            toolId,  // 传递 toolId 以便前端跟踪
            {
                confirmedByToolConfirmation: approvedByToolConfirmation === true,
                newFile: !fileExists,
                ...(newFileCreatedDirectoryRoot ? { newFileCreatedDirectoryRoot } : {}),
                conversationId,
                checkpointReady,
                // PERF-CP：deferred 模式写盘锁持有者身份（DiffManager 审阅期间持有）
                lockHolder
            }
        );

        // 等待 diff 被处理并统一解析审阅终态。
        // 为什么改用统一 helper：write_file 与 apply_diff/insert_code/delete_code/replacePass 都依赖
        // pending diff 生命周期，终态判定（wasAccepted）、diff 内容保存与取消/拒绝文案必须五处一致，
        // 不能各自维护略有差异的判定/文案逻辑（发现 04）。
        const outcome = await resolveDiffOutcome({
            pendingDiffId: pendingDiff.id,
            abortSignal,
            originalContent,
            newContent: content,
            filePath,
            actionLabel: 'Write'
        });

        if (outcome.wasRejected) {
            // 用户显式拒绝：与取消区分，返回 status:'rejected' + 可读错误
            return {
                path: filePath,
                success: false,
                cancelled: false,
                action: fileExists ? 'modified' : 'created',
                status: 'rejected',
                error: outcome.finalDiff?.cleanupError
                    ? `${outcome.rejectedMessage}. ${outcome.finalDiff.cleanupError}`
                    : outcome.rejectedMessage,
                cleanupError: outcome.finalDiff?.cleanupError,
                diffContentId: outcome.diffContentId,
                pendingDiffId: outcome.pendingDiffId
            };
        }

        if (outcome.wasInterrupted) {
            // 用户终止/中断，视为取消
            return {
                path: filePath,
                success: false,
                cancelled: true,
                action: fileExists ? 'modified' : 'created',
                status: 'rejected',
                error: (outcome.interruptKind === 'abort'
                    ? outcome.abortMessage
                    : outcome.interruptMessage) + (outcome.finalDiff?.cleanupError
                    ? `. ${outcome.finalDiff.cleanupError}`
                    : ''),
                cleanupError: outcome.finalDiff?.cleanupError,
                diffContentId: outcome.diffContentId,
                pendingDiffId: outcome.pendingDiffId
            };
        }
        
        // 简化返回：AI 已经知道写入的内容，不需要重复返回
        return {
            path: filePath,
            success: outcome.wasAccepted,
            action: fileExists ? 'modified' : 'created',
            status: outcome.wasAccepted ? 'accepted' : 'rejected',
            error: outcome.wasAccepted
                ? undefined
                : `${outcome.autoSaveError || outcome.rejectedMessage}${outcome.finalDiff?.cleanupError
                    ? `. ${outcome.finalDiff.cleanupError}`
                    : ''}`,
            autoSaveError: outcome.autoSaveError,
            cleanupError: outcome.finalDiff?.cleanupError,
            diffContentId: outcome.diffContentId,
            pendingDiffId: outcome.pendingDiffId
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
 * 创建写入文件工具
 * 使用 DiffManager 来管理文件修改的审阅流程
 */
export function createWriteFileTool(): Tool {
    // 获取工作区信息
    const workspaces = getAllWorkspaces();
    const isMultiRoot = workspaces.length > 1;
    // 模型声明语言：zh-CN → 中文，en/ja → 英文（ja 本阶段映射到英文说明）
    const isZh = resolveLocalizationLanguage(getActualLanguage()) === 'zh-CN';
    
    // 根据工作区数量生成描述
    // 修改原因：write_file 和 apply_diff 一样是单文件 schema，模型容易把它误解为“一轮回复只能调用一次”。
    // 修改方式：在 description 中加入批量写入规则，明确多个独立新文件或重写文件应在同一轮连续输出多个 write_file 调用。
    // 修改目的：让工具声明直接引导模型批量完成已明确的多文件写入计划，避免每写一个文件就停下等待下一轮。
    let description = isZh
        ? `写入内容到一个文件。若文件不存在则创建；若文件已存在则用 content 覆盖其完整内容。执行前会展示 Diff 预览并等待用户确认。

注意：目标文件不存在时，为展示 Diff 预览会在确认前预创建空文件。拒绝或取消后会删除该文件，并删除本次新建且仍为空的父目录；若残留清理失败，工具结果会明确报告。

适用场景：
- 创建新文件
- 重写一个已有文件的完整内容

批量写入规则：
- 本工具一次调用仍然只写入一个文件；如果计划要创建或重写多个互不依赖的文件，应该在同一轮回复中连续输出多个 write_file 调用。
- 不要在完成第一个文件的 write_file 后停止等待结果，除非后续写入依赖该工具结果或需要先确认上一处写入是否成功。
- 对已经明确、互不依赖的多文件写入，应一次性输出所有 write_file 调用，以减少无意义的工具迭代。
- 错误示例：写入 A 文件后停止，等下一轮再写入 B 文件。
- 正确示例：同一轮依次输出 write_file(A)、write_file(B)、write_file(C)。

注意：path 是相对于工作区根目录的路径；content 必须是文件的完整目标内容。修改大文件时，优先考虑 apply_diff，避免整文件重写带来的误删风险。`
        : `Write content to a file. If the file does not exist, it will be created; if it already exists, its entire content will be overwritten with content. A Diff preview is shown and user confirmation is awaited before applying.

Note: when the target does not exist, an empty file is pre-created before confirmation so the Diff preview can be rendered. Rejecting or cancelling removes that file and any still-empty parent directories created for it; cleanup failures are reported in the tool result.

Use cases:
- Creating a new file
- Rewriting the full content of an existing file

Batch write rules:
- This tool still writes only one file per call; if you plan to create or rewrite multiple independent files, output multiple write_file calls in a row in the same reply.
- Do not stop and wait for results after the first write_file unless a later write depends on its result or you need to confirm whether the previous write succeeded.
- For clearly specified, independent multi-file writes, emit all write_file calls at once to reduce pointless tool iterations.
- Wrong example: writing file A then stopping and waiting for the next round to write file B.
- Correct example: output write_file(A), write_file(B), write_file(C) in sequence in the same round.

Note: path is relative to the workspace root; content must be the complete target content of the file. When modifying large files, prefer apply_diff to avoid the risk of accidental deletion from full-file rewrites.`;
    let pathDescription = isZh
        ? '文件路径，相对于当前工作区根目录。例如：docs/example.md。'
        : 'File path, relative to the current workspace root. For example: docs/example.md.';
    
    if (isMultiRoot) {
        description += isZh
            ? `\n\n多根工作区：path 必须使用 "workspace_name/path" 格式。可用工作区：${workspaces.map(w => w.name).join(', ')}。`
            : `\n\nMulti-root workspace: path must use the "workspace_name/path" format. Available workspaces: ${workspaces.map(w => w.name).join(', ')}.`;
        pathDescription = isZh
            ? `文件路径。当前是多根工作区，必须使用 "workspace_name/path" 格式。可用工作区：${workspaces.map(w => w.name).join(', ')}。`
            : `File path. This is a multi-root workspace, so it must use the "workspace_name/path" format. Available workspaces: ${workspaces.map(w => w.name).join(', ')}.`;
    }
    
    return {
        declaration: {
            name: 'write_file',
            strict: true,  // API 端强制 schema 校验
            description,
            category: 'file',
            parameters: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: pathDescription
                    },
                    content: {
                        type: 'string',
                        description: isZh
                            ? '要写入文件的完整内容。已有文件会被该内容整体覆盖。'
                            : 'The complete content to write to the file. An existing file is entirely overwritten by this content.'
                    }
                },
                required: ['path', 'content']
            }
        },
        handler: async (args, context?: ToolContext): Promise<ToolResult> => {
            const entry: WriteFileEntry = {
                path: args.path as string,
                content: args.content as string
            };

            const accessError = ensureOutsideWorkspaceAccessApproved('write_file', args, context);
            if (accessError) {
                return { success: false, error: accessError };
            }

            if (typeof entry.path !== 'string' || entry.path.trim() === '') {
                return { success: false, error: 'path is required' };
            }
            if (typeof entry.content !== 'string') {
                return { success: false, error: 'content is required' };
            }
            
            // 获取工作区信息
            const workspaces = getAllWorkspaces();
            const isMultiRoot = workspaces.length > 1;

            const results: WriteResult[] = [];
            let successCount = 0;
            let failCount = 0;
            let createdCount = 0;
            let modifiedCount = 0;
            let unchangedCount = 0;

            const result = await writeSingleFile(
                entry,
                isMultiRoot,
                context?.toolId,
                context?.abortSignal,
                context?.approvedByToolConfirmation === true,
                context?.conversationId,
                // checkpointReady 由 ToolExecutionService 注入（ToolContext 索引签名透传）
                context?.checkpointReady as Promise<unknown> | undefined,
                // PERF-CP：deferred 模式写盘锁持有者身份（ToolContext 索引签名透传）
                context?.lockHolder as LockHolder | undefined
            );
            results.push(result);

            if (result.success) {
                successCount++;
                if (result.action === 'created') createdCount++;
                else if (result.action === 'modified') modifiedCount++;
                else if (result.action === 'unchanged') unchangedCount++;
            } else {
                failCount++;
            }

            const anyCancelled = results.some(r => r.cancelled);
            const allSuccess = failCount === 0 && !anyCancelled;
            
            // 简化返回：AI 已经知道写入的内容，只需要知道结果
            return {
                success: allSuccess,
                cancelled: anyCancelled,
                data: {
                    results,
                    successCount,
                    failCount,
                    totalCount: 1
                },
                error: anyCancelled
                    ? 'Write was cancelled by user'
                    : (allSuccess ? undefined : `${failCount} file failed to write`)
            };
        }
    };
}

/**
 * 注册写入文件工具
 */
export function registerWriteFile(): Tool {
    return createWriteFileTool();
}
