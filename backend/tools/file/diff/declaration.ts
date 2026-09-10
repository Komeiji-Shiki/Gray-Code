import { prepareDiffProposal } from './prepareProposal';
import { createApplyDiffDeclaration } from './createApplyDiffDeclaration';
/**
 * apply_diff 的工具声明与处理入口：参数校验、diff 应用编排、pendingDiff 审阅流程
 * 与错误文案构建（模型契约 + 前端契约，逐字保留）。
 *
 * 模块化重构第三批：从 backend/tools/file/apply_diff.ts 拆分而来，内容逐字保留。
 * createApplyDiffTool / registerApplyDiff 为对外导出（apply_diff.ts 壳 re-export）。
 */

import * as fs from 'fs';
import type { Tool, ToolDeclaration, ToolResult } from '../../types';
import { parseArgs } from '../../types';
import { getDiffManager } from '../../../core/services/diffManager';
import { resolveUriWithInfo, getAllWorkspaces, formatFileSize } from '../../utils';
import { getGlobalSettingsManager } from '../../../core/settingsContext';
import { resolveDiffOutcome } from './resolveDiffOutcome';
import type { LockHolder } from '../../../core/fileWriteLockManager';
import { applyUnifiedDiffBestEffort, parseUnifiedDiff } from '../unifiedDiff';
import {
    applyStructuredDiffHunksBestEffort,
    applyDiffToContent,
    applyLegacyDiffsBestEffort
} from './apply';
import {
    parseLooseUnifiedPatchToLegacyDiffs,
    convertUnifiedHunksToLegacyDiffs,
    countLineBreaks,
    countTextLines,
    normalizeLineEndings
} from './parse';
import type { LegacyDiffBlock, StructuredDiffHunk, StructuredHunkPlan } from './types';
import { ensureOutsideWorkspaceAccessApproved } from '../outsideWorkspaceAccess';
import { getActualLanguage } from '../../../i18n';
import { resolveLocalizationLanguage } from '../../localization/types';

// 文件大小护栏（与 read_file/search_in_files 的 5MB 上限一致）已统一收敛到 shared/fileSizeGuards
import { MAX_EDIT_FILE_BYTES } from '../../shared/fileSizeGuards';

/**
 * apply_diff 的规范化参数形状（unified 与 search_replace 两种格式的并集）。
 * hunks/patch 为 unified 格式，diffs 为旧 search/replace 格式；handler 按当前配置分流。
 */
interface ApplyDiffArgs {
    path: string;
    patch?: string;
    hunks?: StructuredDiffHunk[];
    diffs?: LegacyDiffBlock[];
}

function getApplyDiffFormat(): 'unified' | 'search_replace' {
    const settingsManager = getGlobalSettingsManager();
    const raw = settingsManager?.getApplyDiffConfig()?.format;
    return raw === 'search_replace' ? 'search_replace' : 'unified';
}

/**
 * apply_diff 声明缓存（性能优化）：declaration getter 之前每次访问都全量重建中英文长描述与 schema；
 * getAllDeclarations/getAvailableDeclarations 一次请求遍历全部工具时会反复触发。
 * 缓存键 = 语言 + diff 格式（unified/search_replace）+ 工作区名列表指纹；任一变化即失效重建。
 */
let applyDiffDeclarationCache: { key: string; declaration: ToolDeclaration } | null = null;

/**
 * 创建 apply_diff 工具
 */
