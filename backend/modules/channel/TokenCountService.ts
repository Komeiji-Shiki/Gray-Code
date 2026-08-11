/**
 * GrayCode - Token 计数服务
 *
 * 提供通过 API 精确计算 token 数量的功能
 * 支持 Gemini、OpenAI、Anthropic 三种渠道
 */

import { createProxyFetch } from './proxyFetch';
import type { TokenCountChannelConfig, TokenCountConfig } from '../settings';
import type { Content } from '../conversation';
import type { ChannelConfig, TokenCountMethod, TokenCountApiConfig } from '../config';
import { cleanContentForAPI } from '../conversation';
import {
    isImageMimeType,
    isPdfMimeType,
    isTextMimeType,
    buildTextAttachmentContent,
    buildUnsupportedAttachmentText
} from './formatters/mediaParts';
import { serializeToolResultForLLM } from './formatters/toolResponseFormatter';

/** 计数请求超时（毫秒）：超时自动中止，调用方走本地估算降级 */
const COUNT_REQUEST_TIMEOUT_MS = 15000;

/**
 * Token 计数结果
 */
export interface TokenCountResult {
    /** 是否成功 */
    success: boolean;
    /** 总 token 数 */
    totalTokens?: number;
    /** 错误信息 */
    error?: string;
}

/**
 * Token 计数服务
 * 
 * 根据渠道类型调用对应的 token 计数 API
 */
export class TokenCountService {
    private proxyUrl?: string;
    
    constructor(proxyUrl?: string) {
        this.proxyUrl = proxyUrl;
    }
    
    /**
     * 更新代理设置
     */
    setProxyUrl(proxyUrl?: string) {
        this.proxyUrl = proxyUrl;
    }

