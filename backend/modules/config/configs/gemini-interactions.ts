/**
 * GrayCode - Gemini Interactions 配置类型
 *
 * Google Gemini Interactions API（v1beta/interactions）的完整配置支持。
 * 与 gemini（generateContent）渠道平行，设计参照 openai / openai-responses：
 * - 无状态模式（store: false）由客户端管理完整 steps 历史
 * - thought 为独立 step（signature + summary），签名复用 thoughtSignatures.gemini 存储键
 */

import type { BaseChannelConfig, ModelInfo } from './base';
import type { GeminiOptionsEnabled, ThinkingConfig } from './gemini';

export type { GeminiOptionsEnabled, ThinkingConfig, ThinkingLevel, ThinkingMode } from './gemini';

/**
 * Gemini Interactions 配置
 *
 * 字段结构与 GeminiConfig 同构（options / optionsEnabled / 思考配置一致），
 * 仅 type 不同；前端设置面板可直接复用 GeminiOptions 组件。
 */
export interface GeminiInteractionsConfig extends BaseChannelConfig {
    type: 'gemini-interactions';

    /** API 端点 URL（默认 https://generativelanguage.googleapis.com/v1beta） */
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
