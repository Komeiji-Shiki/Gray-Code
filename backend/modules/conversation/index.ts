/**
 * 对话管理模块
 *
 * 完整支持 Gemini API 格式:
 * - Content[] 数组作为存储格式
 * - 支持函数调用、思考签名、文件数据等
 * - 支持多模态内容（图片、音频、视频、文档）
 * - 可直接用于 Gemini API 调用
 */

export { ConversationManager } from './ConversationManager';
export { FileUsageIndexStore } from './UsageIndexStore';
export {
    IStorageAdapter,
    MemoryStorageAdapter,
    VSCodeStorageAdapter,
    FileSystemStorageAdapter
} from './storage';
export type {
    // 对话存储定位结果类型（供 webview/测试复用，保持单一来源）
    ConversationStorageLocation
} from './storage';
export {
    // 消息截断与工具配对删除（主对话与 SubAgent 子对话共用同一套规则）
    truncateFrom,
    deleteLogicalMessage,
    mutateTranscript
} from './TranscriptMutation';
export type { TranscriptAdapter } from './TranscriptMutation';
export {
    // Transcript 仓储接口与主聊天 adapter（主聊天与 SubAgent 统一读写入口）
    cloneTranscriptContents,
    DelegatingTranscriptRepository,
    ConversationTranscriptRepository
} from './TranscriptRepository';
export type {
    ITranscriptRepository,
    TranscriptContentsMutator,
    TranscriptRepositoryDelegate
} from './TranscriptRepository';
export type {
    Content,
    ContentPart,
    UsageMetadata,
    ThoughtSignatures,
    ConversationHistory,
    ConversationMetadata,
    ConversationData,
    MessagePosition,
    MessageFilter,
    HistorySnapshot,
    ConversationStats,
    MessageEdit,
    MessageInsert
} from './types';

// 多模态工具
export {
    IMAGE_MIME_TYPES,
    AUDIO_MIME_TYPES,
    VIDEO_MIME_TYPES,
    DOCUMENT_MIME_TYPES,
    SUPPORTED_MIME_TYPES,
    isSupportedMimeType,
    getMultimediaType,
    createInlineDataPart,
    createImagePart,
    createAudioPart,
    createVideoPart,
    createDocumentPart,
    createPartFromDataUrl,
    getInlineDataSize,
    inlineDataToDataUrl,
    hasMultimediaContent,
    getPartMultimediaType
} from './multimedia';
export type {
    ImageMimeType,
    AudioMimeType,
    VideoMimeType,
    DocumentMimeType,
    SupportedMimeType,
    MultimediaType
} from './multimedia';

// 辅助工具函数
export {
    isRealUserMessage,
    ensureBackgroundTaskSourceForDisplay,
    buildMessage,
    buildUserMessage,
    buildSystemMessage,
    buildModelMessage,
    appendParts,
    prependParts,
    getMessageText,
    getTextParts,
    getMultimediaParts,
    hasMultimedia,
    hasConsecutiveSameRole,
    groupByConsecutiveRole,
    mergeConsecutiveSameRole,
    countParts,
    createTextMessage,
    createMultiTextMessage,
    cleanFunctionResponseForAPI,
    cleanContentForAPI
} from './helpers';

// 函数调用工具（支持并行调用）
export {
    createFunctionCall,
    createFunctionCallMessage,
    createParallelFunctionCalls,
    extractFunctionCalls,
    hasFunctionCalls,
    hasParallelFunctionCalls,
    getFunctionCallCount,
    hasFunctionResponses,
    extractFunctionResponses,
    createParallelFunctionResponses,
    groupFunctionCallsByName,
    analyzeFunctionCalls,
    matchFunctionCallsAndResponses
} from './functionCall';

// 函数响应工具（多模态支持 - Gemini 3 Pro+）
export {
    FUNCTION_RESPONSE_MIME_TYPES,
    createJsonRef,
    isJsonRef,
    getRefDisplayName,
    isSupportedForFunctionResponse,
    createFunctionResponse,
    createMultimodalFunctionResponse,
    createFunctionResponseWithFile,
    createFunctionResponseWithInlineData,
    createFunctionResponseWithMultipleFiles,
    validateFunctionResponseRefs,
    extractMultimediaFromFunctionResponse,
    hasFunctionResponseMultimedia
} from './functionResponse';
export type {
    JsonReference,
    FunctionResponseMimeType
} from './functionResponse';

// Token 工具
export {
    setMessageTokens,
    createMessageWithTokens,
    getTotalTokens,
    hasTokenCounts,
    calculateHistoryTokens,
    batchSetTokenCounts,
    getTokenEfficiency,
    formatTokenCount
} from './tokenUtils';

// Diff 存储管理器（用于抽离 apply_diff 的 originalContent/newContent）
export {
    DiffStorageManager,
    getDiffStorageManager
} from './DiffStorageManager';
export type {
    DiffContent,
    DiffReference
} from './DiffStorageManager';

// 用量统计与缓存（统计页聚合 + 目录监听增量失效）
export { aggregateUsageStats } from './usageStats';
export type { UsageStatsResult } from './usageStats';
export { UsageStatsCache, startUsageDirectoryWatcher } from './usageCache';

// 待审批门（pending approval gate）
export { getPendingApprovalGate, getPendingApprovalGateMismatchReason } from './pendingApprovalGate';
export type { PendingApprovalGateExpectation } from './pendingApprovalGate';