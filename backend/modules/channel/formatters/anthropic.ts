/**
 * GrayCode - Anthropic 格式转换器
 *
 * 将统一格式转换为 Anthropic Claude API 格式
 *
 * ## Anthropic API 特点
 *
 * 1. 认证：使用 x-api-key 头部
 * 2. 版本：需要 anthropic-version 头部
 * 3. 消息格式：content 是数组，每项有 type 字段
 * 4. 多模态：{"type": "image", "source": {"type": "base64", "media_type": "...", "data": "..."}}
 * 5. 工具调用：使用 tool_use 和 tool_result
 *
 * ## 工具调用处理流程
 *
 * ### Function Call 模式
 * - AI 返回 content 中包含 type: "tool_use"
 * - functionResponse 使用 type: "tool_result"
 *
 * ### XML/JSON 模式
 * - 与 OpenAI 类似，工具转换为提示词
 */

import { createHash } from 'crypto';
import { t } from '../../../i18n';
import { BaseFormatter, ensureStrictSchema } from './base';
import type { Content, ContentPart } from '../../conversation/types';
import type { AnthropicConfig } from '../../config/types';
import type { ToolDeclaration } from '../../../tools/types';
import {
    convertToolsToXML,
    convertFunctionCallToXML,
    convertFunctionResponseToXML,
    parseXMLToolCalls
} from '../../../tools/xmlFormatter';
import {
    convertToolsToJSON,
    convertFunctionCallToJSON,
    convertFunctionResponseToJSON,
    TOOL_CALL_START,
    TOOL_CALL_END
} from '../../../tools/jsonFormatter';
import {
    detectPromptToolMode,
    extractPromptToolParts,
    IncrementalPromptToolParser
} from '../../../core/parsers/promptToolParser';
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
import type {
    GenerateRequest,
    GenerateResponse,
    StreamChunk,
    HttpRequestOptions
} from '../types';

// 兼容性常量：发送给 Anthropic 的 user id 前缀（历史版本沿用 limcode 品牌）。
// 修改会改变上游侧用户标识，可能影响 Anthropic 侧的用户级缓存/配额统计，请谨慎变更。
const ANTHROPIC_USER_ID_PREFIX = 'limcode-conversation-';

/**
 * Anthropic 格式转换器
 *
 * 支持 Anthropic Claude API 的完整功能：
 * - 文本内容
 * - 多模态（图片）
 * - 工具调用（tool_use/tool_result）
 * - Token 统计
 * - 流式和非流式输出
 */
export class AnthropicFormatter extends BaseFormatter {
    /**
     * 构建 Anthropic API 请求
     */
    buildRequest(
        request: GenerateRequest,
        config: AnthropicConfig,
        tools?: ToolDeclaration[]
    ): HttpRequestOptions {
        const { history } = request;
        const toolMode = (config as any).toolMode || 'function_call';
        
        // 处理系统指令
        let systemInstruction = (config as any).systemInstruction || '';
        
        // 追加静态系统提示词（操作系统、时区、语言、工作区路径 - 可被 API provider 缓存）
        if (request.dynamicSystemPrompt) {
            systemInstruction = systemInstruction
                ? `${systemInstruction}\n\n${request.dynamicSystemPrompt}`
                : request.dynamicSystemPrompt;
        }
        
        // 处理工具描述 - 替换占位符或追加到系统提示词
        // 准备工具定义内容
        let toolsContent = '';
        let mcpToolsContent = '';
        
        if (tools && tools.length > 0) {
            if (toolMode === 'xml') {
                // XML 模式：工具转换为 XML
                toolsContent = convertToolsToXML(tools);
            } else if (toolMode === 'json') {
                // JSON 模式：工具转换为 JSON
                toolsContent = convertToolsToJSON(tools);
            }
        }
        
        // MCP 工具由外部传入
        if (request.mcpToolsContent) {
            mcpToolsContent = request.mcpToolsContent;
        }
        
        // 替换占位符（如果存在）
        if (systemInstruction.includes('{{$TOOLS}}') || systemInstruction.includes('{{$MCP_TOOLS}}')) {
            // 替换 TOOLS 占位符
            systemInstruction = systemInstruction.replace(/\{\{\$TOOLS\}\}/g, toolsContent);
            // 替换 MCP_TOOLS 占位符
            systemInstruction = systemInstruction.replace(/\{\{\$MCP_TOOLS\}\}/g, mcpToolsContent);
        } else if (toolsContent) {
            // 如果没有占位符但有工具内容，追加到末尾
            systemInstruction = systemInstruction
                ? `${systemInstruction}\n\n${toolsContent}`
                : toolsContent;
        }
        
        // 转换思考签名格式
        let processedHistory = this.convertThoughtSignatures(history);
        processedHistory = this.injectPromptContextMessages(
            processedHistory,
            this.getPromptContextForRequest(request),
            request.dynamicContextStrategy,
            { stripPreservedThoughtParts: config.sendHistoryThoughts !== true }
        );
        
        // 清理内部字段（如 isUserInput），这些字段不应该发送给 API
        processedHistory = this.cleanInternalFields(processedHistory);
        
        // 转换历史消息为 Anthropic 格式
        const messages = this.convertToAnthropicMessages(processedHistory, toolMode);
        
        // 构建请求体
        const body: any = {
            model: config.model,
            messages: messages
        };
        
        // 添加系统指令（Anthropic 使用独立的 system 字段）
        if (systemInstruction) {
            body.system = systemInstruction;
        }
        
        // 添加工具（Function Call 模式）
        // strictToolsEnabled: 启用后，标记了 strict: true 的工具会带上 strict 字段
        
        const strictEnabled = !!(config as any).strictToolsEnabled;
        if (tools && tools.length > 0 && toolMode === 'function_call') {
            body.tools = this.convertTools(tools, strictEnabled);
        }
        
        // 添加生成配置
        const genConfig = this.buildGenerationConfig(config);
        Object.assign(body, genConfig);
        
        // 决定是否使用流式（始终发送 stream 字段）
        const useStream = (config.options as any)?.stream ?? (config as any).preferStream ?? false;
        body.stream = useStream;
        
        // 构建 URL
        const baseUrl = config.url.endsWith('/')
            ? config.url.slice(0, -1)
            : config.url;
        
        const url = `${baseUrl}/messages`;
        
        // 构建请求头
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            'anthropic-version': '2023-06-01'
        };

