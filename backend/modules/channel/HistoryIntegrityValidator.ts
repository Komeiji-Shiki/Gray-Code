import type { Content } from '../conversation/types';

export type HistoryIntegrityIssueKind =
    | 'orphan_function_response'
    | 'orphan_function_call'
    | 'duplicate_function_call_id'
    | 'duplicate_function_response_id';

export interface HistoryIntegrityIssue {
    kind: HistoryIntegrityIssueKind;
    callId: string;
    messageIndex: number;
    partIndex: number;
    functionName?: string;
}

export interface HistoryIntegrityValidationResult {
    valid: boolean;
    issues: HistoryIntegrityIssue[];
}

export interface ValidateHistoryIntegrityOptions {
    /**
     * 是否检测悬空 functionCall（有调用没响应）。
     *
     * 只有在检查**完整请求历史**时才应开启：ContextTrimService / summarizeRangePlanner
     * 对历史切片做校验，切片边界上 functionCall 与 functionResponse 天然不配对，
     * 开启此检测会产生大量假阳性。
     *
     * 默认关闭以保持向后兼容。
     */
    detectOrphanFunctionCall?: boolean;
}

/** 归一化调用 ID（trim 后比较；导出供 ContextTrimService 的 O(n) 后缀有效性预计算复用同一口径） */
export function normalizeCallId(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

export function validateHistoryIntegrity(
    history: Content[],
    options: ValidateHistoryIntegrityOptions = {}
): HistoryIntegrityValidationResult {
    const issues: HistoryIntegrityIssue[] = [];
    const seenFunctionCallIds = new Set<string>();
    const seenFunctionResponseIds = new Set<string>();
    // rejected 的 functionCall（中断/取消/超时后由 ConversationManager 标记）：
    // 表示"无对应响应是有意的"，formatter 发送时已过滤，不构成孤儿。
    const rejectedFunctionCallIds = new Set<string>();

    for (let messageIndex = 0; messageIndex < history.length; messageIndex++) {
        const message = history[messageIndex];
        const parts = Array.isArray(message?.parts) ? message.parts : [];

        for (let partIndex = 0; partIndex < parts.length; partIndex++) {
            const part = parts[partIndex];
            const functionCallId = normalizeCallId(part.functionCall?.id);
            if (functionCallId) {
                if (seenFunctionCallIds.has(functionCallId)) {
                    issues.push({
                        kind: 'duplicate_function_call_id',
                        callId: functionCallId,
                        messageIndex,
                        partIndex,
                        functionName: part.functionCall?.name
                    });
                } else {
                    seenFunctionCallIds.add(functionCallId);
                }
                if (part.functionCall?.rejected) {
                    rejectedFunctionCallIds.add(functionCallId);
                }
            }

            const functionResponseId = normalizeCallId(part.functionResponse?.id);
            if (!functionResponseId) {
                continue;
            }

            if (seenFunctionResponseIds.has(functionResponseId)) {
                issues.push({
                    kind: 'duplicate_function_response_id',
                    callId: functionResponseId,
                    messageIndex,
                    partIndex,
                    functionName: part.functionResponse?.name
                });
            } else {
                seenFunctionResponseIds.add(functionResponseId);
            }

            if (!seenFunctionCallIds.has(functionResponseId)) {
                issues.push({
                    kind: 'orphan_function_response',
                    callId: functionResponseId,
                    messageIndex,
                    partIndex,
                    functionName: part.functionResponse?.name
                });
            }
        }
    }

    // 第二轮：检测没有对应 functionResponse 的 functionCall（orphan_function_call）。
    // 仅当调用方显式开启时才执行——切片校验会天然产生配对断裂。
    // 这种悬空调用会导致 Anthropic / OpenAI 直接 400，比 orphan_function_response 更危险。
    if (options.detectOrphanFunctionCall) {
        for (const callId of seenFunctionCallIds) {
            // 跳过 rejected：无响应是设计语义（中断/取消残留），且 formatter 已过滤不会发送
            if (!seenFunctionResponseIds.has(callId) && !rejectedFunctionCallIds.has(callId)) {
                issues.push({
                    kind: 'orphan_function_call',
                    callId,
                    messageIndex: -1,
                    partIndex: -1,
                });
            }
        }
    }

    return {
        valid: issues.length === 0,
        issues
    };
}
