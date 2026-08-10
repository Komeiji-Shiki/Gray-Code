/**
 * LimCode - OpenAI Responses 格式转换器
 *
 * 将统一格式转换为 OpenAI Responses API 格式
 * 详情参考: https://api.openai.com/v1/responses
 */

import { t } from '../../../i18n';
import { BaseFormatter } from './base';
import type { Content, ContentPart } from '../../conversation/types';
import type { OpenAIResponsesConfig } from '../../config/types';
import type { ToolDeclaration } from '../../../tools/types';
import { applyCustomBody, applyCustomHeaders } from '../../config/configs/base';
import { throwIfStreamError } from './streamError';
import { serializeToolResultForLLM } from './toolResponseFormatter';
import {
    isImageMimeType,
    isPdfMimeType,
    isTextMimeType,
    buildTextAttachmentContent,
    buildUnsupportedAttachmentText
} from './mediaParts';
import { ChannelError, ErrorType } from '../types';
import type {
    GenerateRequest,
    GenerateResponse,
    StreamChunk,
    HttpRequestOptions
} from '../types';

function normalizeReasoningSummary(item: any): Array<{ type: 'summary_text'; text: string }> {
    if (!Array.isArray(item?.summary)) return [];
    return item.summary
        .filter((entry: any) => typeof entry?.text === 'string' && entry.text.length > 0)
        .map((entry: any) => ({ type: 'summary_text' as const, text: entry.text }));
}

function normalizeReasoningContent(item: any): Array<{ type: 'reasoning_text'; text: string }> {
    if (!Array.isArray(item?.content)) return [];
    return item.content
        .filter((entry: any) => typeof entry?.text === 'string' && entry.text.length > 0)
        .map((entry: any) => ({ type: 'reasoning_text' as const, text: entry.text }));
}

function getReasoningDisplayText(item: any): string | undefined {
    const summaryText = normalizeReasoningSummary(item).map(entry => entry.text).join('\n');
    if (summaryText) return summaryText;

    const reasoningText = normalizeReasoningContent(item).map(entry => entry.text).join('\n');
    if (reasoningText) return reasoningText;

    if (typeof item?.text === 'string' && item.text) return item.text;
    if (typeof item?.content === 'string' && item.content) return item.content;
    return undefined;
}

/**
 * OpenAI Responses 格式转换器
 * 
 * 使用全新的 Responses API，支持更丰富的内容类型和流式处理方式。
 */
export class OpenAIResponsesFormatter extends BaseFormatter {
    /**
     * 构建 OpenAI Responses API 请求
     */
    buildRequest(
        request: GenerateRequest,
        config: OpenAIResponsesConfig,
        tools?: ToolDeclaration[]
    ): HttpRequestOptions {
        const { history } = request;
        
        // 准备系统指令 (instructions)
        let instructions = config.systemInstruction;
        
        // 追加静态系统提示词（操作系统、时区、语言、工作区路径 - 可被 API provider 缓存）
        if (request.dynamicSystemPrompt) {
            instructions = instructions
                ? `${instructions}\n\n${request.dynamicSystemPrompt}`
                : request.dynamicSystemPrompt;
        }

        let processedHistory = history;
        processedHistory = this.injectPromptContextMessages(
            processedHistory,
            this.getPromptContextForRequest(request),
            request.dynamicContextStrategy,
            { stripPreservedThoughtParts: config.sendHistoryThoughts !== true }
        );

        // 清理内部字段（如 isUserInput），这些字段不应该发送给 API
        processedHistory = this.cleanInternalFields(processedHistory);

        // 转换历史消息为 OpenAI Responses input 格式。
        // reasoning item 是 OpenAI 官方 Responses 专有输入类型，第三方兼容端点往往不支持，
        // 会直接 400「输入项类型 'reasoning' 当前暂不支持」。reasoning item 只来自历史轮次，
        // 且其核心（encrypted_content）就是思考签名，因此回传由「发送历史思考签名」开关控制：
        // 关闭时不回传 reasoning item，可见摘要降级为普通 assistant 文本。
        const allowReasoningItems = !!(config.sendHistoryThoughtSignatures);
        const input = this.convertToResponsesInput(processedHistory, { allowReasoningItems });

        // 构建请求体
        const body: any = {
            model: config.model,
            instructions: instructions || undefined,
            input: input,
            include: ["reasoning.encrypted_content"] // 始终包含加密思考内容
        };

        // 添加工具
        if (tools && tools.length > 0) {
            body.tools = this.convertTools(tools);
        }

        // 添加生成配置
        const genConfig = this.buildGenerationConfig(config);
        Object.assign(body, genConfig);

        // 决定是否使用流式
        const useStream = config.options?.stream ?? config.preferStream ?? false;
        
        // 始终将 stream 添加到请求体
        body.stream = useStream;

        // 构建 URL
        const baseUrl = config.url.endsWith('/') ? config.url.slice(0, -1) : config.url;
        const url = baseUrl.endsWith('/responses') ? baseUrl : `${baseUrl}/responses`;

        // 构建请求头
        const headers: Record<string, string> = {
            'Content-Type': 'application/json'
        };
        
        if (config.apiKey) {
            headers['Authorization'] = `Bearer ${config.apiKey}`;
        }

        // 应用自定义标头
        applyCustomHeaders(headers, config.customHeaders, config.customHeadersEnabled);
        
        // 应用自定义 body
        const finalBody = applyCustomBody(body, config.customBody, config.customBodyEnabled);

        return {
            url,
            method: 'POST',
            headers,
            body: finalBody,
            timeout: config.timeout,
            stream: useStream
        };
    }

