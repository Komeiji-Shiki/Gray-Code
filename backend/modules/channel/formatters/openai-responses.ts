import { parseToolArguments } from './toolArguments';
import { resolveConfiguredStream } from '../../config/configs/base';
/**
 * GrayCode - OpenAI Responses 格式转换器
 *
 * 将统一格式转换为 OpenAI Responses API 格式
 * 详情参考: https://api.openai.com/v1/responses
 */

import { createHash } from 'crypto';
import { t } from '../../../i18n';
import { BaseFormatter } from './base';
import type { Content, ContentPart } from '../../conversation/types';
import type {
    OpenAIResponsesConfig,
    OpenAIResponsesReasoningSignatureMode
} from '../../config/types';
import type { ToolDeclaration } from '../../../tools/types';
import { applyCustomBody } from '../../config/configs/base';
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
    if (Array.isArray(item?.content)) {
        return item.content
            .filter((entry: any) => typeof entry?.text === 'string' && entry.text.length > 0)
            .map((entry: any) => ({ type: 'reasoning_text' as const, text: entry.text }));
    }
    if (typeof item?.content === 'string' && item.content.length > 0) {
        return [{ type: 'reasoning_text', text: item.content }];
    }
    return [];
}

function hasReasoningMetadata(metadata: ContentPart['openaiResponsesReasoning']): boolean {
    return !!metadata && (
        typeof metadata.id === 'string' ||
        typeof metadata.status === 'string' ||
        (Array.isArray(metadata.summary) && metadata.summary.length > 0) ||
        (Array.isArray(metadata.content) && metadata.content.length > 0)
    );
}

