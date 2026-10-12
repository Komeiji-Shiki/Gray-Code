import type { Content, ContentPart } from '../../../../conversation/types';
import { isRealUserMessage } from '../../../../conversation/helpers';
import type { TokenEstimationService } from '../TokenEstimationService';
import type { MessageBuilderService } from '../MessageBuilderService';

export interface RoundTokenInfo {
    startIndex: number;
    endIndex: number;
    cumulativeTokens: number;
}

export interface AccumulateUsageStats {
    modelMessagesWithUsage: number;
    modelMessagesOutputBased: number;
    modelMessagesMismatch: number;
    modelMessagesWithoutUsage: number;
    userMessages: number;
    userFromChannelCount: number;
    userFromEstimatedFieldCount: number;
    userFromLocalEstimateCount: number;
    userTokensTotal: number;
    modelTokensTotal: number;
}

export interface AccumulateTokensResult {
    estimatedTotalTokens: number;
    roundTokenInfos: RoundTokenInfo[];
    usageStats: AccumulateUsageStats;
}

export interface AccumulateTokensDeps {
    tokenEstimationService: TokenEstimationService;
    messageBuilderService: MessageBuilderService;
}

export interface AccumulateTokensParams {
    fullHistory: Content[];
    effectiveStartIndex: number;
    lastNonFunctionResponseUserIndex: number;
    historyThoughtMinIndex: number;
    historyThoughtMaxIndex: number;
    sendHistoryThoughts: boolean;
    sendHistoryThoughtSignatures: boolean;
    sendCurrentThoughts: boolean;
    sendCurrentThoughtSignatures: boolean;
    channelType: string;
    promptTokens: number;
    preservedDynamicContextTokenByIndex?: Map<number, number>;
    /** 旧调用参数保留可读；没有请求前缀及选中历史身份的 usage 不再作为输入预算锚点。 */
    useUsageAnchor?: boolean;
}

/** 累加当前要发送的正文；usage 仅记录观测次数，不能代替或重复叠加历史正文。 */
export function accumulateContextTokens(deps: AccumulateTokensDeps, params: AccumulateTokensParams): AccumulateTokensResult {
    const { fullHistory, effectiveStartIndex, promptTokens, preservedDynamicContextTokenByIndex = new Map() } = params;
    let estimatedTotalTokens = promptTokens;
    const roundTokenInfos: RoundTokenInfo[] = [];
    let currentRoundStartIndex = -1;
    const usageStats: AccumulateUsageStats = {
        modelMessagesWithUsage: 0, modelMessagesOutputBased: 0, modelMessagesMismatch: 0, modelMessagesWithoutUsage: 0,
        userMessages: 0, userFromChannelCount: 0, userFromEstimatedFieldCount: 0, userFromLocalEstimateCount: 0,
        userTokensTotal: 0, modelTokensTotal: 0
    };

    // 原始首条输入可能在切片之前，却仍被发送历史前置；只在切片不包含它时加一次。
    const firstUserIndex = fullHistory.findIndex(message => isRealUserMessage(message));
    if (firstUserIndex >= 0 && firstUserIndex < effectiveStartIndex) {
        const tokens = deps.tokenEstimationService.estimateMessageTokens(fullHistory[firstUserIndex]);
        estimatedTotalTokens += tokens;
        usageStats.userTokensTotal += tokens;
    }

    for (let index = effectiveStartIndex; index < fullHistory.length; index++) {
        const message = fullHistory[index];
        if (message.role === 'user') {
            if (isRealUserMessage(message)) {
                if (currentRoundStartIndex !== -1) {
                    roundTokenInfos.push({ startIndex: currentRoundStartIndex, endIndex: index, cumulativeTokens: estimatedTotalTokens });
                }
                currentRoundStartIndex = index;
            }
            const dynamicTokens = preservedDynamicContextTokenByIndex.get(index) ?? 0;
            // 持久化 tokenCountByChannel 没有正文版本和模型身份，不能在编辑、换模型后复用。
            const tokens = deps.tokenEstimationService.estimateMessageTokens(message) + dynamicTokens;
            estimatedTotalTokens += tokens;
            usageStats.userMessages++;
            usageStats.userFromLocalEstimateCount++;
            usageStats.userTokensTotal += tokens;
            continue;
        }
        if (message.role !== 'model') continue;
        if (message.usageMetadata) usageStats.modelMessagesWithUsage++;
        else usageStats.modelMessagesWithoutUsage++;

        const current = index >= params.lastNonFunctionResponseUserIndex;
        const inHistoryRange = index >= params.historyThoughtMinIndex && index < params.historyThoughtMaxIndex;
        const thoughts = current ? params.sendCurrentThoughts : params.sendHistoryThoughts && inHistoryRange;
        const signatures = current ? params.sendCurrentThoughtSignatures : params.sendHistoryThoughtSignatures && inHistoryRange;
        const parts = message.parts.map(part => budgetPart(part, thoughts, signatures, params.channelType))
            .filter((part): part is ContentPart => part !== undefined);
        if (!parts.length) continue;
        const tokens = deps.tokenEstimationService.estimateMessageTokens({ ...message, parts });
        estimatedTotalTokens += tokens;
        usageStats.modelTokensTotal += tokens;
    }

    if (currentRoundStartIndex !== -1) {
        roundTokenInfos.push({ startIndex: currentRoundStartIndex, endIndex: fullHistory.length, cumulativeTokens: estimatedTotalTokens });
    }
    return { estimatedTotalTokens, roundTokenInfos, usageStats };
}

function budgetPart(part: ContentPart, thoughts: boolean, signatures: boolean, channelType: string): ContentPart | undefined {
    const hasResponsesReasoning = channelType === 'openai-responses' &&
        (!!part.openaiResponsesReasoning || !!part.thoughtSignatures?.['openai-responses']);
    if (part.thought && !thoughts && !signatures && !hasResponsesReasoning) return undefined;
    if (signatures || !part.thoughtSignatures) return part;
    const { thoughtSignatures, ...rest } = part;
    return rest;
}
