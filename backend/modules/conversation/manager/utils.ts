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
 * 只读浅扫描（首次加载页用）：检查历史是否存在未响应的 functionCall（悬空工具调用），
 * 以及是否存在缺 id 的消息（BR-02 迁移判据）。
 * 只遍历检查、不深拷贝、不写回——正常路径（绝大多数历史无悬空调用/已迁移）可完全跳过
 * normalizeHistoryForDisplay 的全量 JSON 深拷贝（HIS-13 后端收益）。
 */
export async function scanHistoryForInitialPage(
    storage: IStorageAdapter,
    conversationId: string
): Promise<{ hasUnresolvedCalls: boolean; needsNodeIdMigration: boolean }> {
    const result = await storage.loadHistoryWithStatus(conversationId);
    const history = result.value;
    if (!history) return { hasUnresolvedCalls: false, needsNodeIdMigration: false };

    const respondedToolCallIds = new Set<string>();
    for (const message of history) {
        if (!message.parts) continue;
        for (const part of message.parts) {
            if (part.functionResponse?.id) {
                respondedToolCallIds.add(part.functionResponse.id);
            }
        }
    }
    let hasUnresolvedCalls = false;
    for (const message of history) {
        if (!message.parts) continue;
        for (const part of message.parts) {
            if (part.functionCall?.id
                && !respondedToolCallIds.has(part.functionCall.id)
                && !part.functionCall.rejected) {
                hasUnresolvedCalls = true;
                break;
            }
        }
        if (hasUnresolvedCalls) break;
    }
    return {
        hasUnresolvedCalls,
        needsNodeIdMigration: needsNodeIdMigration(history),
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