export function createApplyDiffTool(): Tool {
    const buildDeclaration = (): ToolDeclaration => createApplyDiffDeclaration({ language: resolveLocalizationLanguage(getActualLanguage()) === 'zh-CN' ? 'zh-CN' : 'en', workspaces: getAllWorkspaces(), format: getApplyDiffFormat() });

    return {
        // declaration 做成 getter：根据用户设置动态返回不同描述/Schema
        // 性能优化：按「语言 + 格式 + 工作区指纹」进程级 memo，依赖未变化时直接返回缓存声明，
        // 避免每次访问都重建长描述与 schema；语言/格式/工作区列表任一变化即失效重建。
        get declaration() {
            const workspaces = getAllWorkspaces();
            const isZh = resolveLocalizationLanguage(getActualLanguage()) === 'zh-CN';
            const format = getApplyDiffFormat();
            const cacheKey = `${isZh ? 'zh' : 'en'}|${format}|${workspaces.map(w => w.name).join('\u0000')}`;
            if (applyDiffDeclarationCache && applyDiffDeclarationCache.key === cacheKey) {
                return applyDiffDeclarationCache.declaration;
            }
            const declaration = buildDeclaration();
            applyDiffDeclarationCache = { key: cacheKey, declaration };
            return declaration;
        },

        handler: async (args, context): Promise<ToolResult> => {
            // 修改原因：apply_diff 通过 resolveUriWithInfo 接受绝对路径，但入口缺少工作区外策略兜底。
            // 修改方式：与其余文件工具一致，入口处调用 ensureOutsideWorkspaceAccessApproved（写策略 deny/ask）。
            const accessError = ensureOutsideWorkspaceAccessApproved('apply_diff', args, context);
            if (accessError) {
                return { success: false, error: accessError };
            }

            const { path: filePath, patch, hunks: structuredHunks, diffs } = parseArgs<ApplyDiffArgs>(args);

            if (!filePath || typeof filePath !== 'string') {
                return { success: false, error: 'Path is required' };
            }

            const { uri } = resolveUriWithInfo(filePath);
            if (!uri) {
                return { success: false, error: 'No workspace folder open' };
            }

            const absolutePath = uri.fsPath;

            // 文件大小护栏：使用异步 stat/readFile，避免大文件 I/O 阻塞 Extension Host 与停止消息处理。
            try {
                const stat = await fs.promises.stat(absolutePath);
                if (stat.size > MAX_EDIT_FILE_BYTES) {
                    return {
                        success: false,
                        error: `File is too large (${formatFileSize(stat.size)}, limit ${formatFileSize(MAX_EDIT_FILE_BYTES)}). Editing files this large is not supported; use write_file to replace the whole file, or edit a smaller file.`
                    };
                }
            } catch (e) {
                if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') {
                    return { success: false, error: `File not found: ${filePath}` };
                }
                return { success: false, error: `Failed to stat file: ${e instanceof Error ? e.message : String(e)}` };
            }

            const format = getApplyDiffFormat();

            try {
                const originalContent = await fs.promises.readFile(absolutePath, 'utf8');
                // PERF：提前预热目标文档（openTextDocument 读盘 + 语言服务初始化），
                // 与 hunk 应用/解析并行，首次打开 diff 视图时不再卡顿。
                getDiffManager()?.prewarmDocument?.(uri);

                // ========== 统一 diff 模式 ==========
                if (format === 'unified') {
                    if ((!structuredHunks || !Array.isArray(structuredHunks) || structuredHunks.length === 0) && (!patch || typeof patch !== 'string')) {
                        return {
                            success: false,
                            error: 'apply_diff 当前推荐使用结构化 hunks。请提供 { path, hunks: [{ oldContent, newContent, startLine? }] }；旧 patch 字符串仅作为兼容 fallback。'
                        };
                    }

                    const { diffCount, appliedCount, failedCount, results, blocks, newContent, rawDiffs, fallbackMode, structuredHunkPlan } = prepareDiffProposal(originalContent, structuredHunks, patch);

                    // 一个都没应用上：直接失败返回（不创建 pending diff）
                    if (appliedCount === 0) {
                        const firstError = results.find(r => !r.success)?.error || 'All hunks failed';
                        return {
                            success: false,
                            error: `Failed to apply any hunks: ${firstError}`,
                            data: {
                                file: filePath,
                                message: `Failed to apply any hunks to ${filePath}.`,
                                status: 'rejected',
                                diffCount,
                                totalCount: diffCount,
                                appliedCount: 0,
                                failedCount: diffCount,
                                results,
                                fallbackMode
                            }
                        };
                    }

                    // 创建待审阅的 diff
                    const diffManager = getDiffManager();

                    const pendingDiff = await diffManager.createPendingDiff(
                        filePath,
                        absolutePath,
                        originalContent,
                        newContent,
                        blocks,
                        rawDiffs,
                        context?.toolId,
                        {
                            confirmedByToolConfirmation: context?.approvedByToolConfirmation === true,
                            conversationId: context?.conversationId,
                            // fast path 产出的计划：块级拒绝/最终内容重放时复用，避免重复扫描；
                            // 顺序路径（含缩进容错）不产出计划，此处为 undefined，重放走重新扫描。
                            structuredHunkPlan,
                            // checkpoint 写盘屏障由 ToolExecutionService 注入（ToolContext 索引签名透传）
                            checkpointReady: context?.checkpointReady as Promise<unknown> | undefined,
                            // PERF-CP：deferred 模式写盘锁持有者身份（DiffManager 审阅期间持有）
                            lockHolder: context?.lockHolder as LockHolder | undefined
                        }
                    );

                    // 等待 diff 被处理（保存、拒绝、abort 或用户新请求中断），并统一解析审阅终态。
                    // 为什么改：终态判定/文案/保存与其余四个写类工具共用 resolveDiffOutcome（发现 04），
                    // wasAccepted 语义（含 finalDiff.status 复查）五处一致。
                    const outcome = await resolveDiffOutcome({
                        pendingDiffId: pendingDiff.id,
                        abortSignal: context?.abortSignal,
                        originalContent,
                        newContent,
                        filePath,
                        useDeferredSave: true,
                        actionLabel: 'Diff'
                    });
                    // 用户“拒绝”（rejected）与“中断/取消”（abort/user）分开处理：
                    // - rejected：用户在 diff 审阅 UI 里显式点了拒绝 → status:'rejected' + 可读错误（不标记 cancelled）
                    // - abort/user：请求被取消（AbortSignal / 新消息中断）→ cancelled: true
                    const wasRejected = outcome.wasRejected;
                    const wasInterrupted = outcome.wasInterrupted;

                    // 获取最终状态
                    const finalDiff = outcome.finalDiff;
                    const wasAccepted = outcome.wasAccepted;

                    // 用户可能在保存前编辑了内容（手动保存/手动接受时）
                    const userEditedContent = finalDiff?.userEditedContent;
                    const diffContentId = outcome.diffContentId;

                    if (wasRejected) {
                        return {
                            success: false,
                            cancelled: false,
                            error: outcome.rejectedMessage,
                            data: {
                                file: filePath,
                                message: `Diff for ${filePath} was rejected by user.`,
                                status: 'rejected',
                                diffCount,
                                totalCount: diffCount,
                                appliedCount,
                                failedCount,
                                results,
                                diffContentId,
                                diffGuardWarning: pendingDiff.diffGuardWarning,
                                diffGuardDeletePercent: pendingDiff.diffGuardDeletePercent,
                                fallbackMode
                            }
                        };
                    }

                    if (wasInterrupted) {
                        return {
                            success: false,
                            cancelled: true,
                            // apply_diff 的历史文案对 abort/user 统一使用“取消”表述，保留该工具契约
                            error: outcome.abortMessage,
                            data: {
                                file: filePath,
                                message: `Diff for ${filePath} was cancelled by user.`,
                                status: 'rejected',
                                diffCount,
                                totalCount: diffCount,
                                appliedCount,
                                failedCount,
                                results,
                                diffContentId,
                                diffGuardWarning: pendingDiff.diffGuardWarning,
                                diffGuardDeletePercent: pendingDiff.diffGuardDeletePercent,
                                fallbackMode
                            }
                        };
                    }

                    const autoSaveError = outcome.autoSaveError;
                    const rejectedBlockIndices = finalDiff?.rejectedBlockIndices ?? [];
                    // 部分接受：用户拒绝了部分块（或手动编辑内容），不能把初始全量匹配统计当作"全部接受"返回。
                    // 实际接受数 = 初始成功块 - 被拒绝块；实际失败数 = 初始失败块 + 被拒绝块。
                    const isPartial = wasAccepted && (!!finalDiff?.partial || rejectedBlockIndices.length > 0);
                    const finalAppliedCount = isPartial
                        ? Math.max(0, appliedCount - rejectedBlockIndices.length)
                        : appliedCount;
                    const finalFailedCount = isPartial ? failedCount + rejectedBlockIndices.length : failedCount;
                    const message = wasAccepted
                        ? isPartial
                            ? rejectedBlockIndices.length > 0
                              ? `Partially applied hunks to ${filePath}: ${finalAppliedCount} succeeded, ${rejectedBlockIndices.length} rejected, ${failedCount} skipped (unmatched). Saved successfully.`
                              : `Applied hunks to ${filePath}: ${finalAppliedCount} succeeded (content edited by user), ${failedCount} skipped (unmatched). Saved successfully.`
                            : finalFailedCount > 0
                              ? `Applied hunks to ${filePath}: ${finalAppliedCount} succeeded, ${finalFailedCount} failed (unmatched hunks skipped). Saved successfully.`
                              : `Diff applied and saved to ${filePath}`
                        : autoSaveError
                          ? `Auto-save failed for ${filePath}: ${autoSaveError}`
                          : finalDiff?.status === 'rejected'
                          ? `Diff was explicitly rejected by the user for ${filePath}. No changes were saved.`
                          : `Diff was not accepted for ${filePath}. No changes were saved.`;

                    return {
                        success: wasAccepted,
                        error: wasAccepted ? undefined : autoSaveError,
                        data: {
                            file: filePath,
                            message,
                            status: wasAccepted ? (isPartial ? 'partial' : 'accepted') : 'rejected',
                            partial: isPartial,
                            rejectedBlockIndices,
                            diffCount,
                            totalCount: diffCount,
                            appliedCount: finalAppliedCount,
                            failedCount: finalFailedCount,
                            results,
                            userEditedContent,
                            diffContentId,
                            fallbackMode,
                            diffGuardWarning: pendingDiff.diffGuardWarning,
                            diffGuardDeletePercent: pendingDiff.diffGuardDeletePercent,
                            autoSaveError,
                            pendingDiffId: pendingDiff.id
                        }
                    };
                }

                // ========== 旧 search/replace 模式 ==========
                if (!diffs || !Array.isArray(diffs) || diffs.length === 0) {
                    return {
                        success: false,
                        error: 'apply_diff is configured to use legacy diffs. Please provide { diffs: [{search, replace, start_line?}, ...] }.'
                    };
                }

                let currentContent = originalContent;
                // start_line 相对原始文件：前序 hunk 应用改变了行数后，后续 hunk 必须累计偏移
                let lineDelta = 0;

                const diffResults: Array<{
                    index: number;
                    success: boolean;
                    error?: string;
                    matchedLine?: number;
                }> = [];

                for (let i = 0; i < diffs.length; i++) {
                    const diff = diffs[i];

                    if (!diff.search || diff.replace === undefined) {
                        diffResults.push({
                            index: i,
                            success: false,
                            error: `Diff at index ${i} is missing 'search' or 'replace' field`
                        });
                        continue;
                    }

                    const adjustedStartLine = typeof diff.start_line === 'number' && diff.start_line > 0
                        ? diff.start_line + lineDelta
                        : diff.start_line;
                    const result = applyDiffToContent(currentContent, diff.search, diff.replace, adjustedStartLine);
                    diffResults.push({
                        index: i,
                        success: result.success,
                        error: result.error,
                        matchedLine: result.matchedLine
                    });

                    if (result.success) {
                        currentContent = result.result;
                        // 累计行数变化：replace 行数 - search 行数
                        lineDelta += countLineBreaks(normalizeLineEndings(diff.replace)) - countLineBreaks(normalizeLineEndings(diff.search));
                    }
                }

                const appliedCount = diffResults.filter(r => r.success).length;
                const failedCount = diffResults.length - appliedCount;

                // 如果没有任何一个 diff 成功应用，则返回失败
                if (appliedCount === 0 && diffs.length > 0) {
                    const firstError = diffResults.find(r => !r.success)?.error || 'All diffs failed';
                    return {
                        success: false,
                        error: `Failed to apply any diffs: ${firstError}`,
                        data: {
                            file: filePath,
                            message: `Failed to apply any diffs to ${filePath}.`,
                            results: diffResults,
                            appliedCount: 0,
                            totalCount: diffs.length,
                            failedCount: diffs.length
                        }
                    };
                }

                const diffManager = getDiffManager();

                const blocks: Array<{ index: number; startLine: number; endLine: number }> = [];
                for (let i = 0; i < diffs.length; i++) {
                    const res = diffResults[i];
                    if (res.success && res.matchedLine !== undefined) {
                        // 修改原因：旧实现用未归一化的 replace 行数计算 endLine，CRLF 内容会多算。
                        // 修改方式：与结构化路径一致，改用 countTextLines(normalizeLineEndings(...))。
                        const replaceLines = countTextLines(normalizeLineEndings(diffs[i].replace));
                        blocks.push({
                            index: i,
                            startLine: res.matchedLine,
                            // 空 replace 时行数为 0，endLine 会退化为 startLine - 1；用 Math.max 兜底为 startLine
                            endLine: res.matchedLine + Math.max(replaceLines, 1) - 1
                        });
                    }
                }

                const pendingDiff = await diffManager.createPendingDiff(
                    filePath,
                    absolutePath,
                    originalContent,
                    currentContent,
                    blocks,
                    diffs,
                    context?.toolId,
                    {
                        confirmedByToolConfirmation: context?.approvedByToolConfirmation === true,
                        conversationId: context?.conversationId,
                        // legacy search/replace 路径无结构化计划；checkpoint 屏障与结构化路径一致
                        checkpointReady: context?.checkpointReady as Promise<unknown> | undefined,
                        // PERF-CP：deferred 模式写盘锁持有者身份（DiffManager 审阅期间持有）
                        lockHolder: context?.lockHolder as LockHolder | undefined
                    }
                );

                // 等待 diff 被处理（保存、拒绝、abort 或用户新请求中断），并统一解析审阅终态。
                // 为什么旧 search/replace 路径也要改：它和结构化 hunks 一样会创建 pending diff，
                // 终态判定/文案/保存与其余四个写类工具共用 resolveDiffOutcome（发现 04）。
                const outcome = await resolveDiffOutcome({
                    pendingDiffId: pendingDiff.id,
                    abortSignal: context?.abortSignal,
                    originalContent,
                    newContent: currentContent,
                    filePath,
                    useDeferredSave: true,
                    actionLabel: 'Diff'
                });
                // 用户“拒绝”（rejected）与“中断/取消”（abort/user）分开处理（与 unified 路径一致）：
                // rejected → status:'rejected' + 可读错误（不标记 cancelled）；abort/user → cancelled: true
                const wasRejected = outcome.wasRejected;
                const wasInterrupted = outcome.wasInterrupted;

                const finalDiff = outcome.finalDiff;
                const wasAccepted = outcome.wasAccepted;
                const userEditedContent = finalDiff?.userEditedContent;
                const diffContentId = outcome.diffContentId;

                if (wasRejected) {
                    return {
                        success: false,
                        cancelled: false,
                        error: outcome.rejectedMessage,
                        data: {
                            file: filePath,
                            message: `Diff for ${filePath} was rejected by user.`,
                            status: 'rejected',
                            diffCount: diffs.length,
                            appliedCount,
                            failedCount,
                            results: diffResults,
                            diffContentId,
                            diffGuardWarning: pendingDiff.diffGuardWarning,
                            diffGuardDeletePercent: pendingDiff.diffGuardDeletePercent
                        }
                    };
                }

                if (wasInterrupted) {
                    return {
                        success: false,
                        cancelled: true,
                        // apply_diff 的历史文案对 abort/user 统一使用“取消”表述，保留该工具契约
                        error: outcome.abortMessage,
                        data: {
                            file: filePath,
                            message: `Diff for ${filePath} was cancelled by user.`,
                            status: 'rejected',
                            diffCount: diffs.length,
                            appliedCount,
                            failedCount,
                            results: diffResults,
                            diffContentId,
                            diffGuardWarning: pendingDiff.diffGuardWarning,
                            diffGuardDeletePercent: pendingDiff.diffGuardDeletePercent
                        }
                    };
                }

                const autoSaveError = outcome.autoSaveError;
                const rejectedBlockIndices = finalDiff?.rejectedBlockIndices ?? [];
                // 部分接受：用户拒绝了部分块（或手动编辑内容），返回 partial 状态与修正后的计数。
                const isPartial = wasAccepted && (!!finalDiff?.partial || rejectedBlockIndices.length > 0);
                const finalAppliedCount = isPartial
                    ? Math.max(0, appliedCount - rejectedBlockIndices.length)
                    : appliedCount;
                const finalFailedCount = isPartial ? failedCount + rejectedBlockIndices.length : failedCount;
                let message: string;
                if (wasAccepted) {
                    if (isPartial) {
                        message = rejectedBlockIndices.length > 0
                            ? `Partially applied diffs to ${filePath}: ${finalAppliedCount} succeeded, ${rejectedBlockIndices.length} rejected, ${failedCount} skipped (unmatched). Saved successfully.`
                            : `Applied diffs to ${filePath}: ${finalAppliedCount} succeeded (content edited by user), ${failedCount} skipped (unmatched). Saved successfully.`;
                    } else if (finalFailedCount > 0) {
                        message = `Applied diffs to ${filePath}: ${finalAppliedCount} succeeded, ${finalFailedCount} failed (unmatched diffs skipped). Saved successfully.`;
                    } else {
                        message = `Diff applied and saved to ${filePath}`;
                    }
                } else {
                    message = autoSaveError
                        ? `Auto-save failed for ${filePath}: ${autoSaveError}`
                        : finalDiff?.status === 'rejected'
                        ? `Diff was explicitly rejected by the user for ${filePath}. No changes were saved.`
                        : `Diff was not accepted for ${filePath}. No changes were saved.`;
                }

                return {
                    success: wasAccepted,
                    error: wasAccepted ? undefined : autoSaveError,
                    data: {
                        file: filePath,
                        message,
                        status: wasAccepted ? (isPartial ? 'partial' : 'accepted') : 'rejected',
                        partial: isPartial,
                        rejectedBlockIndices,
                        diffCount: diffs.length,
                        appliedCount: finalAppliedCount,
                        failedCount: finalFailedCount,
                        results: diffResults,
                        userEditedContent,
                        diffContentId,
                        diffGuardWarning: pendingDiff.diffGuardWarning,
                        diffGuardDeletePercent: pendingDiff.diffGuardDeletePercent,
                        autoSaveError,
                        pendingDiffId: pendingDiff.id
                    }
                };
            } catch (error) {
                return {
                    success: false,
                    error: `Failed to apply diff: ${error instanceof Error ? error.message : String(error)}`
                };
            }
        }
    };
}

/**
 * 注册 apply_diff 工具
 */
export function registerApplyDiff(): Tool {
    return createApplyDiffTool();
}
