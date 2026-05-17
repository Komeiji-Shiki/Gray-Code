/**
 * 输入组件类型定义
 */

export interface ChannelOption {
  id: string
  name: string
  model: string
  type: string
}

export type DynamicContextStrategy = 'single' | 'preserve'

export interface PromptMode {
  id: string
  name: string
  icon?: string
  dynamicContextStrategy?: DynamicContextStrategy
}

export interface ModelInfo {
  id: string
  name?: string
  description?: string
}
