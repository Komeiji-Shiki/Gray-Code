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
import {
    buildContentFromState,
    tryParseFunctionCallArgs,
    type BuildContentOptions
} from './streamAccumulator/streamContentBuilder';
import { mergeUsageMetadata } from './streamAccumulator/streamUsageMerger';
import { collectNewCompletedFunctionCalls } from './streamAccumulator/streamFunctionCallReporter';

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
export class StreamAccumulator {
    /** 累加的parts */
    private parts: ContentPart[] = [];

    /**
     * 已通过 getNewCompletedFunctionCalls() 返回过的 functionCall id 集合。
     * 用于流式边执行工具：只返回自上次调用以来新完成（args 解析成功）的 functionCall。
     *
     * 用 id 而不是 parts 数组索引去重：parts 的结构可能在流式过程中调整，
     * 索引漂移会导致同一工具被重复上报，进而被重复执行。
     */
    private reportedFunctionCallIds = new Set<string>();

    /**
     * 内容结构修订号。
     *
     * 只在“前端无法通过纯文本追加 delta 还原”的结构性变化时递增：
     * 新 part 入列、functionCall 合并出投影可见的字段变化
     * （name/id 补全、args 从增量 JSON 解析成功、思考签名合并）。
     * 纯文本追加与 partialArgs 追加不递增。
     *
     * StreamResponseProcessor 据此判断是否随 chunk 下发 contentSnapshot，
     * 替代以前每个 chunk 对全部 parts 做 JSON.stringify 深比较的 O(n²) 方案。
     */
    private contentRevision = 0;


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

    /** 多格式思考签名*/
    private thoughtSignatures: ThoughtSignatures = {};

    /** API 提供商类型（用于确定签名格式）*/
    private providerType: 'gemini' | 'gemini-interactions' | 'openai' | 'anthropic' | 'openai-responses' | 'custom' = 'gemini';

    /** 思考开始时间戳（毫秒） */
    private thinkingStartTime?: number;

    /** 思考持续时间（毫秒）*/
    private thinkingDuration?: number;

    /** 是否已经收到非思考的普通文本*/
    private hasReceivedNormalText: boolean = false;

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

    /** 当前请求的工具调用ID 工厂 */
    private readonly createToolCallId: () => string;

    /** Prompt 模式下的增量工具解析器*/
    private promptToolParser?: IncrementalPromptToolParser;