    /**
     * 将历史记录转换为 Responses API 的 input 格式
     * 
     * 支持：
     * - role: user/assistant
     * - content: input_text, input_image, input_file
     * - function_call_output 类型项
     */
    private convertToResponsesInput(
        history: Content[],
        options?: { allowReasoningItems?: boolean }
    ): any[] {
        const input: any[] = [];
        
        // 成对过滤：rejected functionCall 及其配对 function_call_output 一起丢弃，
        // 避免「function_call 被滤掉而 output 残留」的孤儿 output（Responses API 400）。
        const rejectedCallIds = new Set<string>();
        for (const content of history) {
            for (const part of content.parts) {
                if (part.functionCall?.rejected && part.functionCall.id) {
                    rejectedCallIds.add(part.functionCall.id);
                }
            }
        }
        
        for (const content of history) {
            const role = content.role === 'model' ? 'assistant' : content.role;
            
            // 缓存当前正在构建的 message 类型项的内容
            let messageParts: any[] = [];
            
            // 辅助函数：将积攒的文本/图片内容作为一个 message 项提交
            const flushMessage = () => {
                if (messageParts.length > 0) {
                    input.push({
                        type: 'message',
                        role,
                        content: messageParts
                    });
                    messageParts = [];
                }
            };
            
            for (let partIndex = 0; partIndex < content.parts.length; partIndex++) {
                const part = content.parts[partIndex];
                const encryptedContent = part.thoughtSignatures?.['openai-responses'];
                const reasoningMetadata = part.openaiResponsesReasoning;

                // 1. 处理 OpenAI Responses reasoning item。新记录原样复放标准字段；
                // 旧流式记录的摘要与签名分属相邻 part 时，在这里重新组合。
                // 第三方兼容端点不支持 reasoning 输入项时，由 allowReasoningItems=false 整体跳过，
                // 可见摘要文本降级为普通 assistant 内容保留（避免思考内容整体丢失）。
                if (encryptedContent || reasoningMetadata?.id) {
                    const displayText = part.text || (partIndex > 0 ? content.parts[partIndex - 1]?.text : undefined);
                    const shouldSkip = !(options?.allowReasoningItems ?? true);
                    if (shouldSkip) {
                        if (displayText) {
                            messageParts.push({
                                type: role === 'assistant' ? 'output_text' : 'input_text',
                                text: displayText
                            });
                        }
                        continue;
                    }
                    flushMessage();
                    const previousPart = partIndex > 0 ? content.parts[partIndex - 1] : undefined;
                    const legacyAdjacentSummary = previousPart?.thought && !previousPart.thoughtSignatures?.['openai-responses']
                        ? previousPart.text
                        : undefined;
                    const summary = reasoningMetadata?.summary?.length
                        ? reasoningMetadata.summary.map(entry => ({ type: 'summary_text', text: entry.text }))
                        : (part.text || legacyAdjacentSummary
                            ? [{ type: 'summary_text', text: part.text || legacyAdjacentSummary }]
                            : []);
                    const reasoningItem: any = {
                        type: 'reasoning',
                        summary
                    };

                    if (reasoningMetadata?.id) reasoningItem.id = reasoningMetadata.id;
                    if (reasoningMetadata?.status) reasoningItem.status = reasoningMetadata.status;
                    if (encryptedContent) reasoningItem.encrypted_content = encryptedContent;
                    if (reasoningMetadata?.content?.length) {
                        reasoningItem.content = reasoningMetadata.content.map(entry => ({
                            type: 'reasoning_text',
                            text: entry.text
                        }));
                    }

                    input.push(reasoningItem);
                    continue;
                }

                // 2. 处理加密思考内容 (Anthropic/Redacted)
                if (part.redactedThinking) {
                    flushMessage();
                    input.push({
                        type: 'redacted_thinking',
                        data: part.redactedThinking
                    });
                    continue;
                }

                // 3. 过滤掉不含签名的思考分段
                // OpenAI Responses 必须有签名才能回传推理项
                if (part.thought) {
                    continue;
                }

                // 4. 处理函数调用 (Function Call Item)
                // rejected 的调用（无对应 functionResponse 的中断/取消残留）不发，
                // 否则 OpenAI Responses API 会因 call_id 无输出项而报错。
                if (part.functionCall && !part.functionCall.rejected) {
                    flushMessage();
                    input.push({
                        type: 'function_call',
                        name: part.functionCall.name,
                        call_id: part.functionCall.id,
                        arguments: typeof part.functionCall.args === 'string'
                            ? part.functionCall.args
                            : JSON.stringify(part.functionCall.args)
                    });
                    continue;
                }

                // 5. 处理函数响应 (Function Call Output Item)
                // 配对响应属于被 rejected 的调用时一起丢弃（成对过滤）
                if (part.functionResponse && !(part.functionResponse.id && rejectedCallIds.has(part.functionResponse.id))) {
                    flushMessage();
                    input.push({
                        type: 'function_call_output',
                        call_id: part.functionResponse.id,
                        output: typeof part.functionResponse.response === 'string'
                            ? part.functionResponse.response
                            : serializeToolResultForLLM(part.functionResponse.name, part.functionResponse.response as Record<string, unknown>)
                    });
                    
                    // 如果工具返回了多模态内容（如图片），这些需要作为紧随其后的新 message 项
                    if (part.functionResponse.parts && part.functionResponse.parts.length > 0) {
                        const toolContentParts = part.functionResponse.parts
                            .map(p => {
                                if (p.inlineData) {
                                    const { mimeType, data } = p.inlineData;
                                    if (isImageMimeType(mimeType)) {
                                        return {
                                            type: 'input_image' as const,
                                            image_url: `data:${mimeType};base64,${data}`
                                        };
                                    }
                                    if (isPdfMimeType(mimeType)) {
                                        // PDF -> input_file（Responses API 支持 base64 内联 PDF）
                                        return {
                                            type: 'input_file' as const,
                                            filename: 'attachment.pdf',
                                            file_data: `data:${mimeType};base64,${data}`
                                        };
                                    }
                                    if (isTextMimeType(mimeType)) {
                                        return {
                                            type: 'input_text' as const,
                                            text: buildTextAttachmentContent(data)
                                        };
                                    }
                                    return {
                                        type: 'input_text' as const,
                                        text: buildUnsupportedAttachmentText(mimeType)
                                    };
                                }
                                return null;
                            })
                            .filter(p => p !== null);
                        
                        if (toolContentParts.length > 0) {
                            input.push({
                                type: 'message',
                                role: 'user', // 工具返回的内容被视为用户输入
                                content: toolContentParts
                            });
                        }
                    }
                    continue;
                }

                // 6. 处理普通消息内容 (积攒到 messageParts)
                if ('text' in part && part.text) {
                    messageParts.push({
                        type: role === 'assistant' ? 'output_text' : 'input_text',
                        text: part.text
                    });
                } else if (part.inlineData) {
                    const { mimeType, data } = part.inlineData;
                    if (isImageMimeType(mimeType)) {
                        messageParts.push({
                            type: 'input_image',
                            image_url: `data:${mimeType};base64,${data}`
                        });
                    } else if (isPdfMimeType(mimeType)) {
                        // PDF -> input_file（Responses API 支持 base64 内联 PDF）
                        messageParts.push({
                            type: 'input_file',
                            filename: 'attachment.pdf',
                            file_data: `data:${mimeType};base64,${data}`
                        });
                    } else if (isTextMimeType(mimeType)) {
                        // 文本文件（如 txt）-> 解码为 input_text，避免被当作图片发送
                        messageParts.push({
                            type: 'input_text',
                            text: buildTextAttachmentContent(data)
                        });
                    } else {
                        // 音视频等其他格式当前不支持直接发送，转为文本占位
                        messageParts.push({
                            type: 'input_text',
                            text: buildUnsupportedAttachmentText(mimeType)
                        });
                    }
                } else if (part.fileData) {
                    messageParts.push({
                        type: 'input_file',
                        file_url: part.fileData.fileUri
                    });
                }
            }

            // 提交剩余积攒的消息内容
            flushMessage();
        }
        
        return input;
    }

