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
import type { TokenCountResult } from './tokenCount/types';
import {
    buildGeminiCountRequestBody,
    buildOpenAICountMessages,
    buildOpenAIResponsesCountInput,
    buildAnthropicCountPayload
} from './tokenCount/tokenCountRequestBuilder';
import {
    buildOpenAIResponsesCountUrl as buildOpenAIResponsesCountUrlImpl,
    buildAnthropicCountUrl as buildAnthropicCountUrlImpl
} from './tokenCount/tokenCountUrlBuilder';
import { estimateLocalTokens } from './tokenCount/localTokenEstimator';

export type { TokenCountResult } from './tokenCount/types';

/**
 * Token 计数服务
 * 
 * 根据渠道类型调用对应的 token 计数 API
 */
export class TokenCountService {
    /** 计数请求超时（毫秒），超时由 AbortSignal.timeout 触发 reject 后返回 success:false */
    private static readonly COUNT_REQUEST_TIMEOUT_MS = 30_000;

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
     * 构建 OpenAI Responses input_tokens 端点
     *
     * 兼容以下输入：
     * - https://api.openai.com/v1
     * - https://api.openai.com/v1/responses
     * - https://api.openai.com/v1/responses/input_tokens
     */
    private buildOpenAIResponsesCountUrl(rawUrl: string): string {
        return buildOpenAIResponsesCountUrlImpl(rawUrl);
    }

    /**
     * 构建 Anthropic count_tokens 端点
     */
    private buildAnthropicCountUrl(rawUrl?: string): string {
        return buildAnthropicCountUrlImpl(rawUrl);
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
        channelType: 'gemini' | 'gemini-interactions' | 'openai' | 'anthropic' | 'openai-responses',
        config: TokenCountConfig,
        contents: Content[],
        proxyUrl?: string
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
                case 'gemini-interactions':
                    // Interactions 渠道与 gemini 共用 countTokens 端点
                    return await this.countGeminiTokens(channelConfig, contents, proxyUrl);
                case 'openai':
                    return await this.countOpenAITokens(channelConfig, contents, proxyUrl);
                case 'openai-responses':
                    return await this.countOpenAIResponsesTokens(channelConfig, contents, proxyUrl);
                case 'anthropic':
                    return await this.countAnthropicTokens(channelConfig, contents, proxyUrl);
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
        proxyUrl?: string
    ): Promise<TokenCountResult> {
        const method = channelConfig.tokenCountMethod || 'channel_default';
        const apiConfig = channelConfig.tokenCountApiConfig;
        
        // 确定实际使用的计数方式
        let actualMethod: TokenCountMethod = method;
        if (method === 'channel_default') {
            // 根据渠道类型选择默认方式
            switch (channelConfig.type) {
                case 'gemini':
                case 'gemini-interactions':
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
                    return await this.countGeminiTokensWithConfig(channelConfig, apiConfig, contents, proxyUrl);
                case 'openai_custom':
                    return await this.countOpenAITokensWithConfig(channelConfig, apiConfig, contents, proxyUrl);
                case 'openai_responses':
                    return await this.countOpenAIResponsesTokensWithConfig(channelConfig, apiConfig, contents, proxyUrl);
                case 'anthropic':
                    return await this.countAnthropicTokensWithConfig(channelConfig, apiConfig, contents, proxyUrl);
                case 'local':
                    return estimateLocalTokens(contents);
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
        channelType: 'gemini' | 'gemini-interactions' | 'openai' | 'anthropic' | 'openai-responses',
        config: TokenCountConfig,
        contentsList: Content[][],
        proxyUrl?: string
    ): Promise<TokenCountResult[]> {
        // 并行执行所有计数请求
        const promises = contentsList.map(contents => 
            this.countTokens(channelType, config, contents, proxyUrl)
        );
        
        return Promise.all(promises);
    }
        
    /**
     * 使用渠道配置调用 Gemini Token 计数
     */
    private async countGeminiTokensWithConfig(
        channelConfig: ChannelConfig,
        apiConfig: TokenCountApiConfig | undefined,
        contents: Content[],
        proxyUrl?: string
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
        
        // 构建 countTokens URL
        // 将 generateContent 或其他端点替换为 countTokens
        let countUrl: string;
        if (url.includes('{model}') && url.includes('{key}')) {
            // 使用模板格式
            countUrl = url
                .replace('{model}', model)
                .replace('{key}', apiKey);
        } else if (url.includes(':generateContent')) {
            // 替换 generateContent 为 countTokens
            countUrl = url.replace(':generateContent', ':countTokens');
            if (!countUrl.includes('key=')) {
                countUrl += (countUrl.includes('?') ? '&' : '?') + `key=${apiKey}`;
            }
        } else if (url.includes(':streamGenerateContent')) {
            // 替换 streamGenerateContent 为 countTokens
            countUrl = url.replace(':streamGenerateContent', ':countTokens');
            if (!countUrl.includes('key=')) {
                countUrl += (countUrl.includes('?') ? '&' : '?') + `key=${apiKey}`;
            }
        } else {
            // 假设是基础 URL，添加 countTokens 端点
            const baseUrl = url.replace(/\/$/, '');
            countUrl = `${baseUrl}/models/${model}:countTokens?key=${apiKey}`;
        }
        
        // 构建请求体
        const requestBody = buildGeminiCountRequestBody(contents);
        
        const proxyFetch = createProxyFetch(proxyUrl ?? this.proxyUrl);
        const response = await proxyFetch(countUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(TokenCountService.COUNT_REQUEST_TIMEOUT_MS),
            body: JSON.stringify(requestBody)
        });
        
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
        proxyUrl?: string
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
        const messages = buildOpenAICountMessages(contents);
        
        const requestBody: any = { messages };
        if (model) {
            requestBody.model = model;
        }
        
        const proxyFetch = createProxyFetch(proxyUrl ?? this.proxyUrl);
        const response = await proxyFetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            signal: AbortSignal.timeout(TokenCountService.COUNT_REQUEST_TIMEOUT_MS),
            body: JSON.stringify(requestBody)
        });
        
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
        proxyUrl?: string
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
        const { input: inputParts, instructions } = buildOpenAIResponsesCountInput(contents);
        