    constructor(
        toolMode: ToolMode = 'function_call',
        createToolCallId: () => string = () => `fc_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`
    ) {
        this.toolMode = toolMode;
        this.createToolCallId = createToolCallId;

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
                this.addPart(part, { visibleDelta });
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
     * 添加单个 part
     *
     * 简化策略：直接存储 API 返回的原始part 格式
     * - 文本 part：尝试与相同类型的最后一个part 合并
     * - 非文本part（functionCall、thoughtSignature 等）：直接添加，保持原始结构
     */
    private addPart(
        part: ContentPart,
        options?: {
            skipPromptParser?: boolean;
            visibleDelta?: ContentPart[];
        }
    ): void {
        if (!options?.skipPromptParser && this.promptToolParser && part.text && !part.thought) {
            const parsedParts = this.promptToolParser.appendText(part.text);
            for (const parsedPart of parsedParts) {
                this.addPart(parsedPart, {
                    skipPromptParser: true,
                    visibleDelta: options?.visibleDelta
                });
            }
            return;
        }

        if (this.providerType === 'openai-responses' && part.openaiResponsesReasoning) {
            const incomingMetadata = part.openaiResponsesReasoning;
            const incomingReasoningId = incomingMetadata.id;
            const isReasoningDelta = incomingMetadata.status === 'in_progress';

            // Responses reasoning 走专用合并分支并会在末尾提前 return，不能依赖下方
            // 通用文本分支记录思考起点。首个可见 reasoning 文本到达时立即启动计时，
            // StreamResponseProcessor 才能把 thinkingStartTime 随当前 chunk 发给前端。
            if (part.thought === true && part.text && this.thinkingStartTime === undefined) {
                this.thinkingStartTime = Date.now();
            }

            const thoughtParts = this.parts.filter(candidate => candidate.thought === true);
            let existingThought: ContentPart | undefined;

            if (incomingReasoningId) {
                // 有 item id 时优先精确匹配；若首个最终事件才带 id，允许它
                // 接管此前尚未标注 id 的增量 part。
                existingThought = [...thoughtParts].reverse().find(candidate =>
                    candidate.openaiResponsesReasoning?.id === incomingReasoningId
                ) || [...thoughtParts].reverse().find(candidate =>
                    !candidate.openaiResponsesReasoning?.id
                );
            } else {
                // 部分兼容端点省略 item_id，只能使用最近的思考 part 作为回退。
                existingThought = [...thoughtParts].reverse()[0];
            }

            if (existingThought) {
                const existingMetadata = existingThought.openaiResponsesReasoning || {};
                const incomingSummary = incomingMetadata.summary || [];
                const incomingContent = incomingMetadata.content || [];
                const mergedMetadata = {
                    ...existingMetadata,
                    ...incomingMetadata,
                    ...(isReasoningDelta
                        ? {
                            ...(incomingSummary.length > 0 ? {
                                summary: [...(existingMetadata.summary || []), ...incomingSummary.map(entry => ({ ...entry }))]
                            } : {}),
                            ...(incomingContent.length > 0 ? {
                                content: [...(existingMetadata.content || []), ...incomingContent.map(entry => ({ ...entry }))]
                            } : {})
                        }
                        : {
                            ...(incomingSummary.length > 0 ? {
                                summary: incomingSummary.map(entry => ({ ...entry }))
                            } : (existingMetadata.summary?.length ? {
                                summary: existingMetadata.summary.map(entry => ({ ...entry }))
                            } : {})),
                            ...(incomingContent.length > 0 ? {
                                content: incomingContent.map(entry => ({ ...entry }))
                            } : (existingMetadata.content?.length ? {
                                content: existingMetadata.content.map(entry => ({ ...entry }))
                            } : {}))
                        })
                };
                existingThought.openaiResponsesReasoning = mergedMetadata;

                if (part.thoughtSignatures) {
                    existingThought.thoughtSignatures = {
                        ...(existingThought.thoughtSignatures || {}),
                        ...part.thoughtSignatures
                    };
                }

                if (isReasoningDelta) {
                    if (part.text) {
                        existingThought.text = (existingThought.text || '') + part.text;
                        options?.visibleDelta?.push({ text: part.text, thought: true });
                    }
                } else {
                    // done/output_item.done 中的文本是最终权威值；若事件只带
                    // metadata，则保留此前由 delta 累积的文本。
                    const finalText = part.text
                        || incomingMetadata.summary?.map(entry => entry.text).join('\n')
                        || incomingMetadata.content?.map(entry => entry.text).join('\n');
                    if (finalText) {
                        const hadText = !!existingThought.text;
                        existingThought.text = finalText;
                        // 没有任何 delta、只收到最终事件时，需要让前端看到这段文本；
                        // 已有增量时由 snapshot 校准，不重复发送全文 delta。
                        if (!hadText) options?.visibleDelta?.push({ text: finalText, thought: true });
                    }
                }
            } else {
                const newThought: ContentPart = {
                    ...part,
                    openaiResponsesReasoning: {
                        ...incomingMetadata,
                        ...(incomingMetadata.summary?.length ? {
                            summary: incomingMetadata.summary.map(entry => ({ ...entry }))
                        } : {}),
                        ...(incomingMetadata.content?.length ? {
                            content: incomingMetadata.content.map(entry => ({ ...entry }))
                        } : {})
                    }
                };
                this.parts.push(newThought);
                if (part.text) options?.visibleDelta?.push({ text: part.text, thought: true });
            }

            if (part.thoughtSignatures) {
                Object.assign(this.thoughtSignatures, part.thoughtSignatures);
            }
            // 纯 reasoning delta 已通过 visibleDelta 发送；完成事件需要结构快照
            // 把最终 metadata/id 同步给前端和后续历史。
            if (!isReasoningDelta) this.contentRevision++;
            return;
        }

        // 注意：不在此处为 functionCall 生成 id。
        // id 的生成推迟到合并逻辑确认无法合并、需要作为新 Part 推入时再执行（见下方 newPart 构建处）。

        // 例外：prompt 模式（json/xml）的增量解析器只会产出“完整工具调用块”，
        // 不会再走 partialArgs/index 的流式合并路径。
        // 这里提前补一个稳定id，保证：
        // 1. visibleDelta 里的 functionCall 带有 id
        // 2. 后续写入 this.parts 时沿用同一个id
        // 3. 不影响function_call 模式下的增量合并判断
        if (
            this.promptToolParser &&
            part.functionCall &&
            !(part.functionCall as any).id &&
            (part.functionCall as any).partialArgs === undefined &&
            typeof (part.functionCall as any).index !== 'number'
        ) {
            (part.functionCall as any).id = this.createToolCallId();
        }

        if (options?.visibleDelta && part.text !== undefined) {
            options.visibleDelta.push(part.thought ? { text: part.text, thought: true } : { text: part.text });
        } else if (options?.visibleDelta && part.functionCall) {
            options.visibleDelta.push({ functionCall: { ...(part.functionCall as any) } });
        }

        // 提取 thoughtSignature 用于内部追踪
        if ((part as any).thoughtSignature) {
            this.thoughtSignatures[this.providerType] = (part as any).thoughtSignature;
        }
        if (part.thoughtSignatures) {
            Object.assign(this.thoughtSignatures, part.thoughtSignatures);
        }

        const isFunctionCall = !!(part as any).functionCall;

        // 处理非文本part
        if (!('text' in part)) {
            if (part.functionCall && this.thinkingStartTime !== undefined && !this.hasReceivedNormalText) {
                this.hasReceivedNormalText = true;
                this.thinkingDuration = Date.now() - this.thinkingStartTime;
            }

            if (part.functionCall) {
                const fc = part.functionCall as any;

                // 注意：不在此处为 fc 生成 id，否则会破坏下方"纯增量模式"（!fc.id）的合并判断
                // 倒序搜索现有的parts，寻找可以合并的工具调用块
                // 解决并行调用或中间穿插其他消息导致的 lastPart 匹配失败问题
                for (let i = this.parts.length - 1; i >= 0; i--) {
                    const existingPart = this.parts[i];
                    if (!existingPart.functionCall) continue;

                    const lastFc = existingPart.functionCall as any;

                    // 优化合并判断逻辑
                    let canMerge = false;

                    const incomingItemId = typeof fc.itemId === 'string' && fc.itemId.trim() ? fc.itemId.trim() : '';
                    const lastItemId = typeof lastFc.itemId === 'string' && lastFc.itemId.trim() ? lastFc.itemId.trim() : '';
                    const sameItemId = incomingItemId && lastItemId && incomingItemId === lastItemId;
                    const lastIsFreshTool =
                        (!lastFc.args || Object.keys(lastFc.args).length === 0) &&
                        (lastFc.partialArgs === undefined || lastFc.partialArgs === '');

                    const sameIndex = typeof fc.index === 'number' && typeof lastFc.index === 'number' && fc.index === lastFc.index;

                    // OpenAI 模式：优先使用index 匹配（数字类型，包括 0）
                    if (sameIndex) {
                        canMerge = true;
                    }
                    // OpenAI Responses 的item_id 只用于流式事件定位，必须合并到占位function_call，不能作为最终工具ID。
                    else if (sameItemId) {
                        canMerge = true;
                    }
                    // Anthropic 模式：使用id 标识
                    else if (fc.id && lastFc.id) {
                        canMerge = fc.id === lastFc.id;
                    }
                    // 兼容流可能省略output_index；此时把参数增量合并到最后一个刚创建的空工具壳。
                    else if (!fc.id && typeof fc.index !== 'number' && fc.partialArgs !== undefined && i === this.parts.length - 1 && lastIsFreshTool) {
                        canMerge = true;
                    }
                    // 纯增量模式：没有 id 也没有index，但有partialArgs，且是最后一个FC
                    else if (!fc.id && typeof fc.index !== 'number' && fc.partialArgs !== undefined && i === this.parts.length - 1) {
                        canMerge = true;
                    }

                    if (canMerge) {
                        // 跟踪本次合并是否产生“最终投影可见”的字段变化，
                        // 只有可见变化才需要递增结构修订号（触发 snapshot 校准）。
                        // partialArgs 纯追加在最终投影中不可见，不算。
                        let visibleFieldChanged = false;

                        // 合并名称（如果有）
                        if (fc.name && !lastFc.name) {
                            lastFc.name = fc.name;
                            visibleFieldChanged = true;
                        }
                        // 合并 ID；Responses 的官方call_id 到达较晚时，可在 itemId/index 已证明同源后覆盖占位 id。
                        if (fc.id && (!lastFc.id || (this.providerType === 'openai-responses' && (sameItemId || sameIndex)))) {
                            if (lastFc.id !== fc.id) {
                                lastFc.id = fc.id;
                                visibleFieldChanged = true;
                            }
                        }
                        // itemId 仅用于后续流式片段定位，最终Content 会统一删除。
                        if (fc.itemId && !lastFc.itemId) {
                            lastFc.itemId = fc.itemId;
                        }
                        // 合并 index（如果有）
                        if (typeof fc.index === 'number' && typeof lastFc.index !== 'number') {
                            lastFc.index = fc.index;
                        }
                        // Anthropic delta 只有 index 没有 tool_use.id；index 命中时保留已有官方id，维持id/index 语义分离。
                        // 合并思考签名等其他属性
                        if (part.thoughtSignatures) {
                            existingPart.thoughtSignatures = {
                                ...(existingPart.thoughtSignatures || {}),
                                ...part.thoughtSignatures
                            };
                            visibleFieldChanged = true;
                        }
                        if ((part as any).thoughtSignature) {
                            existingPart.thoughtSignatures = {
                                ...(existingPart.thoughtSignatures || {}),
                                [this.providerType]: (part as any).thoughtSignature
                            };
                            visibleFieldChanged = true;
                        }
                        // 合并 partialArgs
                        if (fc.partialArgs !== undefined) {
                            // finalArgs 表示完整 arguments，应覆盖而不是继续追加到增量 JSON。
                            lastFc.partialArgs = fc.finalArgs === true
                                ? fc.partialArgs
                                : (lastFc.partialArgs || '') + fc.partialArgs;

                            // Responses 的arguments.delta 是半截JSON，避免在高频热路径逐片段JSON.parse。
                            const shouldParseNow = this.providerType !== 'openai-responses' || fc.finalArgs === true;
                            if (shouldParseNow && lastFc.partialArgs.trim()) {
                                // 解析成功意味着工具调用“完成”，属于投影可见变化
                                //（预填 input 场景按「预填 + 增量 / 增量自身」两种语义解析）
                                if (tryParseFunctionCallArgs(lastFc)) {
                                    visibleFieldChanged = true;
                                }
                            }
                        }

                        if (visibleFieldChanged) {
                            this.contentRevision++;
                        }
                        return; // 成功合并，直接返回
                    }
                }

                // 找不到可合并块时作为新块添加；Responses 半截 JSON 只在 finalArgs 边界解析。
                if (fc.partialArgs && (this.providerType !== 'openai-responses' || fc.finalArgs === true)) {
                    tryParseFunctionCallArgs(fc);
                }

                // 构建新Part，但排除 API 原始格式的thoughtSignature（单数）
                const { thoughtSignature: rawSignature, ...restPart } = part as any;
                const newPart: ContentPart = { ...restPart };
                // 确保 functionCall 是深拷贝的，且处理了 args
                newPart.functionCall = { ...fc };
                // 只在作为新Part 推入时才生成 id；带 itemId 的Responses 占位等待官方 call_id。
                if (newPart.functionCall && !newPart.functionCall.id && !(this.providerType === 'openai-responses' && (newPart.functionCall as any).itemId)) {
                    (newPart.functionCall as any).id = this.createToolCallId();
                }
                if (fc.args && newPart.functionCall) newPart.functionCall.args = { ...fc.args };

                // 如果有API 原始格式的thoughtSignature，转换为 thoughtSignatures 格式
                if (rawSignature) {
                    newPart.thoughtSignatures = {
                        ...(newPart.thoughtSignatures || {}),
                        [this.providerType]: rawSignature
                    };
                }

                this.parts.push(newPart);
                this.contentRevision++;
                return;
            }

            // 其他非文本Part（如图片、文件等）
            // 排除 API 原始格式的thoughtSignature（单数），转换为 thoughtSignatures 格式
            const { thoughtSignature: rawSig, ...restNonTextPart } = part as any;
            const nonTextPart: ContentPart = { ...restNonTextPart };
            if (rawSig) {
                nonTextPart.thoughtSignatures = {
                    ...(nonTextPart.thoughtSignatures || {}),
                    [this.providerType]: rawSig
                };
            }
            this.parts.push(nonTextPart);
            this.contentRevision++;
            return;
        }

        // 文本 part：尝试合并
        const isThought = part.thought === true;

        // 思考计时逻辑：只有明确来自 thought delta 的文本才更新思考开始时间；
        // Responses reasoning 增量（openaiResponsesReasoning.status='in_progress'）
        // 在 done/output_item.done 前不应影响 thinkingDuration 结算。
        if (isThought && !(this.providerType === 'openai-responses' && part.openaiResponsesReasoning?.status === 'in_progress')) {
            // 记录思考开始时间（仅首次）
            if (this.thinkingStartTime === undefined) {
                this.thinkingStartTime = Date.now();
            }
        } else if (part.text) {
            // 收到普通文本时，计算思考持续时间
            if (this.thinkingStartTime !== undefined && !this.hasReceivedNormalText) {
                this.hasReceivedNormalText = true;
                this.thinkingDuration = Date.now() - this.thinkingStartTime;
            }
        }

        const lastPart = this.parts[this.parts.length - 1];

        // 检查是否可以与最后一个part 合并（都是文本且思考类型相同）
        if (lastPart && 'text' in lastPart && !lastPart.functionCall) {
            const lastIsThought = lastPart.thought === true;

            if (lastIsThought === isThought) {
                // 纯文本追加：前端可通过 delta 自行还原，不递增结构修订号
                lastPart.text = (lastPart.text ?? '') + (part.text ?? '');
                return;
            }
        }

        // 无法合并，添加新 part
        // 排除 API 原始格式的thoughtSignature（单数），转换为 thoughtSignatures 格式
        const { thoughtSignature: rawTextSig, ...restTextPart } = part as any;
        const textPart: ContentPart = { ...restTextPart };
        if (rawTextSig) {
            textPart.thoughtSignatures = {
                ...(textPart.thoughtSignatures || {}),
                [this.providerType]: rawTextSig
            };
        }
        this.parts.push(textPart);
        this.contentRevision++;
    }

    // 注意：这里以前有一个 extractAndConvertToolCalls()，在每次文本合并后
    // 全量重扫所有 parts、把文本中的工具调用标记转换为 functionCall。
    // 该职责已完全由 IncrementalPromptToolParser（addPart 入口处）接管：
    // - 非思考文本在进入 parts 前就被增量解析器消费，不会残留完整标记；
    // - 思考（thought）文本中的标记按系统语义不视为真实调用
    //   （ToolCallParserService.extractFunctionCalls 同样跳过 thought part）。
    // 旧路径除了 O(n²) 的重复扫描外，还会重建 parts 数组导致索引漂移，故删除。

    /**
     * 构造Content 的唯一内部入口。
     * streaming snapshot 只做轻量投影；最终写历史或工具执行前才解析partialArgs 并清理内部字段。
     */
    private buildContent(options: BuildContentOptions): Content {
        return buildContentFromState({
            parts: this.parts,
            thoughtSignatures: this.thoughtSignatures,
            modelVersion: this.modelVersion,
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