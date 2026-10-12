import { StreamPartAccumulator } from './streamAccumulator/StreamPartAccumulator';
/**
 * GrayCode - 流式响应累加器
 *
 * 用于累加流式响应块，生成完整的Content
 * 参考Gemini 流式响应格式设计
 */

import type { Content, ContentPart, UsageMetadata, ThoughtSignatures } from '../conversation';
import type { StreamChunk, StreamUsageMetadata } from './types';
import type { ToolMode } from '../config';
import { IncrementalPromptToolParser } from '../../core/parsers/promptToolParser';
import { buildContentFromState, type BuildContentOptions } from './streamAccumulator/streamContentBuilder';
import { mergeUsageMetadata } from './streamAccumulator/streamUsageMerger';
import { collectNewCompletedFunctionCalls } from './streamAccumulator/streamFunctionCallReporter';
import { reconcileResponsesOutput } from './streamAccumulator/responsesOutput';

export interface StreamingContentOptions {
    includeInternalFields?: boolean;
    /** 是否尝试解析未完成的 partialArgs 为 args（默认 false，流式过程中 JSON 通常不完整） */
    parsePartialArgs?: boolean;
}

/**
 * 流式累加器
 *
 * 负责接收和累加流式响应块，最终生成完整的 Content
 *
 * 设计原则：
 * - 参考Gemini 流式响应格式
 * - 支持思考内容（thought: true）和普通内容的分离
 * - 自动合并相同类型的连续parts
 * - 正确处理 token 统计信息
 * - 支持多格式思考签名存储
 */
export class StreamAccumulator extends StreamPartAccumulator {

    /**
     * 已通过 getNewCompletedFunctionCalls() 返回过的 functionCall id 集合。
     * 用于流式边执行工具：只返回自上次调用以来新完成（args 解析成功）的 functionCall。
     *
     * 用 id 而不是 parts 数组索引去重：parts 的结构可能在流式过程中调整，
     * 索引漂移会导致同一工具被重复上报，进而被重复执行。
     */
    private reportedFunctionCallIds = new Set<string>();

    /** 是否完成 */
    private isDone: boolean = false;

    /** 完整的Token 使用统计 */
    private usageMetadata?: UsageMetadata;

    /** 是否收到过渠道原生的 totalTokenCount */
    private hasProviderTotalTokenCount: boolean = false;

    /** 结束原因 */
    private finishReason?: string;

    /** 模型版本 */
    private modelVersion?: string;

    /** 流式块计数*/
    private chunkCount: number = 0;

    /** 第一个流式块时间戳（毫秒）*/
    private firstChunkTime?: number;

    /** 最后一个流式块时间戳（毫秒）*/
    private lastChunkTime?: number;

    /** 请求开始时间戳（毫秒） - 由外部设置*/
    private requestStartTime?: number;

    /** 当前请求的工具模式*/
    private readonly toolMode: ToolMode;

    constructor(
        toolMode: ToolMode = 'function_call',
        createToolCallId: () => string = () => `fc_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`
    ) {
        super(createToolCallId);
        this.toolMode = toolMode;

        if (toolMode === 'json' || toolMode === 'xml') {
            this.promptToolParser = new IncrementalPromptToolParser(toolMode);
        }
    }

    /**
     * 获取工具模式
     */
    private getToolMode(): ToolMode {
        return this.toolMode;
    }

    /**
     * 合并增量 usage 信息
     *
     * 某些渠道（如 Anthropic）会把输入输出 token 分别放在不同事件里，
     * 这里需要做增量合并，避免后到达的字段覆盖先到达的字段。
     */
    private mergeUsageMetadata(usage: StreamUsageMetadata): void {
        const result = mergeUsageMetadata(this.usageMetadata, this.hasProviderTotalTokenCount, usage);
        this.usageMetadata = result.usageMetadata;
        this.hasProviderTotalTokenCount = result.hasProviderTotalTokenCount;
    }

