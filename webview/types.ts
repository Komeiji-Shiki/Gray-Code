/**
 * ChatViewProvider 类型定义
 */

import type * as vscode from 'vscode';
import type { ConversationManager } from '../backend/modules/conversation';
import type { ConfigManager } from '../backend/modules/config';
import type { ChannelManager } from '../backend/modules/channel';
import type { ChatHandler } from '../backend/modules/api/chat';
import type { ModelsHandler } from '../backend/modules/api/models';
import type { SettingsManager, StoragePathManager } from '../backend/modules/settings';
import type { SettingsHandler } from '../backend/modules/api/settings';
import type { CheckpointManager } from '../backend/modules/checkpoint';
import type { McpManager } from '../backend/modules/mcp';
import type { DependencyManager } from '../backend/modules/dependencies';
import type { DiffStorageManager } from '../backend/modules/conversation';
import type { ToolRegistry } from '../backend/tools';
import type { WindowsAgentStopNotificationService } from '../backend/modules/notifications/WindowsAgentStopNotificationService';
import type { WebviewClientId } from './runtime/WebviewClientRegistry';
import type { StreamAbortManager } from './stream/StreamAbortManager';
import type { UpdateChecker } from '../backend/modules/update';

/**
 * 消息处理器上下文
 * 提供处理器所需的所有依赖
 */
export interface HandlerContext {
  // VSCode 上下文
  context?: vscode.ExtensionContext;
  view?: vscode.WebviewView | undefined;
  clientId?: WebviewClientId;
  
  // 后端模块
  configManager: ConfigManager;
  channelManager: ChannelManager;
  conversationManager: ConversationManager;
  chatHandler: ChatHandler;
  modelsHandler: ModelsHandler;
  settingsManager: SettingsManager;
  settingsHandler: SettingsHandler;
  checkpointManager: CheckpointManager;
  mcpManager: McpManager;
  dependencyManager: DependencyManager;
  storagePathManager: StoragePathManager;
  diffStorageManager: DiffStorageManager;
  toolRegistry?: ToolRegistry;
  windowsAgentStopNotificationService?: WindowsAgentStopNotificationService;
  updateChecker?: UpdateChecker;

  // 流式请求控制（实际注入的是 StreamAbortManager，具有 create/cancel/deleteSummary 等能力）
  streamAbortControllers: StreamAbortManager;
  
  // Diff 预览提供者
  diffPreviewProvider: DiffPreviewContentProvider;
  
  // 响应函数
  sendResponse: (requestId: string, data: any) => void;
  sendError: (requestId: string, code: string, message: string) => void;
  postMessage?: (message: any) => void;
  openSubAgentMonitor?: (runId?: string, conversationId?: string) => Promise<void> | void;
  // 修改原因：Monitor 路由上下文把 view 覆盖为 undefined（流按 clientId 路由、storage 进度不能发到 Monitor），
  //          但 vscode.diff 默认在“当前活动组”打开——焦点在 Monitor 面板时 diff 会开在 Monitor 列而不是主聊天侧。
  // 修改方式：单独下发 diff 的目标列（主聊天所在列，侧边栏时回退主区域第一列），与 view 的解耦职责互不干扰。
  // 修改目的：无论焦点在哪，diff 预览始终跟随主聊天所在的编辑器列。
  diffViewColumn?: vscode.ViewColumn;
  
  // 工具函数
  getCurrentWorkspaceUri: () => string | null;
  syncLanguageToBackend?: () => void;

  // 远程控制（桌面端专用；VS Code 宿主不注入时为 undefined）
  remoteControlStatus?: () => RemoteControlStatus;
  remoteControlApply?: (action: RemoteControlApplyAction) => Promise<RemoteControlApplyResult> | RemoteControlApplyResult;
}

/** 远程控制状态（设置页与移动端 UI 共用） */
export interface RemoteControlStatus {
  /** 当前宿主是否支持远程控制（仅桌面端 true） */
  available: boolean;
  /** 配置是否启用 */
  enabled: boolean;
  /** 配置端口 */
  port: number;
  /** 服务器是否正在监听 */
  running: boolean;
  /** 监听失败等错误信息 */
  error?: string;
  /** 局域网访问地址（http://ip:port） */
  urls?: string[];
  /** 当前激活会话（前端上报或最近使用） */
  activeConversationId?: string | null;
}

/** 远程控制服务器操作（apply 类） */
export interface RemoteControlApplyAction {
  type: 'restart' | 'stop';
}

/** 远程控制服务器操作结果 */
export interface RemoteControlApplyResult {
  ok: boolean;
  error?: string;
}

/**
 * Diff 预览内容提供者接口
 */
export interface DiffPreviewContentProvider {
  setContent(uri: string, content: string): void;
  provideTextDocumentContent(uri: vscode.Uri): string;
  dispose(): void;
}

/**
 * 消息处理器类型
 */
export type MessageHandler = (
  data: any,
  requestId: string,
  ctx: HandlerContext
) => Promise<void>;

/**
 * 消息处理器注册表
 */
export type MessageHandlerRegistry = Map<string, MessageHandler>;

/**
 * 终端输出事件
 */
export interface TerminalOutputEvent {
  terminalId: string;
  type: 'stdout' | 'stderr' | 'exit';
  data?: string;
  exitCode?: number;
}

/**
 * 图像生成输出事件
 */
export interface ImageGenOutputEvent {
  toolId: string;
  type: 'progress' | 'complete' | 'error';
  progress?: number;
  data?: string;
  error?: string;
}

/**
 * 任务事件
 */
export interface TaskEvent {
  taskId: string;
  type: string;
  [key: string]: any;
}

/**
 * 重试状态
 */
export interface RetryStatus {
  type: 'retrying' | 'retrySuccess' | 'retryFailed';
  attempt: number;
  maxAttempts: number;
  error?: string;
  nextRetryIn?: number;
}
