/**
 * GrayCode - Gemini Interactions API 格式转换器
 *
 * 支持 Google Gemini Interactions API（POST /v1beta/interactions）：
 * - 无状态模式（store: false）：客户端管理完整 steps 历史
 * - thought 独立 step（signature + summary）
 * - function_call / function_result 独立 step（call_id 关联）
 * - SSE 事件流（step.start / step.delta / step.stop / interaction.completed / status_update）
 *
 * 与 gemini（generateContent）渠道平行，设计参照 openai / openai-responses；
 * 继承 GeminiFormatter 复用历史预处理（XML/JSON 模式转换、redactedThinking 剥离、
 * prompt context 注入、内部字段清理、图片数量限制）。
 */

import { t } from '../../../i18n';
import { buildGeminiApiUrl, GeminiFormatter, normalizeGeminiModelId } from './gemini';
import { throwIfStreamError } from './streamError';
import { applyCustomBody } from '../../config/configs/base';
import { ChannelError, ErrorType } from '../types';
import type {
    GenerateRequest,
    GenerateResponse,
    StreamChunk,
    StreamUsageMetadata,
    HttpRequestOptions
} from '../types';
import type { Content, ContentPart } from '../../conversation/types';
import type { ChannelConfig, GeminiInteractionsConfig } from '../../config/types';
import type { ToolDeclaration } from '../../../tools/types';
import { convertToolsToXML } from '../../../tools/xmlFormatter';
import { convertToolsToJSON } from '../../../tools/jsonFormatter';

/** 限制历史消息中的图片总数（模块级函数，与 gemini.ts 共用同一实现） */
function isImagePart(part: ContentPart): boolean {
    const mimeType = part.inlineData?.mimeType || part.fileData?.mimeType;
    return mimeType?.startsWith('image/') ?? false;
}

function limitTotalImageParts(contents: Content[], maxImages: number): Content[] {
    let remainingImages = maxImages;

    return contents
        .slice()
        .reverse()
        .map(content => {
            const parts = content.parts
                .slice()
                .reverse()
                .filter(part => {
                    if (!isImagePart(part)) {
                        return true;
                    }

                    if (remainingImages <= 0) {
                        return false;
                    }

                    remainingImages--;
                    return true;
                })
                .reverse();

            return {
                ...content,
                parts
            };
        })
        .reverse();
}

/**
 * Gemini Interactions 格式转换器
 */