        // 如果启用了 strict tool use，注入 structured-outputs beta header
        // Anthropic strict 模式必要的 beta header
        // 此 header 是 Anthropic strict 模式的必要条件
        if (strictEnabled && body.tools?.some((t: any) => t.strict === true)) {
            const existingBeta = headers['anthropic-beta'];
            const strictBeta = 'structured-outputs-2025-12-15';
            headers['anthropic-beta'] = existingBeta
                ? `${existingBeta},${strictBeta}`
                : strictBeta;
        }
        
        // 只有当 apiKey 存在时才添加认证头
        if (config.apiKey) {
            if ((config as any).useAuthorizationHeader) {
                // 使用 Authorization Bearer 格式
                headers['Authorization'] = `Bearer ${config.apiKey}`;
            } else {
                // 使用原生 x-api-key 格式
                headers['x-api-key'] = config.apiKey;
            }
        }
        
        // 应用自定义标头（如果启用）
        applyCustomHeaders(headers, (config as any).customHeaders, (config as any).customHeadersEnabled);
        
        // 修改原因：并行 SubAgent 与主会话共用同一 API Key 时，provider/网关侧需要区分不同运行域的请求。
        // 修改方式：启用 anthropicUserIdEnabled 且请求携带 conversationId（SubAgent 传 runId）时，
        //          注入 Anthropic 官方 metadata.user_id 字段（sha256 哈希，不泄露原始 ID）。
        // 修改目的：与 OpenAI 渠道的 DeepSeek user_id 机制对齐，主会话与各 SubAgent 的缓存/风控域互不混淆。
        const anthropicUserId = this.buildAnthropicUserId(request, config);
        if (anthropicUserId) {
            body.metadata = { ...(body.metadata || {}), user_id: anthropicUserId };
        }

        // 如果启用了 Prompt Caching，注入手动缓存断点
        // 缓存层级顺序：tools -> system -> messages
        // 在每个层级的最后一个内容块上添加 cache_control 标记
        // 支持 5 分钟（默认）或 1 小时 TTL
        if ((config as any).promptCachingEnabled) {
            const ttl = (config as any).promptCachingTtl || '5m';
            this.injectCacheBreakpoints(body, ttl);
        }
        
        // 应用自定义 body（如果启用）
        const finalBody = applyCustomBody(body, (config as any).customBody, (config as any).customBodyEnabled);
        