    /**
     * 添加流式响应块
     *
     * 处理流程：
     * 1. 累加增量内容（delta）
     * 2. 更新 usage、finishReason、modelVersion 等元数据
     * 3. 标记完成状态
     *
     * 注意：OpenAI 格式的流式响应中，usage 可能在单独的 chunk 中发送
     * （choices 为空数组但有 usage 数据），所以即使已经done，
     * 仍然需要接收usage 更新。
     *
     * @param chunk 流式响应块
     */
    add(chunk: StreamChunk): ContentPart[] {
        const now = Date.now();
        const visibleDelta: ContentPart[] = [];

        // 增加块计数
        this.chunkCount++;

        // 记录第一个块的时间
        if (this.chunkCount === 1) {
            this.firstChunkTime = now;
        }

        // 更新最后一个块的时间
        this.lastChunkTime = now;

        // 累加增量内容（如果有）
        // 即使已经 done，也要处理delta（虽然通常 done 后delta 为空）
        if (chunk.delta && chunk.delta.length > 0) {
            for (const part of chunk.delta) {
                this.addPart(part, { visibleDelta, reasoningSummaryIndex: chunk.providerEvent?.summaryIndex, responsesEventType: chunk.providerEvent?.type });
            }
        }

        if (this.providerType === 'openai-responses' && chunk.done && chunk.contentSnapshot) {
            if (this.promptToolParser) {
                // 代理可能只在结束事件补正文；仅喂入未处理的后缀，不能重建已经发出的工具调用。
                const rawText = chunk.contentSnapshot.parts.filter(part => !part.thought && typeof part.text === 'string');
                const reconciled = reconcileResponsesOutput(this.responsesPromptParts, rawText);
                for (const part of reconciled.delta) this.addPart(part, { visibleDelta });
                this.responsesPromptParts = reconciled.parts;
            } else {
                this.exposureEpoch++;
                const reconciled = reconcileResponsesOutput(this.parts, chunk.contentSnapshot.parts);
                this.parts = reconciled.parts;
                visibleDelta.push(...reconciled.delta);
                this.thoughtSignatures = {};
                for (const part of this.parts) Object.assign(this.thoughtSignatures, part.thoughtSignatures);
                this.contentRevision++;
            }
        }

        if (chunk.done && this.promptToolParser) {
            const trailingParts = this.promptToolParser.flushIncompleteAsText();
            for (const part of trailingParts) {
                this.addPart(part, { skipPromptParser: true, visibleDelta });
            }
        }

        // 保存完整的token 使用统计（包括多模态详情）
        // 这个可能在第一个done chunk 中，也可能在后续的usage chunk 中
        if (chunk.usage) {
            this.mergeUsageMetadata(chunk.usage);
        }

        // 保存结束原因（如果有）
        if (chunk.finishReason) {
            this.finishReason = chunk.finishReason;
        }

        // 保存模型版本（如果有）
        if (chunk.modelVersion) {
            this.modelVersion = chunk.modelVersion;
        }

        const stoppedAnthropicFunctionCallBlock =
            this.providerType === 'anthropic' &&
            chunk.providerEvent?.type === 'content_block_stop' &&
            typeof chunk.providerEvent.contentIndex === 'number' &&
            this.parts.some(part => part.functionCall && (part.functionCall as any).index === chunk.providerEvent?.contentIndex);
        if (stoppedAnthropicFunctionCallBlock) {
            // 预填 input（forced tool use）且流式增量从未到达（partialArgs 为空）时，
            // content_block_stop 意味着预填参数即完整参数：清除 prefilledArgs 标记，
            // 恢复 getNewCompletedFunctionCalls 的流式提前执行——否则该调用只能等终态
            // buildContent 清理内部字段后才执行（forced tool use 提前执行退化）。
            // partialArgs 非空（增量仍在合并中）时保持标记，由 tryParseFunctionCallArgs 继续合并。
            for (const part of this.parts) {
                const fc = part.functionCall as any;
                if (fc && fc.index === chunk.providerEvent?.contentIndex && fc.prefilledArgs === true &&
                    (!fc.partialArgs || !String(fc.partialArgs).trim())) {
                    fc.prefilledArgs = false;
                }
            }
        }
        const shouldEmitStructuralSnapshot =
            stoppedAnthropicFunctionCallBlock ||
            (this.providerType === 'anthropic' && chunk.providerEvent?.type === 'message_stop');
        if (shouldEmitStructuralSnapshot) {
            const stoppedIndex = stoppedAnthropicFunctionCallBlock ? chunk.providerEvent?.contentIndex : undefined;
            // Anthropic 的content_block_stop 只终结对应content_block.index；message_stop 才清理所有内部字段。
            // 前端仍通过统一 snapshot 合并入口收束工具卡，不做 provider 特判。
            chunk.contentSnapshot = this.buildContent({
                parsePartialArgs: stoppedIndex === undefined,
                includeInternalFunctionCallFields: stoppedIndex !== undefined,
                warnOnParseFailure: false,
                finalizeFunctionCallIndex: stoppedIndex
            });
        }

        // 更新完成状态
        if (chunk.done) {
            this.isDone = true;
        }
        if (this.providerType === 'openai-responses' && chunk.done && chunk.contentSnapshot && this.promptToolParser) {
            // XML/JSON 模式的原生终态仍是工具标记文本，不能直接交给前端权威替换。
            // 即使结构修订号未变化，也用已经解析的累加内容覆盖，保持工具卡和调用 ID 不变。
            chunk.contentSnapshot = this.getStreamingContent({ parsePartialArgs: true });
        }

        return visibleDelta;
    }

