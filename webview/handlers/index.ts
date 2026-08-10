/**
 * 消息处理器统一导出
 */

import type { MessageHandler } from '../types';

import { registerConversationHandlers } from './ConversationHandlers';
import { registerBranchHandlers } from './BranchHandlers';
import { registerConfigHandlers } from './ConfigHandlers';
import { registerSettingsHandlers } from './SettingsHandlers';
import { registerCheckpointHandlers } from './CheckpointHandlers';
import { registerToolHandlers } from './ToolHandlers';
import { registerMcpHandlers } from './McpHandlers';
import { registerDependencyHandlers } from './DependencyHandlers';
import { registerStoragePathHandlers } from './StoragePathHandlers';
import { registerContextHandlers } from './ContextHandlers';
import { registerFileUtilsHandlers } from './file/fileHandlerUtils';
import { registerPinnedFileHandlers } from './file/PinnedFileHandlers';
import { registerFileReadHandlers } from './file/FileReadHandlers';
import { registerFilePreviewHandlers } from './file/FilePreviewHandlers';
import { registerFileOpenHandlers } from './file/FileOpenHandlers';
import { registerFileSearchHandlers } from './file/FileSearchHandlers';
import { registerPlanApprovalHandlers } from './PlanApprovalHandlers';
import { registerSummarizeHandlers } from './SummarizeHandlers';
import { registerDiffHandlers } from './DiffHandlers';
import { registerChatHandlers } from './ChatHandlers';
import { registerSkillsHandlers } from './SkillsHandlers';
import { registerSubAgentsHandlers } from './SubAgentsHandlers';
import { registerNotificationHandlers } from './NotificationHandlers';
import { registerUsageHandlers } from './UsageHandlers';
import { registerActivityHandlers } from './ActivityHandlers';
import { registerTokenizerHandlers } from './TokenizerHandlers';
import { registerUpdateHandlers } from './UpdateHandlers';

// 重新导出各个模块
export * from './ConversationHandlers';
export * from './BranchHandlers';
export * from './ConfigHandlers';
export * from './SettingsHandlers';
export * from './CheckpointHandlers';
export * from './ToolHandlers';
export * from './McpHandlers';
export * from './DependencyHandlers';
export * from './StoragePathHandlers';
export * from './ContextHandlers';
export * from './FileHandlers';
export * from './DiffHandlers';
export * from './ChatHandlers';
export * from './SkillsHandlers';
export * from './SubAgentsHandlers';
export * from './NotificationHandlers';
export * from './UsageHandlers';
export * from './ActivityHandlers';
export * from './TokenizerHandlers';
export * from './UpdateHandlers';

/**
 * 创建并注册所有消息处理器
 */
export function createMessageHandlerRegistry(): Map<string, MessageHandler> {
  const registry = new Map<string, MessageHandler>();
  
  // 注册各个模块的处理器
  registerConversationHandlers(registry);
  registerBranchHandlers(registry);
  registerConfigHandlers(registry);
  registerSettingsHandlers(registry);
  registerCheckpointHandlers(registry);
  registerToolHandlers(registry);
  registerMcpHandlers(registry);
  registerDependencyHandlers(registry);
  registerStoragePathHandlers(registry);
  registerContextHandlers(registry);
  registerFileUtilsHandlers(registry);
  registerPinnedFileHandlers(registry);
  registerFileReadHandlers(registry);
  registerFilePreviewHandlers(registry);
  registerFileOpenHandlers(registry);
  registerFileSearchHandlers(registry);
  registerPlanApprovalHandlers(registry);
  registerSummarizeHandlers(registry);
  registerDiffHandlers(registry);
  registerChatHandlers(registry);
  registerSkillsHandlers(registry);
  registerSubAgentsHandlers(registry);
  registerNotificationHandlers(registry);
  registerUsageHandlers(registry);
  registerActivityHandlers(registry);
  registerTokenizerHandlers(registry);
  registerUpdateHandlers(registry);
  
  return registry;
}
