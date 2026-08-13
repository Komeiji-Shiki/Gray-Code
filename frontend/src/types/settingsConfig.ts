/**
 * 设置页子对象契约类型（F-09）
 *
 * 对应各设置面板本地保存 / 回填的子配置对象：
 * - GenerateImageSettings 的 ImageConfig
 * - SubAgentsSettings 的 SubAgentConfig（即审查报告中的「AgentConfig」）
 * - SummarizeSettings 的 SummarizeConfig
 *
 * 字段以组件实际读写为准，避免与后端字段失配。
 */

/** 图像生成工具配置（GenerateImageSettings.vue） */
export interface ImageConfig {
  url: string
  apiKey: string
  model: string
  enableAspectRatio: boolean
  defaultAspectRatio: string
  enableImageSize: boolean
  defaultImageSize: string
  maxBatchTasks: number
  maxImagesPerTask: number
}

/** 子代理工具配置（SubAgentsSettings.vue） */
export interface SubAgentToolsConfig {
  mode: 'all' | 'builtin' | 'mcp' | 'whitelist' | 'blacklist'
  whitelist?: string[]
  blacklist?: string[]
  includeMcp?: boolean
}

/** 子代理渠道/模型绑定 */
export interface SubAgentChannelConfig {
  channelId: string
  modelId?: string
  syncWithCurrentModel?: boolean
}

/** 子代理配置（SubAgentsSettings.vue） */
export interface SubAgentConfig {
  type: string
  name: string
  description: string
  systemPrompt: string
  channel: SubAgentChannelConfig
  tools: SubAgentToolsConfig
  maxIterations?: number
  maxRuntime?: number
  enabled?: boolean
}

/** 审查报告中「AgentConfig」的别名 */
export type AgentConfig = SubAgentConfig

/** 上下文总结配置（SummarizeSettings.vue） */
export interface SummarizeConfig {
  summarizePrompt: string
  autoSummarizePrompt: string
  keepRecentRounds: number
  keepRecentTokens: string | number
  useSeparateModel: boolean
  summarizeChannelId: string
  summarizeModelId: string
  maxAutoSummarizeAttemptsPerTurn: number
  summarizeMaxInputRatio: number
}
