/**
 * 消息处理器统一导出
 */

import type { MessageHandler } from '../types';

import { registerConversationHandlers } from './ConversationHandlers';
import { registerBranchHandlers } from './BranchHandlers';
import { registerConfigHandlers } from './ConfigHandlers';
import { registerSettingsHandlers } from './SettingsHandlers';
import { registerWallpaperHandlers } from './WallpaperHandlers';
import { registerMemoryHandlers } from './MemoryHandlers';
import { registerSettingsTransferHandlers } from './SettingsTransferHandlers';
import { registerCheckpointHandlers } from './CheckpointHandlers';
import { registerToolHandlers } from './ToolHandlers';
import { registerMcpHandlers } from './McpHandlers';
import { registerDependencyHandlers } from './DependencyHandlers';
import { registerStoragePathHandlers } from './StoragePathHandlers';
import { registerContextHandlers } from './ContextHandlers';
import { registerFileHandlers } from './FileHandlers';
import { registerDiffHandlers } from './DiffHandlers';
import { registerChatHandlers } from './ChatHandlers';
import { registerSkillsHandlers } from './SkillsHandlers';
import { registerSubAgentsHandlers } from './SubAgentsHandlers';
import { registerNotificationHandlers } from './NotificationHandlers';
import { registerUsageHandlers } from './UsageHandlers';
import { registerWorkspaceHandlers } from './WorkspaceHandlers';
import { registerActivityHandlers } from './ActivityHandlers';
import { registerTokenizerHandlers } from './TokenizerHandlers';
import { registerUpdateHandlers } from './UpdateHandlers';

// 重新导出各个模块（对照 handlers/ 目录实际文件，与上方 import 列表一一对应；
// FileHandlers 为兼容壳，其内容已由下方 file/*、PlanApprovalHandlers、SummarizeHandlers
// 与 NotificationHandlers/ConversationHandlers 的 export * 完整覆盖）
export * from './ConversationHandlers';
export * from './BranchHandlers';
export * from './ConfigHandlers';
export * from './SettingsHandlers';
export * from './WallpaperHandlers';
export * from './CheckpointHandlers';
export * from './ToolHandlers';
export * from './McpHandlers';
export * from './DependencyHandlers';
export * from './StoragePathHandlers';
export * from './ContextHandlers';
export * from './file/fileHandlerUtils';
export * from './file/PinnedFileHandlers';
export * from './file/FileReadHandlers';
export * from './file/FilePreviewHandlers';
export * from './file/FileOpenHandlers';
export * from './file/FileSearchHandlers';
export * from './PlanApprovalHandlers';
export * from './SummarizeHandlers';
export * from './DiffHandlers';
export * from './ChatHandlers';
export * from './SkillsHandlers';
export * from './SubAgentsHandlers';
export * from './NotificationHandlers';
export * from './UsageHandlers';
export * from './WorkspaceHandlers';
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
  // 上游拆分的记忆/导入导出注册在前：本地 SettingsHandlers 的内联实现（多工作区作用域）
  // 后注册覆盖同名消息，保证本地语义生效。
  registerMemoryHandlers(registry);
  registerSettingsTransferHandlers(registry);
  registerSettingsHandlers(registry);
  registerWallpaperHandlers(registry);
  registerCheckpointHandlers(registry);
  registerToolHandlers(registry);
  registerMcpHandlers(registry);
  registerDependencyHandlers(registry);
  registerStoragePathHandlers(registry);
  registerContextHandlers(registry);
  // 本地 FileHandlers 为完整实现（含多工作区/安全加固/审批门），后注册覆盖上游拆分文件的同名消息。
  registerFileHandlers(registry);
  registerDiffHandlers(registry);
  registerChatHandlers(registry);
  registerSkillsHandlers(registry);
  registerSubAgentsHandlers(registry);
  registerNotificationHandlers(registry);
  registerUsageHandlers(registry);
  registerWorkspaceHandlers(registry);
  registerActivityHandlers(registry);
  registerTokenizerHandlers(registry);
  registerUpdateHandlers(registry);
  
  return registry;
}
