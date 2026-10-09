import type { GeminiConfig } from './gemini';
import type { GeminiInteractionsConfig } from './gemini-interactions';
import type { OpenAIConfig } from './openai';
import type { AnthropicConfig } from './anthropic';
import type { OpenAIResponsesConfig } from './openai-responses';

export * from './base';
export type { GeminiConfig, GeminiOptionsEnabled, ThinkingConfig, ThinkingLevel, ThinkingMode } from './gemini';
export type { GeminiInteractionsConfig } from './gemini-interactions';
export type { OpenAIConfig, OpenAIOptionsEnabled } from './openai';
export type { AnthropicConfig, AnthropicOptionsEnabled } from './anthropic';
export type { OpenAIResponsesConfig, OpenAIResponsesOptionsEnabled, OpenAIResponsesReasoningSignatureMode } from './openai-responses';

export type ChannelConfig = GeminiConfig | GeminiInteractionsConfig | OpenAIConfig | AnthropicConfig | OpenAIResponsesConfig;

type UnionKeys<T> = T extends unknown ? keyof T : never;
type UnionField<T, K extends PropertyKey> = T extends unknown ? K extends keyof T ? T[K] : never : never;
/** 表单按通用对象读取渠道，联合类型中的专有字段也应保留为可选字段。 */
type OptionalUnionFields<T> = { [K in UnionKeys<T>]?: UnionField<T, K> };

type ProviderOptions = NonNullable<ChannelConfig['options']>;
type MergedOptions = OptionalUnionFields<ProviderOptions>;
export type ReasoningConfig = OptionalUnionFields<NonNullable<MergedOptions['reasoning']>>;
export type ReasoningEffort = NonNullable<ReasoningConfig['effort']>;
export type AnthropicThinkingConfig = NonNullable<NonNullable<AnthropicConfig['options']>['thinking']>;
export type ChannelOptions = Omit<MergedOptions, 'reasoning'> & { reasoning?: ReasoningConfig };
export type ChannelOptionsEnabled = OptionalUnionFields<NonNullable<ChannelConfig['optionsEnabled']>>;

/** 身份字段必填；旧配置、导入配置和各渠道专有字段仍按原有可选语义读取。 */
export type ChannelConfigDTO = Pick<ChannelConfig, 'id' | 'name' | 'type' | 'enabled'>
    & Omit<OptionalUnionFields<ChannelConfig>, 'id' | 'name' | 'type' | 'enabled' | 'options' | 'optionsEnabled'>
    & { options?: ChannelOptions; optionsEnabled?: ChannelOptionsEnabled };
export type ChannelConfigUpdate = Partial<Omit<ChannelConfigDTO, 'id' | 'createdAt' | 'updatedAt'>>;