export class GeminiInteractionsFormatter extends GeminiFormatter {
    /**
     * 构建 Gemini Interactions API 请求
     *
     * 无状态模式：input 为完整 steps 数组（含历史所有 user_input / model_output /
     * thought / function_call / function_result），每次请求携带全量历史。
     */
    buildRequest(
        request: GenerateRequest,
        config: ChannelConfig,
        tools?: ToolDeclaration[]
    ): HttpRequestOptions {
        const c = config as GeminiInteractionsConfig;
        const { history: rawHistory } = request;
        const toolMode = c.toolMode || 'function_call';

        // 剔除 Anthropic 专有 redactedThinking（与 gemini 渠道同口径）
        const history = this.stripRedactedThinking(rawHistory);

        // 根据模式处理历史记录（复用 GeminiFormatter 的 XML/JSON/function_call 预处理）
        let processedHistory: Content[];
        if (toolMode === 'xml') {
            processedHistory = this.convertHistoryToXMLMode(history);
        } else if (toolMode === 'json') {
            processedHistory = this.convertHistoryToJSONMode(history);
        } else {
            // Function Call 模式：过滤 rejected 残留（与 gemini 渠道同口径）
            const rejectedCallIds = new Set<string>();
            for (const content of history) {
                for (const part of content.parts) {
                    if (part.functionCall?.rejected && part.functionCall.id) {
                        rejectedCallIds.add(part.functionCall.id);
                    }
                }
            }
            processedHistory = history
                .map(content => ({
                    ...content,
                    parts: content.parts.filter(p => {
                        if (p.functionCall?.rejected) return false;
                        if (p.functionResponse?.id && rejectedCallIds.has(p.functionResponse.id)) return false;
                        return true;
                    })
                }))
                .filter(content => content.parts.length > 0);
        }

        // 注入 prompt context（preserve 回插动态快照），随后清理内部字段
        // 注意：Interactions 不需要 convertThoughtSignatures（签名在 thought step 而非 part 上）
        processedHistory = this.injectPromptContextMessages(
            processedHistory,
            this.getPromptContextForRequest(request),
            request.dynamicContextStrategy,
            { stripPreservedThoughtParts: c.sendHistoryThoughts !== true }
        );
        processedHistory = this.cleanInternalFields(processedHistory);

        // 根据配置限制发送的图片总数（在 Content[] 层面，与 steps 转换解耦）
        const maxImages = c.options?.maxImages;
        const maxImagesEnabled = c.optionsEnabled?.maxImages !== false;
        if (maxImagesEnabled && maxImages && maxImages > 0) {
            processedHistory = limitTotalImageParts(processedHistory, maxImages);
        }

        // 构建请求体（官方契约：裸 model ID + input 直接为 steps 数组；用户手填 models/ 前缀统一剥除）
        const body: any = {
            model: normalizeGeminiModelId(c.model),
            input: this.convertHistoryToSteps(processedHistory),
            generation_config: this.buildInteractionsGenerationConfig(c),
            // 客户端管理完整历史：显式关闭服务器端存储（store=false 与 previous_interaction_id 不兼容）
            store: false
        };

        // 系统指令（Interactions API 为字符串，非 parts 包装）
        let systemInstruction = c.systemInstruction || '';

        // 追加静态系统提示词（操作系统、时区、语言、工作区路径）
        if (request.dynamicSystemPrompt) {
            systemInstruction = systemInstruction
                ? `${systemInstruction}\n\n${request.dynamicSystemPrompt}`
                : request.dynamicSystemPrompt;
        }

        // 工具描述内容（xml/json 模式注入系统提示词；function_call 模式走独立 tools 字段）
        let toolsContent = '';
        let mcpToolsContent = '';

        if (tools && tools.length > 0) {
            if (toolMode === 'function_call') {
                body.tools = this.convertTools(tools);
            } else if (toolMode === 'xml') {
                toolsContent = convertToolsToXML(tools);
            } else if (toolMode === 'json') {
                toolsContent = convertToolsToJSON(tools);
            }
        }

        if (request.mcpToolsContent) {
            mcpToolsContent = request.mcpToolsContent;
        }

        // 替换占位符（如果存在）
        if (systemInstruction.includes('{{$TOOLS}}') || systemInstruction.includes('{{$MCP_TOOLS}}')) {
            systemInstruction = systemInstruction.replace(/\{\{\$TOOLS\}\}/g, toolsContent);
            systemInstruction = systemInstruction.replace(/\{\{\$MCP_TOOLS\}\}/g, mcpToolsContent);
        } else if (toolsContent) {
            systemInstruction = systemInstruction
                ? `${systemInstruction}\n\n${toolsContent}`
                : toolsContent;
        }

        if (systemInstruction) {
            body.system_instruction = systemInstruction;
        }

        // 是否流式（完全由配置决定）
        const useStream = c.options?.stream ?? c.preferStream ?? false;
        if (useStream) {
            body.stream = true;
        }

        // 统一 interactions 端点；流式用 alt=sse，基础 URL 的查询参数保留在最终路径末尾。
        const url = buildGeminiApiUrl(c.url, 'interactions', useStream ? { alt: 'sse' } : {});

        // 构建请求头
        const headers: Record<string, string> = {
            'Content-Type': 'application/json'
        };

        if (c.apiKey) {
            if (c.useAuthorizationHeader) {
                headers['Authorization'] = `Bearer ${c.apiKey}`;
            } else {
                headers['x-goog-api-key'] = c.apiKey;
            }
        }

        if (c.customHeadersEnabled && c.customHeaders) {
            for (const header of c.customHeaders) {
                if (header.enabled && header.key && header.key.trim()) {
                    headers[header.key.trim()] = header.value || '';
                }
            }
        }

        // 应用自定义 body（如果启用）
        const finalBody = applyCustomBody(body, c.customBody, c.customBodyEnabled);

        return {
            url,
            method: 'POST',
            headers,
            body: finalBody,
            timeout: c.timeout,
            stream: useStream
        };
    }

