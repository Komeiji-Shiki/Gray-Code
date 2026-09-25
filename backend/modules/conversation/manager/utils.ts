/**
 * ConversationManager 通用辅助函数（拆分自 ConversationManager.ts）。
 *
 * 均为不依赖 this 的纯函数/存储薄封装，供 ConversationManager 及 manager 下
 * 各服务（query / toolCalls）直接 import 使用。
 * 注意：本文件内容按原文件缩进保留（纯移动，不重排）。
 */

import type { Content, ConversationHistory } from '../types';
import type { IStorageAdapter } from '../storage';
import { needsNodeIdMigration } from './nodeId';
import { isPlaceholderToolResponse } from './historyRepair';

/**
 * 结构性更新（parts / isSummary / isAutoSummary / summarizedMessageCount / isFunctionResponse）
 * 是否触发上下文裁剪状态失效。
 */
export function shouldInvalidateContextManagementStateForUpdate(updates: Partial<Content>): boolean {
    return Object.prototype.hasOwnProperty.call(updates, 'parts')
        || Object.prototype.hasOwnProperty.call(updates, 'isSummary')
        || Object.prototype.hasOwnProperty.call(updates, 'isAutoSummary')
        || Object.prototype.hasOwnProperty.call(updates, 'summarizedMessageCount')
        || Object.prototype.hasOwnProperty.call(updates, 'isFunctionResponse');
}

/**
 * 读取消息所属的平台运行时任务 ID。
 *
 * backend 的 Content 类型不声明该字段：只有 2.0 平台运行时写入的消息携带 runId，
 * 旧链路（VS Code 扩展等）消息没有；这里按动态字段读取并做类型校验。
 */
export function messageRunId(message: Content): string | undefined {
    const value = (message as { runId?: unknown }).runId;
    return typeof value === 'string' && value ? value : undefined;
}

/** 首次加载页浅扫描结果（getMessagesPaged 与 normalizeHistoryForDisplay 共用）。 */
export interface InitialPageScan {
    /** 存在没有对应 functionResponse 的 functionCall（不含仍活跃任务写下的在途调用）。 */
    hasUnresolvedCalls: boolean;
    /** 响应侧结构异常：同一调用 ID 出现重复响应，或真实响应仍带 rejected 标记。 */
    hasResponseAnomalies: boolean;
    /** 存在缺稳定 ID 的消息（BR-02 迁移判据）。 */
    needsNodeIdMigration: boolean;
    /** 该会话当前活跃（未终结）任务的 ID 集合；undefined 表示存储不支持或不提供该信息。 */
    activeRunIds?: Set<string>;
}

/**
 * 只读浅扫描（首次加载页用）：检查历史是否存在未响应的 functionCall（悬空工具调用）、
 * 响应侧结构异常（重复响应 / rejected 残留），以及是否存在缺 id 的消息（BR-02 迁移判据）。
 * 只遍历检查、不深拷贝、不写回——正常路径（绝大多数历史无悬空调用/已迁移）可完全跳过
 * normalizeHistoryForDisplay 的全量 JSON 深拷贝（HIS-13 后端收益）。
 *
 * 平台运行时模式（存储实现 listActiveRunIds）下，属于活跃任务的调用不计入
 * hasUnresolvedCalls：结果可能只是尚未落盘，按"已放弃"补齐占位会给迟到的真实结果
 * 制造重复响应（duplicate_function_response_id）。
 */
export async function scanHistoryForInitialPage(
    storage: IStorageAdapter,
    conversationId: string
): Promise<InitialPageScan> {
    const result = await storage.loadHistoryWithStatus(conversationId);
    const history = result.value;
    if (!history) return { hasUnresolvedCalls: false, hasResponseAnomalies: false, needsNodeIdMigration: false };

    // 活跃任务集合查询失败按"信息不可用"处理：保持旧行为（补齐不跳过）。
    let activeRunIds: Set<string> | undefined;
    try {
        activeRunIds = await storage.listActiveRunIds?.(conversationId);
    } catch {
        activeRunIds = undefined;
    }

    const respondedToolCallIds = new Set<string>();
    const seenResponseIds = new Set<string>();
    const resolvedResponseIds = new Set<string>();
    let hasResponseAnomalies = false;
    for (const message of history) {
        if (!message.parts) continue;
        for (const part of message.parts) {
            const response = part.functionResponse;
            if (!response?.id) continue;
            respondedToolCallIds.add(response.id);
            if (seenResponseIds.has(response.id)) hasResponseAnomalies = true;
            else seenResponseIds.add(response.id);
            if (!isPlaceholderToolResponse(response.response)) resolvedResponseIds.add(response.id);
        }
    }
    let hasUnresolvedCalls = false;
    for (const message of history) {
        // 命中未响应调用即可进入深路径，无需继续扫调用侧（响应侧异常已在上方扫完）。
        if (hasUnresolvedCalls) break;
        if (!message.parts) continue;
        const runId = messageRunId(message);
        const activeRunCall = !!(runId && activeRunIds?.has(runId));
        for (const part of message.parts) {
            const call = part.functionCall;
            if (!call?.id) continue;
            if (call.rejected && resolvedResponseIds.has(call.id)) {
                hasResponseAnomalies = true;
                continue;
            }
            if (!activeRunCall && !respondedToolCallIds.has(call.id) && !call.rejected) {
                hasUnresolvedCalls = true;
                break;
            }
        }
    }
    return {
        hasUnresolvedCalls,
        hasResponseAnomalies,
        needsNodeIdMigration: needsNodeIdMigration(history),
        ...(activeRunIds ? { activeRunIds } : {}),
    };
}

/** 限流并发执行（结果按输入顺序返回） */
export async function runBounded<T, R>(
    items: readonly T[],
    concurrency: number,
    task: (item: T) => Promise<R>
): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let next = 0;
    const workerCount = Math.max(1, Math.min(concurrency, items.length));
    await Promise.all(Array.from({ length: workerCount }, async () => {
        while (next < items.length) {
            const index = next++;
            results[index] = await task(items[index]);
        }
    }));
    return results;
}

/**
 * 查找 functionResponse 消息的正确插入位置。
 *
 * 工具响应必须紧跟对应的工具调用消息。若该位置之后已存在同批次
 * functionResponse 消息，则插到它们之后，保持与 functionCall 输出顺序一致。
 *
 * @param history 当前对话历史
 * @param messageIndex 工具调用消息的索引
 * @returns functionResponse 应插入的位置索引
 */
export function findFunctionResponseInsertIndex(history: ConversationHistory, messageIndex: number): number {
    let insertAt = messageIndex + 1;
    while (insertAt < history.length && history[insertAt]?.isFunctionResponse) {
        insertAt++;
    }
    return insertAt;
}
