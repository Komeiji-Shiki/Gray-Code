import { MessageTokenEstimator } from './MessageTokenEstimator';
/**
 * Token 估算服务
 * 
 * 负责 Token 的预计算、估算和计数相关功能。
 * 
 * 职责：
 * - 预计算用户消息的 Token 数量
 * - 计算系统提示词的 Token 数量
 * - 估算消息的 Token 数量（文本和多模态）
 * - 规范化渠道类型
 */

import type { Content, ContentPart, ChannelTokenCounts } from '../../../conversation/types';
import type { ConversationManager } from '../../../conversation/ConversationManager';
import type { SettingsManager } from '../../../settings/SettingsManager';
import type { TokenCountService } from '../../../channel/TokenCountService';

/**
 * 规范化的渠道类型
 */
export type NormalizedChannelType = 'gemini' | 'gemini-interactions' | 'openai' | 'anthropic' | 'openai-responses' | undefined;

export class TokenEstimationService extends MessageTokenEstimator {

    constructor(
        private conversationManager: Pick<ConversationManager, 'getHistoryRef' | 'updateMessage' | 'updateMessagesBatch'>,
        private tokenCountService: TokenCountService,
        private settingsManager?: SettingsManager
    ) { super(); }

    /**
     * 设置 SettingsManager
     */
    setSettingsManager(settingsManager: SettingsManager): void {
        this.settingsManager = settingsManager;
    }

    /**
     * 预计算用户消息的 Token 数量
     * 
     * 尝试使用 API 获取精确值，失败时使用估算。
     * 结果会保存到消息的 tokenCountByChannel 字段。
     * 
     * @param conversationId 会话 ID
     * @param channelType 渠道类型
     * @param messageIndex 消息索引（默认为最后一条消息）
     * @param forceRecount 是否强制重新计算
     */
    async preCountUserMessageTokens(
        conversationId: string,
        channelType?: string,
        messageIndex?: number,
        forceRecount?: boolean
    ): Promise<void> {
        if (!this.settingsManager) {
            return;
        }
        
        const history = await this.conversationManager.getHistoryRef(conversationId);
        
        if (history.length === 0) {
            return;
        }
        
        // 获取用户消息索引
        const targetIndex = messageIndex ?? history.length - 1;
        const targetMessage = history[targetIndex];
        
        if (!targetMessage || targetMessage.role !== 'user') {
            return;
        }

        // channelType 为空直接返回：写入侧只在 channelType 非空时落键（见下方 124 行），
        // 空串键在存储中不存在，检查 `tokenCountByChannel['']` 语义不成立。
        if (!channelType) {
            return;
        }

        // 检查是否已经有 token 数（除非强制重新计算）
        if (!forceRecount && targetMessage.tokenCountByChannel?.[channelType] !== undefined) {
            return;
        }
        
        // 获取 Token 计数配置
        const tokenCountConfig = this.settingsManager.getTokenCountConfig();
        const normalizedChannelType = this.normalizeChannelType(channelType);
        
        let tokenCount: number | undefined;
        
        // 尝试调用 API 获取精确 token 数
        if (normalizedChannelType && tokenCountConfig[normalizedChannelType]?.enabled) {
            // 每次调用前更新代理设置（以便运行时更改代理生效）
            this.tokenCountService.setProxyUrl(this.settingsManager.getEffectiveProxyUrl());
            
            // 使用与真实 API 历史相同的固定转后台提醒，避免缓存的消息 token 数低估。
            const messageForCount = this.cleanMessageForTokenCount(targetMessage);
            const result = await this.tokenCountService.countTokens(
                normalizedChannelType,
                tokenCountConfig,
                [messageForCount]
            );
            
            if (result.success && result.totalTokens !== undefined) {
                tokenCount = result.totalTokens;
            }
        }
        
        // 如果 API 调用失败或未配置，使用估算
        if (tokenCount === undefined) {
            tokenCount = this.estimateMessageTokens(targetMessage);
        }
        
        // 更新用户消息的 token 数
        const tokenCountByChannel: ChannelTokenCounts = targetMessage.tokenCountByChannel || {};
        if (channelType) {
            tokenCountByChannel[channelType] = tokenCount;
        }
        
        await this.conversationManager.updateMessage(conversationId, targetIndex, {
            tokenCountByChannel,
            estimatedTokenCount: tokenCount  // 向后兼容
        });
    }
    
