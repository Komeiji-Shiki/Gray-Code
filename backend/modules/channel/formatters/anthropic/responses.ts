/** Anthropic 非流式与 SSE 响应共用相同的内容和 usage 解释。 */
import { t } from '../../../../i18n';
import type { Content, ContentPart } from '../../../conversation/types';
import type { GenerateResponse, StreamChunk } from '../../types';
import { detectPromptToolMode, IncrementalPromptToolParser } from '../../../../core/parsers/promptToolParser';
import { throwIfStreamError } from '../streamError';

/**
 * 解析 Anthropic API 响应
 *
 * Anthropic 思考内容格式：
 * {
 *   "content": [
 *     {
 *       "type": "thinking",
 *       "thinking": "思考过程...",
 *       "signature": "Base64签名..."
 *     },
 *     {
 *       "type": "text",
 *       "text": "最终回答..."
 *     }
 *   ]
 * }
 */
export function parseAnthropicResponse(response: any): GenerateResponse {
    // 上游用 HTTP 200 + 错误体回应时，先把它的原文抛出来，
    // 否则下面只会报一句「没有内容」，用户根本看不到真正的原因
    throwIfStreamError(response, 'Anthropic');

    // 验证响应格式
    if (!response || !response.content) {
        throw new Error(t('modules.channel.formatters.anthropic.errors.invalidResponse'));
    }
    
    // 构建 ContentPart 数组
    let parts: ContentPart[] = [];
    
    // 解析 content 数组
    for (const block of response.content) {
        if (block.type === 'thinking') {
            // 思考内容块
            // 1. 存储思考文本（带 thought: true 标记）
            if (block.thinking) {
                parts.push({
                    text: block.thinking,
                    thought: true
                });
            }
            // 2. 存储思考签名（使用多格式存储）
            if (block.signature) {
                parts.push({
                    thoughtSignatures: {
                        anthropic: block.signature
                    }
                });
            }
        } else if (block.type === 'redacted_thinking') {
            // 加密思考内容块
            // 存储加密的思考数据，需要在后续对话中原样返回
            if (block.data) {
                parts.push({
                    redactedThinking: block.data
                });
            }
        } else if (block.type === 'text') {
            parts.push({ text: block.text });
        } else if (block.type === 'tool_use') {
            parts.push({
                functionCall: {
                    name: block.name,
                    args: block.input || {},
                    id: block.id
                }
            });
        }
    }
    
    // 如果没有原生工具调用，尝试从文本中检测
    const hasToolUse = response.content.some((b: any) => b.type === 'tool_use');
    if (!hasToolUse) {
        const normalizedParts: ContentPart[] = [];
        let promptMode: 'json' | 'xml' | null = null;
        let promptParser: IncrementalPromptToolParser | undefined;

        for (const part of parts) {
            if (!part.text || part.thought) {
                normalizedParts.push(part);
                continue;
            }

            if (!promptMode) {
                promptMode = detectPromptToolMode(part.text);
                if (promptMode) {
                    promptParser = new IncrementalPromptToolParser(promptMode);
                }
            }

            if (promptParser) {
                normalizedParts.push(...promptParser.appendText(part.text));
            } else {
                normalizedParts.push(part);
            }
        }

        parts = promptParser ? [...normalizedParts, ...promptParser.flushIncompleteAsText()] : normalizedParts;
    }
    
    // 构建完整的 Content
    const content: Content = {
        role: 'model',
        parts,
        modelVersion: response.model
    };
    
    // 存储 usageMetadata
    if (response.usage) {
        content.usageMetadata = extractUsageMetadata(response.usage);
    }
    
    // 提取结束原因
    const finishReason = response.stop_reason;
    
    return {
        content,
        finishReason,
        model: response.model,
        raw: response
    };
}

/**
 * 统一从 Anthropic usage 对象中提取 UsageMetadata
 *
 * 兼容官方 Anthropic API 和第三方代理（OpenRouter、one-api 等）的 usage 格式差异：
 * - 标准字段：input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens
 * - thinking 模型：output_tokens_details.thinking_tokens
 * - 部分代理可能在任意事件中返回完整 usage，统一处理避免遗漏
 */
