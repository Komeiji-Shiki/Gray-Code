/**
 * apply_diff 的工具声明与处理入口：参数校验、diff 应用编排、pendingDiff 审阅流程
 * 与错误文案构建（模型契约 + 前端契约，逐字保留）。
 *
 * 模块化重构第三批：从 backend/tools/file/apply_diff.ts 拆分而来，内容逐字保留。
 * createApplyDiffTool / registerApplyDiff 为对外导出（apply_diff.ts 壳 re-export）。
 */

import * as fs from 'fs';
import type { Tool, ToolDeclaration, ToolResult } from '../../types';
import { getDiffManager } from '../../../core/services/diffManager';
import { resolveUriWithInfo, getAllWorkspaces, formatFileSize } from '../../utils';
import { getDiffStorageManager } from '../../../modules/conversation';
import { getGlobalSettingsManager } from '../../../core/settingsContext';
import type { LockHolder } from '../../../core/fileWriteLockManager';
import { applyUnifiedDiffBestEffort, parseUnifiedDiff, type UnifiedDiffHunk } from '../unifiedDiff';
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

// 文件大小护栏（与 read_file/search_in_files 的 5MB 上限一致）：
// 超大文件（如打包产物）全量 readFileSync 会阻塞 extension host 并全量读入内存。
const MAX_EDIT_FILE_BYTES = 5 * 1024 * 1024;

function getApplyDiffFormat(): 'unified' | 'search_replace' {
    const settingsManager = getGlobalSettingsManager();
    const raw = settingsManager?.getApplyDiffConfig()?.format;
    return raw === 'search_replace' ? 'search_replace' : 'unified';
}

/**
 * 创建 apply_diff 工具
 */
