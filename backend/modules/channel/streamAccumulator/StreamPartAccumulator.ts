import type { ContentPart, ThoughtSignatures } from '../../conversation';
import { IncrementalPromptToolParser } from '../../../core/parsers/promptToolParser';
import { tryParseFunctionCallArgs } from './streamContentBuilder';
import { mergeResponsesMessagePart } from './responsesOutput';
import { createJsonClosureState, mayBeClosedJsonObject, scanJsonClosure, type JsonClosureState } from './jsonClosureScanner';

interface ResponsesSummaryState {
    segments: Map<number, string>;
    /** segments 的键升序排列；正常顺序下只会在末尾追加 */
    order: number[];
    text: string;
    reasoning: ContentPart['openaiResponsesReasoning'];
}

interface FunctionCallArgsScanState {
    text: string;
    plain: JsonClosureState;
    /** 预填 input 的「预填 JSON 去尾闭合符 + 增量」候选；无预填时为 undefined */
    prefilled?: JsonClosureState;
    prefilledArgs: unknown;
    prefilledFlag: unknown;
}

/** 只维护内容块及其增量解析状态，整轮统计由 StreamAccumulator 负责。 */
export class StreamPartAccumulator {
    /** 累加的parts */
    protected parts: ContentPart[] = [];

    /** 摘要索引只用于当前流内合并，持久化仍使用标准 summary 数组。 */
    protected responsesSummarySegments = new WeakMap<ContentPart, ResponsesSummaryState>();

    /** 只服务于增量参数的解析门控，不进入 Content，也不参与持久化。 */
    protected functionCallArgsScans = new WeakMap<object, FunctionCallArgsScanState>();

    /**
     * 无 summary_index 的推理 delta 追加 summary/content 时的写时复制状态。快照只浅拷贝 part，
     * 会与累加器共享这些数组；每次对外交出 parts（构造快照、终态校准）后 epoch 加一，
     * 仅当数组在当前 epoch 内由本累加器新建、尚未交出时才原地追加，否则先复制一次。
     * 这样连续 delta 不再每次复制整个数组，已交出的快照也不会被后续修改。
     */
    protected exposureEpoch = 0;

    protected ownedReasoningArrays = new WeakMap<object, number>();

    /** 提示词工具的原始 message 用于比较 done 全文，工具 ID 仍由同一个增量解析器维护。 */
    protected responsesPromptParts: ContentPart[] = [];

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
    protected contentRevision = 0;

    /** 多格式思考签名*/
    protected thoughtSignatures: ThoughtSignatures = {};

    /** API 提供商类型（用于确定签名格式）*/
    protected providerType: 'gemini' | 'gemini-interactions' | 'openai' | 'anthropic' | 'openai-responses' | 'custom' = 'gemini';

    /** 思考开始时间戳（毫秒） */
    protected thinkingStartTime?: number;

    /** 思考持续时间（毫秒）*/
    protected thinkingDuration?: number;

    /** 是否已经收到非思考的普通文本*/
    protected hasReceivedNormalText: boolean = false;

    /** Prompt 模式下的增量工具解析器*/
    protected promptToolParser?: IncrementalPromptToolParser;