    /**
     * 设置 API 提供商类型
     * 用于确定思考签名的存储格式
     */
    setProviderType(type: 'gemini' | 'gemini-interactions' | 'openai' | 'anthropic' | 'openai-responses' | 'custom'): void {
        this.providerType = type;
    }

    /**
     * 获取 API 提供商类型
     */
    getProviderType(): 'gemini' | 'gemini-interactions' | 'openai' | 'anthropic' | 'openai-responses' | 'custom' {
        return this.providerType;
    }

    /**
     * 构造Content 的唯一内部入口。
     * streaming snapshot 只做轻量投影；最终写历史或工具执行前才解析partialArgs 并清理内部字段。
     * 快照与累加器共享推理数组，交出前推进 epoch，之后的追加先复制。
     */
    private buildContent(options: BuildContentOptions): Content {
        this.exposureEpoch++;
        return buildContentFromState({
            parts: this.parts,
            thoughtSignatures: this.thoughtSignatures,
            modelVersion: this.modelVersion,
            finishReason: this.finishReason,
            usageMetadata: this.usageMetadata,
            thinkingStartTime: this.thinkingStartTime,
            thinkingDuration: this.thinkingDuration,
            hasReceivedNormalText: this.hasReceivedNormalText,
            chunkCount: this.chunkCount,
            firstChunkTime: this.firstChunkTime,
            requestStartTime: this.requestStartTime,
            lastChunkTime: this.lastChunkTime
        }, options);
    }

    /** 获取流式校准快照；保留内部合并字段（index/itemId），便于前端通过 index 匹配工具调用。
     *  默认不解析未完成的 partialArgs；设置 options.parsePartialArgs=true 可解析。*/
    getStreamingContent(options?: StreamingContentOptions): Content {
        return this.buildContent({
            parsePartialArgs: options?.parsePartialArgs ?? false,
            includeInternalFunctionCallFields: options?.includeInternalFields ?? true,
            warnOnParseFailure: false
        });
    }

    /** 获取最终内容：解析 partialArgs，并清理 itemId/index/finalArgs 等内部字段。*/
    getFinalContent(): Content {
        return this.buildContent({
            parsePartialArgs: true,
            includeInternalFunctionCallFields: false,
            warnOnParseFailure: true
        });
    }

    /**
     * 兼容旧调用方的最终Content 入口。
     */
    getContent(): Content {
        return this.getFinalContent();
    }