    /**
     * 规范化渠道类型
     *
     * 将渠道类型映射为 TokenCountService 支持的类型
     * 
     * @param channelType 渠道类型
     * @returns 规范化的渠道类型
     */
    normalizeChannelType(channelType?: string): NormalizedChannelType {
        if (!channelType) return undefined;
        
        const type = channelType.toLowerCase();
        if (type === 'gemini') return 'gemini';
        if (type === 'openai') return 'openai';
        if (type === 'anthropic') return 'anthropic';
        if (type === 'openai-responses') return 'openai-responses';
        
        return undefined;
    }
    
    /**
     * 批量并行预计算多条消息的 Token 数量
     * 
     * 所有计数请求将并行执行，节省时间。
     * 
     * @param conversationId 会话 ID
     * @param channelType 渠道类型
     * @param messageIndices 消息索引数组
     * @param forceRecount 是否强制重新计算
     * @returns 与 messageIndices 等长的 token 数数组：跳过条目（非用户消息/已有缓存）
     *          以 undefined 占位，计数条目为精确值（失败条目已内部降级为本地估算）。
     *          调用方按下标逐条对齐即可，无需二次读取历史即可回填快照；
     *          undefined 条目由调用方走本地估算或跳过回填。
     */
    async preCountUserMessageTokensBatch(
        conversationId: string,
        channelType: string | undefined,
        messageIndices: number[],
        forceRecount?: boolean
    ): Promise<Array<number | undefined>> {
        if (!this.settingsManager || messageIndices.length === 0) {
            return [];
        }
        
        const history = await this.conversationManager.getHistoryRef(conversationId);
        
        if (history.length === 0) {
            // 历史为空时无任何条目可计数：返回等长占位数组（全 undefined），
            // 保持「返回数组与 messageIndices 等长」的对齐契约。
            return new Array(messageIndices.length).fill(undefined);
        }
        
        // 获取 Token 计数配置
        const tokenCountConfig = this.settingsManager.getTokenCountConfig();
        const normalizedChannelType = this.normalizeChannelType(channelType);
        
        // 收集需要计数的消息；position 记录该条目在 messageIndices 中的位置，
        // 用于把计数结果写回与入参等长的返回数组（跳过条目以 undefined 占位）——
        // 此前返回数组只含实际计数条目，与调用方逐条对齐时整体错位
        // （如已缓存条目被跳过时，后续条目的计数全部前移一位）。
        const messagesToCount: Array<{ index: number; position: number; message: Content }> = [];
        
        for (let position = 0; position < messageIndices.length; position++) {
            const index = messageIndices[position];
            const message = history[index];
            if (!message || message.role !== 'user') {
                continue;
            }
            
            // 检查是否已经有 token 数（除非强制重新计算）
            // 缓存键与单条版 preCountUserMessageTokens 统一（channelType 原样作键，不补 ''），
            // 避免两端键不一致导致已计数的消息被重复计数/重复写回。
            // channelType 为 undefined/空串时写入侧不落键（见下方 if (channelType)），
            // 缓存中不存在对应键，直接跳过缓存检查，保持与单条版一致的空值语义。
            if (!forceRecount && channelType && message.tokenCountByChannel?.[channelType] !== undefined) {
                continue;
            }
            
            messagesToCount.push({ index, position, message: this.cleanMessageForTokenCount(message) });
        }
        
        // 返回数组与 messageIndices 等长：跳过条目保持 undefined 占位，调用方按
        // undefined 走本地估算/跳过回填，不再出现「返回数组与调用方入参错位」。
        const tokenCounts: Array<number | undefined> = new Array(messageIndices.length).fill(undefined);
        
        if (messagesToCount.length === 0) {
            return tokenCounts;
        }
        
        // 更新代理设置
        this.tokenCountService.setProxyUrl(this.settingsManager.getEffectiveProxyUrl());
        
        // 检查是否启用 API 计数
        const useApiCount = normalizedChannelType && tokenCountConfig[normalizedChannelType]?.enabled;
        
        if (useApiCount) {
            // 并行调用 API 计数；逐条错误隔离——任一次计数抛错只让该条走本地估算，
            // 不因单条失败让整轮上下文裁剪 reject（此前 Promise.all 无逐条 catch，
            // 一次抛错会整轮失败，用户看到莫名 error chunk）。
            const countPromises = messagesToCount.map(({ message }) =>
                this.tokenCountService.countTokens(
                    normalizedChannelType!,
                    tokenCountConfig,
                    [message]
                ).catch(() => ({ success: false as const }))
            );
            
            const results = await Promise.all(countPromises);
            
            // 批量更新消息（一次读写，避免并行 updateMessage 覆盖写）
            const batchUpdates: Array<{ messageIndex: number; updates: Partial<Content> }> = [];

            for (let i = 0; i < messagesToCount.length; i++) {
                const { index, position, message } = messagesToCount[i];
                const result = results[i];

                let tokenCount: number;
                if (result.success && result.totalTokens !== undefined) {
                    tokenCount = result.totalTokens;
                } else {
                    // API 失败，使用估算
                    tokenCount = this.estimateMessageTokens(message);
                }

                const tokenCountByChannel: ChannelTokenCounts = { ...(message.tokenCountByChannel || {}) };
                if (channelType) {
                    tokenCountByChannel[channelType] = tokenCount;
                }

                batchUpdates.push({
                    messageIndex: index,
                    updates: {
                        tokenCountByChannel,
                        estimatedTokenCount: tokenCount
                    }
                });
                tokenCounts[position] = tokenCount;
            }

            await this.conversationManager.updateMessagesBatch(conversationId, batchUpdates);
            return tokenCounts;
        } else {
            // 不使用 API，直接估算并批量更新（一次读写，避免并行 updateMessage 覆盖写）
            const batchUpdates: Array<{ messageIndex: number; updates: Partial<Content> }> = [];

            for (const { index, position, message } of messagesToCount) {
                const tokenCount = this.estimateMessageTokens(message);

                const tokenCountByChannel: ChannelTokenCounts = { ...(message.tokenCountByChannel || {}) };
                if (channelType) {
                    tokenCountByChannel[channelType] = tokenCount;
                }

                batchUpdates.push({
                    messageIndex: index,
                    updates: {
                        tokenCountByChannel,
                        estimatedTokenCount: tokenCount
                    }
                });
                tokenCounts[position] = tokenCount;
            }

            await this.conversationManager.updateMessagesBatch(conversationId, batchUpdates);
            return tokenCounts;
        }
    }
    
