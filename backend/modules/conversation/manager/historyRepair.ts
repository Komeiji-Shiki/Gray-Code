/**
 * 工具调用响应重复清理（读取路径与请求路径共用的纯函数）。
 *
 * 问题背景：同一个 functionCall ID 出现多条 functionResponse 时，历史完整性校验
 * （HistoryIntegrityValidator 的 duplicate_function_response_id）会让下一次模型请求直接
 * 失败（界面上表现为 API_ERROR: Unpaired tool history）。典型来源是「读取路径的悬空调用
 * 补齐」与仍然活跃的任务并发：补齐把结果尚未落盘的在途调用误判为已放弃、写入"用户拒绝"
 * 占位，真实结果随后照常落盘 → 同一调用两条响应。
 *
 * 修复策略（保守、可重入、无变更返回原引用）：
 * - 同一 ID 只保留一条响应：优先保留真实结果（非占位）；全部为占位时保留最后一条（最新写入）。
 * - 保留真实结果时，清除对应 functionCall 的 rejected 标记（占位配套的"无响应是有意的"
 *   标记不再成立；否则 formatter 会把真实结果也一并过滤掉）。
 * - 占位响应被清空的消息整条删除；删除消息后修正其后继消息的 parentId，保持线性链。
 *
 * 不处理重复的 functionCall（模型侧身份重复）：调用侧重复由 provider 与运行时校验负责，
 * 本函数只修响应侧。
 */

import type { Content, ContentPart, ConversationHistory } from '../types';

export interface ToolHistoryRepairResult {
    /** 是否有实际变更；false 时 history 为原引用（调用方可安全跳过写回）。 */
    changed: boolean;
    /** 修复后的历史；changed=false 时为传入原引用。 */
    history: ConversationHistory;
}

/**
 * 判断一条 functionResponse 是否为"占位"（尚未真实结算的弱响应）。
 *
 * 只认结构标记，不依赖界面文案（i18n 变更不影响判定）：
 * - rejected: true —— 拒绝占位（rejectToolCalls / rejectAllPendingToolCalls / 读取路径补齐）；
 * - cancelled: true —— 取消占位（流式/非流式取消结算）；
 * - code: 'CANCELLED' / 'INTERRUPTED' —— 平台运行时侧的取消/中断收尾结果（可能被随后
 *   落盘的真实结果取代，属同一弱响应族）。
 */
export function isPlaceholderToolResponse(response: unknown): boolean {
    if (!response || typeof response !== 'object' || Array.isArray(response)) return false;
    const record = response as Record<string, unknown>;
    return record.rejected === true
        || record.cancelled === true
        || record.code === 'CANCELLED'
        || record.code === 'INTERRUPTED';
}

function messageId(message: Content | undefined): string | null {
    return typeof message?.id === 'string' && message.id ? message.id : null;
}

export function repairDuplicateFunctionResponses(history: ConversationHistory): ToolHistoryRepairResult {
    if (!Array.isArray(history) || history.length === 0) return { changed: false, history };

    // 1) 索引每个 functionResponse ID 的分布（消息内、跨消息统一处理）。
    interface ResponseRef { messageIndex: number; partIndex: number; placeholder: boolean }
    const responsesById = new Map<string, ResponseRef[]>();
    for (let messageIndex = 0; messageIndex < history.length; messageIndex++) {
        const parts = history[messageIndex]?.parts;
        if (!Array.isArray(parts)) continue;
        for (let partIndex = 0; partIndex < parts.length; partIndex++) {
            const id = parts[partIndex]?.functionResponse?.id;
            if (typeof id !== 'string' || !id) continue;
            const refs = responsesById.get(id) ?? [];
            refs.push({
                messageIndex,
                partIndex,
                placeholder: isPlaceholderToolResponse(parts[partIndex].functionResponse?.response),
            });
            responsesById.set(id, refs);
        }
    }
    if (responsesById.size === 0) return { changed: false, history };

    // 2) 每个 ID 至多保留一条响应：优先真实结果；全为占位时保留最后一条（最新写入）。
    const removedParts = new Set<string>();
    const resolvedCallIds = new Set<string>();
    for (const [id, refs] of responsesById) {
        if (refs.some(ref => !ref.placeholder)) resolvedCallIds.add(id);
        if (refs.length <= 1) continue;
        let keep = refs[refs.length - 1];
        for (let i = refs.length - 1; i >= 0; i--) {
            if (!refs[i].placeholder) {
                keep = refs[i];
                break;
            }
        }
        for (const ref of refs) {
            if (ref !== keep) removedParts.add(`${ref.messageIndex}:${ref.partIndex}`);
        }
    }

    // 3) 组装修复后的历史。无重复也无可清理的 rejected 残留时返回原引用。
    const deletedMessageIds = new Set<string>();
    const nextHistory: Content[] = [];
    let changed = false;
    let lastKeptId: string | null = null;
    for (let messageIndex = 0; messageIndex < history.length; messageIndex++) {
        const original = history[messageIndex];
        const parts = original?.parts;
        if (!Array.isArray(parts)) {
            nextHistory.push(original);
            lastKeptId = messageId(original);
            continue;
        }
        const keptParts: ContentPart[] = [];
        let messageChanged = false;
        for (let partIndex = 0; partIndex < parts.length; partIndex++) {
            if (removedParts.has(`${messageIndex}:${partIndex}`)) {
                messageChanged = true;
                continue;
            }
            const part = parts[partIndex];
            const callId = part?.functionCall?.id;
            if (part?.functionCall?.rejected && typeof callId === 'string' && resolvedCallIds.has(callId)) {
                // 真实响应已存在：清掉占位配套的 rejected 标记（拷贝后再改，不污染共享引用）。
                keptParts.push({ ...part, functionCall: { ...part.functionCall, rejected: false } });
                messageChanged = true;
                continue;
            }
            keptParts.push(part);
        }
        let next: Content = messageChanged ? { ...original, parts: keptParts } : original;
        if (messageChanged) {
            changed = true;
            if (keptParts.length === 0) {
                // 整条消息的 parts 都被清理（典型：被真实结果取代的占位消息）→ 删除消息。
                const deletedId = messageId(original);
                if (deletedId) deletedMessageIds.add(deletedId);
                continue;
            }
        }
        if (deletedMessageIds.size > 0 && typeof next.parentId === 'string' && deletedMessageIds.has(next.parentId)) {
            // 前驱消息已删除：把线性 parentId 链接到最近一条保留消息上。
            next = { ...next, parentId: lastKeptId };
        }
        nextHistory.push(next);
        lastKeptId = messageId(next);
    }
    if (!changed) return { changed: false, history };
    return { changed: true, history: nextHistory };
}
