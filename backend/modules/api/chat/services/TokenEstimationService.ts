import { MessageTokenEstimator } from './MessageTokenEstimator';
import type { Content } from '../../../conversation/types';
import type { ConversationManager } from '../../../conversation/ConversationManager';
import type { TokenizerOptions } from '../../../../../packages/core/src/tokenizer';

export type NormalizedChannelType = 'gemini' | 'gemini-interactions' | 'openai' | 'anthropic' | 'openai-responses' | undefined;

/** 上下文预算直接使用本地 tokenizer；供应方精确计数由显式 TokenCountService 入口承担。 */
export class TokenEstimationService extends MessageTokenEstimator {
    constructor(
        private readonly conversationManager: Pick<ConversationManager, 'getHistoryRef' | 'updateMessage' | 'updateMessagesBatch'>,
        options: TokenizerOptions = {}
    ) { super(options); }

    async preCountUserMessageTokens(
        conversationId: string,
        channelType?: string,
        messageIndex?: number,
        _forceRecount?: boolean
    ): Promise<void> {
        const history = await this.conversationManager.getHistoryRef(conversationId);
        const index = messageIndex ?? history.length - 1;
        const message = history[index];
        if (!message || message.role !== 'user') return;
        const tokenCount = this.estimateMessageTokens(message, { ...this.tokenizerOptions, channelType: channelType ?? this.tokenizerOptions.channelType });
        if (message.estimatedTokenCount === tokenCount && (!channelType || message.tokenCountByChannel?.[channelType] === tokenCount)) return;
        await this.conversationManager.updateMessage(conversationId, index, this.countUpdates(message, tokenCount, channelType));
    }

    normalizeChannelType(channelType?: string): NormalizedChannelType {
        const type = channelType?.toLowerCase();
        return type === 'gemini' || type === 'gemini-interactions' || type === 'openai' || type === 'anthropic' || type === 'openai-responses'
            ? type : undefined;
    }

    async preCountUserMessageTokensBatch(
        conversationId: string,
        channelType: string | undefined,
        messageIndices: number[],
        _forceRecount?: boolean
    ): Promise<Array<number | undefined>> {
        if (!messageIndices.length) return [];
        const history = await this.conversationManager.getHistoryRef(conversationId);
        const counts: Array<number | undefined> = new Array(messageIndices.length).fill(undefined);
        const updates: Array<{ messageIndex: number; updates: Partial<Content> }> = [];
        for (let position = 0; position < messageIndices.length; position++) {
            const index = messageIndices[position];
            const message = history[index];
            if (!message || message.role !== 'user') continue;
            // 旧持久缓存没有模型/词表身份，不能拿它替代当前正文计数；弱缓存避免重复 BPE。
            const count = this.estimateMessageTokens(message, { ...this.tokenizerOptions, channelType: channelType ?? this.tokenizerOptions.channelType });
            counts[position] = count;
            if (message.estimatedTokenCount === count && (!channelType || message.tokenCountByChannel?.[channelType] === count)) continue;
            updates.push({ messageIndex: index, updates: this.countUpdates(message, count, channelType) });
        }
        if (updates.length) await this.conversationManager.updateMessagesBatch(conversationId, updates);
        return counts;
    }

    private countUpdates(message: Content, count: number, channelType?: string): Partial<Content> {
        return {
            tokenCountByChannel: { ...message.tokenCountByChannel, ...(channelType ? { [channelType]: count } : {}) },
            estimatedTokenCount: count
        };
    }

    async countSystemPromptTokens(systemPrompt: string, channelType?: string): Promise<number> {
        return this.estimateTextTokensLocal(systemPrompt, { ...this.tokenizerOptions, channelType: channelType ?? this.tokenizerOptions.channelType });
    }

    async countTextTokensBatch(texts: (string | null | undefined)[], channelType?: string): Promise<number[]> {
        const options = { ...this.tokenizerOptions, channelType: channelType ?? this.tokenizerOptions.channelType };
        return texts.map(text => this.estimateTextTokensLocal(text ?? '', options));
    }
}