    /**
     * 构建生成配置（Interactions API 使用 snake_case generation_config）
     *
     * 差异（相对 generateContent）：
     * - maxOutputTokens → max_output_tokens
     * - thinkingConfig：mode='level' → thinking_level；mode='budget' 不发送
     *   （Interactions 的 GenerationConfig 无 thinking_budget，预算语义由 thinking_level 取代）；
     *   includeThoughts === false → thinking_summaries: "none"
     */
    private buildInteractionsGenerationConfig(config: GeminiInteractionsConfig): any {
        const genConfig: any = {};

        const { options, optionsEnabled } = config;
        if (!options || !optionsEnabled) {
            return genConfig;
        }

        if (optionsEnabled.temperature && options.temperature !== undefined) {
            genConfig.temperature = options.temperature;
        }

        if (optionsEnabled.maxOutputTokens && options.maxOutputTokens !== undefined) {
            genConfig.max_output_tokens = options.maxOutputTokens;
        }

        // 思考配置（默认开启，与 gemini 渠道同口径）
        const thinkingEnabled = optionsEnabled.thinkingConfig !== false;
        if (thinkingEnabled) {
            const thinkingConfig = options.thinkingConfig || {};

            const mode = thinkingConfig.mode || 'default';
            if (mode === 'level' && thinkingConfig.thinkingLevel) {
                genConfig.thinking_level = thinkingConfig.thinkingLevel;
            }
            // budget 模式：Interactions 无 thinking_budget 字段，不发送（thinking_level 已覆盖预算语义）

            if (thinkingConfig.includeThoughts === false) {
                genConfig.thinking_summaries = 'none';
            }
        }

        return genConfig;
    }

    /**
     * 解析 Gemini Interactions API 响应（非流式）
     *
     * Interaction 资源：{ id, status, steps: [...], usage: {...}, model }
     * 模型生成的步骤：thought（signature+summary）、model_output（content 数组）、
     * function_call（id/name/arguments）；user_input / function_result 为输入回显，跳过。
     */
    parseResponse(response: any): GenerateResponse {
        // 上游用 HTTP 200 + 错误体回应时，先把它的原文抛出来
        throwIfStreamError(response, 'Gemini Interactions');

        if (!response || !Array.isArray(response.steps)) {
            throw new Error(t('modules.channel.formatters.gemini.errors.invalidResponse'));
        }

        // failed 状态：显式报错而非当作正常响应
        if (response.status === 'failed') {
            throw new ChannelError(
                ErrorType.API_ERROR,
                t('modules.channel.formatters.gemini.errors.emptyCandidate', { finishReason: 'failed' }),
                response
            );
        }

        const parts: ContentPart[] = [];

        for (const step of response.steps) {
            if (!step || typeof step !== 'object') continue;

            if (step.type === 'model_output') {
                // 模型输出内容块（text / image / audio / document / video）
                for (const block of step.content || []) {
                    const part = this.convertContentBlockToPart(block);
                    if (part) parts.push(part);
                }
            } else if (step.type === 'thought') {
                // 思考步骤：signature（加密推理状态）+ summary（摘要文本）
                const sig = typeof step.signature === 'string' && step.signature ? step.signature : undefined;
                const text = this.extractSummaryText(step.summary);
                if (text || sig) {
                    parts.push({
                        ...(text ? { text } : {}),
                        thought: true,
                        ...(sig ? { thoughtSignatures: { gemini: sig } } : {})
                    });
                }
            } else if (step.type === 'function_call') {
                // 函数调用步骤：id 用于后续 function_result 的 call_id 关联
                parts.push({
                    functionCall: {
                        name: step.name,
                        args: this.normalizeArguments(step.arguments),
                        ...(typeof step.id === 'string' && step.id ? { id: step.id } : {})
                    }
                });
            }
            // user_input / function_result 是历史回显，内部历史已持有，不重复组装
        }

        const content: Content = {
            role: 'model',
            parts
        };

        // 存储 usage（snake_case → 内部 camelCase）
        if (response.usage) {
            content.usageMetadata = this.mapUsage(response.usage);
        }

        // 存储模型版本
        if (response.model) {
            content.modelVersion = response.model;
        }

        return {
            content,
            finishReason: this.mapStatus(response.status),
            model: response.model,
            raw: response
        };
    }

