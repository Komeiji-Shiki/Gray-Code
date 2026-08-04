/**
 * LimCode - 流式响应处理器
 *
 * 封装流式响应处理的公共逻辑，包括：
 * - 流式响应累积
 * - 取消处理
 * - Chunk 处理和增量计算
 * - 部分内容保存
 */

import type { Content } from '../../../conversation/types';
import type { StreamChunk, GenerateResponse } from '../../../channel/types';
import { StreamAccumulator } from '../../../channel/StreamAccumulator';
import { ChannelError, ErrorType } from '../../../channel/types';
import type { ToolMode } from '../../../config/configs/base';
import { generateToolCallId } from '../utils';

/**
 * 流式处理配置
 */
export interface StreamProcessorConfig {
    /** 请求开始时间（用于计算响应持续时间） */
    requestStartTime: number;
    /** 渠道类型 */
    providerType: 'gemini' | 'openai' | 'anthropic' | 'openai-responses' | 'custom';
    /** 当前请求的工具模式 */
    toolMode: ToolMode;
    /** 取消信号 */
    abortSignal?: AbortSignal;
    /** 对话 ID */
    conversationId: string;
}

/**
 * 流式 chunk 数据（用于 yield）
 */
export interface ProcessedChunkData {
    conversationId: string;
    chunk: StreamChunk & { thinkingStartTime?: number };
}

/**
 * 取消数据（用于 yield）
 */
export interface CancelledData {
    conversationId: string;
    cancelled: true;
    content?: Content;
}

/**
 * 流式响应处理器
 *
 * 提供统一的流式响应处理逻辑，减少 ChatHandler 中的重复代码
 */
export class StreamResponseProcessor {
    private accumulator: StreamAccumulator;
    private config: StreamProcessorConfig;
    private cancelled: boolean = false;
    /**
     * 上一个 chunk 处理完时的内容结构修订号。
     * 修订号变化 = 发生了纯文本追加无法表达的结构性变化，需要下发 contentSnapshot 校准前端。
     * 替代以前每个 chunk 全量重建 Content 并逐 part JSON.stringify 深比较的 O(n²) 方案。
     */
    private lastContentRevision?: number;

    constructor(config: StreamProcessorConfig) {
        this.config = config;
        this.accumulator = new StreamAccumulator(config.toolMode, generateToolCallId);
        this.accumulator.setRequestStartTime(config.requestStartTime);
        this.accumulator.setProviderType(config.providerType);
    }

    /** 暴露内部累加器，供 ToolIterationLoopService 实现流式边执行工具 */
    getAccumulator(): StreamAccumulator {
        return this.accumulator;
    }

    /**
     * 处理流式响应
     *
     * 这是一个生成器函数，会 yield 处理后的 chunk 数据
     *
     * @param response 流式响应生成器
     * @yields 处理后的 chunk 数据
     */
    async *processStream(
        response: AsyncGenerator<StreamChunk>
    ): AsyncGenerator<ProcessedChunkData> {
        try {
            for await (const chunk of response) {
                // 检查是否已取消
                if (this.config.abortSignal?.aborted) {
                    this.cancelled = true;
                    break;
                }

                const normalizedDelta = this.accumulator.add(chunk);

                // 结构修订号未变 = 本 chunk 只有纯文本/参数增量追加，前端可由 delta 自行还原；
                // 仅在结构性变化时才构建完整 Content 快照下发（首个 chunk 不发，与旧行为一致）。
                const revision = this.accumulator.getContentRevision();
                const shouldSendSnapshot = this.lastContentRevision !== undefined && revision !== this.lastContentRevision;
                this.lastContentRevision = revision;

                // 构建处理后的 chunk
                const processedChunk: StreamChunk & { thinkingStartTime?: number } = {
                    ...chunk,
                    delta: normalizedDelta
                };

                if (shouldSendSnapshot) {
                    // 使用 getStreamingContent 保留 index/itemId 内部字段，确保前端能通过 index 匹配工具调用。
                    // getFinalContent 会清理这些字段，导致 Anthropic 等 id 延迟到达的渠道出现重复工具调用框。
                    processedChunk.contentSnapshot = this.accumulator.getStreamingContent({ parsePartialArgs: true });
                }

                // 如果有思考开始时间，添加到 chunk（直接从累加器读，避免为此构建完整 Content）
                const thinkingStartTime = this.accumulator.getThinkingStartTime();
                if (thinkingStartTime !== undefined) {
                    processedChunk.thinkingStartTime = thinkingStartTime;
                }

                yield {
                    conversationId: this.config.conversationId,
                    chunk: processedChunk
                };
            }
        } catch (err) {
            // 如果是取消错误，设置 cancelled 为 true
            if (this.config.abortSignal?.aborted ||
                (err instanceof ChannelError && err.type === ErrorType.CANCELLED_ERROR)) {
                this.cancelled = true;
            } else {
                throw err;
            }
        }
    }

    /**
     * 获取最终内容
     */
    getContent(): Content {
        return this.accumulator.getFinalContent();
    }

    /**
     * 是否已取消
     */
    isCancelled(): boolean {
        return this.cancelled;
    }

    /**
     * 获取取消数据（用于 yield）
     */
    getCancelledData(): CancelledData {
        const content = this.accumulator.getFinalContent();
        if (content.parts.length > 0) {
            // 取消流的内容 usage 是半截数据，标记以便统计端（usageStats/getStats）回退估算
            content.usageMetadataPartial = true;
            return {
                conversationId: this.config.conversationId,
                cancelled: true,
                content
            };
        } else {
            return {
                conversationId: this.config.conversationId,
                cancelled: true
            };
        }
    }

    /**
     * 处理非流式响应
     *
     * @param response 非流式响应
     * @returns 处理后的数据
     */
    processNonStream(response: GenerateResponse): {
        content: Content;
        chunkData: ProcessedChunkData;
    } {
        const content = response.content;
        // 添加响应持续时间
        content.responseDuration = Date.now() - this.config.requestStartTime;
        content.chunkCount = 1;

        // 模拟一个完成块
        const chunkData: ProcessedChunkData = {
            conversationId: this.config.conversationId,
            chunk: {
                delta: content.parts,
                done: true
            }
        };

        return { content, chunkData };
    }

}

/**
 * 检查响应是否是 AsyncGenerator
 */
export function isAsyncGenerator<T = unknown>(obj: any): obj is AsyncGenerator<T> {
    return obj && typeof obj[Symbol.asyncIterator] === 'function';
}
