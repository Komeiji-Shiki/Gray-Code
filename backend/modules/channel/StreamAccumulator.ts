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

interface BuildContentOptions {
    parsePartialArgs: boolean;
    includeInternalFunctionCallFields: boolean;
    warnOnParseFailure: boolean;
    finalizeFunctionCallIndex?: number;
}

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
    private providerType: 'gemini' | 'openai' | 'anthropic' | 'openai-responses' | 'custom' = 'gemini';

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
        const previous = this.usageMetadata;

        if (usage.totalTokenCount !== undefined) {
            this.hasProviderTotalTokenCount = true;
        }

        const merged: UsageMetadata = {
            promptTokenCount: usage.promptTokenCount ?? previous?.promptTokenCount,
            candidatesTokenCount: usage.candidatesTokenCount ?? previous?.candidatesTokenCount,
            totalTokenCount: usage.totalTokenCount ?? previous?.totalTokenCount,
            cachedContentTokenCount: usage.cachedContentTokenCount ?? previous?.cachedContentTokenCount,
            cacheCreationTokenCount: usage.cacheCreationTokenCount ?? previous?.cacheCreationTokenCount,
            cacheReadTokenCount: usage.cacheReadTokenCount ?? previous?.cacheReadTokenCount,
            thoughtsTokenCount: usage.thoughtsTokenCount ?? previous?.thoughtsTokenCount,
            promptTokensDetails: usage.promptTokensDetails ?? previous?.promptTokensDetails,
            candidatesTokensDetails: usage.candidatesTokensDetails ?? previous?.candidatesTokensDetails
        };

        const hasAnyTokenField = merged.promptTokenCount !== undefined ||
            merged.candidatesTokenCount !== undefined ||
            merged.thoughtsTokenCount !== undefined;

        // 某些流式渠道（如 Anthropic）不会直接给 totalTokenCount。
        // 当未收到过渠道原生total 时，每次合并后都用已知字段重算，
        // 避免出现先收到prompt，后收到 candidates 时total 仍停留在 prompt 的问题。
        if (hasAnyTokenField) {
            const prompt = merged.promptTokenCount ?? 0;
            const candidates = merged.candidatesTokenCount ?? 0;
            const thoughts = merged.thoughtsTokenCount ?? 0;

            if (!this.hasProviderTotalTokenCount) {
                merged.totalTokenCount = prompt + candidates + thoughts;
            } else if (usage.totalTokenCount === undefined
                && usage.candidatesTokenCount !== undefined
                && previous?.totalTokenCount !== undefined) {
                // Anthropic：message_start 的 total 只含 input（output 恒 0），
                // message_delta 只带 output_tokens。若已有原生 total，把新的
                // candidates 增量合并进去——否则输出 token 从总量中消失，
                // 下游 ContextTrim/Summarize 的 total−prompt 恒为 0。
                // 仅当本事件未带 total（即不是代理返回的完整 usage）时走此分支。
                const prevCandidates = previous.candidatesTokenCount ?? 0;
                merged.totalTokenCount = previous.totalTokenCount - prevCandidates + usage.candidatesTokenCount;
            } else if (merged.totalTokenCount === undefined) {
                // 理论上有原生 total 时不应进入此分支，但为稳健性保底。
                merged.totalTokenCount = prompt + candidates + thoughts;
            }
        }

        this.usageMetadata = merged;
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
    setProviderType(type: 'gemini' | 'openai' | 'anthropic' | 'openai-responses' | 'custom'): void {
        this.providerType = type;
    }

    /**
     * 获取 API 提供商类型
     */
    getProviderType(): 'gemini' | 'openai' | 'anthropic' | 'openai-responses' | 'custom' {
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

        // Responses API 在 output_item.done 才给出完整 reasoning item。把最终的
        // id/summary/content/encrypted_content 合并回已经由 delta 建立的思考 part，
        // 避免最终摘要被当作第二段文本重复追加，也保证后续轮次可以原样回传。
        if (this.providerType === 'openai-responses' && part.openaiResponsesReasoning) {
            const existingThought = [...this.parts].reverse().find(candidate =>
                candidate.thought === true && !candidate.openaiResponsesReasoning
            );

            if (existingThought) {
                existingThought.openaiResponsesReasoning = {
                    ...part.openaiResponsesReasoning,
                    ...(part.openaiResponsesReasoning.summary ? {
                        summary: part.openaiResponsesReasoning.summary.map(entry => ({ ...entry }))
                    } : {}),
                    ...(part.openaiResponsesReasoning.content ? {
                        content: part.openaiResponsesReasoning.content.map(entry => ({ ...entry }))
                    } : {})
                };
                if (part.thoughtSignatures) {
                    existingThought.thoughtSignatures = {
                        ...(existingThought.thoughtSignatures || {}),
                        ...part.thoughtSignatures
                    };
                }
                // done 中的 summary/content 是最终权威文本，可修复未收到 delta 的兼容端点。
                if (part.text) existingThought.text = part.text;
            } else {
                this.parts.push({
                    ...part,
                    openaiResponsesReasoning: {
                        ...part.openaiResponsesReasoning,
                        ...(part.openaiResponsesReasoning.summary ? {
                            summary: part.openaiResponsesReasoning.summary.map(entry => ({ ...entry }))
                        } : {}),
                        ...(part.openaiResponsesReasoning.content ? {
                            content: part.openaiResponsesReasoning.content.map(entry => ({ ...entry }))
                        } : {})
                    }
                });
                if (options?.visibleDelta && part.text) {
                    options.visibleDelta.push({ text: part.text, thought: true });
                }
            }

            if (part.thoughtSignatures) {
                Object.assign(this.thoughtSignatures, part.thoughtSignatures);
            }
            this.contentRevision++;
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
                                try {
                                    const parsed = JSON.parse(lastFc.partialArgs);
                                    lastFc.args = parsed;
                                    // args 解析成功意味着工具调用“完成”，属于投影可见变化
                                    visibleFieldChanged = true;
                                } catch (e) {
                                    // 解析失败（JSON 不完整），继续等待更多增量。
                                    // 此处不打日志——流式增量中 JSON 不完整是正常现象。
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
                    try {
                        fc.args = JSON.parse(fc.partialArgs);
                    } catch {
                        // Incomplete JSON during streaming is expected; keep partialArgs and wait for more chunks.
                    }
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

        // 思考计时逻辑
        if (isThought) {
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
        let parts = this.parts
            .map(p => {
                const part = { ...p };
                if (part.functionCall) {
                    const fc = { ...part.functionCall } as any;
                    const shouldFinalizeFunctionCall =
                        typeof options.finalizeFunctionCallIndex === 'number' &&
                        typeof fc.index === 'number' &&
                        fc.index === options.finalizeFunctionCallIndex;
                    if ((options.parsePartialArgs || shouldFinalizeFunctionCall) && fc.partialArgs && (!fc.args || Object.keys(fc.args).length === 0)) {
                        try {
                            fc.args = JSON.parse(fc.partialArgs);
                        } catch (e) {
                            if (options.warnOnParseFailure) {
                                const fnName = fc.name || 'unknown';
                                const preview = String(fc.partialArgs || '').slice(0, 200);
                                console.warn(`[StreamAccumulator] Failed to parse tool "${fnName}" partialArgs: ${preview}`);
                            }
                        }
                    }

                    if (!options.includeInternalFunctionCallFields || shouldFinalizeFunctionCall) {
                        delete fc.index;
                        delete fc.partialArgs;
                        // itemId/finalArgs 只是流式合并字段，最终Content 只保留跨 provider 通用协议。
                        delete fc.itemId;
                        delete fc.finalArgs;
                    }
                    part.functionCall = fc;
                }
                return part;
            })
            .filter(p => {
                // 保留非文本part（functionCall 等）
                if (!('text' in p) || p.functionCall) return true;
                // 过滤空文本（但保留有意义的内容）
                if ('text' in p && p.text === '' && !p.thought) return false;
                return true;
            });

        // 添加思考签名到 parts 中
        // 如果有收集到的思考签名，需要作为单独的 part 添加
        // 这样可以在后续发送给 API 时正确传递签名
        if (Object.keys(this.thoughtSignatures).length > 0) {
            // 检查parts 中是否已经有包含 thoughtSignatures 的part
            const hasSignaturePart = parts.some(p => p.thoughtSignatures);
            if (!hasSignaturePart) {
                // 添加一个包含所有格式签名的 part
                parts.push({ thoughtSignatures: { ...this.thoughtSignatures } });
            }
        }

        const content: Content = {
            role: 'model',
            parts
        };

        // 添加模型版本
        if (this.modelVersion) {
            content.modelVersion = this.modelVersion;
        }

        // 添加完整的usageMetadata
        if (this.usageMetadata) {
            content.usageMetadata = { ...this.usageMetadata };
        }

        // 添加思考开始时间（用于前端实时显示）
        if (this.thinkingStartTime !== undefined) {
            content.thinkingStartTime = this.thinkingStartTime;
        }

        // 添加思考持续时间
        // 如果有思考内容但没有普通文本，在获取Content 时计算最终持续时间
        if (this.thinkingStartTime !== undefined) {
            if (this.thinkingDuration !== undefined) {
                content.thinkingDuration = this.thinkingDuration;
            } else if (!this.hasReceivedNormalText) {
                // 消息只有思考内容没有普通文本，使用当前时间计算
                content.thinkingDuration = Date.now() - this.thinkingStartTime;
            }
        }

        // 添加流式统计信息
        content.chunkCount = this.chunkCount;
        if (this.firstChunkTime !== undefined) {
            content.firstChunkTime = this.firstChunkTime;
        }

        // 首字延迟（TTFT）：第一个流式块到达时间 - 请求开始时间
        // 用于前端展示首字等待耗时，并让 Token 速率分母剥离首字等待窗口（避免首字等待拉低速率）
        if (this.firstChunkTime !== undefined && this.requestStartTime !== undefined) {
            const ttft = this.firstChunkTime - this.requestStartTime;
            if (ttft >= 0) {
                content.ttft = ttft;
            }
        }

        // 修改原因：旧 streamDuration 只覆盖首块到末块窗口，上游攒包后会让 token 速度分母过小。
        // 修改方式：用同一个requestStartTime -> lastChunkTime / Date.now() 局部值同时写入responseDuration 与streamDuration。
        // 修改目的：字面修复streamDuration 为完整请求到流结束耗时，并避免两个字段因重复采样产生毫秒级抖动。
        if (this.requestStartTime !== undefined) {
            const completeResponseDuration = (this.lastChunkTime ?? Date.now()) - this.requestStartTime;
            content.responseDuration = completeResponseDuration;
            content.streamDuration = completeResponseDuration;
        }

        return content;
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
        const result: Array<{ index: number; name: string; id: string; args: Record<string, unknown> }> = [];

        for (let i = 0; i < this.parts.length; i++) {
            const part = this.parts[i];
            if (!part.functionCall) continue;

            const fc = part.functionCall as any;
            // "完成"判定：args 必须包含至少一个键，排除初始占位空壳{}。
            //
            // Anthropic content_block_start 发送input: {}，formatter 存为
            // args: {}；OpenAI 首个 tool_call chunk 也设 args: {}。
            // 真正的参数通过后续增量（input_json_delta / arguments delta）
            // 拼接到partialArgs，JSON.parse 成功后才更新 args。
            // 仅检查args 是否为对象会在初始阶段误判为完成，导致以空参数执行。
            //
            // 只有 partialArgs 被成功JSON.parse 后，args 才会含有实际的键。
            const hasRealArgs = fc.args && typeof fc.args === 'object' && Object.keys(fc.args).length > 0;
            // 所有 provider 都要求稳定 id 才允许提前执行：
            // - 常规路径下 functionCall 在入列时就会生成 id，此条件恒满足；
            // - openai-responses 的占位调用要等官方 call_id 到达；
            // - 没有稳定 id 的调用交给最终统一执行路径兜底，
            //   避免 id 后补时与提前执行结果对不上号导致重复执行。
            const hasStableToolCallId = typeof fc.id === 'string' && fc.id.trim().length > 0;
            if (!hasRealArgs || !fc.name || !hasStableToolCallId) continue;
            if (this.reportedFunctionCallIds.has(fc.id)) continue;

            this.reportedFunctionCallIds.add(fc.id);
            result.push({
                index: i,
                name: fc.name,
                id: fc.id,
                // 返回浅拷贝：避免调用方修改污染累加器内部 parts 的 args 引用
                args: { ...fc.args },
            });
        }

        return result;
    }
}