function extractUsageMetadata(usage: any): Content['usageMetadata'] {
    const inputBase = usage.input_tokens ?? 0;
    const cacheCreation = usage.cache_creation_input_tokens ?? 0;
    const cacheRead = usage.cache_read_input_tokens ?? 0;
    const promptTotal = inputBase + cacheCreation + cacheRead;
    const cachedTotal = cacheCreation + cacheRead;
    const outputTokens = usage.output_tokens ?? 0;
    const thinkingTokens = usage.output_tokens_details?.thinking_tokens ?? 0;

    // totalTokenCount 只在收到原生 input 侧计数时提供：Anthropic 的 message_delta
    // usage 只含 output_tokens，若此时也输出 total（= 0 + output），累加器的
    // mergeUsageMetadata 会把 message_start 时正确的 total 覆盖掉，输入 token 从总量中消失。
    // （部分代理在任意事件返回完整 usage，此时 input_tokens 存在，仍会正常输出 total。）
    const hasInputSideTokens = usage.input_tokens !== undefined
        || usage.cache_creation_input_tokens !== undefined
        || usage.cache_read_input_tokens !== undefined;

    return {
        promptTokenCount: promptTotal || undefined,
        // Anthropic output_tokens 已包含 thinking token；界面统一展示总输出。
        candidatesTokenCount: outputTokens > 0 ? outputTokens : undefined,
        totalTokenCount: hasInputSideTokens ? (promptTotal + outputTokens || undefined) : undefined,
        ...(thinkingTokens > 0 ? { thoughtsTokenCount: thinkingTokens } : {}),
        ...(cacheCreation > 0 ? { cacheCreationTokenCount: cacheCreation } : {}),
        ...(cacheRead > 0 ? { cacheReadTokenCount: cacheRead } : {}),
        ...(cachedTotal > 0 ? { cachedContentTokenCount: cachedTotal } : {})
    };
}

