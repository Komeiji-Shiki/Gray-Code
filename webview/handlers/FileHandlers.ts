/**
 * 固定文件和工作区文件消息处理器（拆分后的聚合壳）
 *
 * FileHandlers.ts 已按职责拆分为：
 * - handlers/file/ 子目录：fileHandlerUtils（共享工具 + 工作区信息）、
 *   PinnedFileHandlers（固定文件管理）、FileReadHandlers（文件读取与类型推断）、
 *   FilePreviewHandlers（预览展示 + 临时文件清理）、FileOpenHandlers（打开/保存 + 跳转高亮）、
 *   FileSearchHandlers（工作区文件搜索）
 * - handlers/PlanApprovalHandlers.ts（Design/Review/Plan 审批确认）
 * - handlers/SummarizeHandlers.ts（上下文总结）
 * - showNotification 移入 NotificationHandlers.ts
 * - conversation.revealInExplorer 移入 ConversationHandlers.ts
 *
 * 本文件保留为纯 re-export 壳，兼容既有引用路径：
 * - backend/__tests__/webview/*.test.ts 直接 import 本文件（isUriInsideWorkspace / summarizeContext）
 * - ChatViewProvider.ts 从本文件 import disposeFileHandlerResources
 * 新代码请直接引用拆分后的模块。
 */

export * from './file/fileHandlerUtils';
export * from './file/PinnedFileHandlers';
export * from './file/FileReadHandlers';
export * from './file/FilePreviewHandlers';
export * from './file/FileOpenHandlers';
export * from './file/FileSearchHandlers';
export * from './PlanApprovalHandlers';
export * from './SummarizeHandlers';
export { showNotification } from './NotificationHandlers';
export { revealConversationInExplorer } from './ConversationHandlers';