    /**
     * 解析流式响应块（Interactions API 使用 SSE 事件流）
     *
     * 每个 chunk 是一个完整事件：
     * - interaction.created / interaction.status_update：生命周期
     * - step.start / step.delta / step.stop：步骤时间轴（含函数参数增量）
     * - interaction.completed：完成（携带 usage）
     * - error：上游错误
     *
     * 无状态化设计：函数调用参数以 partialArgs + index 增量产出，
     * 由 StreamAccumulator 按 index 合并并解析（并发流共享 formatter 实例，不持有流状态）。
     */
    parseStreamChunk(chunk: any): StreamChunk {
        // 流内联错误统一在这里归一为 ChannelError（{ type: 'error', error: {...} } 形态已覆盖）
        throwIfStreamError(chunk, 'Gemini Interactions');

        if (!chunk || typeof chunk !== 'object') {
            return { delta: [], done: false };
        }

        const eventType = chunk.type || chunk.event_type;
        const parts: ContentPart[] = [];
        let done = false;
        let usage: StreamUsageMetadata | undefined;
        let finishReason: string | undefined;
        let modelVersion: string | undefined;

        switch (eventType) {
            case 'interaction.created':
                // 交互创建：携带 model（用于模型版本展示）
                if (chunk.interaction?.model) {
                    modelVersion = chunk.interaction.model;
                }
                break;

            case 'interaction.in_progress':
                // 进行中：忽略
                break;

            case 'interaction.status_update':
                // 生命周期状态变化：requires_action（工具回合暂停）是本轮正常结束标记
                switch (chunk.status) {
                    case 'requires_action':
                        done = true;
                        finishReason = 'STOP';
                        break;
                    case 'completed':
                        done = true;
                        finishReason = 'STOP';
                        break;
                    case 'cancelled':
                        done = true;
                        finishReason = 'STOP';
                        break;
                    case 'failed':
                        throw new ChannelError(
                            ErrorType.API_ERROR,
                            t('modules.channel.formatters.streamError', { provider: 'Gemini Interactions', message: 'interaction failed' }),
                            chunk
                        );
                    case 'incomplete':
                    case 'budget_exceeded':
                        // budget_exceeded：思考预算耗尽，与 incomplete 同为非错误终止
                        done = true;
                        finishReason = 'incomplete';
                        break;
                    default:
                        // in_progress 等：忽略
                        break;
                }
                break;

            case 'step.start': {
                // 步骤开始：function_call 步骤在此声明 id/name（占位，参数由 arguments_delta 流式到达）
                const step = chunk.step || {};
                switch (step.type) {
                    case 'thought': {
                        // thought 步骤的 step.start 通常携带完整初始 summary；
                        // 含非空 signature 时一并保留（与 thought_signature delta 同源）
                        const text = this.extractSummaryText(step.summary);
                        const sig = typeof step.signature === 'string' && step.signature ? step.signature : undefined;
                        if (text) {
                            parts.push({
                                text,
                                thought: true,
                                ...(sig ? { thoughtSignatures: { gemini: sig } } : {})
                            });
                        } else if (sig) {
                            // 无摘要但有签名：仅签名 part（与 thought_signature delta 同形态）
                            parts.push({ thought: true, thoughtSignatures: { gemini: sig } });
                        }
                        break;
                    }
                    case 'model_output': {
                        // model_output 步骤的 step.start 携带初始内容块
                        for (const block of step.content || []) {
                            const part = this.convertContentBlockToPart(block);
                            if (part) parts.push(part);
                        }
                        break;
                    }
                    case 'function_call': {
                        const args = (step.arguments && typeof step.arguments === 'object' && Object.keys(step.arguments).length > 0)
                            ? step.arguments
                            : {};
                        parts.push({
                            functionCall: {
                                name: step.name,
                                args,
                                partialArgs: '',
                                ...(typeof chunk.index === 'number' ? { index: chunk.index } : {}),
                                ...(typeof step.id === 'string' && step.id ? { id: step.id } : {})
                            } as any
                        });
                        break;
                    }
                    default:
                        break;
                }
                break;
            }

            case 'step.delta': {
                const delta = chunk.delta || {};
                switch (delta.type) {
                    case 'text':
                        // 文本增量
                        if (delta.text) {
                            parts.push({ text: delta.text });
                        }
                        break;

                    case 'thought_summary': {
                        // 思考摘要增量（content 单对象 / content 数组 / 直接 text 三形态兼容）
                        const text = this.extractSummaryText(delta.content !== undefined ? delta.content : delta.text);
                        if (text) {
                            parts.push({ text, thought: true });
                        }
                        break;
                    }

                    case 'thought_signature':
                        // 思考签名：step.stop 前的最后一个 delta。
                        // 输出复数格式（thoughtSignatures.gemini），StreamAccumulator 非文本分支
                        // 原样存储，与思考文本保持相邻独立 part；回传时合并为同一 thought step。
                        if (delta.signature) {
                            parts.push({
                                thought: true,
                                thoughtSignatures: { gemini: delta.signature }
                            });
                        }
                        break;

                    case 'arguments_delta':
                    case 'arguments': {
                        // 函数参数增量（迁移指南与 API 参考的 type 不一致，两种都认）。
                        // 官方流式字段是 delta.arguments（部分 JSON 字符串）；旧形态 partial_arguments 兼容。
                        // 非字符串对象（部分代理直接返回完整对象）合理序列化；空增量不输出伪 part。
                        const raw = (delta.arguments !== undefined && delta.arguments !== null && delta.arguments !== '')
                            ? delta.arguments
                            : (delta.partial_arguments !== undefined && delta.partial_arguments !== null && delta.partial_arguments !== '')
                                ? delta.partial_arguments
                                : undefined;
                        let partialArgs: string | undefined;
                        if (typeof raw === 'string') {
                            partialArgs = raw;
                        } else if (typeof raw === 'object') {
                            try {
                                partialArgs = JSON.stringify(raw);
                            } catch {
                                partialArgs = String(raw);
                            }
                        } else if (raw !== undefined) {
                            partialArgs = String(raw);
                        }
                        if (!partialArgs) {
                            break;
                        }
                        parts.push({
                            functionCall: {
                                partialArgs,
                                ...(typeof chunk.index === 'number' ? { index: chunk.index } : {})
                            } as any
                        });
                        break;
                    }

                    case 'text_annotation_delta':
                        // 引用标注：前端不渲染，忽略
                        break;

                    default:
                        // image/audio/document/video delta：完整块转 inlineData
                        if (delta.data) {
                            parts.push({
                                inlineData: {
                                    mimeType: delta.mime_type || 'application/octet-stream',
                                    data: delta.data
                                }
                            });
                        }
                        break;
                }
                break;
            }

            case 'step.stop':
                // 步骤结束：函数参数已由 arguments_delta 增量流补全，无需额外处理
                break;

            case 'interaction.completed': {
                // 交互完成：携带 usage 与最终状态。
                // 终态细分：budget_exceeded / incomplete → incomplete 终止；failed 抛错；
                // 其余（completed / requires_action / cancelled 等）→ STOP
                done = true;
                const interaction = chunk.interaction || {};
                if (interaction.usage) {
                    usage = this.mapUsage(interaction.usage);
                }
                if (interaction.model) {
                    modelVersion = interaction.model;
                }
                switch (interaction.status) {
                    case 'budget_exceeded':
                    case 'incomplete':
                        finishReason = 'incomplete';
                        break;
                    case 'failed':
                        throw new ChannelError(
                            ErrorType.API_ERROR,
                            t('modules.channel.formatters.streamError', { provider: 'Gemini Interactions', message: 'interaction failed' }),
                            chunk
                        );
                    default:
                        finishReason = 'STOP';
                        break;
                }
                break;
            }

            case 'interaction.requires_action':
                // 工具回合暂停：本轮生成结束，等待 function_result 后继续
                done = true;
                finishReason = 'STOP';
                break;

            case 'interaction.failed':
                // 官方失败生命周期事件：显式抛错（与 status_update failed 同口径）
                throw new ChannelError(
                    ErrorType.API_ERROR,
                    t('modules.channel.formatters.streamError', { provider: 'Gemini Interactions', message: 'interaction failed' }),
                    chunk
                );

            case 'done':
                // SSE 结束标记（data: [DONE] 已被 parseStreamBuffer 剥离，事件本身无内容）
                break;

            default:
                // 未知事件类型：忽略（空 delta），保证前向兼容
                break;
        }

        return {
            delta: parts,
            done,
            usage,
            finishReason,
            modelVersion
        };
    }