    /**
     * 执行带超时的计数请求：15s 超时自动中止，外部 abort 或超时任一触发即中止
     */
    private async fetchWithTimeout(url: string, init: RequestInit, externalSignal?: AbortSignal): Promise<Response> {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), COUNT_REQUEST_TIMEOUT_MS);
        const onExternalAbort = () => controller.abort();
        if (externalSignal) {
            externalSignal.addEventListener('abort', onExternalAbort);
        }
        try {
            const proxyFetch = createProxyFetch(this.proxyUrl);
            return await proxyFetch(url, { ...init, signal: controller.signal });
        } finally {
            clearTimeout(timeoutId);
            if (externalSignal) {
                externalSignal.removeEventListener('abort', onExternalAbort);
            }
        }
    }

    /**
     * 构建 OpenAI Responses input_tokens 端点
     *
     * 兼容以下输入：
     * - https://api.openai.com/v1
     * - https://api.openai.com/v1/responses
     * - https://api.openai.com/v1/responses/input_tokens
     */
    private buildOpenAIResponsesCountUrl(rawUrl: string): string {
        const normalizedUrl = rawUrl.trim().replace(/\/+$/, '');

        if (/\/responses\/input_tokens$/i.test(normalizedUrl)) {
            return normalizedUrl;
        }

        if (/\/v1\/responses$/i.test(normalizedUrl) || /\/responses$/i.test(normalizedUrl)) {
            return `${normalizedUrl}/input_tokens`;
        }

        if (/\/v1$/i.test(normalizedUrl)) {
            return `${normalizedUrl}/responses/input_tokens`;
        }

        return `${normalizedUrl}/v1/responses/input_tokens`;
    }

    /**
     * 构建 Anthropic count_tokens 端点
     */
    private buildAnthropicCountUrl(rawUrl?: string): string {
        if (!rawUrl) {
            return 'https://api.anthropic.com/v1/messages/count_tokens';
        }

        let normalizedUrl = rawUrl.trim().replace(/\/+$/, '');
        // 先去掉旧端点后缀（/complete），再规整 /v1/models → /v1。
        // 顺序不能反：若先处理 /v1/models，baseUrl 为 .../v1/models/complete 时
        // 会残留 /complete 后缀，最终拼出 .../v1/models/v1/messages/count_tokens 的畸形 URL。
        // （/v1/complete 结尾的地址会被 /complete 规则覆盖，无需单独处理。）
        normalizedUrl = normalizedUrl
            .replace(/\/complete$/i, '')
            .replace(/\/v1\/models$/i, '/v1');

        if (/\/v1\/messages\/count_tokens$/i.test(normalizedUrl) || /\/messages\/count_tokens$/i.test(normalizedUrl)) {
            return normalizedUrl;
        }
        if (/\/v1\/messages$/i.test(normalizedUrl) || /\/messages$/i.test(normalizedUrl)) {
            return `${normalizedUrl}/count_tokens`;
        }
        return /\/v1$/i.test(normalizedUrl) ? `${normalizedUrl}/messages/count_tokens` : `${normalizedUrl}/v1/messages/count_tokens`;
    }
    
    /**
     * 计算内容的 token 数（使用全局配置）
     *
     * @param channelType 渠道类型 (gemini, openai, anthropic)
     * @param config Token 计数配置
     * @param contents 要计算的内容
     * @returns Token 计数结果
     */
    async countTokens(
        channelType: 'gemini' | 'openai' | 'anthropic' | 'openai-responses',
        config: TokenCountConfig,
        contents: Content[],
        externalSignal?: AbortSignal
    ): Promise<TokenCountResult> {
        const channelConfig = config[channelType];
        
        if (!channelConfig?.enabled) {
            return {
                success: false,
                error: `Token count not enabled for ${channelType}`
            };
        }
        
        if (!channelConfig.apiKey) {
            return {
                success: false,
                error: `API key not configured for ${channelType} token count`
            };
        }
        
        try {
            switch (channelType) {
                case 'gemini':
                    return await this.countGeminiTokens(channelConfig, contents, externalSignal);
                case 'openai':
                    return await this.countOpenAITokens(channelConfig, contents, externalSignal);
                case 'openai-responses':
                    return await this.countOpenAIResponsesTokens(channelConfig, contents, externalSignal);
                case 'anthropic':
                    return await this.countAnthropicTokens(channelConfig, contents, externalSignal);
                default:
                    return {
                        success: false,
                        error: `Unknown channel type: ${channelType}`
                    };
            }
        } catch (error: any) {
            return {
                success: false,
                error: error?.message || 'Unknown error'
            };
        }
    }
    
    /**
     * 根据渠道配置计算内容的 token 数
     *
     * 根据渠道的 tokenCountMethod 字段选择对应的计数方式：
     * - 'channel_default': 根据渠道类型自动选择默认方式
     * - 'gemini': 使用 Gemini countTokens API
     * - 'openai_custom': 使用自定义 OpenAI 格式 API
     * - 'anthropic': 使用 Anthropic count_tokens API
     * - 'local': 使用本地估算
     *
     * @param channelConfig 渠道配置
     * @param contents 要计算的内容
     * @returns Token 计数结果
     */
    async countTokensWithChannelConfig(
        channelConfig: ChannelConfig,
        contents: Content[],
        externalSignal?: AbortSignal
    ): Promise<TokenCountResult> {
        const method = channelConfig.tokenCountMethod || 'channel_default';
        const apiConfig = channelConfig.tokenCountApiConfig;
        
        // 确定实际使用的计数方式
        let actualMethod: TokenCountMethod = method;
        if (method === 'channel_default') {
            // 根据渠道类型选择默认方式
            switch (channelConfig.type) {
                case 'gemini':
                    actualMethod = 'gemini';
                    break;
                case 'anthropic':
                    actualMethod = 'anthropic';
                    break;
                case 'openai-responses':
                    actualMethod = 'openai_responses';
                    break;
                case 'openai':
                default:
                    actualMethod = 'local';
                    break;
            }
        }
        
        try {
            switch (actualMethod) {
                case 'gemini':
                    return await this.countGeminiTokensWithConfig(channelConfig, apiConfig, contents, externalSignal);
                case 'openai_custom':
                    return await this.countOpenAITokensWithConfig(channelConfig, apiConfig, contents, externalSignal);
                case 'openai_responses':
                    return await this.countOpenAIResponsesTokensWithConfig(channelConfig, apiConfig, contents, externalSignal);
                case 'anthropic':
                    return await this.countAnthropicTokensWithConfig(channelConfig, apiConfig, contents, externalSignal);
                case 'local':
                    return this.countLocalTokens(contents);
                default:
                    return {
                        success: false,
                        error: `Unknown token count method: ${actualMethod}`
                    };
            }
        } catch (error: any) {
            return {
                success: false,
                error: error?.message || 'Unknown error'
            };
        }
    }
    
    /**
     * 批量并行计算多个内容的 token 数
     * 
     * 所有计数请求将并行执行，节省时间
     *
     * @param channelType 渠道类型
     * @param config Token 计数配置
     * @param contentsList 要计算的内容数组
     * @returns Token 计数结果数组（与输入顺序一致）
     */
    async countTokensBatch(
        channelType: 'gemini' | 'openai' | 'anthropic' | 'openai-responses',
        config: TokenCountConfig,
        contentsList: Content[][],
        externalSignal?: AbortSignal
    ): Promise<TokenCountResult[]> {
        // 并行执行所有计数请求
        const promises = contentsList.map(contents => 
            this.countTokens(channelType, config, contents, externalSignal)
        );
        
        return Promise.all(promises);
    }
    
    /**
     * 本地估算 token 数
     * 约 4 个字符 = 1 个 token，并乘以 1.5 安全系数偏大估算
     */
    private countLocalTokens(contents: Content[]): TokenCountResult {
        const SAFETY_FACTOR = 1.5;
        let totalChars = 0;
        
        for (const content of contents) {
            const cleaned = cleanContentForAPI(content);
            for (const part of cleaned.parts) {
                if ('text' in part && part.text) {
                    totalChars += part.text.length;
                } else if (part.functionResponse) {
                    // 工具结果文本计入本地估算（与 API 计数口径一致，避免 tool 消息被整体漏计）
                    const serialized = serializeToolResultForLLM(
                        part.functionResponse.name,
                        part.functionResponse.response as Record<string, unknown>
                    );
                    totalChars += serialized.length;
                } else if (part.functionCall) {
                    // 工具调用参数计入本地估算（参数 JSON 是发送给模型的真实输入）
                    totalChars += JSON.stringify(part.functionCall.args).length;
                }
            }
        }
        
        return {
            success: true,
            totalTokens: Math.ceil(Math.ceil(totalChars / 4) * SAFETY_FACTOR)
        };
    }
    
    /**
     * 使用渠道配置调用 Gemini Token 计数
     */
    private async countGeminiTokensWithConfig(
        channelConfig: ChannelConfig,
        apiConfig: TokenCountApiConfig | undefined,
        contents: Content[],
        externalSignal?: AbortSignal
    ): Promise<TokenCountResult> {
        // 使用独立配置或渠道配置
        const url = apiConfig?.url || channelConfig.url;
        const apiKey = apiConfig?.apiKey || channelConfig.apiKey;
        const model = apiConfig?.model || channelConfig.model;
        
        if (!url || !apiKey || !model) {
            return {
                success: false,
                error: 'Gemini token count: URL, API key or model not configured'
            };
        }
        
        // 构建 countTokens URL（密钥一律走 x-goog-api-key 请求头，不拼进 URL，
        // 避免密钥泄漏到访问日志 / 代理日志 / 浏览器历史）
        let countUrl: string;
        if (url.includes('{model}') && url.includes('{key}')) {
            // 使用模板格式（模板含 {key} 时替换为空，密钥统一走请求头）
            countUrl = url
                .replace('{model}', model)
                .replace('{key}', '');
            // 模板形如 `...?key={key}` 时替换后会残留空 `key=` 参数，统一交给 stripKeyQuery 清理
            countUrl = stripKeyQuery(countUrl);
        } else if (url.includes(':generateContent')) {
            // 替换 generateContent 为 countTokens
            countUrl = url.replace(':generateContent', ':countTokens');
            countUrl = stripKeyQuery(countUrl);
        } else if (url.includes(':streamGenerateContent')) {
            // 替换 streamGenerateContent 为 countTokens
            countUrl = url.replace(':streamGenerateContent', ':countTokens');
            countUrl = stripKeyQuery(countUrl);
        } else {
            // 假设是基础 URL，添加 countTokens 端点
            const baseUrl = url.replace(/\/$/, '');
            countUrl = `${baseUrl}/models/${model}:countTokens`;
        }
        
        // 构建请求体
        const geminiContents = contents.map(content => {
            const cleaned = cleanContentForAPI(content);
            return {
                role: cleaned.role,
                parts: cleaned.parts.map(part => {
                    if ('text' in part && part.text !== undefined) {
                        return { text: part.text };
                    }
                    return part;
                })
            };
        });
        
        const requestBody = {
            contents: geminiContents
        };
        
        const response = await this.fetchWithTimeout(countUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-goog-api-key': apiKey
            },
            body: JSON.stringify(requestBody)
        }, externalSignal);
        
        if (!response.ok) {
            let errorBody: string;
            try {
                errorBody = await response.text();
            } catch {
                errorBody = `HTTP ${response.status}`;
            }
            return {
                success: false,
                error: `Gemini API error: ${errorBody}`
            };
        }
        
        const result = await response.json() as { totalTokens: number };
        
        return {
            success: true,
            totalTokens: result.totalTokens
        };
    }
    
    /**
     * 使用渠道配置调用 OpenAI 兼容 Token 计数
     */
    private async countOpenAITokensWithConfig(
        channelConfig: ChannelConfig,
        apiConfig: TokenCountApiConfig | undefined,
        contents: Content[],
        externalSignal?: AbortSignal
    ): Promise<TokenCountResult> {
        // 使用独立配置或渠道配置
        const url = apiConfig?.url;
        const apiKey = apiConfig?.apiKey || channelConfig.apiKey;
        const model = apiConfig?.model || channelConfig.model;
        
        if (!url) {
            return {
                success: false,
                error: 'OpenAI custom token count: URL not configured'
            };
        }
        
        if (!apiKey) {
            return {
                success: false,
                error: 'OpenAI custom token count: API key not configured'
            };
        }
        
        // 转换内容格式（对齐 openai.ts convertHistoryFunctionCallMode 的消息形态）：
        // - functionCall → assistant 消息的 tool_calls（旧实现拍成空文本，工具调用 token 漏计）
        // - functionResponse → role:tool 消息（旧实现拍成空文本，工具结果 token 漏计）
        // - system / 文本 / 图片维持原格式
        const messages: any[] = [];
        for (const content of contents) {
            const cleaned = cleanContentForAPI(content);
            const role = cleaned.role === 'model' ? 'assistant' : cleaned.role;

            const textParts = cleaned.parts.filter(p => 'text' in p && p.text);
            const functionCallParts = cleaned.parts.filter(p => p.functionCall);
            const functionResponseParts = cleaned.parts.filter(p => p.functionResponse);

            if (functionCallParts.length > 0) {
                // assistant 消息：文本并入 content，调用挂 tool_calls
                messages.push({
                    role: 'assistant',
                    content: textParts.length > 0 ? textParts.map(p => p.text).join('\n') : null,
                    tool_calls: functionCallParts.map((p, index) => ({
                        id: p.functionCall!.id || `call_${Date.now()}_${index}`,
                        type: 'function',
                        function: {
                            name: p.functionCall!.name,
                            arguments: typeof p.functionCall!.args === 'string'
                                ? p.functionCall!.args
                                : JSON.stringify(p.functionCall!.args)
                        }
                    }))
                });
            }

            // 工具结果独立为 role:tool 消息
            for (const part of functionResponseParts) {
                const resp = part.functionResponse!;
                messages.push({
                    role: 'tool',
                    tool_call_id: resp.id || '',
                    content: serializeToolResultForLLM(resp.name, resp.response as Record<string, unknown>)
                });
            }

            // 普通消息（文本 + 图片，含 system）
            if (functionCallParts.length === 0 && functionResponseParts.length === 0) {
                messages.push({
                    role,
                    content: cleaned.parts.map(part => {
                        if ('text' in part && part.text) {
                            return { type: 'text' as const, text: part.text };
                        }
                        if ('inlineData' in part && part.inlineData) {
                            const { mimeType, data } = part.inlineData;
                            if (isImageMimeType(mimeType)) {
                                return {
                                    type: 'image_url' as const,
                                    image_url: {
                                        url: `data:${mimeType};base64,${data}`
                                    }
                                };
                            }
                            if (isTextMimeType(mimeType)) {
                                return { type: 'text' as const, text: buildTextAttachmentContent(data) };
                            }
                            return { type: 'text' as const, text: buildUnsupportedAttachmentText(mimeType) };
                        }
                        return { type: 'text' as const, text: '' };
                    })
                });
            }
        }
        
        const requestBody: any = { messages };
        if (model) {
            requestBody.model = model;
        }
        
        const response = await this.fetchWithTimeout(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify(requestBody)
        }, externalSignal);
        
        if (!response.ok) {
            let errorBody: string;
            try {
                errorBody = await response.text();
            } catch {
                errorBody = `HTTP ${response.status}`;
            }
            return {
                success: false,
                error: `OpenAI compatible API error: ${errorBody}`
            };
        }
        
        const result = await response.json() as { total_tokens?: number; totalTokens?: number };
        const totalTokens = result.total_tokens ?? result.totalTokens;
        
        if (totalTokens === undefined) {
            return {
                success: false,
                error: 'Response missing total_tokens field'
            };
        }
        
        return {
            success: true,
            totalTokens
        };
    }
    
    /**
     * 使用渠道配置调用 OpenAI Responses Token 计数
     */
    private async countOpenAIResponsesTokensWithConfig(
        channelConfig: ChannelConfig,
        apiConfig: TokenCountApiConfig | undefined,
        contents: Content[],
        externalSignal?: AbortSignal
    ): Promise<TokenCountResult> {
        // 使用独立配置或渠道配置
        const url = apiConfig?.url || (channelConfig.type === 'openai-responses' ? channelConfig.url : undefined);
        const apiKey = apiConfig?.apiKey || channelConfig.apiKey;
        const model = apiConfig?.model || channelConfig.model;
        
        if (!url) {
            return {
                success: false,
                error: 'OpenAI responses token count: URL not configured'
            };
        }
        
        if (!apiKey) {
            return {
                success: false,
                error: 'OpenAI responses token count: API key not configured'
            };
        }

        const countUrl = this.buildOpenAIResponsesCountUrl(url);
        
        // 转换内容格式
        // 对于 Responses API，我们将所有内容转换为 input 数组
        // 系统消息提取为 instructions
        let instructions = '';
        const inputParts: any[] = [];

        for (const content of contents) {
            const cleaned = cleanContentForAPI(content);
            if (cleaned.role === 'system') {
                for (const part of cleaned.parts) {
                    if ('text' in part && part.text) {
                        instructions += (instructions ? '\n' : '') + part.text;
                    }
                }
                continue;
            }

            // user/model 消息都放入 input
            for (const part of cleaned.parts) {
                if ('text' in part && part.text) {
                    inputParts.push({ type: 'text', text: part.text });
                } else if ('inlineData' in part && part.inlineData) {
                    const { mimeType, data } = part.inlineData;
                    if (isImageMimeType(mimeType)) {
                        inputParts.push({
                            type: 'image_url',
                            image_url: {
                                url: `data:${mimeType};base64,${data}`
                            }
                        });
                    } else if (isTextMimeType(mimeType)) {
                        inputParts.push({ type: 'text', text: buildTextAttachmentContent(data) });
                    } else {
                        inputParts.push({ type: 'text', text: buildUnsupportedAttachmentText(mimeType) });
                    }
                }
            }
        }
        
        const requestBody: any = { 
            input: inputParts 
        };
        if (instructions) {
            requestBody.instructions = instructions;
        }
        if (model) {
            requestBody.model = model;
        }
        
        const response = await this.fetchWithTimeout(countUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify(requestBody)
        }, externalSignal);
        
        if (!response.ok) {
            let errorBody: string;
            try {
                errorBody = await response.text();
            } catch {
                errorBody = `HTTP ${response.status}`;
            }
            return {
                success: false,
                error: `OpenAI Responses API error: ${errorBody}`
            };
        }
        
        const result = await response.json() as { input_tokens?: number };
        
        if (result.input_tokens === undefined) {
            return {
                success: false,
                error: 'Response missing input_tokens field'
            };
        }
        
        return {
            success: true,
            totalTokens: result.input_tokens
        };
    }
    
    /**
     * 使用渠道配置调用 Anthropic Token 计数
     */
    private async countAnthropicTokensWithConfig(
        channelConfig: ChannelConfig,
        apiConfig: TokenCountApiConfig | undefined,
        contents: Content[],
        externalSignal?: AbortSignal
    ): Promise<TokenCountResult> {
        // 使用独立配置或渠道配置
        const baseUrl = apiConfig?.url || channelConfig.url;
        const apiKey = apiConfig?.apiKey || channelConfig.apiKey;
        const model = apiConfig?.model || channelConfig.model;
        
        if (!apiKey || !model) {
            return {
                success: false,
                error: 'Anthropic token count: API key or model not configured'
            };
        }
        
        const countUrl = this.buildAnthropicCountUrl(baseUrl);
        
        // 转换内容格式（对齐 anthropic.ts buildRequest 的消息形态）：
        // - system 消息提取到独立 system 字段（count_tokens 与 Messages API 一样只接受
        //   user/assistant 角色，旧实现把 system 塞进 messages 会漏计/报错）
        // - 图片/PDF → image/document 块（旧实现拍成空文本，图片 token 漏计）
        // - functionCall/functionResponse → tool_use/tool_result 块（旧实现拍成空文本，
        //   工具调用与结果 token 漏计）
        const systemTexts: string[] = [];
        const messages: any[] = [];
        for (const content of contents) {
            const cleaned = cleanContentForAPI(content);
            if (cleaned.role === 'system') {
                for (const part of cleaned.parts) {
                    if ('text' in part && part.text) {
                        systemTexts.push(part.text);
                    }
                }
                continue;
            }
            const role = cleaned.role === 'model' ? 'assistant' : cleaned.role;
            const contentBlocks: any[] = [];
            for (const part of cleaned.parts) {
                if ('text' in part && part.text !== undefined) {
                    contentBlocks.push({ type: 'text', text: part.text });
                } else if (part.inlineData) {
                    const { mimeType, data } = part.inlineData;
                    if (isImageMimeType(mimeType)) {
                        contentBlocks.push({ type: 'image', source: { type: 'base64', media_type: mimeType, data } });
                    } else if (isPdfMimeType(mimeType)) {
                        contentBlocks.push({ type: 'document', source: { type: 'base64', media_type: mimeType, data } });
                    } else if (isTextMimeType(mimeType)) {
                        contentBlocks.push({ type: 'text', text: buildTextAttachmentContent(data) });
                    } else {
                        contentBlocks.push({ type: 'text', text: buildUnsupportedAttachmentText(mimeType) });
                    }
                } else if (part.functionCall) {
                    const fc = part.functionCall;
                    contentBlocks.push({
                        type: 'tool_use',
                        // 无 id 时生成（与 anthropic.ts convertHistoryFunctionCallMode 一致），
                        // 保证 count_tokens 结构校验通过
                        id: fc.id || `toolu_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                        name: fc.name,
                        input: fc.args
                    });
                } else if (part.functionResponse) {
                    const resp = part.functionResponse;
                    contentBlocks.push({
                        type: 'tool_result',
                        tool_use_id: resp.id || `toolu_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                        content: serializeToolResultForLLM(resp.name, resp.response as Record<string, unknown>)
                    });
                }
            }
            if (contentBlocks.length === 0) {
                // 空消息（如思考被剥离）：保留一个空 text 块，避免 count_tokens 结构校验报错
                contentBlocks.push({ type: 'text', text: '' });
            }
            messages.push({ role, content: contentBlocks });
        }
        
        const requestBody: any = {
            model,
            messages
        };
        // system 消息单独放在 system 字段（与 Messages API 请求一致），确保计入输入 token
        if (systemTexts.length > 0) {
            requestBody.system = systemTexts.join('\n');
        }
        
        const response = await this.fetchWithTimeout(countUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify(requestBody)
        }, externalSignal);
        
        if (!response.ok) {
            let errorBody: string;
            try {
                errorBody = await response.text();
            } catch {
                errorBody = `HTTP ${response.status}`;
            }
            return {
                success: false,
                error: `Anthropic API error: ${errorBody}`
            };
        }
        
        const result = await response.json() as { input_tokens: number };
        
        return {
            success: true,
            totalTokens: result.input_tokens
        };
    }
    
    /**
     * Gemini Token 计数
     * 
     * API: POST https://generativelanguage.googleapis.com/v1beta/models/{model}:countTokens?key={key}
     * 
     * 请求体:
     * {
     *   "contents": [{ "parts": [{ "text": "..." }] }]
     * }
     * 
     * 响应:
     * {
     *   "totalTokens": number,
     *   "cachedContentTokenCount": number,
     *   "promptTokensDetails": [...],
     *   "cacheTokensDetails": [...]
     * }
     */
    private async countGeminiTokens(
        config: TokenCountChannelConfig,
        contents: Content[],
        externalSignal?: AbortSignal
    ): Promise<TokenCountResult> {
        // 构建 URL（{key} 模板替换为空并清理残留 query；密钥走 x-goog-api-key 请求头，
        // 避免密钥出现在 URL 而泄漏到访问日志 / 代理日志 / 浏览器历史）
        let url = config.baseUrl
            .replace('{model}', config.model)
            .replace('{key}', '');
        url = stripKeyQuery(url);
        
        // 清理并转换内容格式为 Gemini 格式
        const geminiContents = contents.map(content => {
            const cleaned = cleanContentForAPI(content);
            return {
                role: cleaned.role,
                parts: cleaned.parts.map(part => {
                    if ('text' in part && part.text !== undefined) {
                        return { text: part.text };
                    }
                    // 处理其他类型的 part（如 inlineData, functionResponse 等）
                    return part;
                })
            };
        });
        
        const requestBody = {
            contents: geminiContents
        };
        
        const response = await this.fetchWithTimeout(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-goog-api-key': config.apiKey
            },
            body: JSON.stringify(requestBody)
        }, externalSignal);
        
        if (!response.ok) {
            let errorBody: string;
            try {
                errorBody = await response.text();
            } catch {
                errorBody = `HTTP ${response.status}`;
            }
            return {
                success: false,
                error: `Gemini API error: ${errorBody}`
            };
        }
        
        const result = await response.json() as { totalTokens: number };
        
        return {
            success: true,
            totalTokens: result.totalTokens
        };
    }
    
    /**
     * OpenAI Token 计数
     *
     * 支持用户自定义的 OpenAI 兼容 Token 计数 API。
     *
     * API 规范：
     * - POST {baseUrl}
     * - Headers: Content-Type: application/json, Authorization: Bearer {apiKey}
     * - Body: { model: string, messages: [...] }
     * - Response: { total_tokens: number }
     */
    private async countOpenAITokens(
        config: TokenCountChannelConfig,
        contents: Content[],
        externalSignal?: AbortSignal
    ): Promise<TokenCountResult> {
        // 如果没有配置 baseUrl，返回失败让调用方回退到估算
        if (!config.baseUrl) {
            return {
                success: false,
                error: 'OpenAI token count API URL not configured. Use estimation instead.'
            };
        }
        
        // 清理并转换内容格式为 OpenAI Messages 格式（对齐 openai.ts convertHistoryFunctionCallMode）：
        // - functionCall → assistant 消息的 tool_calls（旧实现拍成空文本，工具调用 token 漏计）
        // - functionResponse → role:tool 消息（旧实现拍成空文本，工具结果 token 漏计）
        // - system / 文本 / 图片维持原格式
        const messages: any[] = [];
        for (const content of contents) {
            const cleaned = cleanContentForAPI(content);
            const role = cleaned.role === 'model' ? 'assistant' : cleaned.role;

            const textParts = cleaned.parts.filter(p => 'text' in p && p.text);
            const functionCallParts = cleaned.parts.filter(p => p.functionCall);
            const functionResponseParts = cleaned.parts.filter(p => p.functionResponse);

            if (functionCallParts.length > 0) {
                // assistant 消息：文本并入 content，调用挂 tool_calls
                messages.push({
                    role: 'assistant',
                    content: textParts.length > 0 ? textParts.map(p => p.text).join('\n') : null,
                    tool_calls: functionCallParts.map((p, index) => ({
                        id: p.functionCall!.id || `call_${Date.now()}_${index}`,
                        type: 'function',
                        function: {
                            name: p.functionCall!.name,
                            arguments: typeof p.functionCall!.args === 'string'
                                ? p.functionCall!.args
                                : JSON.stringify(p.functionCall!.args)
                        }
                    }))
                });
            }

            // 工具结果独立为 role:tool 消息
            for (const part of functionResponseParts) {
                const resp = part.functionResponse!;
                messages.push({
                    role: 'tool',
                    tool_call_id: resp.id || '',
                    content: serializeToolResultForLLM(resp.name, resp.response as Record<string, unknown>)
                });
            }

            // 普通消息（文本 + 图片，含 system）
            if (functionCallParts.length === 0 && functionResponseParts.length === 0) {
                messages.push({
                    role,
                    content: cleaned.parts.map(part => {
                        if ('text' in part && part.text) {
                            return { type: 'text' as const, text: part.text };
                        }
                        // 处理图片、文本附件等其他类型（按 MIME 分发，文本不能当图片）
                        if ('inlineData' in part && part.inlineData) {
                            const { mimeType, data } = part.inlineData;
                            if (isImageMimeType(mimeType)) {
                                return {
                                    type: 'image_url' as const,
                                    image_url: {
                                        url: `data:${mimeType};base64,${data}`
                                    }
                                };
                            }
                            if (isTextMimeType(mimeType)) {
                                return { type: 'text' as const, text: buildTextAttachmentContent(data) };
                            }
                            return { type: 'text' as const, text: buildUnsupportedAttachmentText(mimeType) };
                        }
                        return { type: 'text' as const, text: '' };
                    })
                });
            }
        }
        
        const requestBody = {
            model: config.model,
            messages
        };
        
        const response = await this.fetchWithTimeout(config.baseUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${config.apiKey}`
            },
            body: JSON.stringify(requestBody)
        }, externalSignal);
        
        if (!response.ok) {
            let errorBody: string;
            try {
                errorBody = await response.text();
            } catch {
                errorBody = `HTTP ${response.status}`;
            }
            return {
                success: false,
                error: `OpenAI compatible API error: ${errorBody}`
            };
        }
        
        const result = await response.json() as { total_tokens?: number; totalTokens?: number };
        
        // 支持 total_tokens 或 totalTokens 字段
        const totalTokens = result.total_tokens ?? result.totalTokens;
        
        if (totalTokens === undefined) {
            return {
                success: false,
                error: 'Response missing total_tokens field'
            };
        }
        
        return {
            success: true,
            totalTokens
        };
    }
    
    /**
     * OpenAI Responses Token 计数
     *
     * API: POST https://api.openai.com/v1/responses/input_tokens
     *
     * 请求体:
     * {
     *   "model": "gpt-5",
     *   "input": [...],
     *   "instructions": "..."
     * }
     *
     * 响应:
     * {
     *   "object": "response.input_tokens",
     *   "input_tokens": number
     * }
     */
    private async countOpenAIResponsesTokens(
        config: TokenCountChannelConfig,
        contents: Content[],
        externalSignal?: AbortSignal
    ): Promise<TokenCountResult> {
        if (!config.baseUrl) {
            return {
                success: false,
                error: 'OpenAI responses token count API URL not configured. Use estimation instead.'
            };
        }

        const url = this.buildOpenAIResponsesCountUrl(config.baseUrl);
        
        // 转换内容格式
        let instructions = '';
        const inputParts: any[] = [];

        for (const content of contents) {
            const cleaned = cleanContentForAPI(content);
            if (cleaned.role === 'system') {
                for (const part of cleaned.parts) {
                    if ('text' in part && part.text) {
                        instructions += (instructions ? '\n' : '') + part.text;
                    }
                }
                continue;
            }

            for (const part of cleaned.parts) {
                if ('text' in part && part.text) {
                    inputParts.push({ type: 'text', text: part.text });
                } else if ('inlineData' in part && part.inlineData) {
                    const { mimeType, data } = part.inlineData;
                    if (isImageMimeType(mimeType)) {
                        inputParts.push({
                            type: 'image_url',
                            image_url: {
                                url: `data:${mimeType};base64,${data}`
                            }
                        });
                    } else if (isTextMimeType(mimeType)) {
                        inputParts.push({ type: 'text', text: buildTextAttachmentContent(data) });
                    } else {
                        inputParts.push({ type: 'text', text: buildUnsupportedAttachmentText(mimeType) });
                    }
                }
            }
        }
        
        const requestBody = {
            model: config.model,
            input: inputParts,
            instructions: instructions || undefined
        };
        
        const response = await this.fetchWithTimeout(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${config.apiKey}`
            },
            body: JSON.stringify(requestBody)
        }, externalSignal);
        
        if (!response.ok) {
            let errorBody: string;
            try {
                errorBody = await response.text();
            } catch {
                errorBody = `HTTP ${response.status}`;
            }
            return {
                success: false,
                error: `OpenAI Responses API error: ${errorBody}`
            };
        }
        
        const result = await response.json() as { input_tokens: number };
        
        if (result.input_tokens === undefined) {
            return {
                success: false,
                error: 'Response missing input_tokens field'
            };
        }
        
        return {
            success: true,
            totalTokens: result.input_tokens
        };
    }
    
    /**
     * Anthropic Token 计数
     * 
     * API: POST https://api.anthropic.com/v1/messages/count_tokens
     * 
     * 请求体:
     * {
     *   "model": "claude-sonnet-4-5",
     *   "messages": [...]
     * }
     * 
     * 响应:
     * {
     *   "input_tokens": number
     * }
     */
    private async countAnthropicTokens(
        config: TokenCountChannelConfig,
        contents: Content[],
        externalSignal?: AbortSignal
    ): Promise<TokenCountResult> {
        // 清理并转换内容格式为 Anthropic messages 格式（对齐 anthropic.ts buildRequest）：
        // - system 消息提取到独立 system 字段（count_tokens 与 Messages API 一样只接受
        //   user/assistant 角色，旧实现把 system 塞进 messages 会漏计/报错）
        // - 图片/PDF → image/document 块（旧实现拍成空文本，图片 token 漏计）
        // - functionCall/functionResponse → tool_use/tool_result 块（旧实现拍成空文本，
        //   工具调用与结果 token 漏计）
        const systemTexts: string[] = [];
        const messages: any[] = [];
        for (const content of contents) {
            const cleaned = cleanContentForAPI(content);
            if (cleaned.role === 'system') {
                for (const part of cleaned.parts) {
                    if ('text' in part && part.text) {
                        systemTexts.push(part.text);
                    }
                }
                continue;
            }
            const role = cleaned.role === 'model' ? 'assistant' : cleaned.role;
            const contentBlocks: any[] = [];
            for (const part of cleaned.parts) {
                if ('text' in part && part.text !== undefined) {
                    contentBlocks.push({ type: 'text', text: part.text });
                } else if (part.inlineData) {
                    const { mimeType, data } = part.inlineData;
                    if (isImageMimeType(mimeType)) {
                        contentBlocks.push({ type: 'image', source: { type: 'base64', media_type: mimeType, data } });
                    } else if (isPdfMimeType(mimeType)) {
                        contentBlocks.push({ type: 'document', source: { type: 'base64', media_type: mimeType, data } });
                    } else if (isTextMimeType(mimeType)) {
                        contentBlocks.push({ type: 'text', text: buildTextAttachmentContent(data) });
                    } else {
                        contentBlocks.push({ type: 'text', text: buildUnsupportedAttachmentText(mimeType) });
                    }
                } else if (part.functionCall) {
                    const fc = part.functionCall;
                    contentBlocks.push({
                        type: 'tool_use',
                        // 无 id 时生成（与 anthropic.ts convertHistoryFunctionCallMode 一致），
                        // 保证 count_tokens 结构校验通过
                        id: fc.id || `toolu_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                        name: fc.name,
                        input: fc.args
                    });
                } else if (part.functionResponse) {
                    const resp = part.functionResponse;
                    contentBlocks.push({
                        type: 'tool_result',
                        tool_use_id: resp.id || `toolu_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                        content: serializeToolResultForLLM(resp.name, resp.response as Record<string, unknown>)
                    });
                }
            }
            if (contentBlocks.length === 0) {
                // 空消息（如思考被剥离）：保留一个空 text 块，避免 count_tokens 结构校验报错
                contentBlocks.push({ type: 'text', text: '' });
            }
            messages.push({ role, content: contentBlocks });
        }
        
        const requestBody: any = {
            model: config.model,
            messages
        };
        // system 消息单独放在 system 字段（与 Messages API 请求一致），确保计入输入 token
        if (systemTexts.length > 0) {
            requestBody.system = systemTexts.join('\n');
        }
        
        const response = await this.fetchWithTimeout(config.baseUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': config.apiKey,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify(requestBody)
        }, externalSignal);
        
        if (!response.ok) {
            let errorBody: string;
            try {
                errorBody = await response.text();
            } catch {
                errorBody = `HTTP ${response.status}`;
            }
            return {
                success: false,
                error: `Anthropic API error: ${errorBody}`
            };
        }
        
        const result = await response.json() as { input_tokens: number };
        
        return {
            success: true,
            totalTokens: result.input_tokens
        };
    }
}

/**
 * 从 URL 中剥离 key / api_key / api-key query 参数（密钥改走请求头后防止残留泄漏）
 */
function stripKeyQuery(url: string): string {
    if (!url.includes('?') && !url.includes('#')) {
        return url.replace(/\?+$/, '');
    }
    try {
        const parsed = new URL(url);
        for (const name of ['key', 'api_key', 'api-key', 'apikey']) {
            parsed.searchParams.delete(name);
        }
        const cleaned = parsed.toString();
        return cleaned.endsWith('?') ? cleaned.slice(0, -1) : cleaned;
    } catch {
        return url;
    }
}

/**
 * 创建 TokenCountService 实例
 */
export function createTokenCountService(proxyUrl?: string): TokenCountService {
    return new TokenCountService(proxyUrl);
}