    /**
     * 添加单个 part
     *
     * 简化策略：直接存储 API 返回的原始part 格式
     * - 文本 part：尝试与相同类型的最后一个part 合并
     * - 非文本part（functionCall、thoughtSignature 等）：直接添加，保持原始结构
     */
    protected addPart(
        part: ContentPart,
        options?: {
            skipPromptParser?: boolean;
            visibleDelta?: ContentPart[];
            reasoningSummaryIndex?: number;
            responsesEventType?: string;
        },
    ): void {
        if (this.promptToolParser && !options?.skipPromptParser && this.providerType === 'openai-responses') {
            if (part.openaiResponsesMessage) {
                const merged = mergeResponsesMessagePart(this.responsesPromptParts, part, options?.responsesEventType);
                if (!merged.delta.length) return;
                part = merged.delta[0];
            } else if (part.text && !part.thought) {
                // 没有 item 定位符的旧文本事件仍归入最近的 message，与普通累加路径保持一致。
                const last = this.responsesPromptParts.at(-1);
                if (last) last.text = (last.text ?? '') + part.text;
                else this.responsesPromptParts.push({ text: part.text });
            }
        }
        if (!options?.skipPromptParser && this.promptToolParser && part.text && !part.thought) {
            const parsedParts = this.promptToolParser.appendText(part.text);
            for (const parsedPart of parsedParts) {
                this.addPart(parsedPart, {
                    skipPromptParser: true,
                    visibleDelta: options?.visibleDelta,
                });
            }
            return;
        }

        if (this.providerType === 'openai-responses' && part.openaiResponsesMessage) {
            if (part.text && this.thinkingStartTime !== undefined && !this.hasReceivedNormalText) {
                this.hasReceivedNormalText = true;
                this.thinkingDuration = Date.now() - this.thinkingStartTime;
            }
            const merged = mergeResponsesMessagePart(this.parts, part, options?.responsesEventType);
            options?.visibleDelta?.push(...merged.delta);
            if (merged.structural) this.contentRevision++;
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

            let existingThought: ContentPart | undefined;
            let unassignedThought: ContentPart | undefined;
            // 通常连续增量属于末尾思考段，倒序直接查找，避免每个片段分配过滤和反转数组。
            // 有 id 时仍优先精确匹配；最终事件才补 id 时接管最近的无 id 思考段。
            for (let index = this.parts.length - 1; index >= 0; index--) {
                const candidate = this.parts[index];
                if (candidate.thought !== true) continue;
                if (!incomingReasoningId || candidate.openaiResponsesReasoning?.id === incomingReasoningId) {
                    existingThought = candidate;
                    break;
                }
                if (!unassignedThought && !candidate.openaiResponsesReasoning?.id) unassignedThought = candidate;
            }
            existingThought ??= unassignedThought;

            const summaryIndex = options?.reasoningSummaryIndex;
            if (typeof summaryIndex === 'number' && Number.isInteger(summaryIndex) && summaryIndex >= 0 && incomingMetadata.summary?.length) {
                // text.done 只完成 summary_index 指向的一段，并不代表整个 reasoning item。
                // 各段分别合并，避免第二段完成后遇到中断时覆盖已经展示的第一段。
                const target = existingThought || { ...part };
                const previousText = existingThought?.text || '';
                const state: ResponsesSummaryState = this.responsesSummarySegments.get(target) ?? {
                    segments: new Map((existingThought?.openaiResponsesReasoning?.summary || []).map((entry, index) => [index, entry.text])),
                    order: [],
                    text: '',
                    reasoning: undefined,
                };
                this.responsesSummarySegments.set(target, state);
                const incomingText = incomingMetadata.summary.map((entry) => entry.text).join('');
                const lastIndex = state.order.length ? state.order[state.order.length - 1] : -1;
                // 正常顺序：delta 追加到最后一段或开启更大索引的新段，且 part 仍是本状态上次写入的结果。
                // 此时新全文必然是「旧全文 + [换行] + 增量」，可以直接拼接，不必重新排序、join 全部分段再比较前缀；
                // 长摘要小片段输出时旧做法的累计扫描量接近平方增长。
                // 乱序（较早段收到 delta 或新段索引小于已有最大值）、done 替换全文、part 被其他分支改写时
                // 走下方完整排序与前缀校准。
                if (
                    existingThought &&
                    isReasoningDelta &&
                    summaryIndex >= lastIndex &&
                    state.text === existingThought.text &&
                    state.reasoning === existingThought.openaiResponsesReasoning
                ) {
                    const isNewSegment = summaryIndex > lastIndex;
                    state.segments.set(summaryIndex, (state.segments.get(summaryIndex) || '') + incomingText);
                    if (isNewSegment) state.order.push(summaryIndex);
                    // 已有段时 join('\n') 会在新段前插入换行；空增量开启的新段同样要补换行以保持一致。
                    const appended = (isNewSegment && state.order.length > 1 ? '\n' : '') + incomingText;
                    const summary = state.order.map((index) => ({ type: 'summary_text' as const, text: state.segments.get(index)! }));
                    existingThought.openaiResponsesReasoning = {
                        ...existingThought.openaiResponsesReasoning,
                        ...incomingMetadata,
                        summary,
                    };
                    existingThought.text = previousText + appended;
                    state.text = existingThought.text;
                    state.reasoning = existingThought.openaiResponsesReasoning;
                    if (appended) options?.visibleDelta?.push({ text: appended, thought: true });
                    return;
                }
                state.segments.set(summaryIndex, isReasoningDelta ? (state.segments.get(summaryIndex) || '') + incomingText : incomingText);
                state.order = [...state.segments.keys()].sort((a, b) => a - b);
                const summary = state.order.map((index) => ({ type: 'summary_text' as const, text: state.segments.get(index)! }));
                target.openaiResponsesReasoning = {
                    ...target.openaiResponsesReasoning,
                    ...incomingMetadata,
                    summary,
                };
                target.text = summary.map((entry) => entry.text).join('\n');
                state.text = target.text;
                state.reasoning = target.openaiResponsesReasoning;
                if (!existingThought) this.parts.push(target);
                const canAppendText = target.text.startsWith(previousText);
                if (canAppendText && target.text.length > previousText.length) {
                    options?.visibleDelta?.push({ text: target.text.slice(previousText.length), thought: true });
                }
                if (!existingThought || !isReasoningDelta || !canAppendText) this.contentRevision++;
                return;
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
                              ...(incomingSummary.length > 0
                                  ? {
                                        summary: this.appendReasoningEntries(existingMetadata.summary, incomingSummary),
                                    }
                                  : {}),
                              ...(incomingContent.length > 0
                                  ? {
                                        content: this.appendReasoningEntries(existingMetadata.content, incomingContent),
                                    }
                                  : {}),
                          }
                        : {
                              ...(incomingSummary.length > 0
                                  ? {
                                        summary: incomingSummary.map((entry) => ({ ...entry })),
                                    }
                                  : existingMetadata.summary?.length
                                    ? {
                                          summary: existingMetadata.summary.map((entry) => ({ ...entry })),
                                      }
                                    : {}),
                              ...(incomingContent.length > 0
                                  ? {
                                        content: incomingContent.map((entry) => ({ ...entry })),
                                    }
                                  : existingMetadata.content?.length
                                    ? {
                                          content: existingMetadata.content.map((entry) => ({ ...entry })),
                                      }
                                    : {}),
                          }),
                };
                existingThought.openaiResponsesReasoning = mergedMetadata;