    /**
     * 获取当前文本内容（用于实时显示）
     *
     * @param options 选项
     * @returns 当前累加的文本
     */
    getText(options?: {
        /** 是否包含思考内容*/
        includeThoughts?: boolean;
    }): string {
        const includeThoughts = options?.includeThoughts ?? false;

        return this.parts
            .filter(part => {
                if (!('text' in part)) {
                    return false;
                }
                // 如果不包含思考内容，过滤掉思考part
                if (!includeThoughts && part.thought === true) {
                    return false;
                }
                return true;
            })
            .map(part => ('text' in part ? part.text : ''))
            .join('');
    }

    /**
     * 获取思考内容（单独获取）
     *
     * @returns 思考内容文本
     */
    getThoughts(): string {
        return this.parts
            .filter(part => 'text' in part && part.thought === true)
            .map(part => ('text' in part ? part.text : ''))
            .join('');
    }

    /**
     * 获取普通内容（不含思考）
     *
     * @returns 普通内容文本
     */
    getNormalText(): string {
        return this.parts
            .filter(part => 'text' in part && part.thought !== true)
            .map(part => ('text' in part ? part.text : ''))
            .join('');
    }

    /**
     * 检查是否完成
     */
    isComplete(): boolean {
        return this.isDone;
    }

    /**
     * 获取结束原因
     */
    getFinishReason(): string | undefined {
        return this.finishReason;
    }

    /**
     * 获取模型版本
     */
    getModelVersion(): string | undefined {
        return this.modelVersion;
    }

    /**
     * 设置模型版本
     */
    setModelVersion(modelVersion: string): void {
        this.modelVersion = modelVersion;
    }

    /**
     * 重置累加器
     */
    reset(): void {
        this.parts = [];
        this.responsesSummarySegments = new WeakMap();
        this.functionCallArgsScans = new WeakMap();
        this.ownedReasoningArrays = new WeakMap();
        this.exposureEpoch++;
        this.responsesPromptParts = [];
        this.isDone = false;
        // 恢复初始 providerType（构造默认 gemini）：reset 后累加器回到全新状态，
        // 避免上一轮渠道的 provider 语义泄漏到下一轮
        this.providerType = 'gemini';
        this.usageMetadata = undefined;
        this.hasProviderTotalTokenCount = false;
        this.finishReason = undefined;
        this.modelVersion = undefined;
        this.thoughtSignatures = {};
        this.thinkingStartTime = undefined;
        this.thinkingDuration = undefined;
        this.hasReceivedNormalText = false;
        this.chunkCount = 0;
        this.firstChunkTime = undefined;
        this.lastChunkTime = undefined;
        this.requestStartTime = undefined;
        this.reportedFunctionCallIds.clear();
        this.contentRevision = 0;

        if (this.promptToolParser) {
            this.promptToolParser.reset();
        }
    }

    /**
     * 设置请求开始时间
     * 修改原因：token 速度需要完整请求耗时，而不是首块到末块的短流出窗口。
     * 修改方式：同一个requestStartTime 同时驱动 responseDuration 与streamDuration 的完整耗时计算。
     * 修改目的：保证后续构造Content 时两个耗时字段同源，避免SSE 攒包导致畸高速率。
     */
    setRequestStartTime(time: number): void {
        this.requestStartTime = time;
    }

    /**
     * 获取流式块计数
     */
    getChunkCount(): number {
        return this.chunkCount;
    }

    /**
     * 获取第一个流式块时间
     */
    getFirstChunkTime(): number | undefined {
        return this.firstChunkTime;
    }

    /**
     * 获取最后一个流式块时间
     */
    getLastChunkTime(): number | undefined {
        return this.lastChunkTime;
    }

    /**
     * 获取思考签名（多格式）
     */
    getThoughtSignatures(): ThoughtSignatures {
        return { ...this.thoughtSignatures };
    }

    /**
     * 获取指定格式的思考签名
     */
    getThoughtSignature(format: string = 'gemini'): string | undefined {
        return this.thoughtSignatures[format];
    }

