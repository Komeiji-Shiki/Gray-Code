import type { CharacterChatConfig } from './characters';

export interface ConversationModelConfig {
  configId?: string;
  /** 旧记录的渠道字段，分支复制保留原值，当前选择使用 configId。 */
  channelId?: string;
  modelId?: string;
  reasoningEffort?: string;
}

export interface ConversationPromptModeConfig { modeId?: string }

/** 声明常用字段，索引签名继续容纳旧存档及工具自定义元数据。 */
export interface ConversationCustomMetadata extends Record<string, unknown> {
  /** 旧记录及动态 custom 写入没有统一模式校验，读取方仍须检查实际值。 */
  platformMode?: unknown;
  platformSubagentId?: string;
  inputModelConfig?: ConversationModelConfig;
  promptModeConfig?: ConversationPromptModeConfig;
  characterConfig?: CharacterChatConfig;
  messageCount?: number;
  preview?: string;
}

export interface ConversationUiMetadata {
  id: string;
  title?: string;
  createdAt: number;
  updatedAt: number;
  workspaceUri?: string;
  custom?: ConversationCustomMetadata;
  integrityStatus?: 'ok' | 'meta_missing' | 'meta_corrupt' | 'history_missing' | 'history_corrupt';
}

/** 旧聊天列表返回的摘要不包含平台导航所需的 revision。 */
export interface ConversationUiSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  preview?: string;
  workspaceUri?: string;
  integrityStatus?: string;
}