                if (part.thoughtSignatures) {
                    existingThought.thoughtSignatures = {
                        ...(existingThought.thoughtSignatures || {}),
                        ...part.thoughtSignatures,
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
                    const finalText =
                        part.text ||
                        incomingMetadata.summary?.map((entry) => entry.text).join('\n') ||
                        incomingMetadata.content?.map((entry) => entry.text).join('\n');
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
                        ...(incomingMetadata.summary?.length
                            ? {
                                  summary: incomingMetadata.summary.map((entry) => ({ ...entry })),
                              }
                            : {}),
                        ...(incomingMetadata.content?.length
                            ? {
                                  content: incomingMetadata.content.map((entry) => ({ ...entry })),
                              }
                            : {}),
                    },
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
                        (!lastFc.args || Object.keys(lastFc.args).length === 0) && (lastFc.partialArgs === undefined || lastFc.partialArgs === '');

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
                    else if (
                        !fc.id &&
                        !incomingItemId &&
                        typeof fc.index !== 'number' &&
                        fc.partialArgs !== undefined &&
                        i === this.parts.length - 1 &&
                        lastIsFreshTool
                    ) {
                        canMerge = true;
                    }
                    // 纯增量模式：没有 id 也没有index，但有partialArgs，且是最后一个FC
                    else if (!fc.id && !incomingItemId && typeof fc.index !== 'number' && fc.partialArgs !== undefined && i === this.parts.length - 1) {
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
                        // async 可能只在完整 item 到达时给出，需保留到最终历史。
                        if (typeof fc.async === 'boolean' && lastFc.async !== fc.async) {
                            lastFc.async = fc.async;
                            visibleFieldChanged = true;
                        }
                        // namespace 可能只在完整调用到达时给出，不能在分段合并中丢掉其上游作用域。
                        if (typeof fc.namespace === 'string' && lastFc.namespace !== fc.namespace) {
                            lastFc.namespace = fc.namespace;
                            visibleFieldChanged = true;
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
                                ...part.thoughtSignatures,
                            };
                            visibleFieldChanged = true;
                        }
                        if ((part as any).thoughtSignature) {
                            existingPart.thoughtSignatures = {
                                ...(existingPart.thoughtSignatures || {}),
                                [this.providerType]: (part as any).thoughtSignature,
                            };
                            visibleFieldChanged = true;
                        }
                        // 合并 partialArgs
                        if (fc.partialArgs !== undefined) {
                            const previousArgs = lastFc.partialArgs;
                            // finalArgs 表示完整 arguments，应覆盖而不是继续追加到增量 JSON。
                            lastFc.partialArgs = fc.finalArgs === true ? fc.partialArgs : (lastFc.partialArgs || '') + fc.partialArgs;

                            // Responses 的arguments.delta 是半截JSON，避免在高频热路径逐片段JSON.parse。
                            const shouldParseNow = this.providerType !== 'openai-responses' || fc.finalArgs === true;
                            // 其他渠道先用增量闭合扫描门控：门控为 false 时旧逻辑的 trim/parse 必然跳过或失败，
                            // 省去的只是对累计全文的无效扫描与异常；门控为 true 时仍走原有解析路径。
                            const mayComplete =
                                !shouldParseNow || fc.finalArgs === true ? true : this.mayCompleteFunctionCallArgs(lastFc, previousArgs, fc.partialArgs);
                            if (shouldParseNow && mayComplete && lastFc.partialArgs.trim()) {
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
                        [this.providerType]: rawSignature,
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
                    [this.providerType]: rawSig,
                };
            }

            // Gemini Interactions 会把 thought 文本与签名拆成不同事件；签名元数据应并回
            // 紧邻的 thought part，避免历史回传时生成「摘要 thought + 仅签名 thought」两步。
            const isSignatureOnlyThought =
                this.providerType === 'gemini-interactions' &&
                nonTextPart.thought === true &&
                !!nonTextPart.thoughtSignatures &&
                Object.entries(nonTextPart).every(([key, value]) => value === undefined || key === 'thought' || key === 'thoughtSignatures');
            if (isSignatureOnlyThought) {
                const previousPart = this.parts[this.parts.length - 1];
                if (previousPart?.thought === true) {
                    const incomingSignatures = nonTextPart.thoughtSignatures || {};
                    const previousSignatures = previousPart.thoughtSignatures || {};
                    const hasConflictingSignature = Object.entries(incomingSignatures).some(
                        ([provider, signature]) => !!previousSignatures[provider] && !!signature && previousSignatures[provider] !== signature,
                    );
                    // 无冲突或签名相同：属于同一 thought 的后到元数据，可安全并入。
                    // 同一 provider 的签名不同通常代表新的无摘要 thought step，保留独立 part。
                    if (!hasConflictingSignature) {
                        previousPart.thoughtSignatures = {
                            ...previousSignatures,
                            ...incomingSignatures,
                        };
                        this.contentRevision++;
                        return;
                    }
                }
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

            // Gemini 的签名属于原始 part，带签名的文本不能与相邻文本合并。
            // 流末也可能单独返回带签名的空文本 part，必须保留其边界供下轮原样回传。
            const hasGeminiSignatureBoundary =
                this.providerType === 'gemini' &&
                (!!part.thoughtSignatures?.gemini || !!(part as any).thoughtSignature || !!lastPart.thoughtSignatures?.gemini);
            if (lastIsThought === isThought && !hasGeminiSignatureBoundary) {
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
                [this.providerType]: rawTextSig,
            };
        }
        this.parts.push(textPart);
        this.contentRevision++;
    }

