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

import type { SubAgentConfigItem } from '../../../packages/contracts/src/subagents'
export type { SubAgentToolsConfig, SubAgentConfigUpdate, SubAgentsConfig } from '../../../packages/contracts/src/subagents'

export type SubAgentChannelConfig = SubAgentConfigItem['channel']
/** 前端还会读取省略 enabled 的旧配置，其余字段直接使用共享契约。 */
export type SubAgentConfig = Omit<SubAgentConfigItem, 'enabled'> & Partial<Pick<SubAgentConfigItem, 'enabled'>>

/** 审查报告中「AgentConfig」的别名 */
export type AgentConfig = SubAgentConfig

/** 上下文总结配置（SummarizeSettings.vue） */
export interface SummarizeConfig {
  method?: 'summary' | 'notes'
  userMessageRetention?: import('../../../shared/contextManagement').ContextUserMessageRetention
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