    /**
     * 转换工具声明为 Interactions API 格式
     *
     * Interactions 使用扁平工具数组（非 generateContent 的 function_declarations 包装）：
     * [{ "type": "function", "name": ..., "description": ..., "parameters": {...} }]
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
     * 验证配置（与 gemini 渠道同一套规则）
     */
    validateConfig(config: any): boolean {
        if (config.type !== 'gemini-interactions') {
            return false;
        }

        const c = config as GeminiInteractionsConfig;
        return !!c.url && !!c.model;
    }

    /**
     * 获取支持的配置类型
     */
    getSupportedType(): string {
        return 'gemini-interactions';
    }

    /**
     * 将统一历史（Content[]）转换为 Interactions API 的 steps 数组。
     *
     * 映射规则：
     * - functionCall part → function_call step（id 复用内部 id，保证 function_result 的 call_id 关联）
     * - functionResponse part → function_result step（call_id + result 内容块数组）
     * - thought part → thought step（signature 来自 thoughtSignatures.gemini）
     * - 普通 part（text/inlineData/fileData）按消息 role 积攒为 user_input / model_output step
     *
     * 签名兼容：旧数据形态下签名可能挂在 functionCall / 普通文本 part 上
     * （generateContent 时代），统一并入同消息最近的 thought step；
     * 无 thought step 时生成「仅签名」thought step（API 明确允许 summary 为空）。
     */
    private convertHistoryToSteps(history: Content[]): any[] {
        const steps: any[] = [];

        // 当前积攒的普通内容块（同一 role 合并为一个 user_input / model_output step）
        let pendingBlocks: any[] = [];
        let pendingRole: 'user' | 'model' | null = null;

        const flush = () => {
            if (pendingBlocks.length === 0) {
                pendingRole = null;
                return;
            }
            if (pendingRole === 'user') {
                steps.push({ type: 'user_input', content: pendingBlocks });
            } else if (pendingRole === 'model') {
                steps.push({ type: 'model_output', content: pendingBlocks });
            }
            pendingBlocks = [];
            pendingRole = null;
        };

        for (const message of history) {
            if (message.role === 'system') {
                // system 消息不走 steps（Interactions 的 system_instruction 为独立字段）
                continue;
            }

            const messageStepStart = steps.length;
            // 同消息内最近的 thought step（用于合并散落的旧格式签名）
            let lastThoughtStep: any = null;

            for (const part of message.parts) {
                if (part.functionCall) {
                    // 函数调用：flush 前置内容块，独立 step
                    flush();
                    const fc = part.functionCall;
                    const sig = part.thoughtSignatures?.gemini;
                    if (sig) {
                        // Interactions 的签名只在 thought step 上（function_call step 不识别），
                        // 合并到同消息 thought step；没有则生成仅签名 thought step（保持调用前位置）
                        if (lastThoughtStep) {
                            if (!lastThoughtStep.signature) lastThoughtStep.signature = sig;
                        } else {
                            steps.push({ type: 'thought', signature: sig, summary: [] });
                        }
                    }
                    steps.push({
                        type: 'function_call',
                        ...(typeof fc.id === 'string' && fc.id ? { id: fc.id } : {}),
                        name: fc.name,
                        arguments: fc.args || {}
                    });
                } else if (part.functionResponse) {
                    // 函数结果：flush 前置内容块，独立 step
                    flush();
                    const fr = part.functionResponse;
                    if (typeof fr.id !== 'string' || !fr.id) {
                        throw new ChannelError(
                            ErrorType.VALIDATION_ERROR,
                            'Gemini Interactions function_result is missing the call_id required to pair with function_call.'
                        );
                    }
                    const resultBlocks: any[] = [];

                    if (fr.response !== undefined) {
                        const responseText = typeof fr.response === 'string'
                            ? fr.response
                            : JSON.stringify(fr.response);
                        if (responseText) {
                            resultBlocks.push({ type: 'text', text: responseText });
                        }
                    }

                    // functionResponse.parts 中的多模态内容（如工具返回的图片）
                    if (fr.parts && fr.parts.length > 0) {
                        for (const responsePart of fr.parts) {
                            const block = this.convertPartToContentBlock(responsePart);
                            if (block) resultBlocks.push(block);
                        }
                    }

                    steps.push({
                        type: 'function_result',
                        call_id: fr.id,
                        name: fr.name,
                        result: resultBlocks.length > 0
                            ? resultBlocks
                            : [{ type: 'text', text: '{}' }]
                    });
                } else if (part.thought) {
                    // 思考步骤必须携带 Gemini signature。流式历史可能把摘要和签名保存为
                    // 相邻 parts：仅签名 part 优先合并到前一个摘要 step，避免丢摘要。
                    flush();
                    const sig = part.thoughtSignatures?.gemini;
                    if (sig && !part.text && lastThoughtStep && !lastThoughtStep.signature) {
                        lastThoughtStep.signature = sig;
                        continue;
                    }
                    const step: any = { type: 'thought' };
                    if (sig) {
                        step.signature = sig;
                    }
                    if (part.text) {
                        step.summary = [{ type: 'text', text: part.text }];
                    }
                    steps.push(step);
                    lastThoughtStep = step;
                } else if (part.thoughtSignatures?.gemini) {
                    // 旧数据形态：签名挂在普通 part（无 thought 标记）上
                    // 签名并入同消息 thought step（无则生成仅签名 step），内容块照常保留
                    if (lastThoughtStep) {
                        if (!lastThoughtStep.signature) lastThoughtStep.signature = part.thoughtSignatures.gemini;
                    } else {
                        flush();
                        steps.push({ type: 'thought', signature: part.thoughtSignatures.gemini, summary: [] });
                    }
                    const block = this.convertPartToContentBlock(part);
                    if (block) {
                        pendingBlocks.push(block);
                        if (pendingRole === null) pendingRole = message.role as 'user' | 'model';
                    }
                } else {
                    // 普通内容块：积攒
                    const block = this.convertPartToContentBlock(part);
                    if (block) {
                        pendingBlocks.push(block);
                        if (pendingRole === null) pendingRole = message.role as 'user' | 'model';
                    }
                }
            }

            flush();

            // Interactions 无状态回放要求 thought 带加密 signature。跨渠道裸 thought、
            // 丢签名旧历史不能包装成无效 thought step；只过滤协议元数据，不改普通正文。
            for (let index = steps.length - 1; index >= messageStepStart; index--) {
                const step = steps[index];
                if (step?.type === 'thought' && (typeof step.signature !== 'string' || !step.signature)) {
                    steps.splice(index, 1);
                }
            }
        }

        return steps;
    }