    /**
     * 增量参数是否可能已经拼成完整 JSON 对象（tryParseFunctionCallArgs 的必要条件）。
     *
     * 状态只在「上次扫描的全文 + 本次片段 = 当前全文」时增量推进；参数被整体替换、解析成功后清空、
     * 预填 args 变化或非字符串时从当前全文重建（这些场景全文很短或只发生一次）。
     * 候选与 tryParseFunctionCallArgs 一一对应：预填时同时跟踪「预填 JSON 去尾闭合符 + 增量」和「增量自身」。
     * 任一候选首字符不是 '{'（数组、标量、预填剩余片段以 ',' 开头等）无法用深度判断，返回 true 回退为旧行为。
     */
    private mayCompleteFunctionCallArgs(fc: any, previousArgs: unknown, fragment: unknown): boolean {
        const text = fc.partialArgs;
        if (typeof text !== 'string') return true;

        const prefilledArgs = fc.prefilledArgs === true && fc.args && typeof fc.args === 'object' ? fc.args : undefined;
        let state = this.functionCallArgsScans.get(fc);
        const canAdvance =
            !!state &&
            typeof previousArgs === 'string' &&
            typeof fragment === 'string' &&
            state.text === previousArgs &&
            state.prefilledArgs === prefilledArgs &&
            state.prefilledFlag === fc.prefilledArgs;
        if (canAdvance) {
            scanJsonClosure(state!.plain, fragment as string);
            if (state!.prefilled) scanJsonClosure(state!.prefilled, fragment as string);
            state!.text = text;
        } else {
            let prefilled: JsonClosureState | undefined;
            if (prefilledArgs) {
                let prefillJson: string | undefined;
                try {
                    prefillJson = JSON.stringify(prefilledArgs);
                } catch {
                    prefillJson = undefined;
                }
                // 与 tryParseFunctionCallArgs 的候选 1 拼接方式保持一致；序列化异常时无法预判，直接回退。
                if (prefillJson === undefined) return true;
                prefilled = scanJsonClosure(scanJsonClosure(createJsonClosureState(), prefillJson.slice(0, -1)), text);
            }
            state = {
                text,
                plain: scanJsonClosure(createJsonClosureState(), text),
                prefilled,
                prefilledArgs,
                prefilledFlag: fc.prefilledArgs,
            };
            this.functionCallArgsScans.set(fc, state);
        }

        const candidates = state!.prefilled ? [state!.prefilled, state!.plain] : [state!.plain];
        return candidates.some((candidate) => candidate.mode === 'other' || mayBeClosedJsonObject(candidate));
    }

    // 注意：这里以前有一个 extractAndConvertToolCalls()，在每次文本合并后
    // 全量重扫所有 parts、把文本中的工具调用标记转换为 functionCall。
    // 该职责已完全由 IncrementalPromptToolParser（addPart 入口处）接管：
    // - 非思考文本在进入 parts 前就被增量解析器消费，不会残留完整标记；
    // - 思考（thought）文本中的标记按系统语义不视为真实调用
    //   （ToolCallParserService.extractFunctionCalls 同样跳过 thought part）。
    // 旧路径除了 O(n²) 的重复扫描外，还会重建 parts 数组导致索引漂移，故删除。

    /** 追加推理条目：数组仍由本累加器独占时原地追加，已交出或来自外部时复制一次后再独占。 */
    private appendReasoningEntries<T extends object>(existing: T[] | undefined, incoming: readonly T[]): T[] {
        const owned = !!existing && this.ownedReasoningArrays.get(existing) === this.exposureEpoch;
        const target = owned ? existing! : [...(existing || [])];
        for (const entry of incoming) target.push({ ...entry });
        this.ownedReasoningArrays.set(target, this.exposureEpoch);
        return target;
    }

    constructor(protected readonly createToolCallId: () => string) {}
}