    /**
     * 计算系统提示词的 token 数
     *
     * 尝试使用 API 计算精确值，失败时使用估算。
     *
     * @param systemPrompt 系统提示词
     * @param channelType 渠道类型
     * @returns token 数量
     */
    async countSystemPromptTokens(
        systemPrompt: string,
        channelType?: string
    ): Promise<number> {
        if (!this.settingsManager) {
            // 没有设置管理器，直接估算
            return this.estimateTextTokensLocal(systemPrompt);
        }
        
        const tokenCountConfig = this.settingsManager.getTokenCountConfig();
        const normalizedChannelType = this.normalizeChannelType(channelType);
        
        // 尝试调用 API 获取精确 token 数
        if (normalizedChannelType && tokenCountConfig[normalizedChannelType]?.enabled) {
            // 更新代理设置
            this.tokenCountService.setProxyUrl(this.settingsManager.getEffectiveProxyUrl());
            
            // 创建一个包含系统提示词的消息用于 token 计数
            const systemMessage: Content = {
                role: 'user',
                parts: [{ text: systemPrompt }]
            };
            
            const result = await this.tokenCountService.countTokens(
                normalizedChannelType,
                tokenCountConfig,
                [systemMessage]
            );
            
            if (result.success && result.totalTokens !== undefined) {
                return result.totalTokens;
            }
        }
        
        // 回退到估算
        return this.estimateTextTokensLocal(systemPrompt);
    }
    