    /**
     * 解析 OpenAI Responses API 响应 (非流式)
     */
    parseResponse(response: any): GenerateResponse {
        if (!response || !response.output || !Array.isArray(response.output)) {
            throw new Error(t('modules.channel.formatters.openai.errors.invalidResponse'));
        }

        const parts: ContentPart[] = [];
        
        // 遍历 output 数组
        for (const item of response.output) {
            if (item.type === 'message') {
                // 处理消息内容
                if (item.content && Array.isArray(item.content)) {
                    for (const contentPart of item.content) {
                        if (contentPart.type === 'output_text') {
                            parts.push({
                                text: contentPart.text
                            });
                        }
                    }
                }
            } else if (item.type === 'reasoning') {
                const summary = normalizeReasoningSummary(item);
                const reasoningContent = normalizeReasoningContent(item);
                const reasoningPart: ContentPart = {
                    thought: true,
                    openaiResponsesReasoning: {
                        ...(typeof item.id === 'string' ? { id: item.id } : {}),
                        ...(item.status ? { status: item.status } : {}),
                        ...(summary.length > 0 ? { summary } : {}),
                        ...(reasoningContent.length > 0 ? { content: reasoningContent } : {})
                    }
                };

                const displayText = getReasoningDisplayText(item);
                if (displayText) reasoningPart.text = displayText;

                // store=false 时 encrypted_content 是后续轮次恢复 reasoning 上下文的关键字段。
                if (item.encrypted_content) {
                    reasoningPart.thoughtSignatures = {
                        'openai-responses': item.encrypted_content
                    };
                }

                if (reasoningPart.text || reasoningPart.thoughtSignatures || reasoningPart.openaiResponsesReasoning?.id) {
                    parts.push(reasoningPart);
                }
            } else if (item.type === 'redacted_thinking') {
                // 处理加密思考内容
                if (item.data) {
                    parts.push({
                        redactedThinking: item.data
                    });
                }
            } else if (item.type === 'function_call') {
                // 处理函数调用
                let args: Record<string, unknown> = {};
                try {
                    args = JSON.parse(item.arguments || '{}');
                } catch {
                    args = {};
                }
                parts.push({
                    functionCall: {
                        name: item.name,
                        args,
                        id: item.call_id
                    }
                });
            }
        }

        const content: Content = {
            role: 'model',
            parts,
            modelVersion: response.model
        };

        // 处理 Usage 统计
        if (response.usage) {
            const usage = response.usage;
            const outputTokens = usage.output_tokens || 0;
            const reasoningTokens = usage.output_tokens_details?.reasoning_tokens || 0;
            const cachedTokens = usage.input_tokens_details?.cached_tokens || 0;
            content.usageMetadata = {
                promptTokenCount: usage.input_tokens,
                // Responses API 的 output_tokens 已包含 reasoning_tokens；主界面按总输出显示。
                candidatesTokenCount: outputTokens > 0 ? outputTokens : undefined,
                totalTokenCount: usage.total_tokens,
                thoughtsTokenCount: reasoningTokens > 0 ? reasoningTokens : undefined,
                ...(cachedTokens > 0 ? { cacheReadTokenCount: cachedTokens, cachedContentTokenCount: cachedTokens } : {})
            };
        }

        return {
            content,
            finishReason: response.status,
            model: response.model,
            raw: response
        };
    }

