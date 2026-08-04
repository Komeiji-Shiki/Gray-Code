/**
 * GrayCode - Token 计数相关设置类型
 *
 * 从 types.ts 拆分而来：types.ts 通过 `export *` 重导出，旧引用路径保持兼容。
 */

/**
 * Token 计数 API 渠道配置
 *
 * 支持 Gemini、OpenAI、Anthropic 三种格式
 */
export interface TokenCountChannelConfig {
    /**
     * 是否启用此渠道的 Token 计数 API
     */
    enabled: boolean;
    
    /**
     * API 基础 URL
     *
     * Gemini 示例: https://generativelanguage.googleapis.com/v1beta/models/{model}:countTokens?key={key}
     * OpenAI 示例: https://api.openai.com/v1/chat/completions (使用 tiktoken 或 API)
     * Anthropic 示例: https://api.anthropic.com/v1/messages/count_tokens
     */
    baseUrl: string;
    
    /**
     * API Key
     */
    apiKey: string;
    
    /**
     * 模型名称
     *
     * 用于替换 URL 中的 {model} 占位符
     * 例如: gemini-2.5-pro
     */
    model: string;
}

/**
 * Token 计数配置
 *
 * 允许用户配置各渠道的 Token 计数 API，用于精确计算上下文 token 数量
 * 如果未配置或 API 调用失败，将回退到估算方法
 */
export interface TokenCountConfig {
    /**
     * Gemini 渠道配置
     */
    gemini?: TokenCountChannelConfig;
    
    /**
     * OpenAI 渠道配置
     */
    openai?: TokenCountChannelConfig;
    
    /**
     * Anthropic 渠道配置
     */
    anthropic?: TokenCountChannelConfig;

    /**
     * OpenAI Responses 渠道配置
     */
    'openai-responses'?: TokenCountChannelConfig;
    
    [key: string]: unknown;
}

/**
 * 默认 Gemini Token 计数配置
 */
export const DEFAULT_GEMINI_TOKEN_COUNT_CONFIG: TokenCountChannelConfig = {
    enabled: false,
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/models/{model}:countTokens?key={key}',
    apiKey: '',
    model: 'gemini-2.5-pro'
};

/**
 * 默认 OpenAI Token 计数配置
 */
export const DEFAULT_OPENAI_TOKEN_COUNT_CONFIG: TokenCountChannelConfig = {
    enabled: false,
    baseUrl: 'https://api.openai.com/v1/chat/completions',
    apiKey: '',
    model: 'gpt-5'
};

/**
 * 默认 OpenAI Responses Token 计数配置
 */
export const DEFAULT_OPENAI_RESPONSES_TOKEN_COUNT_CONFIG: TokenCountChannelConfig = {
    enabled: false,
    baseUrl: 'https://api.openai.com/v1/responses/input_tokens',
    apiKey: '',
    model: 'gpt-5'
};

/**
 * 默认 Anthropic Token 计数配置
 */
export const DEFAULT_ANTHROPIC_TOKEN_COUNT_CONFIG: TokenCountChannelConfig = {
    enabled: false,
    baseUrl: 'https://api.anthropic.com/v1/messages/count_tokens',
    apiKey: '',
    model: 'claude-sonnet-4-5'
};

/**
 * 默认 Token 计数配置
 */
export const DEFAULT_TOKEN_COUNT_CONFIG: TokenCountConfig = {
    gemini: DEFAULT_GEMINI_TOKEN_COUNT_CONFIG,
    openai: DEFAULT_OPENAI_TOKEN_COUNT_CONFIG,
    anthropic: DEFAULT_ANTHROPIC_TOKEN_COUNT_CONFIG,
    'openai-responses': DEFAULT_OPENAI_RESPONSES_TOKEN_COUNT_CONFIG
};
