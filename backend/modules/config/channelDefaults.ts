import type { ChannelType } from './types';

export function getDefaultConfig(type: ChannelType): Record<string, any> {
    const baseDefaults = {
        enabled: true,
        timeout: 120000,
        model: '',
        models: [],
        apiKey: '',
        toolMode: 'function_call' as const,
        retryEnabled: true,
        retryCount: 3,
        retryInterval: 3000,
        contextThresholdEnabled: false,
        contextThreshold: '80%',
        autoSummarizeEnabled: false,
        multimodalToolsEnabled: false,
        customHeadersEnabled: false,
        customHeaders: [],
        openCodeSessionEnabled: false,
        customBodyEnabled: false,
        customBody: { mode: 'simple' as const, items: [] },
        sendHistoryThoughts: true,
        sendHistoryThoughtSignatures: false,
        sendCurrentThoughts: true,
        maxContextTokens: 256000,
        options: {
            // 默认流式：实时可见输出、支持流式工具边执行；
            // 显式保存过 options.stream 的已有渠道不受影响（显式值优先）
            stream: true,
        },
    };

    switch (type) {
        case 'gemini':
            return {
                ...baseDefaults,
                url: 'https://generativelanguage.googleapis.com/v1beta',
                options: {
                    ...baseDefaults.options,
                    temperature: 1.0,
                    maxOutputTokens: 65535,
                    maxImages: 0,
                    // Gemini 思考配置默认值
                    thinkingConfig: {
                        includeThoughts: true,
                        mode: 'default',
                        thinkingLevel: 'low',
                        thinkingBudget: 1024,
                    },
                },
                optionsEnabled: {
                    temperature: false,
                    maxOutputTokens: false,
                    maxImages: false,
                    thinkingConfig: true,
                },
            };

        case 'gemini-interactions':
            // Gemini Interactions API：与 gemini 同构的默认配置（URL/options/思考配置一致）
            return {
                ...baseDefaults,
                url: 'https://generativelanguage.googleapis.com/v1beta',
                options: {
                    ...baseDefaults.options,
                    temperature: 1.0,
                    maxOutputTokens: 65535,
                    maxImages: 0,
                    thinkingConfig: {
                        includeThoughts: true,
                        mode: 'default',
                        thinkingLevel: 'low',
                        thinkingBudget: 1024,
                    },
                },
                optionsEnabled: {
                    temperature: false,
                    maxOutputTokens: false,
                    maxImages: false,
                    thinkingConfig: true,
                },
            };

        case 'openai':
            return {
                ...baseDefaults,
                url: 'https://api.openai.com/v1',
                deepSeekUserIdEnabled: false,
                deepSeekVisionEnabled: false,
                pdfAttachmentEnabled: false,
                options: {
                    ...baseDefaults.options,
                    temperature: 1.0,
                    max_tokens: 65535,
                    // OpenAI 思考配置默认值
                    reasoning: {
                        effort: 'high',
                        summaryEnabled: false,
                        summary: 'auto',
                    },
                },
                optionsEnabled: {
                    temperature: false,
                    max_tokens: false,
                    top_p: false,
                    frequency_penalty: false,
                    presence_penalty: false,
                    reasoning: false,
                },
            };

        case 'anthropic':
            return {
                ...baseDefaults,
                url: 'https://api.anthropic.com/v1',
                deepSeekVisionEnabled: false,
                options: {
                    ...baseDefaults.options,
                    temperature: 1.0,
                    max_tokens: 65535,
                    // Anthropic 思考配置默认值
                    thinking: {
                        type: 'adaptive',
                        budget_tokens: 10000,
                        effort: 'high',
                    },
                },
                optionsEnabled: {
                    temperature: false,
                    max_tokens: false,
                    top_p: false,
                    top_k: false,
                    thinking: false,
                },
            };

        case 'openai-responses':
            return {
                ...baseDefaults,
                url: 'https://api.openai.com/v1',
                deepSeekVisionEnabled: false,
                promptCacheKeyEnabled: false,
                reasoningSignatureMode: 'official' as const,
                options: {
                    ...baseDefaults.options,
                    temperature: 1.0,
                    max_output_tokens: 65535,
                    reasoning: {
                        effort: 'medium',
                        summaryEnabled: false,
                        summary: 'auto',
                    },
                },
                optionsEnabled: {
                    temperature: false,
                    max_output_tokens: false,
                    top_p: false,
                    reasoning: false,
                },
            };

        default:
            return baseDefaults;
    }
}
