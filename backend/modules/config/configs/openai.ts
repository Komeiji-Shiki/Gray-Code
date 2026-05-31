/**
 * LimCode - OpenAI 配置类型
 * 
 * OpenAI API 格式的配置支持（兼容 DeepSeek 等）
 */

import type { BaseChannelConfig, ModelInfo } from './base';

/**
 * 配置项启用状态
 *
 * 用于控制哪些配置项会被发送到 API
 * 未列出的配置项默认不发送
 */
export interface OpenAIOptionsEnabled {
    /** 是否发送温度参数 */
    temperature?: boolean;
    
    /** 是否发送最大输出 token 数 */
    max_tokens?: boolean;
    
    /** 是否发送 top_p 参数 */
    top_p?: boolean;
    
    /** 是否发送频率惩罚 */
    frequency_penalty?: boolean;
    
    /** 是否发送存在惩罚 */
    presence_penalty?: boolean;
    
    /** 是否启用思考配置 */
    reasoning?: boolean;
}

/**
 * OpenAI 配置
 *
 * 支持 OpenAI API 格式的配置（包括兼容格式如 DeepSeek）
 */
export interface OpenAIConfig extends BaseChannelConfig {
    type: 'openai';
    
    /** API 端点 URL */
    url: string;
    
    /** API 密钥 */
    apiKey: string;
    
    /** 当前使用的模型名称 */
    model: string;
    
    /**
     * 是否为 DeepSeek Chat Completions 请求发送 user_id。
     * 开启后会基于主聊天 conversationId 生成稳定且不含隐私信息的 user_id。
     */
    deepSeekUserIdEnabled?: boolean;

    /** 可用模型列表 */
    models?: ModelInfo[];
    
    /** 生成配置（可选） */
    options?: {
        /** 温度参数 (0.0 - 2.0) */
        temperature?: number;
        
        /** 最大输出 token 数 */
        max_tokens?: number;
        
        /** Top-p 采样参数 */
        top_p?: number;
        
        /** 频率惩罚 (-2.0 - 2.0) */
        frequency_penalty?: number;
        
        /** 存在惩罚 (-2.0 - 2.0) */
        presence_penalty?: number;
        
        /** 停止序列 */
        stop?: string[];
        
        /** 候选结果数量 */
        n?: number;
        
        /** 是否流式输出 */
        stream?: boolean;
        
        /**
         * 思考配置
         *
         * 用于控制 OpenAI o1 系列等推理模型的思考行为
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
             */
            effort?: 'none' | 'low' | 'medium' | 'high' | 'xhigh';
            
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
    optionsEnabled?: OpenAIOptionsEnabled;
}