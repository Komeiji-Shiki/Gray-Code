/**
 * GrayCode - OpenAI Responses 配置类型
 * 
 * OpenAI Responses API 格式的配置支持
 * 使用 /v1/responses 端点，支持更丰富的功能
 */

import type { BaseChannelConfig, ModelInfo } from './base';

/** Responses 历史 reasoning 签名的回传格式。 */
export type OpenAIResponsesReasoningSignatureMode = 'official' | 'codex';

/**
 * 配置项启用状态
 *
 * 用于控制哪些配置项会被发送到 API
 * 未列出的配置项默认不发送
 */
export interface OpenAIResponsesOptionsEnabled {
    /** 是否发送温度参数 */
    temperature?: boolean;
    
    /** 是否发送最大输出 token 数 */
    max_output_tokens?: boolean;
    
    /** 是否发送 top_p 参数 */
    top_p?: boolean;
    
    /** 是否启用思考配置 */
    reasoning?: boolean;
}

/**
 * OpenAI Responses 配置
 *
 * 支持 OpenAI Responses API 格式的配置
 * 使用 POST /v1/responses 端点
 * 
 * 与 OpenAI Chat Completions API 的主要区别：
 * - 使用 input 而不是 messages
 * - 使用 instructions 而不是 system message
 * - 工具调用返回 function_call 类型而不是 tool_calls
 * - 响应格式完全不同，使用 output 数组
 */
export interface OpenAIResponsesConfig extends BaseChannelConfig {
    type: 'openai-responses';
    
    /** API 端点 URL（不包含 /responses 路径） */
    url: string;
    
    /** API 密钥 */
    apiKey: string;
    
    /** 当前使用的模型名称 */
    model: string;
    
    /**
     * 是否启用 DeepSeek Vision 专用图片/PDF 预处理。
     * 默认关闭；开启后由请求准备层将 PDF 按页转换为图片并切分大图。
     */
    deepSeekVisionEnabled?: boolean;

    /**
     * 是否发送 prompt_cache_key（OpenAI 兼容网关的会话缓存透传）。
     *
     * 开启后基于主聊天 conversationId 生成稳定且不含隐私信息的 prompt_cache_key，
     * 相同对话的后续请求可在支持该字段的网关（如 openai-api-server-via-codex）
     * 上复用 Codex 后端会话缓存（网关会把该字段转成 session_id 请求头）；
     * 总结、子代理等内部请求默认不携带 conversationId，不会发送该字段。
     * 仅支持 prompt_cache_key 的网关可开启，默认关闭。
     */
    promptCacheKeyEnabled?: boolean;

    /**
     * 显式 prompt_cache_key 覆盖。
     *
     * 非空时优先使用此值（跨对话共享同一会话缓存域，高级用法）；
     * 未设置或为空时回退为基于 conversationId 哈希生成。
     */
    promptCacheKey?: string;

    /**
     * 历史 reasoning 签名回传格式。
     *
     * - official：完整保留官方 GPT Responses reasoning item 字段；
     * - codex：兼容 Codex 反代，省略反代不接受的 status 字段。
     */
    reasoningSignatureMode?: OpenAIResponsesReasoningSignatureMode;

    /** 可用模型列表 */
    models?: ModelInfo[];
    
    /** 生成配置（可选） */
    options?: {
        /** 温度参数 (0.0 - 2.0) */
        temperature?: number;
        
        /** 最大输出 token 数 */
        max_output_tokens?: number;
        
        /** Top-p 采样参数 */
        top_p?: number;
        
        /** 是否流式输出 */
        stream?: boolean;
        
        /**
         * 思考配置
         *
         * 用于控制 GPT-5/o 系列等推理模型的思考行为
         *
         * 示例：
         * {
         *   effort: "medium",
         *   summaryEnabled: true,
         *   summary: "auto"
         * }
         */
        reasoning?: {
            /**
             * 思考强度
             * - none: 不使用思考
             * - low: 较少的思考
             * - medium: 中等思考
             * - high: 较多思考
             * - xhigh: 最高思考强度 (extra high)
             * - max: 最大思考强度
             * - ultra: 极限思考强度
             * - custom: 自定义（使用 effortCustom 字段的值）
             */
            effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra' | 'custom';
            
            /**
             * 自定义思考强度
             * 仅在 effort 为 'custom' 时使用，值会原样发送给 API
             */
            effortCustom?: string;
            
            /**
             * 是否启用输出详细程度
             * 只有当此字段为 true 时，summary 才会发送到 API
             */
            summaryEnabled?: boolean;
            
            /**
             * 输出详细程度
             * - auto: 自动选择
             * - concise: 简洁输出
             * - detailed: 详细输出
             */
            summary?: 'auto' | 'concise' | 'detailed';
        };
        
    };
    
    /**
     * 配置项启用状态
     *
     * 控制 options 中的哪些参数会被发送到 API
     * 仅当此处的对应字段为 true 时，options 中的值才会被发送
     */
    optionsEnabled?: OpenAIResponsesOptionsEnabled;
}