/** 逐事件返回增量；块 index、原始签名和终态事件由累加器继续处理。 */
export function parseAnthropicStreamChunk(chunk: any): StreamChunk {
    // Anthropic SSE 有独立的 `event: error`（overloaded_error / rate_limit_error 等），
    // 之前这里没有分支处理，整条错误事件被静默丢弃，界面上只剩「模型返回空内容」
    throwIfStreamError(chunk, 'Anthropic');

    const parts: ContentPart[] = [];
    let done = false;
    let usage: any;
    let finishReason: string | undefined;
    let modelVersion: string | undefined;
    
    // 处理不同的事件类型
    if (chunk.type === 'content_block_delta') {
        const delta = chunk.delta;
        
        if (delta?.type === 'text_delta') {
            parts.push({ text: delta.text });
        } else if (delta?.type === 'thinking_delta') {
            // 思考内容增量
            parts.push({
                text: delta.thinking,
                thought: true
            });
        } else if (delta?.type === 'signature_delta') {
            // 思考签名增量（使用多格式存储）
            parts.push({
                thoughtSignatures: {
                    anthropic: delta.signature
                }
            });
        } else if (delta?.type === 'redacted_thinking_delta') {
            // 加密思考内容增量
            parts.push({
                redactedThinking: delta.data
            });
        } else if (delta?.type === 'input_json_delta') {
            // 工具调用参数增量
            if (delta.partial_json !== undefined) {
                parts.push({
                    functionCall: {
                        name: '', // 名称在 block_start 中提供，这里留空供累加器合并
                        args: {},
                        partialArgs: delta.partial_json,
                        // 透传事件级 index：Anthropic 每个 content_block_* 事件顶层都带 index，
                        // 累加器依赖它区分并行工具调用，缺 index 时参数增量会被全部拼进最后一个空工具壳。
                        index: chunk.index
                    }
                });
            }
        }
    } else if (chunk.type === 'content_block_start') {
        const block = chunk.content_block;
        
        if (block?.type === 'text') {
            // 文本块开始
            if (block.text) {
                parts.push({ text: block.text });
            }
        } else if (block?.type === 'thinking') {
            // 思考块开始，可能包含初始内容
            if (block.thinking) {
                parts.push({
                    text: block.thinking,
                    thought: true
                });
            }
        } else if (block?.type === 'redacted_thinking') {
            // 加密思考块开始，可能包含初始数据
            if (block.data) {
                parts.push({
                    redactedThinking: block.data
                });
            }
        } else if (block?.type === 'tool_use') {
            const args = block.input || {};
            // input 已显式提供即视为预填（含空对象 {} / 空串：上游 forced tool use
            // 可能预填空参数）；累加器按「预填 + 增量 / 增量自身」语义解析时，
            // 空对象预填同样参与片段拼接（'{}' 去尾闭合符后为 '{' + delta）
            const hasPrefilledArgs = block.input !== undefined;
            parts.push({
                functionCall: {
                    name: block.name,
                    args: args,
                    // 预填 input（forced tool use）时 partialArgs 置空并标记 prefilledArgs：
                    // 后续 input_json_delta 是与预填相对的剩余片段（或完整重放），把预填
                    // JSON.stringify 直接拼进 partialArgs 会破坏 JSON（{"a":1} + ,"b":2}）。
                    // 累加器对「预填 JSON + delta 累积 / delta 自身」两种语义重新解析合并。
                    partialArgs: '',
                    prefilledArgs: hasPrefilledArgs,
                    id: block.id,
                    // 透传事件级 index（同 input_json_delta），保证与参数增量按同一 index 合并
                    index: chunk.index
                }
            });
        }
    } else if (chunk.type === 'content_block_stop') {
        // 内容块结束：不产出增量，providerEvent 在返回前统一注入。
        // StreamAccumulator 的 Anthropic 分支依赖它：forced tool use（content_block_start
        // 预填 input）且流式增量从未到达时，在此恢复流式提前执行（见返回前 providerEvent 注释）。
    } else if (chunk.type === 'message_delta') {
        finishReason = chunk.delta?.stop_reason;
        if (chunk.usage) {
            usage = extractUsageMetadata(chunk.usage);
        }
    } else if (chunk.type === 'message_stop') {
        done = true;
        // 部分代理（OpenRouter 等）在 message_stop 中返回完整 usage
        if (chunk.usage) {
            usage = extractUsageMetadata(chunk.usage);
        } else if (chunk.message?.usage) {
            usage = extractUsageMetadata(chunk.message.usage);
        }
    } else if (chunk.type === 'message_start') {
        // 消息开始，包含模型名称和 usage 信息
        if (chunk.message?.model) {
            modelVersion = chunk.message.model;
        }
        if (chunk.message?.usage) {
            usage = extractUsageMetadata(chunk.message.usage);
        }
    }
    
    const streamChunk: StreamChunk = {
        delta: parts,
        done
    };
    
    if (finishReason) {
        streamChunk.finishReason = finishReason;
    }
    
    if (usage) {
        streamChunk.usage = usage;
    }

    if (modelVersion) {
        streamChunk.modelVersion = modelVersion;
    }

    // 回退：部分第三方代理将 model 放在顶层 chunk.model（类似 OpenAI 格式），
    // 而不是标准的 message_start.message.model。与 OpenAI formatter 对齐。
    if (!streamChunk.modelVersion && chunk.model) {
        streamChunk.modelVersion = chunk.model;
    }

    // Provider 事件级元数据（与 openai-responses.ts 的 providerEvent 形态对齐：{ type, contentIndex }）。
    // StreamAccumulator 的 Anthropic 分支依赖它：
    // - content_block_stop：forced tool use（预填 input）且流式增量从未到达（partialArgs 为空）时，
    //   清除 prefilledArgs 标记、恢复 getNewCompletedFunctionCalls 的流式提前执行——否则该分支永不触发，
    //   提前执行退化为等终态，并触发结构快照收束工具卡；
    // - message_stop：触发结构快照统一收束前端工具卡。
    if (chunk.type === 'content_block_stop' || chunk.type === 'message_stop') {
        streamChunk.providerEvent = {
            type: chunk.type,
            // Anthropic 每个 content_block_* 事件顶层都带 index；message_stop 无 index
            ...(typeof chunk.index === 'number' ? { contentIndex: chunk.index } : {})
        };
    }
    
    return streamChunk;
}