        // 构建请求选项
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
     * Anthropic Messages API 支持 metadata.user_id 官方字段。
     *
     * 只有渠道启用 anthropicUserIdEnabled 且调用方传入 conversationId 时才生成。
     * 主聊天请求传真实对话 ID，SubAgent 传 runId，各运行域彼此区分。
     *
     * 续跑（continueFromRunId）时 executor 会把 conversationId 直接沿用旧 runId，
     * 因此 user_id 哈希输入与旧 run 一致，运行域天然相同，无需额外字段。
     *
     * user_id 使用 ID 的 sha256 哈希，稳定且不包含原始对话信息。
     */
    private buildAnthropicUserId(request: GenerateRequest, config: AnthropicConfig): string | undefined {
        if (!(config as any).anthropicUserIdEnabled) {
            return undefined;
        }

        const domainId = request.conversationId?.trim();
        if (!domainId) {
            return undefined;
        }

        const digest = createHash('sha256')
            .update(domainId, 'utf8')
            .digest('hex');

        return `${ANTHROPIC_USER_ID_PREFIX}${digest}`;
    }

    /**
     * 转换为 Anthropic 消息格式
     *
     * Anthropic 格式：
     * - role: "user" | "assistant"
     * - content: array of content blocks
     */
    private convertToAnthropicMessages(
        history: Content[],
        toolMode: string = 'function_call'
    ): any[] {
        const messages: any[] = [];
        
        // 根据模式使用不同的转换策略
        if (toolMode === 'function_call') {
            this.convertHistoryFunctionCallMode(history, messages);
        } else {
            // XML 或 JSON 模式
            this.convertHistoryTextMode(history, messages, toolMode as 'xml' | 'json');
        }
        
        return messages;
    }
    
    /**
     * 追加一条转换后的消息，相邻同角色消息自动合并
     *
     * 修改原因（H1-3 防御）：总结功能（SummarizeService）会把总结消息以 role:'user'
     * 插入历史，可能紧随 functionResponse（tool_result）之后，或与真实 user 消息相邻，
     * 形成连续两条 user 消息；Anthropic Messages API 对同角色相邻消息敏感（部分端点
     * 要求严格交替）。这里把连续同角色输出合并为一条消息（content block 数组拼接）——
     * tool_result 与 text 允许共存于同一条 user 消息，语义不变。
     *
     * 注意：只合并真正同角色的连续条目。assistant(tool_use) 与 user(tool_result) 角色
     * 不同，天然交替，不会跨 tool_use 边界错误合并。assistant 连续消息同样合并
     * （防御，很少发生）。
     */
    private pushMergedMessage(messages: any[], role: string, contentArray: any[]): void {
        const last = messages[messages.length - 1];
        if (last && last.role === role) {
            last.content.push(...contentArray);
        } else {
            messages.push({ role, content: contentArray });
        }
    }
    
