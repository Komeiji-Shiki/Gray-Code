import { applyUnifiedDiffBestEffort, parseUnifiedDiff } from '../unifiedDiff';
import { applyStructuredDiffHunksBestEffort, applyLegacyDiffsBestEffort } from './apply';
import { parseLooseUnifiedPatchToLegacyDiffs, convertUnifiedHunksToLegacyDiffs } from './parse';
import type { StructuredDiffHunk, StructuredHunkPlan } from './types';
/** 原统一差异提案计算，与宿主预览和写盘分离。 */
export function prepareDiffProposal(originalContent: string, structuredHunks?: StructuredDiffHunk[], patch?: string) {
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
                        rawDiffs = structuredHunks;
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
                        rawDiffs = parsed.hunks;

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
                                results = legacyApplied.results;
                                blocks = legacyApplied.blocks;
                                newContent = legacyApplied.newContent;
                                rawDiffs = legacyDiffs;
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
                                rawDiffs = legacyDiffs;
                                fallbackMode = 'loose_hunk_search_replace';
                            } else {
                                throw e;
                            }
                        }
                    }


return { diffCount, appliedCount, failedCount, results, blocks, newContent, rawDiffs, fallbackMode, structuredHunkPlan };
}