function getReasoningEventText(chunk: any): string | undefined {
    if (typeof chunk?.text === 'string' && chunk.text.length > 0) return chunk.text;
    if (typeof chunk?.delta === 'string' && chunk.delta.length > 0) return chunk.delta;
    if (typeof chunk?.content?.text === 'string' && chunk.content.text.length > 0) return chunk.content.text;
    if (Array.isArray(chunk?.content)) {
        const text = chunk.content
            .filter((entry: any) => typeof entry?.text === 'string')
            .map((entry: any) => entry.text)
            .join('');
        if (text) return text;
    }
    return undefined;
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

const PROMPT_CACHE_KEY_PREFIX = 'graycode-cache-';
const DEEPSEEK_REASONING_TEXT_FALLBACK = '';

function isDeepSeekModel(model: string): boolean {
    return model.toLowerCase().includes('deepseek');
}

function createDeepSeekReasoningTextFallbackContent(): Array<{ type: 'reasoning_text'; text: string }> {
    return [{ type: 'reasoning_text', text: DEEPSEEK_REASONING_TEXT_FALLBACK }];
}

function hasReasoningTextContent(item: any): boolean {
    return item?.type === 'reasoning' &&
        Array.isArray(item.content) &&
        item.content.some((entry: any) =>
            entry?.type === 'reasoning_text' &&
            typeof entry.text === 'string'
        );
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
        // reasoning item 的两种回放形态分开控制：
        // - DeepSeek：允许 content/summary 形式的 reasoning_text 回传。DeepSeek 无状态
        //   thinking mode 要求下一轮把 reasoning_text 原样放回 input。
        // - 官方 GPT/Responses：保留 encrypted_content + summary 的签名回传，由
        //   sendHistoryThoughtSignatures 控制；不能因为 DeepSeek 的兼容限制而删掉 GPT 思考衔接。
        // - 非 DeepSeek 的 content-only reasoning：不构造 reasoning item，也不降级成普通文本，
        //   避免把不被当前 Responses endpoint 接受的 reasoning_text 发出去。
        const isDeepSeek = isDeepSeekModel(config.model);
        const input = this.convertToResponsesInput(processedHistory, {
            allowReasoningContent: isDeepSeek && config.sendHistoryThoughts === true,
            allowReasoningSignatures: config.sendHistoryThoughtSignatures === true,
            reasoningSignatureMode: config.reasoningSignatureMode ?? 'official',
            useDeepSeekReasoningTextFallback: isDeepSeek
        });

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

        // 添加 prompt_cache_key（会话缓存透传）
        const promptCacheKey = this.buildPromptCacheKey(request, config);
        if (promptCacheKey) {
            body.prompt_cache_key = promptCacheKey;
        }

        // 添加生成配置
        const genConfig = this.buildGenerationConfig(config);
        Object.assign(body, genConfig);

        // 决定是否使用流式
        const useStream = resolveConfiguredStream(config);
        
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
        if (config.customHeadersEnabled && config.customHeaders) {
            for (const header of config.customHeaders) {
                if (header.enabled && header.key && header.key.trim()) {
                    headers[header.key.trim()] = header.value || '';
                }
            }
        }
        
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
     * 生成 OpenAI 兼容网关的 prompt_cache_key（会话缓存透传）。
     *
     * 支持该字段的网关（如 openai-api-server-via-codex）会把它原样转成
     * session_id / x-client-request-id 请求头发给 Codex 后端，相同 key 的
     * 后续请求可能复用后端会话缓存。
     *
     * - 显式 promptCacheKey 非空时优先使用（跨对话共享同一缓存域，高级用法）；
     * - 否则仅当 promptCacheKeyEnabled 且请求携带 conversationId 时，
     *   基于 conversationId 的 sha256 生成稳定 key（每对话独立缓存域，
     *   不泄露原始 ID；续跑时 executor 沿用旧 runId，缓存域天然一致，
     *   与 deepSeekUserIdEnabled 语义对齐）；
     * - 其余情况返回 undefined（请求体不带该字段，不影响不识别它的端点）。
     */
    private buildPromptCacheKey(request: GenerateRequest, config: OpenAIResponsesConfig): string | undefined {
        // 总开关优先：输入框即使保留了旧自定义值，关闭功能后也不得继续发送。
        if (!config.promptCacheKeyEnabled) {
            return undefined;
        }

        const explicitKey = config.promptCacheKey?.trim();
        if (explicitKey) {
            return explicitKey;
        }

        const conversationId = request.conversationId?.trim();
        if (!conversationId) {
            return undefined;
        }

        const digest = createHash('sha256')
            .update(conversationId, 'utf8')
            .digest('hex');

        return `${PROMPT_CACHE_KEY_PREFIX}${digest}`;
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
        options?: {
            allowReasoningContent?: boolean;
            allowReasoningSignatures?: boolean;
            reasoningSignatureMode?: OpenAIResponsesReasoningSignatureMode;
            useDeepSeekReasoningTextFallback?: boolean;
        }
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
            const contentInputStart = input.length;
            const role = content.role === 'model' ? 'assistant' : content.role;
            const useDeepSeekReasoningTextFallback =
                options?.useDeepSeekReasoningTextFallback === true &&
                role === 'assistant';
            
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
                const previousPart = partIndex > 0 ? content.parts[partIndex - 1] : undefined;
                const nextPart = partIndex + 1 < content.parts.length ? content.parts[partIndex + 1] : undefined;
                const hasAdjacentReasoningPart = !!nextPart && (
                    !!nextPart.thoughtSignatures?.['openai-responses'] ||
                    hasReasoningMetadata(nextPart.openaiResponsesReasoning)
                );
                const legacyAdjacentText = previousPart?.thought &&
                    !previousPart.thoughtSignatures?.['openai-responses'] &&
                    !hasReasoningMetadata(previousPart.openaiResponsesReasoning)
                    ? previousPart.text
                    : undefined;
                const reasoningSummary = normalizeReasoningSummary(reasoningMetadata);
                const reasoningContent = normalizeReasoningContent(reasoningMetadata);
                const displayText = part.text || getReasoningDisplayText(reasoningMetadata) || legacyAdjacentText;
                const reasoningSignatureMode = options?.reasoningSignatureMode ?? 'official';
                const hasPlainThought = options?.allowReasoningContent === true &&
                    part.thought === true &&
                    typeof part.text === 'string' &&
                    part.text.length > 0 &&
                    !hasAdjacentReasoningPart &&
                    !hasReasoningMetadata(reasoningMetadata) &&
                    !encryptedContent;
                const hasResponsesReasoning = !!encryptedContent || hasReasoningMetadata(reasoningMetadata) || hasPlainThought;
                const canReplayEmptyDeepSeekReasoning =
                    useDeepSeekReasoningTextFallback &&
                    !!reasoningMetadata &&
                    reasoningContent.length === 0 &&
                    reasoningSummary.length === 0 &&
                    !displayText &&
                    !encryptedContent;
                const canReplayPlainReasoning = (
                    options?.allowReasoningContent === true && (
                        reasoningContent.length > 0 ||
                        reasoningSummary.length > 0 ||
                        hasPlainThought ||
                        (!!reasoningMetadata && !!displayText && (
                            typeof reasoningMetadata.id === 'string' ||
                            typeof reasoningMetadata.status === 'string'
                        ))
                    )
                ) || canReplayEmptyDeepSeekReasoning;
                const canReplaySignedReasoning = options?.allowReasoningSignatures === true && !!encryptedContent;

                // 1. 处理 OpenAI Responses reasoning item。新记录原样复放标准字段；
                // 旧流式记录的摘要与签名分属相邻 part 时，在这里重新组合。
                // 「发送历史思考内容」控制 plain reasoning_text/summary；
                // 「发送历史思考签名」控制 encrypted_content。没有 Responses 元数据的
                // 裸 thought 不会被猜测成 reasoning item，避免把其他 provider 的思考误发。
                if (hasResponsesReasoning) {
                    // 没有当前 endpoint 支持的 reasoning 回放形态时直接丢弃。
                    // 尤其不能把非 DeepSeek 的 content-only reasoning 降级成 output_text：
                    // 那会把思考内容伪装成普通回答，并且无法解决 schema 不兼容。
                    if (!canReplayPlainReasoning && !canReplaySignedReasoning) {
                        continue;
                    }

                    // summary-only reasoning 没有可回放的 reasoning_text；签名路径未开启时
                    // 直接丢弃，不再把摘要降级成普通 assistant 文本。
                    if (
                        !canReplaySignedReasoning &&
                        reasoningContent.length === 0 &&
                        reasoningSummary.length > 0
                    ) {
                        continue;
                    }

                    flushMessage();
                    const reasoningItem: any = {
                        type: 'reasoning'
                    };
                    if (reasoningMetadata?.id) reasoningItem.id = reasoningMetadata.id;
                    if (reasoningSignatureMode === 'official' && reasoningMetadata?.status) {
                        reasoningItem.status = reasoningMetadata.status;
                    }

                    if (canReplaySignedReasoning) {
                        // OpenAI 官方 Responses 的加密推理回传：保留 encrypted_content
                        // 和官方 summary；不要把 plain content 混入该兼容路径。
                        reasoningItem.encrypted_content = encryptedContent;
                        const summary = reasoningSummary.length > 0
                            ? reasoningSummary
                            : (part.text || legacyAdjacentText
                                ? [{ type: 'summary_text' as const, text: part.text || legacyAdjacentText }]
                                : []);
                        // 官方 Responses 对 reasoning 输入要求 summary 字段，即使为空。
                        reasoningItem.summary = summary;
                    } else if (reasoningContent.length > 0) {
                        // DeepSeek 等端点要求 plain reasoning_text，并不接受
                        // encrypted_content/summary；使用权威 content 数组原样回传。
                        reasoningItem.content = reasoningContent;
                    } else if (displayText) {
                        // 到达此处的形态：无 content、无 summary（summary-only 已被上方守卫
                        // 降级）、未开签名——即 id/status + text 的旧流式记录或裸 thought
                        // 补全为 plain reasoning_text，以满足下一轮带 tools 的无状态回传要求。
                        reasoningItem.content = [{ type: 'reasoning_text', text: displayText }];
                    } else if (canReplayEmptyDeepSeekReasoning) {
                        // DeepSeek 可能返回只有 id/status、没有文本的 reasoning item；下一轮
                        // 仍要求该项携带 reasoning_text，因此仅在原项的字段内补空字符串。
                        reasoningItem.content = createDeepSeekReasoningTextFallbackContent();
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

                // 3. 过滤掉没有 Responses 元数据、且未开启纯文本思考回传的思考分段。
                // 有 openaiResponsesReasoning 的分段已在上方转换为 reasoning item；
                // 普通 provider 的裸 thought 仍保持旧的丢弃语义。
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
                    if (isImageMimeType(part.fileData.mimeType)) {
                        messageParts.push({
                            type: 'input_image',
                            image_url: part.fileData.fileUri
                        });
                    } else {
                        messageParts.push({
                            type: 'input_file',
                            file_url: part.fileData.fileUri
                        });
                    }
                }
            }

            // 提交剩余积攒的消息内容
            flushMessage();

            const contentInputItems = input.slice(contentInputStart);
            const hasAssistantOutput = contentInputItems.some(item =>
                (item?.type === 'message' && item.role === 'assistant') ||
                item?.type === 'function_call'
            );
            if (
                useDeepSeekReasoningTextFallback &&
                hasAssistantOutput &&
                !contentInputItems.some(hasReasoningTextContent)
            ) {
                // Responses 把 assistant 的思维链字段编码为独立 reasoning input item，
                // DeepSeek 再将它与同一 assistant 输出消息合并。模型无论是直接调用工具
                // 还是直接输出文本，只要完全跳过思考，都在该消息片段开头补空字符串字段。
                input.splice(contentInputStart, 0, {
                    type: 'reasoning',
                    content: createDeepSeekReasoningTextFallbackContent()
                });
            }
        }
        
        return input;
    }

    /**
     * 解析 OpenAI Responses API 响应 (非流式)
     */
    parseResponse(response: any): GenerateResponse {
        // 兼容代理常在 HTTP 200 的响应体里内联错误（余额不足、模型不存在等），
        // 这类 body 没有 output 数组，不识别就会被当成 invalidResponse 误报
        throwIfStreamError(response, 'OpenAI');

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
                        } else if (contentPart.type === 'refusal' && typeof contentPart.refusal === 'string') {
                            parts.push({ text: contentPart.refusal });
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
                const args = parseToolArguments(item.arguments, item.name);
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
            
            case 'response.refusal.delta':
            case 'response.output_text.delta':
            case 'response.text.delta': // 兼容旧版本
                // 文本增量
                parts.push({
                    text: chunk.delta
                });
                break;
            
            case 'response.reasoning_text.done':
                // DeepSeek 等兼容端点会在 delta 后发送完整 reasoning_text；
                // 该事件是权威全文，交给 StreamAccumulator 覆盖已累积的增量，
                // 并保存为下一轮请求所需的 reasoning_text content。
                {
                    const text = getReasoningEventText(chunk);
                    if (text) {
                        parts.push({
                            text,
                            thought: true,
                            openaiResponsesReasoning: {
                                ...(typeof chunk.item_id === 'string' ? { id: chunk.item_id } : {}),
                                status: 'completed',
                                content: [{ type: 'reasoning_text', text }]
                            }
                        });
                    }
                }
                break;

            case 'response.reasoning_summary_text.done':
                // 兼容提供完整摘要事件的 Responses 端点。
                {
                    const text = getReasoningEventText(chunk);
                    if (text) {
                        parts.push({
                            text,
                            thought: true,
                            openaiResponsesReasoning: {
                                ...(typeof chunk.item_id === 'string' ? { id: chunk.item_id } : {}),
                                status: 'completed',
                                summary: [{ type: 'summary_text', text }]
                            }
                        });
                    }
                }
                break;

            case 'response.reasoning_text.delta':
            case 'response.reasoning_summary_text.delta':
            case 'response.reasoning.delta': // 兼容旧版本
                const isSummaryDelta = chunk.type === 'response.reasoning_summary_text.delta';
                parts.push({
                    text: chunk.delta,
                    thought: true,
                    openaiResponsesReasoning: {
                        ...(typeof chunk.item_id === 'string' ? { id: chunk.item_id } : {}),
                        status: 'in_progress',
                        ...(isSummaryDelta
                            ? { summary: [{ type: 'summary_text', text: chunk.delta }] }
                            : { content: [{ type: 'reasoning_text', text: chunk.delta }] })
                    }
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
            
            case 'response.incomplete':
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
                
                finishReason = chunk.type === 'response.incomplete'
                    ? chunk.response?.incomplete_details?.reason || 'incomplete'
                    : chunk.response?.status;
                break;
            
            case 'response.failed':
                // 响应失败：错误体挂在 response 下，顶层判错拦不到，这里单独归一
                throwIfStreamError(chunk.response, 'OpenAI Responses');
                throw new ChannelError(
                    ErrorType.API_ERROR,
                    t('modules.channel.formatters.streamError', { provider: 'OpenAI Responses', message: 'Response failed' }),
                    chunk
                );


                
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
        if (optionsEnabled.reasoning && options.reasoning) {
            const reasoning: any = {};
            let effort: string | undefined = options.reasoning.effort;
            // 自定义模式：使用 effortCustom 的值原样透传
            if (effort === 'custom') {
                effort = options.reasoning.effortCustom?.trim() || undefined;
            }
            if (effort) {
                reasoning.effort = effort;
            }
            
            // 处理输出详细程度 (Summary)
            if (options.reasoning.summaryEnabled && options.reasoning.summary) {
                reasoning.summary = options.reasoning.summary;
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