    /**
     * 获取 token 使用统计
     */
    getUsageMetadata(): UsageMetadata | undefined {
        return this.usageMetadata ? { ...this.usageMetadata } : undefined;
    }

    /**
     * 获取加密思考内容
     *
     * @returns 加密思考内容数组（可能有多个块）
     */
    getRedactedThinking(): string[] {
        return this.parts
            .filter(part => part.redactedThinking)
            .map(part => part.redactedThinking!);
    }

    /** 获取思考开始时间；避免只为发送thinkingStartTime 而构造完整Content。*/
    getThinkingStartTime(): number | undefined {
        return this.thinkingStartTime;
    }

    /**
     * 获取内容结构修订号。
     * 修订号未变化 = 自上次读取以来只发生了纯文本/partialArgs 追加，
     * 前端可完全依赖 delta 还原，无需 contentSnapshot 校准。
     */
    getContentRevision(): number {
        return this.contentRevision;
    }

    /**
     * 获取思考持续时间
     */
    getThinkingDuration(): number | undefined {
        if (this.thinkingDuration !== undefined) {
            return this.thinkingDuration;
        }
        if (this.thinkingStartTime !== undefined && !this.hasReceivedNormalText) {
            return Date.now() - this.thinkingStartTime;
        }
        return undefined;
    }

    /**
     * 获取统计信息
     */
    getStats(): {
        partCount: number;
        textLength: number;
        thoughtsLength: number;
        normalTextLength: number;
        hasThoughts: boolean;
        hasRedactedThinking: boolean;
        hasThoughtSignatures: boolean;
        thoughtSignatureFormats: string[];
        usageMetadata?: UsageMetadata;
        thinkingDuration?: number;
        chunkCount: number;
        firstChunkTime?: number;
        lastChunkTime?: number;
    } {
        const signatureFormats = Object.keys(this.thoughtSignatures).filter(k => this.thoughtSignatures[k]);

        // 单遍累积三种文本长度与标志位，替代三次 filter+map+join 遍历
        // （getText/getThoughts/getNormalText 语义：'text' in part 判定 + thought 标志分流）
        let textLength = 0;
        let thoughtsLength = 0;
        let normalTextLength = 0;
        let hasThoughts = false;
        let hasRedactedThinking = false;
        for (const part of this.parts) {
            if ('text' in part) {
                const text = part.text || '';
                textLength += text.length;
                if (part.thought === true) {
                    thoughtsLength += text.length;
                } else {
                    normalTextLength += text.length;
                }
            }
            if ('thought' in part && part.thought === true) {
                hasThoughts = true;
            }
            if (part.redactedThinking) {
                hasRedactedThinking = true;
            }
        }

        return {
            partCount: this.parts.length,
            textLength,
            thoughtsLength,
            normalTextLength,
            hasThoughts,
            hasRedactedThinking,
            hasThoughtSignatures: signatureFormats.length > 0,
            thoughtSignatureFormats: signatureFormats,
            usageMetadata: this.usageMetadata ? { ...this.usageMetadata } : undefined,
            thinkingDuration: this.getThinkingDuration(),
            chunkCount: this.chunkCount,
            firstChunkTime: this.firstChunkTime,
            lastChunkTime: this.lastChunkTime
        };
    }

    /**
     * 返回自上次调用以来新完成（args 已解析成功）的functionCall。
     *
     * 用于流式边执行工具：ToolIterationLoopService 在流式消费循环中
     * 每处理一个chunk 后调用此方法，检测是否有新的 functionCall 完成）
     * 对不需要确认的工具立即启动异步执行。
     *
     * "完成"的判定：functionCall.args 已有值（partialArgs 已成功JSON.parse）。
     * 每个 functionCall 只会被返回一次（通过 reportedFunctionCallIndices 去重）。
     */
    getNewCompletedFunctionCalls(): Array<{
        index: number;
        name: string;
        id: string;
        args: Record<string, unknown>;
    }> {
        return collectNewCompletedFunctionCalls(this.parts, this.reportedFunctionCallIds);
    }
}
