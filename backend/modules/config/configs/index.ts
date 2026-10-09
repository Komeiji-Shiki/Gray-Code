/**
 * GrayCode - 配置类型统一导出
 *
 * 集中管理所有渠道配置类型的导出
 */

// 导出基础类型
import { CHANNEL_TYPES } from './base';
export { CHANNEL_TYPES };
export type { ChannelType, BaseChannelConfig, ModelInfo, TokenCountMethod, TokenCountApiConfig } from './base';

// 导出各渠道配置
export type { GeminiConfig, GeminiOptionsEnabled, ThinkingConfig, ThinkingLevel, ThinkingMode } from './gemini';
export type { GeminiInteractionsConfig } from './gemini-interactions';
export type { OpenAIConfig } from './openai';
export type { AnthropicConfig } from './anthropic';
export type {
    OpenAIResponsesConfig,
    OpenAIResponsesOptionsEnabled,
    OpenAIResponsesReasoningSignatureMode
} from './openai-responses';

/**
 * 渠道配置联合类型
 *
 * 使用 TypeScript 的 discriminated union 实现类型安全
 */
export type { ChannelConfig } from '../../../../packages/contracts/src/channels';
