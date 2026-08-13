/**
 * SubAgentsSettings 拆分（S7 批次，纯重构，行为零变化）共享类型。
 *
 * SubAgentsSettings.vue 与拆出的 subAgentsSettings/ 子组件共用这些接口；
 * 独立 .ts 模块（非 .vue 具名导出），供 .ts / .vue 双向安全引用。
 */
import type { ModelInfo, SubAgentToolsConfig } from '@/types'

// 渠道配置（子代理选择渠道/模型时消费）
export interface ChannelConfig {
  id: string
  name: string
  type: string
  enabled: boolean
  model: string
  models: ModelInfo[]
}

// 工具信息（内置 + MCP）
export interface ToolInfo {
  name: string
  description: string
  category?: string
  source: 'builtin' | 'mcp'
  serverId?: string
  serverName?: string
}

// 预设模板（与后端 backend/tools/subagents/presets.ts 同构）
export interface SubAgentPreset {
  presetId: string
  defaultName: string
  defaultDescription: string
  icon: string
  systemPrompt: string
  tools: SubAgentToolsConfig
  maxIterations?: number
  maxRuntime?: number
}
