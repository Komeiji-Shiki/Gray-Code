/**
 * 发送历史选择与 token 回填辅助（从 ContextTrimService 抽离）。
 *
 * - getNormalizedHistoryForStartIndex：把候选裁剪起点归一化后格式化出可发送历史
 * - countAndUpdateMessageTokens：批量预计算缺失 token 的用户消息
 */

import type { Content } from '../../../../conversation/types';
import type { ConversationManager, GetHistoryOptions } from '../../../../conversation/ConversationManager';
import type { DynamicContextStrategy } from '../../../../settings/types';
import type { ContextTrimInfo } from '../../utils';
import type { TokenEstimationService } from '../TokenEstimationService';
import {
    normalizeTrimStartIndex,
    type NormalizedTrimStartResult
} from './historyNormalization';
import { prependFirstUserMessage } from './historyAssembly';
import { prependPreservedUserInputs } from './preservedUserInputs';

export async function getNormalizedHistoryForStartIndex(
    conversationManager: ConversationManager,
    conversationId: string,
    fullHistory: Content[],
    historyOptions: GetHistoryOptions,
    minimumStartIndex: number,
    candidateStartIndex: number,
    dynamicContextStrategy: DynamicContextStrategy = 'single'
): Promise<ContextTrimInfo & { normalization: NormalizedTrimStartResult }> {
    const normalization = normalizeTrimStartIndex(fullHistory, minimumStartIndex, candidateStartIndex);
    // HIS-03/04：调用方已加载 fullHistory，直接复用格式化，避免同一迭代内第二次 loadHistory
    const formattedHistory = conversationManager.getHistoryForAPIFrom(fullHistory, {
        ...historyOptions,
        startIndex: normalization.startIndex,
        includeTurnDynamicContext: dynamicContextStrategy === 'preserve'
    });
    const history = prependFirstUserMessage(
        fullHistory,
        prependPreservedUserInputs(
            formattedHistory,
            fullHistory,
            normalization.startIndex
        ),
        normalization.startIndex
    );

    return {
        history,
        trimStartIndex: normalization.startIndex,
        normalization
    };
}

/**
 * 并行计算并更新消息的 token 数
 *
 * @param messages 需要计算的消息列表；index 必须为原始存储历史下标——过滤 isSummarized 后
 *                 的下标与本方法内部 getHistoryRef 读到的原始数组错位，会导致计数错位
 * @returns 与 messages 等长的 token 数数组；跳过条目（非用户消息/已有缓存）为 undefined 占位，
 *          调用方按下标逐条对齐，undefined 条目保持粗估/走本地估算
 */
export async function countAndUpdateMessageTokens(
    conversationManager: ConversationManager,
    tokenEstimationService: TokenEstimationService,
    conversationId: string,
    channelType: string,
    messages: Array<{ index: number; message: Content }>
): Promise<Array<number | undefined>> {
    if (messages.length === 0) {
        return [];
    }

    // 使用 TokenEstimationService 的批量方法；preCountUserMessageTokensBatch
    // 逐条返回精确计数（失败条目内部已降级为本地估算），不再二次 getHistoryRef
    // 全量读取——每轮裁剪此前合计 3 次全量历史读取（本方法自身 + 计数内部 + 调用方）。
    const messageIndices = messages.map(m => m.index);
    const tokenCounts = await tokenEstimationService.preCountUserMessageTokensBatch(
        conversationId,
        channelType,
        messageIndices
    );
    // 防御：测试替身或异常路径可能返回非数组（旧签名 Promise<void>），
    // 此时回退为从消息自身读取已写回的计数（缺失按 0 计，与旧行为一致）。
    if (!Array.isArray(tokenCounts)) {
        const updatedHistory = await conversationManager.getHistoryRef(conversationId);
        return messages.map(({ index }) => {
            const msg = updatedHistory[index];
            // C-14：并发删除/裁剪后该索引处消息可能已不存在，缺失时按 0 计，
            // 避免 estimateMessageTokens(undefined) 抛错中断整批计数。
            if (!msg) {
                return 0;
            }
            return msg.tokenCountByChannel?.[channelType] ?? tokenEstimationService.estimateMessageTokens(msg);
        });
    }
    return tokenCounts;
}