    /**
     * 解析流式响应块
     * 
     * Responses API 使用 SSE 发送事件，每个 chunk 是一个完整的 JSON 事件
     */
    parseStreamChunk(chunk: any): StreamChunk {
        // 流内联错误统一在这里归一为 ChannelError，并带上上游给出的原文
        throwIfStreamError(chunk, 'OpenAI Responses');

        const parts: ContentPart[] = [];
        let done = false;
        let usage: any;
        let finishReason: string | undefined;

        // 根据事件类型处理
        switch (chunk.type) {
            case 'response.output_item.added':
                // 当函数调用被添加时
                if (chunk.item?.type === 'function_call') {
                    parts.push({
                        functionCall: {
                            name: chunk.item.name,
                            args: {},
                            partialArgs: '',
                            id: chunk.item.call_id,
                            index: chunk.output_index
                        } as any
                    });
                }
                break;
            
            case 'response.output_item.done':
                // reasoning item 的 id/summary/content/encrypted_content 必须一起持久化，
                // 才能在 store=false 的后续请求中按官方格式原样回传。
                if (chunk.item?.type === 'reasoning') {
                    const summary = normalizeReasoningSummary(chunk.item);
                    const reasoningContent = normalizeReasoningContent(chunk.item);
                    const displayText = getReasoningDisplayText(chunk.item);
                    const reasoningPart: ContentPart = {
                        thought: true,
                        ...(displayText ? { text: displayText } : {}),
                        openaiResponsesReasoning: {
                            ...(typeof chunk.item.id === 'string' ? { id: chunk.item.id } : {}),
                            ...(chunk.item.status ? { status: chunk.item.status } : {}),
                            ...(summary.length > 0 ? { summary } : {}),
                            ...(reasoningContent.length > 0 ? { content: reasoningContent } : {})
                        },
                        ...(chunk.item.encrypted_content ? {
                            thoughtSignatures: {
                                'openai-responses': chunk.item.encrypted_content
                            }
                        } : {})
                    };

                    if (displayText || chunk.item.encrypted_content || chunk.item.id) {
                        parts.push(reasoningPart);
                    }
                }
                break;
            
            case 'response.output_text.delta':
            case 'response.text.delta': // 兼容旧版本
                // 文本增量
                parts.push({
                    text: chunk.delta
                });
                break;
            
            case 'response.reasoning_text.delta':
            case 'response.reasoning_summary_text.delta':
            case 'response.reasoning.delta': // 兼容旧版本
                // 思考内容增量
                parts.push({
                    text: chunk.delta,
                    thought: true
                });
                break;
            
            case 'response.function_call_arguments.delta':
                // 函数参数增量
                parts.push({
                    functionCall: {
                        partialArgs: chunk.delta,
                        index: chunk.output_index
                    } as any
                });
                break;

            case 'response.function_call_arguments.done':
                // 函数调用完成
                parts.push({
                    functionCall: {
                        name: chunk.name,
                        args: {}, // arguments 将在 done 之后由 StreamAccumulator 解析
                        partialArgs: chunk.arguments,
                        id: chunk.item_id,
                        index: chunk.output_index,
                        // done 事件携带完整 arguments：累加器据此覆盖已累积的增量 JSON 而非继续追加，
                        // 并在此边界解析（否则 delta 半截 JSON + 完整 JSON 会拼成垃圾串，工具全部空参数执行）。
                        finalArgs: true
                    } as any
                });
                break;
            
            case 'response.completed':
            case 'response.done': // 兼容旧版本
                // 响应完成
                done = true;
                if (chunk.response?.usage) {
                    const u = chunk.response.usage;
                    const outputTokens = u.output_tokens || 0;
                    const reasoningTokens = u.output_tokens_details?.reasoning_tokens || 0;
                    const cachedTokens = u.input_tokens_details?.cached_tokens || 0;
                    usage = {
                        promptTokenCount: u.input_tokens,
                        // Responses API 的 output_tokens 已包含 reasoning_tokens；主界面按总输出显示。
                        candidatesTokenCount: outputTokens > 0 ? outputTokens : undefined,
                        totalTokenCount: u.total_tokens,
                        thoughtsTokenCount: reasoningTokens > 0 ? reasoningTokens : undefined,
                        ...(cachedTokens > 0 ? { cacheReadTokenCount: cachedTokens, cachedContentTokenCount: cachedTokens } : {})
                    };
                }
                
                finishReason = chunk.response?.status;
                break;
            
            case 'response.failed':
                // 响应失败：错误体挂在 response 下，顶层判错拦不到，这里单独归一
                throwIfStreamError(chunk.response, 'OpenAI Responses');
                throw new ChannelError(
                    ErrorType.API_ERROR,
                    t('modules.channel.formatters.streamError', { provider: 'OpenAI Responses', message: 'Response failed' }),
                    chunk
                );

            case 'response.incomplete':
                // 响应不完整
                done = true;
                finishReason = chunk.response?.incomplete_details?.reason || 'incomplete';
                break;
                
        }

        return {
            delta: parts,
            done,
            usage,
            finishReason,
            modelVersion: chunk.response?.model,
            providerEvent: {
                type: chunk.type || 'unknown',
                outputIndex: chunk.output_index,
                contentIndex: chunk.content_index,
                itemId: chunk.item_id || chunk.item?.id,
                callId: chunk.item?.call_id,
                isFinalArgs: chunk.type === 'response.function_call_arguments.done'
            }
        };
    }

