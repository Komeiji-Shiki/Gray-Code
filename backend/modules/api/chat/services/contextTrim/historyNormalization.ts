/**
 * 裁剪起点归一化与历史后缀完整性预计算（纯函数模块，从 ContextTrimService 抽离）。
 *
 * - computeValidSuffixMap：一次从右向左扫描，预计算每个下标 i 的
 *   「切片 fullHistory.slice(i) 是否通过 validateHistoryIntegrity」判定。
 * - normalizeTrimStartIndex：把候选裁剪起点归一化到合法回合边界，并保证
 *   切点之后的 history 通过完整性校验（无重复 call/response id、无孤儿 response）。
 */

import type { Content } from '../../../../conversation/types';
import { isRealUserMessage } from '../../../../conversation/helpers';
import { validateHistoryIntegrity, normalizeCallId } from '../../../../channel/HistoryIntegrityValidator';

export interface NormalizedTrimStartResult {
    startIndex: number;
    valid: boolean;
    reason: 'unchanged' | 'clamped_minimum' | 'moved_to_next_round' | 'moved_to_current_round' | 'advanced_to_valid_round' | 'no_legal_round_boundary';
    issueKind?: string;
    issueCallId?: string;
}

/**
 * 上下文起点允许落在真实用户消息或总结消息上；functionResponse 不能作为起点。
 * 总结消息本身是 user 角色，若排除它，归一化会错误跳到总结后的下一条用户消息并把总结也丢掉。
 */
export function isLegalTrimStart(history: Content[], index: number): boolean {
    const message = history[index];
    return !!message && (message.isSummary === true || isRealUserMessage(message));
}

export function collectLegalTrimStartIndices(history: Content[], minimumStartIndex: number): number[] {
    const starts: number[] = [];
    for (let i = Math.max(0, minimumStartIndex); i < history.length; i++) {
        if (isLegalTrimStart(history, i)) {
            starts.push(i);
        }
    }
    return starts;
}

/**
 * PERF：一次从右向左扫描，预计算每个下标 i 的「切片 fullHistory.slice(i) 是否通过
 * validateHistoryIntegrity」判定（validSuffix[i]），使 normalizeTrimStartIndex 的每个
 * 候选判定降为 O(1)。语义与 validateHistoryIntegrity（不开启 detectOrphanFunctionCall）
 * 完全一致：重复 functionCall id、重复 functionResponse id、以及「functionResponse
 * 的配对 functionCall 不在切片内」的孤儿响应。
 *
 * 配对方向注意（与正向校验逐位等价的关键）：正向中「response 的配对 call 必须出现在
 * response 之前」（同一消息内更早的 part 或更左侧的消息）；反向扫描时因此要区分三种情况：
 * - 本消息内更早 part 已有 call（localCallSeen）→ 配对成立；
 * - seenFunctionCallIds 已有但本消息内没有（call 在右侧消息，乱序配对）→ 正向判孤儿，
 *   置 hasOrphanResponse（该切片向左扩展后仍至少是重复或孤儿，永久 invalid，不可治愈）；
 * - 两侧都无 → 可能是跨消息正常配对（call 在更左侧，尚未扫到），先记入孤儿集合，
 *   扫到左侧 call 时治愈；本消息新增孤儿不得被本消息内 call 治愈（同消息乱序）。
 */