    /**
     * 将内部 ContentPart 转换为 Interactions API 的内容块（{type, text/data/uri, mime_type}）。
     * 仅处理文本与多模态（inlineData/fileData）；functionCall/functionResponse/thought 由调用方先行分流。
     */
    private convertPartToContentBlock(part: ContentPart): any | null {
        if (typeof part.text === 'string' && part.text.length > 0) {
            return { type: 'text', text: part.text };
        }
        if (part.inlineData) {
            const { mimeType, data } = part.inlineData;
            return {
                type: this.contentTypeForMime(mimeType),
                data,
                mime_type: mimeType
            };
        }
        if (part.fileData) {
            const { mimeType, fileUri } = part.fileData;
            return {
                type: this.contentTypeForMime(mimeType),
                uri: fileUri,
                mime_type: mimeType
            };
        }
        return null;
    }

    /**
     * 将 Interactions API 的内容块转换为内部 ContentPart。
     * text → {text}；image/audio/document/video → inlineData（有 data）或 fileData（有 uri）。
     */
    private convertContentBlockToPart(block: any): ContentPart | null {
        if (!block || typeof block !== 'object') return null;

        if (block.type === 'text') {
            return typeof block.text === 'string' && block.text.length > 0 ? { text: block.text } : null;
        }

        if (block.type === 'image' || block.type === 'audio' || block.type === 'document' || block.type === 'video') {
            const mimeType = block.mime_type || 'application/octet-stream';
            if (typeof block.data === 'string' && block.data) {
                return { inlineData: { mimeType, data: block.data } };
            }
            if (typeof block.uri === 'string' && block.uri) {
                return { fileData: { mimeType, fileUri: block.uri } };
            }
            return null;
        }

        return null;
    }

