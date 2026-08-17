/**
 * 渠道配置契约类型（F-09）
 *
 * 与后端 backend/modules/config/configs/*.ts 的 ChannelConfig 结构对齐：
 * - BaseChannelConfig（backend/modules/config/configs/base.ts）
 * - GeminiConfig / OpenAIConfig / AnthropicConfig / OpenAIResponsesConfig
 *
 * 前端对渠道配置的读取是「通用」的（输入区 / 设置页 / 任务卡都按同一份对象消费，
 * 不按渠道类型做 discriminated union 分支），因此这里定义为单一接口，所有字段
 * （除 id/name/type/enabled 身份字段外）保持可选，宁可可选也不要漏字段，
 * 保证与后端已持久化/旧配置/导入配置兼容，运行时字段读写语义不变。
 */
import type { ModelInfo } from './index'

/** 支持的渠道类型（与 backend/modules/config/configs/base.ts 的 ChannelType 同源） */
export type ChannelType = 'gemini' | 'gemini-interactions' | 'openai' | 'anthropic' | 'openai-responses'

/** 工具调用模式 */
export type ToolMode = 'function_call' | 'xml' | 'json'

/** Token 计数方式 */
export type TokenCountMethod =
  | 'channel_default'
  | 'gemini'
  | 'openai_custom'
  | 'openai_responses'
  | 'anthropic'
  | 'local'

/** 自定义请求标头项 */
export interface CustomHeader {
  key: string
  value: string
  enabled: boolean
}

/** 自定义 body 项 */
export interface CustomBodyItem {
  key: string
  value: string
  enabled: boolean
}

/** 自定义 body 配置 */
export interface CustomBodyConfig {
  mode: 'simple' | 'advanced'
  items?: CustomBodyItem[]
  json?: string
}

/** 裁切图片工具配置 */
export interface CropImageToolOptions {
  useNormalizedCoordinates?: boolean
}

/** 工具配置 */
export interface ToolOptions {
  cropImage?: CropImageToolOptions
}

/** Token 计数 API 配置 */
export interface TokenCountApiConfig {
  url?: string
  apiKey?: string
  model?: string
}

// ============ 各渠道 options / optionsEnabled ============

/** Gemini 思考等级 */
export type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high'

/** Gemini 思考模式 */
export type ThinkingMode = 'default' | 'level' | 'budget'

/** Gemini 思考配置 */
export interface ThinkingConfig {
  includeThoughts?: boolean
  mode?: ThinkingMode
  thinkingLevel?: ThinkingLevel
  thinkingBudget?: number
}

/** OpenAI / OpenAI Responses 推理强度 */
export type ReasoningEffort =
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'
  | 'ultra'
  | 'custom'

/** OpenAI / OpenAI Responses 推理配置 */
export interface ReasoningConfig {
  effort?: ReasoningEffort
  effortCustom?: string
  summaryEnabled?: boolean
  summary?: 'auto' | 'concise' | 'detailed'
}

/** Anthropic 思考配置 */
export interface AnthropicThinkingConfig {
  type?: 'enabled' | 'adaptive' | 'disabled'
  budget_tokens?: number
  effort?: 'ultra' | 'max' | 'xhigh' | 'high' | 'medium' | 'low' | 'custom'
  effortCustom?: string
  display?: 'omitted' | 'summarized'
}

/**
 * 渠道生成配置（options）。
 *
 * 合并了四种渠道所有可能的选项字段（各渠道独有的字段为可选），
 * 与设置页通用读写（updateOption / options.xxx）保持一致。
 */
export interface ChannelOptions {
  // Gemini
  temperature?: number
  maxOutputTokens?: number
  maxImages?: number
  thinkingConfig?: ThinkingConfig
  // OpenAI / Anthropic / OpenAI Responses 通用
  max_tokens?: number
  top_p?: number
  top_k?: number
  frequency_penalty?: number
  presence_penalty?: number
  max_output_tokens?: number
  stop?: string[]
  stop_sequences?: string[]
  n?: number
  stream?: boolean
  // OpenAI / OpenAI Responses 推理
  reasoning?: ReasoningConfig
  // Anthropic 思考
  thinking?: AnthropicThinkingConfig
}

/** 配置项启用状态（optionsEnabled），合并四种渠道的开关字段 */
export interface ChannelOptionsEnabled {
  temperature?: boolean
  maxOutputTokens?: boolean
  maxImages?: boolean
  max_tokens?: boolean
  top_p?: boolean
  top_k?: boolean
  frequency_penalty?: boolean
  presence_penalty?: boolean
  max_output_tokens?: boolean
  thinkingConfig?: boolean
  reasoning?: boolean
  thinking?: boolean
}

/**
 * 渠道配置（前端契约类型）。
 *
 * 身份字段 id/name/type/enabled 为后端始终写入的字段；
 * 其余字段（含各渠道特有字段）一律可选，以兼容旧配置与导入配置。
 */
export interface ChannelConfig {
  id: string
  name: string
  type: ChannelType
  enabled: boolean

  // 通用字段
  createdAt?: number
  updatedAt?: number
  description?: string
  tags?: string[]
  systemInstruction?: string
  timeout?: number
  maxContextTokens?: number
  preferStream?: boolean
  toolMode?: ToolMode
  customHeaders?: CustomHeader[]
  customHeadersEnabled?: boolean
  customBody?: CustomBodyConfig
  customBodyEnabled?: boolean
  sendHistoryThoughtSignatures?: boolean
  sendCurrentThoughtSignatures?: boolean
  reasoningSignatureMode?: 'official' | 'codex'
  sendHistoryThoughts?: boolean
  historyThinkingRounds?: number
  sendCurrentThoughts?: boolean
  strictToolsEnabled?: boolean
  retryEnabled?: boolean
  retryCount?: number
  retryInterval?: number
  contextManagementEnabled?: boolean
  contextManagementMode?: 'trim' | 'summarize'
  contextThresholdEnabled?: boolean
  contextThreshold?: number | string
  contextTrimExtraCut?: number | string
  autoSummarizeEnabled?: boolean
  multimodalToolsEnabled?: boolean
  toolOptions?: ToolOptions
  tokenCountMethod?: TokenCountMethod
  tokenCountApiConfig?: TokenCountApiConfig

  // 各渠道特有字段
  url?: string
  apiKey?: string
  useAuthorizationHeader?: boolean
  deepSeekUserIdEnabled?: boolean
  pdfAttachmentEnabled?: boolean
  promptCacheKeyEnabled?: boolean
  promptCacheKey?: string
  promptCachingEnabled?: boolean
  promptCachingTtl?: '5m' | '1h'
  promptCachingKeepAlive?: boolean
  anthropicUserIdEnabled?: boolean

  // 模型与选项
  model?: string
  models?: ModelInfo[]
  options?: ChannelOptions
  optionsEnabled?: ChannelOptionsEnabled
}

/** 更新渠道配置的输入（排除后端自管字段 id/createdAt/updatedAt） */
export type ChannelConfigUpdate = Partial<Omit<ChannelConfig, 'id' | 'createdAt' | 'updatedAt'>>