    /**
     * 构建生成配置
     */
    private buildGenerationConfig(config: OpenAIResponsesConfig): any {
        const genConfig: any = {
            store: false
        };
        const optionsEnabled = config.optionsEnabled || {};
        const options = config.options || {};

        if (optionsEnabled.temperature && options.temperature !== undefined) {
            genConfig.temperature = options.temperature;
        }
        
        if (optionsEnabled.max_output_tokens && options.max_output_tokens !== undefined) {
            genConfig.max_output_tokens = options.max_output_tokens;
        }
        
        if (optionsEnabled.top_p && options.top_p !== undefined) {
            genConfig.top_p = options.top_p;
        }

        // 处理推理配置
        if (options.reasoning && (optionsEnabled.reasoning || options.reasoning.effort === 'none')) {
            const reasoning: any = {};

            if (optionsEnabled.reasoning) {
                let effort: string | undefined = options.reasoning.effort;
                // 自定义模式：使用 effortCustom 的值原样透传
                if (effort === 'custom') {
                    effort = options.reasoning.effortCustom?.trim() || undefined;
                }
                // none 档位：不传递思考强度参数（请求缺省该段，模型按 API 默认行为思考）
                if (effort && effort !== 'none') {
                    reasoning.effort = effort;
                }

                // 处理输出详细程度 (Summary)
                if (options.reasoning.summaryEnabled && options.reasoning.summary) {
                    reasoning.summary = options.reasoning.summary;
                }
            } else {
                // Off（关闭思考）：闸门关闭且显式记录 effort='none' 时强制传递
                // {"reasoning": {"effort": "none"}}——OpenAI 请求缺省 reasoning 段时
                // 模型仍按默认强度思考，只有显式 effort='none' 才真正关闭思考。
                reasoning.effort = 'none';
            }

            if (Object.keys(reasoning).length > 0) {
                genConfig.reasoning = reasoning;
            }
        }

        return genConfig;
    }

    /**
     * 转换工具声明
     */
    convertTools(tools: ToolDeclaration[]): any {
        if (!tools || tools.length === 0) {
            return undefined;
        }
        
        return tools.map(tool => ({
            type: 'function',
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters
        }));
    }

    /**
     * 验证配置
     */
    validateConfig(config: any): boolean {
        if (config.type !== 'openai-responses') {
            return false;
        }
        
        const c = config as OpenAIResponsesConfig;
        return !!c.url && !!c.model;
    }

    /**
     * 获取支持的类型
     */
    getSupportedType(): string {
        return 'openai-responses';
    }
}
