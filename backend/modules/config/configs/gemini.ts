/**
 * LimCode - Gemini 配置类型
 * 
 * Google Gemini API 的完整配置支持
 */

import type { BaseChannelConfig, ModelInfo } from './base';

/**
 * 配置项启用状态
 *
 * 用于控制哪些配置项会被发送到 API
 * 未列出的配置项默认不发送
 */
export interface GeminiOptionsEnabled {
    /** 是否发送温度参数 */
    temperature?: boolean;
    
    /** 是否发送最大输出 token 数 */
    maxOutputTokens?: boolean;

    /** 是否限制历史消息中的图片数量 */
    maxImages?: boolean;
    
    /** 是否启用思考配置 */
    thinkingConfig?: boolean;
}

/**
 * 思考等级
 * - 'minimal': 最少思考
 * - 'low': 较少思考
 * - 'medium': 中等思考
 * - 'high': 深度思考
 */
export type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high';

/**
 * 思考配置模式
 * - 'default': 使用 API 默认值（不发送等级或预算）
 * - 'level': 使用预设等级
 * - 'budget': 使用自定义 token 预算
 */
export type ThinkingMode = 'default' | 'level' | 'budget';

/**
 * 思考配置
 *
 * 支持两种互斥模式：
 * - level: 使用预设等级（low/high）
 * - budget: 使用自定义 token 预算
 */
export interface ThinkingConfig {
    /** 是否包含思考内容在响应中 */
    includeThoughts?: boolean;
    
    /** 思考模式：level（等级）或 budget（预算） */
    mode?: ThinkingMode;
    
    /** 思考等级（当 mode 为 'level' 时使用） */
    thinkingLevel?: ThinkingLevel;
    
    /** 思考预算 token 数（当 mode 为 'budget' 时使用） */
    thinkingBudget?: number;
}

/**
 * Gemini 配置
 *
 * 支持 Google Gemini API 的完整配置
 */
export interface GeminiConfig extends BaseChannelConfig {
    type: 'gemini';
    
    /** API 端点 URL */
    url: string;
    
    /** API 密钥 */
    apiKey: string;
    
    /** 是否使用 Authorization Bearer 格式发送 API Key（替代 x-goog-api-key） */
    useAuthorizationHeader?: boolean;
    
    /** 当前使用的模型名称 */
    model: string;
    
    /** 可用模型列表 */
    models?: ModelInfo[];
    
    /** 生成配置（可选） */
    options?: {
        /** 温度参数 (0.0 - 2.0) */
        temperature?: number;
        
        /** 最大输出 token 数 */
        maxOutputTokens?: number;

        /** 发送给上游的图片总数上限，0 表示不限制 */
        maxImages?: number;
        
        /** 是否流式输出 */
        stream?: boolean;
        
        /** 思考配置 */
        thinkingConfig?: ThinkingConfig;
    };
    
    /**
     * 配置项启用状态
     *
     * 控制 options 中的哪些参数会被发送到 API
     * 仅当此处的对应字段为 true 时，options 中的值才会被发送
     */
    optionsEnabled?: GeminiOptionsEnabled;
}