    /**
     * Function Call 模式转换
     *
     * - functionCall 使用 type: "tool_use"
     * - functionResponse 使用 type: "tool_result"
     * - 思考内容使用 type: "thinking"，包含 thinking 和 signature 字段
     * - 加密思考使用 type: "redacted_thinking"，包含 data 字段
     */
    private convertHistoryFunctionCallMode(history: Content[], messages: any[]): void {
        // 成对过滤：rejected functionCall 及其配对 functionResponse 一起丢弃，
        // 避免「tool_use 被滤掉、tool_result 残留」的孤儿 tool_result 400。
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
            
            // 分离各种类型的 parts
            const textParts = content.parts.filter(p => 'text' in p && !p.thought);
            const thoughtParts = content.parts.filter(p => 'text' in p && p.thought);
            const redactedThinkingParts = content.parts.filter(p => p.redactedThinking);
            const signatureParts = content.parts.filter(p => (p as any).signature);
            const functionCallParts = content.parts.filter(p => p.functionCall && !p.functionCall.rejected);
            const functionResponseParts = content.parts.filter(
                p => p.functionResponse && !(p.functionResponse.id && rejectedCallIds.has(p.functionResponse.id))
            );
            const mediaParts = content.parts.filter(p => p.inlineData || p.fileData);
            
            if (functionCallParts.length > 0) {
                // assistant 消息包含 tool_use
                const contentArray: any[] = [];
                
                // 添加思考内容（如果有）- 包括普通思考和加密思考
                this.addThinkingBlocks(contentArray, thoughtParts, redactedThinkingParts, signatureParts);
                
                // 添加文本内容
                for (const part of textParts) {
                    if (part.text) {
                        contentArray.push({
                            type: 'text',
                            text: part.text
                        });
                    }
                }
                
                // 添加 tool_use
                for (const [index, part] of functionCallParts.entries()) {
                    const fc = part.functionCall!;
                    contentArray.push({
                        type: 'tool_use',
                        // 无 id 时生成：计数器+随机后缀保证同消息内多个 tool_use 不重复
                        // （对齐 openai.ts 的 _${index} 做法；裸 Date.now() 同毫秒会碰撞）
                        id: fc.id || `toolu_${Date.now()}_${index}_${Math.random().toString(36).slice(2, 8)}`,
                        name: fc.name,
                        input: fc.args
                    });
                }
                
                this.pushMergedMessage(messages, 'assistant', contentArray);
            }

            // 工具结果独立生成（与 functionCall 解耦）：同一历史消息同时携带
            // functionCall + functionResponse（如中断残留/修复数据的混合形态）时，
            // 原来的 else-if 会吞掉 functionResponse，导致 assistant tool_use
            // 后没有对应 tool_result → Anthropic 400。
            // 注意：普通消息分支必须加 functionCallParts.length === 0 守卫——
            // 否则「文本 + 工具调用」同消息的日常形态会把文本重复推送为第二条
            // assistant 消息，并使后续 tool_result 不再紧跟 tool_use（上游 80e9de7
            // 因此引入的回归；此处为修正版）。
            if (functionResponseParts.length > 0) {
                // user 消息包含 tool_result；同消息的 textParts 一并并入 content
                // （Anthropic tool_result 与 text 块可共存），避免 text + functionResponse
                // 混合形态把文本丢掉。
                const contentArray: any[] = [];

                // 添加文本内容
                for (const part of textParts) {
                    if (part.text) {
                        contentArray.push({
                            type: 'text',
                            text: part.text
                        });
                    }
                }

                for (const [index, part] of functionResponseParts.entries()) {
                    const resp = part.functionResponse!;
                    contentArray.push({
                        type: 'tool_result',
                        // 无 id 时生成：计数器+随机后缀保证同消息内多个 tool_result 不重复
                        // （对齐本文件 tool_use 的 id 生成；裸 Date.now() 同毫秒会碰撞）
                        tool_use_id: resp.id || `toolu_${Date.now()}_${index}_${Math.random().toString(36).slice(2, 8)}`,
                        content: serializeToolResultForLLM(resp.name, resp.response as Record<string, unknown>)
                    });
                }
                
                this.pushMergedMessage(messages, 'user', contentArray);
            } else if (functionCallParts.length === 0 && (textParts.length > 0 || mediaParts.length > 0 || thoughtParts.length > 0 || redactedThinkingParts.length > 0)) {
                // 普通消息（可能包含文本、多媒体和/或思考内容）
                const contentArray: any[] = [];
                
                // 添加思考内容（如果有）- 包括普通思考和加密思考
                this.addThinkingBlocks(contentArray, thoughtParts, redactedThinkingParts, signatureParts);
                
                // 添加普通内容
                contentArray.push(...this.buildMessageContent(textParts, mediaParts));
                
                this.pushMergedMessage(messages, role, contentArray);
            }
        }
    }
    
    /**
     * 添加思考块到内容数组
     *
     * 处理三种类型的思考内容：
     * 1. 普通思考（thinking）
     * 2. 加密思考（redacted_thinking）
     * 3. 思考签名（signature）
     */
    private addThinkingBlocks(
        contentArray: any[],
        thoughtParts: ContentPart[],
        redactedThinkingParts: ContentPart[],
        signatureParts: ContentPart[]
    ): void {
        // 添加普通思考内容
        if (thoughtParts.length > 0) {
            const thinkingText = thoughtParts.map(p => p.text).join('\n');
            const thinkingBlock: any = {
                type: 'thinking',
                thinking: thinkingText
            };
            // 如果有签名，添加到思考块
            if (signatureParts.length > 0) {
                thinkingBlock.signature = (signatureParts[0] as any).signature;
            }
            contentArray.push(thinkingBlock);
        }
        
        // 添加加密思考内容
        for (const part of redactedThinkingParts) {
            if (part.redactedThinking) {
                contentArray.push({
                    type: 'redacted_thinking',
                    data: part.redactedThinking
                });
            }
        }
    }
    
    /**
     * 构建消息内容（支持多模态）
     *
     * Anthropic 格式：
     * - 文本：{type: "text", text: "..."}
     * - 图片：{type: "image", source: {type: "base64", media_type: "...", data: "..."}}
     */
    private buildMessageContent(textParts: ContentPart[], mediaParts: ContentPart[]): any[] {
        const contentArray: any[] = [];
        
        // 添加多媒体部分（按 MIME 类型转换，不能一律当作图片）
        for (const part of mediaParts) {
            if (part.inlineData) {
                const { mimeType, data } = part.inlineData;
                
                if (isImageMimeType(mimeType)) {
                    // 图片 -> image 块（Base64 内联数据）
                    contentArray.push({
                        type: 'image',
                        source: {
                            type: 'base64',
                            media_type: mimeType,
                            data
                        }
                    });
                } else if (isPdfMimeType(mimeType)) {
                    // PDF -> document 块（Anthropic 支持）
                    contentArray.push({
                        type: 'document',
                        source: {
                            type: 'base64',
                            media_type: mimeType,
                            data
                        }
                    });
                } else if (isTextMimeType(mimeType)) {
                    // 文本文件（如 txt）-> 解码为 text 块
                    contentArray.push({
                        type: 'text',
                        text: buildTextAttachmentContent(data)
                    });
                } else {
                    // 其他格式（音视频等）Anthropic 不支持直接发送，转为文本占位
                    contentArray.push({
                        type: 'text',
                        text: buildUnsupportedAttachmentText(mimeType)
                    });
                }
            } else if (part.fileData) {
                // 文件引用 -> URL 格式
                contentArray.push({
                    type: 'image',
                    source: {
                        type: 'url',
                        url: part.fileData.fileUri
                    }
                });
            }
        }
        
        // 添加文本部分
        for (const part of textParts) {
            if (part.text) {
                contentArray.push({
                    type: 'text',
                    text: part.text
                });
            }
        }
        
        return contentArray;
    }
    
    /**
     * XML/JSON 模式转换
     *
     * - functionCall 转回文本
     * - functionResponse 作为 user 消息发送
     */
    private convertHistoryTextMode(history: Content[], messages: any[], mode: 'xml' | 'json'): void {
        // 成对过滤：rejected functionCall 及其配对 functionResponse 一起丢弃（与 function_call 模式注释同理）
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
            
            // 分离各种类型的 parts
            const functionResponseParts = content.parts.filter(
                p => p.functionResponse && !(p.functionResponse.id && rejectedCallIds.has(p.functionResponse.id))
            );
            const mediaParts = content.parts.filter(p => p.inlineData || p.fileData);
            
            if (functionResponseParts.length > 0) {
                // functionResponse 作为 user 消息发送；同消息的普通 text parts 一并并入
                // （与 function_call 模式分支对齐：text → response 文本 → media 的顺序），
                // 避免 text + functionResponse 混合形态把文本丢掉。
                const contentArray: any[] = [];

                // 添加同消息的普通文本内容
                for (const part of content.parts) {
                    if ('text' in part && part.text && !part.thought) {
                        contentArray.push({
                            type: 'text',
                            text: part.text
                        });
                    }
                }
                
                for (const part of functionResponseParts) {
                    const resp = part.functionResponse!;
                    const responseText = mode === 'xml'
                        ? convertFunctionResponseToXML(resp.name, resp.response)
                        : convertFunctionResponseToJSON(resp.name, resp.response);
                    
                    contentArray.push({
                        type: 'text',
                        text: responseText
                    });
                }
                
                this.pushMergedMessage(messages, 'user', contentArray);
            } else {
                // 将 functionCall 转回文本，与 text 合并
                const textParts: ContentPart[] = [];
                
                for (const part of content.parts) {
                    if (part.thought) {
                        continue;
                    }
                    
                    if (part.inlineData || part.fileData) {
                        continue;
                    }
                    
                    if (part.functionCall && !part.functionCall.rejected) {
                        const callText = mode === 'xml'
                            ? convertFunctionCallToXML(part.functionCall.name, part.functionCall.args)
                            : convertFunctionCallToJSON(part.functionCall.name, part.functionCall.args);
                        textParts.push({ text: callText });
                    } else if ('text' in part && part.text) {
                        textParts.push({ text: part.text });
                    }
                }
                
                if (textParts.length > 0 || mediaParts.length > 0) {
                    const contentArray = this.buildMessageContent(textParts, mediaParts);
                    this.pushMergedMessage(messages, role, contentArray);
                }
            }
        }
    }
    
    /**
     * 构建生成配置
     */
    private buildGenerationConfig(config: AnthropicConfig): any {
        const genConfig: any = {};
        const optionsEnabled = (config as any).optionsEnabled || {};
        
        // max_tokens: Anthropic API 强制要求该字段，无条件发送（未显式配置时用 65535 兜底，上游 6d4bb95）
        genConfig.max_tokens = config.options?.max_tokens ?? 65535;
        
        if (optionsEnabled.temperature && config.options?.temperature !== undefined) {
            genConfig.temperature = config.options.temperature;
        }
        
        if (optionsEnabled.top_p && config.options?.top_p !== undefined) {
            genConfig.top_p = config.options.top_p;
        }
        
        if (optionsEnabled.top_k && config.options?.top_k !== undefined) {
            genConfig.top_k = config.options.top_k;
        }
        
        if (config.options?.stop_sequences && config.options.stop_sequences.length > 0) {
            genConfig.stop_sequences = config.options.stop_sequences;
        }
        
        // 添加 thinking 配置（如果启用）
        const thinkingEnabled = optionsEnabled.thinking;
        const thinking = config.options?.thinking;
        
        if (thinkingEnabled && thinking) {
            const thinkingType = thinking.type || 'enabled';
            const thinkingDisplay = thinking.display;  // 'omitted' | 'summarized' | undefined
            
            if (thinkingType === 'adaptive') {
                // 自适应思考模式（Opus 4.6+）
                genConfig.thinking = {
                    type: 'adaptive'
                };
                
                // 思考内容显示模式（Opus 4.7+ 默认 omitted）
                if (thinkingDisplay) {
                    genConfig.thinking.display = thinkingDisplay;
                }
                
                // effort 通过 output_config 发送
                let effort: string | undefined = thinking.effort;
                // 自定义模式：使用 effortCustom 的值原样透传
                if (effort === 'custom') {
                    effort = thinking.effortCustom?.trim() || undefined;
                }
                if (effort) {
                    genConfig.output_config = {
                        effort
                    };
                }
            } else if (thinkingType === 'enabled') {
                // 传统手动思考模式
                const thinkingConfig: any = {
                    type: 'enabled'
                };
                
                // 思考内容显示模式
                if (thinkingDisplay) {
                    thinkingConfig.display = thinkingDisplay;
                }
                
                // 思考预算（budget_tokens）
                if (thinking.budget_tokens && thinking.budget_tokens > 0) {
                    thinkingConfig.budget_tokens = thinking.budget_tokens;
                } else {
                    // 默认预算
                    thinkingConfig.budget_tokens = 10000;
                }
                
                genConfig.thinking = thinkingConfig;
            } else if (thinkingType === 'disabled') {
                // 显式关闭思考：请求显式携带 {"thinking": {"type": "disabled"}}
                // （思考强度快捷下拉 Off 档写入 type=disabled，与省略字段的隐式关闭等价但更明确）
                genConfig.thinking = {
                    type: 'disabled'
                };
            }
        }
        
        return genConfig;
    }

    /**
     * 注入手动缓存断点
     *
     * 根据 Anthropic Prompt Caching 的缓存前缀层级（tools -> system -> messages），
     * 在各层级的最后一个可缓存内容块上添加 cache_control 标记。
     *
     * 最多使用 4 个缓存断点（Anthropic 限制），当前策略使用最多 3 个：
     * 1. tools 数组的最后一个工具
     * 2. system 内容（转为数组格式后的最后一个块）
     * 3. messages 中最后一条 user 消息的最后一个 content block
     *
     * @param body - 请求体
     * @param ttl - 缓存 TTL：'5m'（默认，1.25x 写入价格）或 '1h'（2x 写入价格）
     */
    private injectCacheBreakpoints(body: any, ttl: string = '5m'): void {
        const cacheControl: any = { type: 'ephemeral' as const };
        if (ttl === '1h') {
            cacheControl.ttl = '1h';
        }

        // 1. 在 tools 的最后一个工具上添加缓存断点
        if (body.tools && Array.isArray(body.tools) && body.tools.length > 0) {
            body.tools[body.tools.length - 1].cache_control = cacheControl;
        }

        // 2. 将 system 从字符串转为内容块数组格式，并在最后一个块上添加缓存断点
        // Anthropic 支持 system 为字符串或内容块数组，使用数组格式才能添加 cache_control
        if (body.system && typeof body.system === 'string') {
            body.system = [
                {
                    type: 'text',
                    text: body.system,
                    cache_control: cacheControl
                }
            ];
        } else if (Array.isArray(body.system) && body.system.length > 0) {
            body.system[body.system.length - 1].cache_control = cacheControl;
        }

        // 3. 在 messages 中最后一条 user 消息的最后一个 content block 上添加缓存断点
        // 这样可以缓存大部分历史消息前缀
        if (body.messages && Array.isArray(body.messages) && body.messages.length > 0) {
            // 从后向前找最后一条 user 消息
            for (let i = body.messages.length - 1; i >= 0; i--) {
                const msg = body.messages[i];
                if (msg.role === 'user' && Array.isArray(msg.content) && msg.content.length > 0) {
                    // 确保 content block 是对象格式（Anthropic 消息通常已经是对象数组）
                    const lastBlock = msg.content[msg.content.length - 1];
                    if (typeof lastBlock === 'object' && lastBlock !== null) {
                        lastBlock.cache_control = cacheControl;
                        break;
                    }
                }
            }
        }
    }
    
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
    parseResponse(response: any): GenerateResponse {
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
            content.usageMetadata = this.extractUsageMetadata(response.usage);
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
     * 自动检测模式解析响应
     */
    private parseResponseAutoDetect(contentText: string): ContentPart[] {
        const promptMode = detectPromptToolMode(contentText);
        if (!promptMode) {
            const parts: ContentPart[] = [];
            if (contentText.trim()) {
                parts.push({ text: contentText });
            }
            return parts;
        }

        const extracted = extractPromptToolParts(contentText, promptMode, {
            flushIncompleteTailAsText: true
        });
        return extracted.parts;
    }
    
    /**
     * 从内容中提取 JSON 格式的工具调用
     */
    private extractJSONToolCallsFromContent(content: string, existingParts: ContentPart[]): ContentPart[] {
        const parts = [...existingParts];
        const segments = content.split(TOOL_CALL_START);
        
        for (let i = 0; i < segments.length; i++) {
            const segment = segments[i];
            
            if (i === 0) {
                const text = segment.trim();
                if (text) {
                    parts.push({ text });
                }
            } else {
                const endIndex = segment.indexOf(TOOL_CALL_END);
                
                if (endIndex !== -1) {
                    const jsonStr = segment.substring(0, endIndex).trim();
                    try {
                        const parsed = JSON.parse(jsonStr);
                        if (parsed.tool && typeof parsed.tool === 'string') {
                            parts.push({
                                functionCall: {
                                    name: parsed.tool,
                                    args: parsed.parameters || {},
                                    id: `toolu_${Date.now()}_${i}`
                                }
                            });
                        }
                    } catch (error) {
                        console.warn('Failed to parse JSON tool call:', error);
                        parts.push({ text: `${TOOL_CALL_START}${jsonStr}${TOOL_CALL_END}` });
                    }
                    
                    const afterText = segment.substring(endIndex + TOOL_CALL_END.length).trim();
                    if (afterText) {
                        parts.push({ text: afterText });
                    }
                } else {
                    parts.push({ text: `${TOOL_CALL_START}${segment}` });
                }
            }
        }
        
        return parts;
    }
    
    /**
     * 从内容中提取 XML 格式的工具调用
     */
    private extractXMLToolCallsFromContent(content: string, existingParts: ContentPart[]): ContentPart[] {
        const parts = [...existingParts];
        const toolUseRegex = /<tool_use>([\s\S]*?)<\/tool_use>/g;
        let lastIndex = 0;
        let match;
        
        while ((match = toolUseRegex.exec(content)) !== null) {
            const beforeText = content.substring(lastIndex, match.index).trim();
            if (beforeText) {
                parts.push({ text: beforeText });
            }
            
            const toolCalls = parseXMLToolCalls(match[0]);
            for (const call of toolCalls) {
                parts.push({
                    functionCall: {
                        name: call.name,
                        args: call.args,
                        id: `toolu_${Date.now()}_${parts.length}`
                    }
                });
            }
            
            lastIndex = match.index + match[0].length;
        }
        
        const afterText = content.substring(lastIndex).trim();
        if (afterText) {
            parts.push({ text: afterText });
        }
        
        if (parts.length === existingParts.length && content.trim()) {
            parts.push({ text: content });
        }
        
        return parts;
    }
    
    /**
     * 解析流式响应块
     *
     * Anthropic 流式格式使用 SSE，事件类型：
     * - message_start: 消息开始
     * - content_block_start: 内容块开始
     * - content_block_delta: 内容增量
     * - content_block_stop: 内容块结束
     * - message_delta: 消息增量（包含 stop_reason）
     * - message_stop: 消息结束
     *
     * 思考内容流式格式：
     * - content_block_start: { type: "thinking" }
     * - content_block_delta: { type: "thinking_delta", thinking: "..." }
     * - content_block_delta: { type: "signature_delta", signature: "..." }
     */
    /**
     * 统一从 Anthropic usage 对象中提取 UsageMetadata
     *
     * 兼容官方 Anthropic API 和第三方代理（OpenRouter、one-api 等）的 usage 格式差异：
     * - 标准字段：input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens
     * - thinking 模型：output_tokens_details.thinking_tokens
     * - 部分代理可能在任意事件中返回完整 usage，统一处理避免遗漏
     */
    private extractUsageMetadata(usage: any): Content['usageMetadata'] {
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

    parseStreamChunk(chunk: any): StreamChunk {
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
                parts.push({
                    functionCall: {
                        name: block.name,
                        args: args,
                        partialArgs: Object.keys(args).length > 0 ? JSON.stringify(args) : '',
                        id: block.id,
                        // 透传事件级 index（同 input_json_delta），保证与参数增量按同一 index 合并
                        index: chunk.index
                    }
                });
            }
        } else if (chunk.type === 'message_delta') {
            finishReason = chunk.delta?.stop_reason;
            if (chunk.usage) {
                usage = this.extractUsageMetadata(chunk.usage);
            }
        } else if (chunk.type === 'message_stop') {
            done = true;
            // 部分代理（OpenRouter 等）在 message_stop 中返回完整 usage
            if (chunk.usage) {
                usage = this.extractUsageMetadata(chunk.usage);
            } else if (chunk.message?.usage) {
                usage = this.extractUsageMetadata(chunk.message.usage);
            }
        } else if (chunk.type === 'message_start') {
            // 消息开始，包含模型名称和 usage 信息
            if (chunk.message?.model) {
                modelVersion = chunk.message.model;
            }
            if (chunk.message?.usage) {
                usage = this.extractUsageMetadata(chunk.message.usage);
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
        
        return streamChunk;
    }
    
    /**
     * 验证配置（不验证 API Key）
     */
    validateConfig(config: any): boolean {
        if (config.type !== 'anthropic') {
            return false;
        }
        
        const anthropicConfig = config as AnthropicConfig;
        
        // 检查必需字段（不验证 apiKey）
        if (!anthropicConfig.url || !anthropicConfig.model) {
            return false;
        }
        
        return true;
    }
    
    /**
     * 获取支持的配置类型
     */
    getSupportedType(): string {
        return 'anthropic';
    }
    
    /**
     * 转换思考签名格式
     *
     * 将内部存储的 thoughtSignatures: { anthropic: "..." } 格式
     * 转换为 Anthropic API 需要的 signature 字段格式
     *
     * Anthropic 思考签名格式（发送时）：
     * content: [
     *   { type: "thinking", thinking: "...", signature: "..." }
     * ]
     *
     * 由于我们在 convertToAnthropicMessages 中处理内容，
     * 这里需要处理 parts 中的 thoughtSignatures
     */
    private convertThoughtSignatures(history: Content[]): Content[] {
        return history.map(content => {
            return {
                ...content,
                parts: content.parts.map(part => {
                    // 如果有 thoughtSignatures，提取 anthropic 格式的签名
                    if (part.thoughtSignatures?.anthropic) {
                        const { thoughtSignatures, ...restPart } = part;
                        return {
                            ...restPart,
                            // 使用 signature 字段存储，在后续处理中会转换为正确格式
                            signature: thoughtSignatures.anthropic
                        } as ContentPart;
                    }
                    // 如果有 thoughtSignatures 但没有 anthropic 格式，移除
                    if (part.thoughtSignatures) {
                        const { thoughtSignatures, ...restPart } = part;
                        return restPart;
                    }
                    return part;
                })
            };
        });
    }
    
    /**
     * 转换工具声明为 Anthropic 格式
     *
     * Anthropic 格式：
     * [{
     *   "name": "...",
     *   "description": "...",
     *   "input_schema": {...}  // JSON Schema
     * }]
     */
    convertTools(tools: ToolDeclaration[], strictEnabled?: boolean): any {
        if (!tools || tools.length === 0) {
            return undefined;
        }
        
        // Anthropic strict 工具数量上限为 20（API 限制）
        
        const ANTHROPIC_STRICT_TOOL_LIMIT = 20;
        let strictCount = 0;

        return tools.map(tool => {
            // 判断此工具是否启用 strict
            let useStrict = false;
            if (strictEnabled && tool.strict === true) {
                if (strictCount < ANTHROPIC_STRICT_TOOL_LIMIT) {
                    useStrict = true;
                    strictCount++;
                } else {
                    // 超过 20 个 strict 工具，降级为非 strict，记录警告
                    console.warn(
                        `[Anthropic] strict tool limit (${ANTHROPIC_STRICT_TOOL_LIMIT}) exceeded, ` +
                        `tool "${tool.name}" downgraded to non-strict`
                    );
                }
            }

            const toolDef: any = {
                name: tool.name,
                description: tool.description,
                input_schema: useStrict
                    ? ensureStrictSchema(tool.parameters)
                    : tool.parameters
            };

            if (useStrict) {
                toolDef.strict = true;
            }

            return toolDef;
        });
    }
}