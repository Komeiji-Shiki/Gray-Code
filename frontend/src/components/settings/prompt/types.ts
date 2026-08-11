/**
 * PromptSettings 相关（S6 批次拆分）共享类型。
 *
 * PromptSettings.vue 与拆出的 prompt/ 子组件（ModulesReference / PromptEntriesEditor /
 * ToolPolicySection / DynamicTemplateSection / DynamicStrategyBlock / AssemblyModeSelector）
 * 共用这些类型；独立 .ts 模块（非 .vue 具名导出），供 .ts / .vue 双向安全引用。
 */

// 提示词模块定义
export interface PromptModule {
  id: string
  name: string
  description: string
  example?: string
  requiresConfig?: string
}

export type DynamicContextStrategy = 'single' | 'preserve'
export type PromptEntryRole = 'system' | 'user' | 'assistant'
export type PromptAssemblyMode = 'legacy' | 'entries'
export type PromptEntryType = 'prompt' | 'chat_history'

export interface PromptEntry {
  id: string
  name: string
  type?: PromptEntryType
  enabled: boolean
  role: PromptEntryRole
  content: string
  /** 伪造思考内容（仅 assistant 角色生效，随临时消息以 thought part 回传） */
  fakeThought?: string
  order: number
}

export interface ToolInfo {
  name: string
  description: string
  enabled: boolean
  category?: string
  // MCP tools may include extra fields; ignore them here.
  [key: string]: any
}

export type ToolPolicyMode = 'inherit' | 'custom'