        const requestBody: any = { 
            input: inputParts 
        };
        if (instructions) {
            requestBody.instructions = instructions;
        }
        if (model) {
            requestBody.model = model;
        }
        
        const proxyFetch = createProxyFetch(proxyUrl ?? this.proxyUrl);
        const response = await proxyFetch(countUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            signal: AbortSignal.timeout(TokenCountService.COUNT_REQUEST_TIMEOUT_MS),
            body: JSON.stringify(requestBody)
        });
        
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
        proxyUrl?: string
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
        const { messages, system } = buildAnthropicCountPayload(contents);
        
        const requestBody: any = {
            model,
            messages
        };
        // system 消息单独放在 system 字段（与 Messages API 请求一致），确保计入输入 token
        if (system) {
            requestBody.system = system;
        }
        
        const proxyFetch = createProxyFetch(proxyUrl ?? this.proxyUrl);
        const response = await proxyFetch(countUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01'
            },
            signal: AbortSignal.timeout(TokenCountService.COUNT_REQUEST_TIMEOUT_MS),
            body: JSON.stringify(requestBody)
        });
        
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
        proxyUrl?: string
    ): Promise<TokenCountResult> {
        // 构建 URL
        let url = config.baseUrl
            .replace('{model}', config.model)
            .replace('{key}', config.apiKey);
        
        // 清理并转换内容格式为 Gemini 格式
        const requestBody = buildGeminiCountRequestBody(contents);
        
        const proxyFetch = createProxyFetch(proxyUrl ?? this.proxyUrl);
        const response = await proxyFetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(TokenCountService.COUNT_REQUEST_TIMEOUT_MS),
            body: JSON.stringify(requestBody)
        });
        
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
        proxyUrl?: string
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
        const messages = buildOpenAICountMessages(contents);
        
        const requestBody = {
            model: config.model,
            messages
        };
        
        const proxyFetch = createProxyFetch(proxyUrl ?? this.proxyUrl);
        const response = await proxyFetch(config.baseUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${config.apiKey}`
            },
            signal: AbortSignal.timeout(TokenCountService.COUNT_REQUEST_TIMEOUT_MS),
            body: JSON.stringify(requestBody)
        });
        
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
        proxyUrl?: string
    ): Promise<TokenCountResult> {
        if (!config.baseUrl) {
            return {
                success: false,
                error: 'OpenAI responses token count API URL not configured. Use estimation instead.'
            };
        }

        const url = this.buildOpenAIResponsesCountUrl(config.baseUrl);
        
        // 转换内容格式
        const { input: inputParts, instructions } = buildOpenAIResponsesCountInput(contents);
        
        const requestBody = {
            model: config.model,
            input: inputParts,
            instructions: instructions || undefined
        };
        
        const proxyFetch = createProxyFetch(proxyUrl ?? this.proxyUrl);
        const response = await proxyFetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${config.apiKey}`
            },
            signal: AbortSignal.timeout(TokenCountService.COUNT_REQUEST_TIMEOUT_MS),
            body: JSON.stringify(requestBody)
        });
        
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
        proxyUrl?: string
    ): Promise<TokenCountResult> {
        // 清理并转换内容格式为 Anthropic messages 格式（对齐 anthropic.ts buildRequest）：
        // - system 消息提取到独立 system 字段（count_tokens 与 Messages API 一样只接受
        //   user/assistant 角色，旧实现把 system 塞进 messages 会漏计/报错）
        // - 图片/PDF → image/document 块（旧实现拍成空文本，图片 token 漏计）
        // - functionCall/functionResponse → tool_use/tool_result 块（旧实现拍成空文本，
        //   工具调用与结果 token 漏计）
        const { messages, system } = buildAnthropicCountPayload(contents);
        
        const requestBody: any = {
            model: config.model,
            messages
        };
        // system 消息单独放在 system 字段（与 Messages API 请求一致），确保计入输入 token
        if (system) {
            requestBody.system = system;
        }
        
        const proxyFetch = createProxyFetch(proxyUrl ?? this.proxyUrl);
        const response = await proxyFetch(config.baseUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': config.apiKey,
                'anthropic-version': '2023-06-01'
            },
            signal: AbortSignal.timeout(TokenCountService.COUNT_REQUEST_TIMEOUT_MS),
            body: JSON.stringify(requestBody)
        });
        
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
 * 创建 TokenCountService 实例
 */
export function createTokenCountService(proxyUrl?: string): TokenCountService {
    return new TokenCountService(proxyUrl);
}