    /**
     * 批量并行计算多个文本的 token 数
     *
     * 所有计数请求将并行执行，节省时间。
     *
     * @param texts 要计算的文本数组
     * @param channelType 渠道类型
     * @returns token 数量数组（与输入顺序一致）
     */
    async countTextTokensBatch(
        texts: (string | null | undefined)[],
        channelType?: string
    ): Promise<number[]> {
        if (!this.settingsManager) {
            // 没有设置管理器，直接估算
            return texts.map(text => text ? this.estimateTextTokensLocal(text) : 0);
        }
        
        const tokenCountConfig = this.settingsManager.getTokenCountConfig();
        const normalizedChannelType = this.normalizeChannelType(channelType);
        
        // 检查是否启用 API 计数
        const useApiCount = normalizedChannelType && tokenCountConfig[normalizedChannelType]?.enabled;
        
        if (!useApiCount) {
            // 不使用 API，直接估算
            return texts.map(text => text ? this.estimateTextTokensLocal(text) : 0);
        }
        
        // 更新代理设置
        this.tokenCountService.setProxyUrl(this.settingsManager.getEffectiveProxyUrl());
        
        // 筛选出需要计数的文本及其索引
        const textsToCount: Array<{ index: number; text: string }> = [];
        for (let i = 0; i < texts.length; i++) {
            if (texts[i]) {
                textsToCount.push({ index: i, text: texts[i]! });
            }
        }
        
        if (textsToCount.length === 0) {
            return texts.map(() => 0);
        }
        
        // 并行调用 API 计数（带并发上限：避免大量文本同时打 token 计数 API
        // 打爆上游/代理——简单信号量，同时最多 4 个在飞请求）
        const MAX_CONCURRENT_TOKEN_COUNTS = 4;
        let activeCount = 0;
        const waiters: Array<() => void> = [];
        const acquire = async (): Promise<void> => {
            if (activeCount < MAX_CONCURRENT_TOKEN_COUNTS) {
                activeCount++;
                return;
            }
            // 槽位已满：排队等待；release 时槽位直接转移给等待者（等待者不再自增）
            await new Promise<void>((resolve) => waiters.push(resolve));
        };
        const release = (): void => {
            const next = waiters.shift();
            if (next) {
                next(); // 槽位直接转移给等待者
            } else {
                activeCount--;
            }
        };

        const countPromises = textsToCount.map(async ({ text }) => {
            await acquire();
            try {
                const message: Content = {
                    role: 'user',
                    parts: [{ text }]
                };
                return await this.tokenCountService.countTokens(
                    normalizedChannelType!,
                    tokenCountConfig,
                    [message]
                );
            } finally {
                release();
            }
        });
        
        const results = await Promise.all(countPromises);
        
        // 构建结果数组
        const tokenCounts: number[] = texts.map(text => text ? this.estimateTextTokensLocal(text) : 0);
        
        // 填入 API 结果
        for (let i = 0; i < textsToCount.length; i++) {
            const { index } = textsToCount[i];
            const result = results[i];
            if (result.success && result.totalTokens !== undefined) {
                tokenCounts[index] = result.totalTokens;
            }
            // API 失败时保留估算值
        }
        
        return tokenCounts;
    }
}