    /**
     * 从 thought step 的 summary 提取拼接文本。
     *
     * 兼容三种形态：
     * - 数组：[{type:"text", text:"..."}, ...]
     * - 单对象：{type:"text", text:"..."}
     * - 纯字符串
     */
    private extractSummaryText(summary: any): string | undefined {
        if (summary === undefined || summary === null) return undefined;
        if (typeof summary === 'string') {
            return summary.length > 0 ? summary : undefined;
        }
        if (Array.isArray(summary)) {
            let result = '';
            for (const item of summary) {
                if (item && typeof item === 'object') {
                    if (typeof item.text === 'string') {
                        result += (result ? '\n' : '') + item.text;
                    }
                } else if (typeof item === 'string') {
                    result += (result ? '\n' : '') + item;
                }
            }
            return result.length > 0 ? result : undefined;
        }
        if (typeof summary.text === 'string') {
            return summary.text.length > 0 ? summary.text : undefined;
        }
        return undefined;
    }

    /**
     * 归一化函数调用参数：对象原样返回，JSON 字符串解析，其他形态空对象。
     */
    private normalizeArguments(argumentsValue: any): Record<string, unknown> {
        if (argumentsValue && typeof argumentsValue === 'object' && !Array.isArray(argumentsValue)) {
            return argumentsValue;
        }
        if (typeof argumentsValue === 'string' && argumentsValue.trim()) {
            try {
                const parsed = JSON.parse(argumentsValue);
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                    return parsed;
                }
            } catch {
                // 解析失败：空对象
            }
        }
        return {};
    }

    /**
     * 按 MIME 类型前缀映射 Interactions 内容块类型。
     */
    private contentTypeForMime(mimeType: string): string {
        if (mimeType.startsWith('image/')) return 'image';
        if (mimeType.startsWith('audio/')) return 'audio';
        if (mimeType.startsWith('video/')) return 'video';
        return 'document';
    }

    /**
     * Interaction 状态 → 内部 finishReason 映射。
     */
    private mapStatus(status: string | undefined): string | undefined {
        switch (status) {
            case 'completed':
            case 'requires_action':
            case 'cancelled':
                return 'STOP';
            case 'incomplete':
            case 'budget_exceeded':
                // budget_exceeded：思考预算耗尽，非错误终止（与流式路径同口径）
                return 'incomplete';
            default:
                return status;
        }
    }

    /**
     * Interactions usage（snake_case）→ 内部 StreamUsageMetadata（camelCase）。
     *
     * 映射：
     * - total_input_tokens → promptTokenCount
     * - total_output_tokens → candidatesTokenCount
     * - total_thought_tokens → thoughtsTokenCount（思考 token 独立计费字段）
     * - total_cached_tokens → cachedContentTokenCount + cacheReadTokenCount
     * - total_tokens → totalTokenCount
     */
    private mapUsage(usage: any): StreamUsageMetadata {
        const result: StreamUsageMetadata = {};
        if (!usage || typeof usage !== 'object') {
            return result;
        }
        if (typeof usage.total_input_tokens === 'number') {
            result.promptTokenCount = usage.total_input_tokens;
        }
        if (typeof usage.total_output_tokens === 'number') {
            result.candidatesTokenCount = usage.total_output_tokens;
        }
        if (typeof usage.total_thought_tokens === 'number') {
            result.thoughtsTokenCount = usage.total_thought_tokens;
        }
        if (typeof usage.total_cached_tokens === 'number') {
            result.cachedContentTokenCount = usage.total_cached_tokens;
            result.cacheReadTokenCount = usage.total_cached_tokens;
        }
        if (typeof usage.total_tokens === 'number') {
            result.totalTokenCount = usage.total_tokens;
        }
        return result;
    }
}