export function computeValidSuffixMap(fullHistory: Content[]): boolean[] {
    const validSuffix = new Array<boolean>(fullHistory.length);
    const seenFunctionCallIds = new Set<string>();
    const seenFunctionResponseIds = new Set<string>();
    const orphanedFunctionResponseIds = new Set<string>();
    let hasDuplicateCall = false;
    let hasDuplicateResponse = false;
    let hasOrphanResponse = false;

    for (let i = fullHistory.length - 1; i >= 0; i--) {
        const message = fullHistory[i];
        const parts = Array.isArray(message?.parts) ? message.parts : [];
        // 本消息内全部 functionCall id（跨消息治愈用）
        const localCallIds = new Set<string>();
        for (const part of parts) {
            const functionCallId = normalizeCallId(part.functionCall?.id);
            if (functionCallId) {
                localCallIds.add(functionCallId);
            }
        }
        // 本消息内已按 parts 原序处理过的 functionCall（配对判定：call 必须在本 response 之前）
        const localCallSeen = new Set<string>();
        // 本消息新增的孤儿 response（同消息内 call 在 response 之后时，正向确实判孤儿，
        // 不得被本消息的 call 治愈）
        const newOrphanIds = new Set<string>();
        // parts 原序处理（与正向校验同序）：重复检测 + 配对判定
        for (const part of parts) {
            const functionCallId = normalizeCallId(part.functionCall?.id);
            if (functionCallId) {
                localCallSeen.add(functionCallId);
                if (seenFunctionCallIds.has(functionCallId)) {
                    hasDuplicateCall = true;
                } else {
                    seenFunctionCallIds.add(functionCallId);
                }
            }

            const functionResponseId = normalizeCallId(part.functionResponse?.id);
            if (!functionResponseId) {
                continue;
            }
            if (seenFunctionResponseIds.has(functionResponseId)) {
                hasDuplicateResponse = true;
            } else {
                seenFunctionResponseIds.add(functionResponseId);
            }

            if (localCallSeen.has(functionResponseId)) {
                // 本消息内更早的 part 已有配对 call → 配对成立（正向不判孤儿）
            } else if (seenFunctionCallIds.has(functionResponseId)) {
                // call 在右侧消息（乱序配对）→ 正向判孤儿；切片向左扩展后仍至少
                // 是重复或孤儿，永久 invalid，不可治愈
                hasOrphanResponse = true;
            } else {
                // 可能是跨消息正常配对（call 在更左侧尚未扫到）→ 暂记孤儿，等待治愈
                orphanedFunctionResponseIds.add(functionResponseId);
                newOrphanIds.add(functionResponseId);
            }
        }
        // 跨消息治愈：本消息的 call 在右侧消息孤儿 response 的左侧 → 治愈
        // （本消息新增孤儿除外——同消息乱序在正向中确实是孤儿）
        for (const callId of localCallIds) {
            if (!newOrphanIds.has(callId)) {
                orphanedFunctionResponseIds.delete(callId);
            }
        }
        validSuffix[i] = !hasDuplicateCall && !hasDuplicateResponse
            && !hasOrphanResponse && orphanedFunctionResponseIds.size === 0;
    }
    return validSuffix;
}

export function normalizeTrimStartIndex(
    fullHistory: Content[],
    minimumStartIndex: number,
    candidateStartIndex: number
): NormalizedTrimStartResult {
    if (fullHistory.length === 0) {
        return {
            startIndex: 0,
            valid: true,
            reason: 'unchanged'
        };
    }

    const maxIndex = Math.max(0, fullHistory.length - 1);
    const safeMinimumStartIndex = Math.max(0, Math.min(Math.floor(minimumStartIndex), maxIndex));
    const rawCandidate = Number.isFinite(candidateStartIndex) ? Math.floor(candidateStartIndex) : safeMinimumStartIndex;
    const clampedCandidate = Math.max(safeMinimumStartIndex, Math.min(rawCandidate, maxIndex));
    const legalStartIndices = collectLegalTrimStartIndices(fullHistory, safeMinimumStartIndex);

    if (legalStartIndices.length === 0) {
        return {
            startIndex: clampedCandidate,
            valid: false,
            reason: 'no_legal_round_boundary'
        };
    }

    let normalizedStartIndex = clampedCandidate;
    let reason: NormalizedTrimStartResult['reason'] = rawCandidate === clampedCandidate ? 'unchanged' : 'clamped_minimum';

    if (!isLegalTrimStart(fullHistory, clampedCandidate)) {
        const nextLegalStartIndex = legalStartIndices.find(index => index > clampedCandidate);
        if (nextLegalStartIndex !== undefined) {
            normalizedStartIndex = nextLegalStartIndex;
            reason = 'moved_to_next_round';
        } else {
            let currentRoundStartIndex = legalStartIndices[legalStartIndices.length - 1];
            for (let i = legalStartIndices.length - 1; i >= 0; i--) {
                if (legalStartIndices[i] <= clampedCandidate) {
                    currentRoundStartIndex = legalStartIndices[i];
                    break;
                }
            }
            normalizedStartIndex = currentRoundStartIndex;
            reason = 'moved_to_current_round';
        }
    }

    // PERF：O(n) 预计算全部后缀的有效性，替代对每个候选 slice + validateHistoryIntegrity
    const validSuffix = computeValidSuffixMap(fullHistory);
    const candidateStarts = [normalizedStartIndex, ...legalStartIndices.filter(index => index > normalizedStartIndex)];

    for (let i = 0; i < candidateStarts.length; i++) {
        const startIndex = candidateStarts[i];
        if (validSuffix[startIndex]) {
            return {
                startIndex,
                valid: true,
                reason: i === 0 ? reason : 'advanced_to_valid_round'
            };
        }
    }

    // 全部候选无效：与旧实现一致，firstIssue 只来自第一个候选（normalizedStartIndex），
    // 失败路径只出现一次 O(n) 校验（结构异常历史的低频路径）。
    const validation = validateHistoryIntegrity(fullHistory.slice(normalizedStartIndex));
    return {
        startIndex: normalizedStartIndex,
        valid: false,
        reason,
        issueKind: validation.issues[0]?.kind,
        issueCallId: validation.issues[0]?.callId
    };
}