export function createApplyDiffTool(): Tool {
    const buildDeclaration = (): ToolDeclaration => {
        // 获取工作区信息
        const workspaces = getAllWorkspaces();
        const isMultiRoot = workspaces.length > 1;

        // 根据工作区数量生成描述
        let pathDescription = '文件路径，相对于当前工作区根目录。例如：src/example.ts。';
        let descriptionSuffix = '';

        if (isMultiRoot) {
            pathDescription = `文件路径，必须使用 "workspace_name/path" 格式。可用工作区：${workspaces.map(w => w.name).join(', ')}`;
            descriptionSuffix = `\n\n多根工作区：必须使用 "workspace_name/path" 格式。可用工作区：${workspaces.map(w => w.name).join(', ')}`;
        }

        const format = getApplyDiffFormat();

        if (format === 'search_replace') {
            // 修改原因：旧版 search/replace 声明只强调“单次调用单文件”，容易让模型误以为每改一个文件后必须停止等待。
            // 修改方式：在工具 description 中加入批量修改规则，明确“一个工具调用单文件”和“一轮回复多个工具调用”并不冲突。
            // 修改目的：鼓励模型在多文件修改计划已经明确且互不依赖时，同一轮连续输出多个 apply_diff 调用，减少无意义的工具迭代。
            return {
                name: 'apply_diff',
                category: 'file',
                strict: true,  // API 端强制 schema 校验
                description: `对单个文件应用旧版 search/replace 差异，并打开待确认 diff 预览。

参数：
- path：目标文件路径。
- diffs：要应用的旧版差异数组。

每个 diff 对象包含：
- search：要查找的原始内容，必须和文件内容完全一致。
- replace：替换后的目标内容。
- start_line：可选，1-based 起始行号，用于重复内容定位。

规则：
- search 必须精确匹配，包括空格、缩进和换行。
- diffs 会按数组顺序应用。
- 某个 diff 失败时，该 diff 不会生效。

批量修改规则：
- 本工具一次调用仍然只修改一个文件；如果计划要修改多个互不依赖的文件，应该在同一轮回复中连续输出多个 apply_diff 调用。
- 不要在完成第一个文件的 apply_diff 后停止等待结果，除非后续修改依赖该工具结果或需要先确认上一处修改是否成功。
- 对已经明确、互不依赖的多文件修改，应一次性输出所有 apply_diff 调用，以减少无意义的工具迭代。
- 错误示例：修改 A 文件后停止，等下一轮再修改 B 文件。
- 正确示例：同一轮依次输出 apply_diff(A)、apply_diff(B)、apply_diff(C)。

${descriptionSuffix}`,

                parameters: {
                    type: 'object',
                    properties: {
                        path: {
                            type: 'string',
                            description: pathDescription
                        },
                        diffs: {
                            type: 'array',
                            description: '旧版 diff 对象数组。即使只有一个 diff，也必须使用数组。',
                            items: {
                                type: 'object',
                                properties: {
                                    search: {
                                        type: 'string',
                                        description: '要查找的原始内容，必须精确匹配。'
                                    },
                                    replace: {
                                        type: 'string',
                                        description: '替换后的目标内容。'
                                    },
                                    start_line: {
                                        type: 'number',
                                        description: '可选，1-based 起始行号，用于重复内容定位。'
                                    }
                                },
                                required: ['search', 'replace']
                            }
                        }
                    },
                    required: ['path', 'diffs']
                }
            };
        }

        // 为什么要把默认声明改为结构化 hunks：旧 patch 字符串让模型混淆 JSON 转义和 unified diff 文本，双引号、反斜杠等内容容易写错。
        // 怎么改：主推 hunks[{oldContent,newContent,startLine?}]，同时保留 patch 字符串作为历史兼容字段。
        // 目的：让 newContent 像 write_file.content 一样表示最终内容，并保留一次调用处理多个连续片段的能力。
        // 修改原因：模型会把“apply_diff 一次调用只处理一个文件”误读成“一轮只能调用一次 apply_diff”。
        // 修改方式：在默认结构化 hunk 声明中补充批量修改规则，明确多文件计划应在同一轮连续输出多个 apply_diff 调用。
        // 修改目的：让工具说明本身承担行为引导，减少用户反复用自然语言纠正模型每次只改一个文件的问题。
        return {
            name: 'apply_diff',
            category: 'file',
            strict: true,  // API 端强制 schema 校验
            description: `对单个文件应用一个或多个结构化内容替换，并打开待确认 diff 预览。

推荐输入格式：
- path：目标文件路径。
- hunks：结构化修改数组。每个 hunk 表示一个连续片段替换。
- hunks[].oldContent：文件中要被替换的原始内容，必须和文件内容完全一致。
- hunks[].newContent：替换后的目标内容。按 JSON 字符串规则填写；工具收到后会作为最终文件内容使用，不要加 + 前缀，也不要为了 diff 再额外转义双引号。
- hunks[].startLine：可选，1-based，基于修改前原文件的行号。只有 oldContent 在当前文件中重复出现时才会用于定位；oldContent 唯一匹配时会忽略 startLine，避免陈旧行号导致失败。

规则：
- 一次调用只修改一个文件；多个不连续片段放在 hunks 数组中。
- hunks 应按原文件中的出现顺序排列，这样前面修改造成的行号偏移可以被工具正确维护。
- 不能让两个 hunk 修改同一段或互相覆盖的文本；如果要改同一个区块，应该合并成一个 hunk。
- oldContent 必须能匹配；如果 oldContent 重复出现，请提供 startLine 或增加上下文让它唯一。
- patch 字段仅作为兼容旧 unified diff hunk 字符串的 fallback；新调用优先使用 hunks。

批量修改规则：
- 本工具一次调用仍然只修改一个文件；如果计划要修改多个互不依赖的文件，应该在同一轮回复中连续输出多个 apply_diff 调用。
- 不要在完成第一个文件的 apply_diff 后停止等待结果，除非后续修改依赖该工具结果或需要先确认上一处修改是否成功。
- 对已经明确、互不依赖的多文件修改，应一次性输出所有 apply_diff 调用，以减少无意义的工具迭代。
- 错误示例：修改 A 文件后停止，等下一轮再修改 B 文件。
- 正确示例：同一轮依次输出 apply_diff(A)、apply_diff(B)、apply_diff(C)。

示例：
{
  "path": "src/example.ts",
  "hunks": [
    {
      "oldContent": "content: old;",
      "newContent": "content: \"\";",
      "startLine": 12
    }
  ]
}
${descriptionSuffix}`,

            parameters: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: pathDescription
                    },
                    hunks: {
                        type: 'array',
                        description: '推荐格式。结构化 hunk 数组；每个 hunk 使用 oldContent/newContent 表示一次连续内容替换。',
                        items: {
                            type: 'object',
                            properties: {
                                oldContent: {
                                    type: 'string',
                                    description: '文件中要被替换的原始内容，必须精确匹配。'
                                },
                                newContent: {
                                    type: 'string',
                                    description: '替换后的目标内容。按 JSON 字符串规则填写；工具收到后作为最终文件内容使用。'
                                },
                                startLine: {
                                    type: 'number',
                                    description: '可选，1-based，基于修改前原文件的行号。仅当 oldContent 重复出现时用于定位。'
                                }
                            },
                            required: ['oldContent', 'newContent']
                        }
                    },
                    patch: {
                        type: 'string',
                        description: "兼容字段。旧 unified diff hunks 文本；新调用请优先使用 hunks。"
                    }
                },
                required: ['path']
            }
        };
    };

    return {
        // declaration 做成 getter：根据用户设置动态返回不同描述/Schema
        get declaration() {
            return buildDeclaration();
        },

        handler: async (args, context): Promise<ToolResult> => {
            // 修改原因：apply_diff 通过 resolveUriWithInfo 接受绝对路径，但入口缺少工作区外策略兜底。
            // 修改方式：与其余文件工具一致，入口处调用 ensureOutsideWorkspaceAccessApproved（写策略 deny/ask）。
            const accessError = ensureOutsideWorkspaceAccessApproved('apply_diff', args, context);
            if (accessError) {
                return { success: false, error: accessError };
            }

            const filePath = args.path as string;
            const patch = args.patch as string | undefined;
            const structuredHunks = args.hunks as StructuredDiffHunk[] | undefined;
            const diffs = args.diffs as LegacyDiffBlock[] | undefined;

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

                // ========== 统一 diff 模式 ==========
                if (format === 'unified') {
                    if ((!structuredHunks || !Array.isArray(structuredHunks) || structuredHunks.length === 0) && (!patch || typeof patch !== 'string')) {
                        return {
                            success: false,
                            error: 'apply_diff 当前推荐使用结构化 hunks。请提供 { path, hunks: [{ oldContent, newContent, startLine? }] }；旧 patch 字符串仅作为兼容 fallback。'
                        };
                    }

                    let diffCount = 0;
                    let appliedCount = 0;
                    let failedCount = 0;
                    let results: Array<{ index: number; success: boolean; error?: string; startLine?: number; endLine?: number }> = [];
                    let blocks: Array<{ index: number; startLine: number; endLine: number }> = [];
                    let newContent = originalContent;
                    let rawDiffs: any[] = [];
                    let fallbackMode: 'none' | 'structured_hunks' | 'loose_hunk_search_replace' | 'unified_hunks_search_replace' = 'none';
                    // fast path 产出的结构化 hunk 计划：随 createPendingDiff 缓存，供块级拒绝/最终内容重放复用
                    let structuredHunkPlan: StructuredHunkPlan | undefined;

                    // 为什么优先处理 hunks：新格式把 newContent 当最终内容字段，避免旧 patch 字符串里的反斜杠/双引号被模型误写。
                    // 怎么改：当 hunks 存在时不再解析 patch；按结构化规则应用，并把原始 hunks 存入 DiffManager 以支持块级接受/拒绝重放。
                    // 目的：兼容历史 patch 的同时，让新的 AI 调用路径默认走更稳定的结构化参数。
                    if (structuredHunks && Array.isArray(structuredHunks) && structuredHunks.length > 0) {
                        const applied = applyStructuredDiffHunksBestEffort(originalContent, structuredHunks);

                        diffCount = structuredHunks.length;
                        appliedCount = applied.appliedCount;
                        failedCount = applied.failedCount;
                        results = applied.results;
                        blocks = applied.blocks;
                        newContent = applied.newContent;
                        rawDiffs = structuredHunks as any[];
                        fallbackMode = 'structured_hunks';
                        // 顺序路径（含缩进容错）不产出计划；fast path 成功时缓存计划供重放复用
                        structuredHunkPlan = applied.plan;
                    } else {
                        try {
                            if (!patch || typeof patch !== 'string') {
                                throw new Error('Missing patch fallback input.');
                            }
                        const parsed = parseUnifiedDiff(patch);
                        const applied = applyUnifiedDiffBestEffort(originalContent, parsed);

                        diffCount = parsed.hunks.length;
                        appliedCount = applied.results.filter(r => r.ok).length;
                        failedCount = diffCount - appliedCount;

                        results = applied.results.map(r => ({
                            index: r.index,
                            success: r.ok,
                            error: r.error,
                            startLine: r.startLine,
                            endLine: r.endLine
                        }));

                        blocks = applied.appliedHunks.map(h => ({
                            index: h.index,
                            startLine: h.startLine,
                            endLine: h.endLine
                        }));

                        newContent = applied.newContent;
                        rawDiffs = parsed.hunks as UnifiedDiffHunk[] as any[];

                        // 若有 hunk 因行号/上下文不匹配等原因失败，尝试兜底：将 hunks 退化为全局精确 search/replace。
                        // 说明：
                        // - 仅在兜底能“额外应用更多块”时采用，避免降低标准 unified diff 的成功率。
                        // - 兜底不会在多处匹配时强行选择（会失败并返回 candidateLines）。
                        if (appliedCount < diffCount) {
                            const legacyDiffs = convertUnifiedHunksToLegacyDiffs(parsed.hunks);
                            const legacyApplied = applyLegacyDiffsBestEffort(originalContent, legacyDiffs, {
                                errorSuffix:
                                    '(unified fallback: applied via global exact search/replace; if ambiguous, add more context or provide start_line)'
                            });

                            if (legacyApplied.appliedCount > appliedCount) {
                                diffCount = legacyDiffs.length;
                                appliedCount = legacyApplied.appliedCount;
                                failedCount = legacyApplied.failedCount;
                                results = legacyApplied.results as any;
                                blocks = legacyApplied.blocks;
                                newContent = legacyApplied.newContent;
                                rawDiffs = legacyDiffs as any[];
                                fallbackMode = 'unified_hunks_search_replace';
                            }
                        }
                        } catch (e) {
                            const msg = e instanceof Error ? e.message : String(e);

                            // “裸 @@”兜底：将 patch 退化为 legacy search/replace diffs（全局精确匹配）。
                            // 触发条件放宽：解析失败但 patch 中含 @@ 行即尝试兜底（错误附解析原因），
                            // 避免只认 'Invalid hunk header' 前缀而漏掉其它解析错误（如行号越界/上下文不匹配）。
                            const patchText = patch || '';
                            if (patchText.split('\n').some(line => line.startsWith('@@'))) {
                                const legacyDiffs = parseLooseUnifiedPatchToLegacyDiffs(patchText);
                                const looseApplied = applyLegacyDiffsBestEffort(originalContent, legacyDiffs, {
                                    errorSuffix:
                                        `(loose @@ fallback after parse error: ${msg}; ensure the search block is unique, or use a full @@ -a,b +c,d @@ header)`
                                });

                                diffCount = legacyDiffs.length;
                                appliedCount = looseApplied.appliedCount;
                                failedCount = looseApplied.failedCount;
                                results = looseApplied.results;
                                blocks = looseApplied.blocks;
                                newContent = looseApplied.newContent;
                                rawDiffs = legacyDiffs as any[];
                                fallbackMode = 'loose_hunk_search_replace';
                            } else {
                                throw e;
                            }
                        }
                    }

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

                    // 等待 diff 被处理（保存、拒绝、abort 或用户新请求中断）。
                    // 为什么改用 DiffManager 统一等待：apply_diff 之前只监听状态变化，用户中断会清掉自动保存定时器但不一定产生新状态事件，导致偶发卡住。
                    // 怎么改：统一等待方法同时监听状态事件、轮询中断标记，并处理 AbortSignal。
                    // 目的：让结构化 hunks 与旧 patch 路径共享可靠的 diff 生命周期收敛逻辑。
                    const interruptReason = await diffManager.waitForDiffResolution(pendingDiff.id, context?.abortSignal);
                    // 用户“拒绝”（rejected）与“中断/取消”（abort/user）分开处理：
                    // - rejected：用户在 diff 审阅 UI 里显式点了拒绝 → status:'rejected' + 可读错误（不标记 cancelled）
                    // - abort/user：请求被取消（AbortSignal / 新消息中断）→ cancelled: true
                    const wasRejected = interruptReason === 'rejected';
                    const wasInterrupted = interruptReason === 'abort' || interruptReason === 'user';

                    // 获取最终状态
                    const finalDiff = diffManager.getDiff(pendingDiff.id);
                    const wasAccepted = !wasInterrupted && !wasRejected && (!finalDiff || finalDiff.status === 'accepted');

                    // 用户可能在保存前编辑了内容（手动保存/手动接受时）
                    const userEditedContent = finalDiff?.userEditedContent;

                    // 尝试将大内容保存到 DiffStorageManager
                    const diffStorageManager = getDiffStorageManager();
                    let diffContentId: string | undefined;

                    if (diffStorageManager) {
                        try {
                            const diffRef = diffStorageManager.saveGlobalDiffDeferred({
                                originalContent,
                                newContent,
                                filePath
                            });
                            diffContentId = diffRef.diffId;
                        } catch (e) {
                            console.warn('Failed to save diff content to storage:', e);
                        }
                    }

                    if (wasRejected) {
                        return {
                            success: false,
                            cancelled: false,
                            error: 'Diff was rejected by user',
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
                            error: 'Diff was cancelled by user',
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

                    const autoSaveError = finalDiff?.autoSaveError;
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
                    diffs as any[],
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

                // 等待 diff 被处理（保存、拒绝、abort 或用户新请求中断）。
                // 为什么旧 search/replace 路径也要改：它和结构化 hunks 一样会创建 pending diff，不能保留另一套可能遗漏中断的等待逻辑。
                // 怎么改：复用 DiffManager.waitForDiffResolution，统一事件监听、轮询兜底和 abort 清理。
                // 目的：让 apply_diff 的所有输入格式在自动保存和取消场景下表现一致。
                const interruptReason = await diffManager.waitForDiffResolution(pendingDiff.id, context?.abortSignal);
                // 用户“拒绝”（rejected）与“中断/取消”（abort/user）分开处理（与 unified 路径一致）：
                // rejected → status:'rejected' + 可读错误（不标记 cancelled）；abort/user → cancelled: true
                const wasRejected = interruptReason === 'rejected';
                const wasInterrupted = interruptReason === 'abort' || interruptReason === 'user';

                const finalDiff = diffManager.getDiff(pendingDiff.id);
                const wasAccepted = !wasInterrupted && !wasRejected && (!finalDiff || finalDiff.status === 'accepted');
                const userEditedContent = finalDiff?.userEditedContent;

                const diffStorageManager = getDiffStorageManager();
                let diffContentId: string | undefined;

                if (diffStorageManager) {
                    try {
                        const diffRef = diffStorageManager.saveGlobalDiffDeferred({
                            originalContent,
                            newContent: currentContent,
                            filePath
                        });
                        diffContentId = diffRef.diffId;
                    } catch (e) {
                        console.warn('Failed to save diff content to storage:', e);
                    }
                }

                if (wasRejected) {
                    return {
                        success: false,
                        cancelled: false,
                        error: 'Diff was rejected by user',
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
                        error: 'Diff was cancelled by user',
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

                const autoSaveError = finalDiff?.autoSaveError;
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
