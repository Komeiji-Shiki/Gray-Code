/**
 * 对话内容的纯函数与类型：消息结构、截断与工具配对、多模态与函数调用辅助、用量统计。
 * 会话存储与历史读写由平台（apps/server、packages/core）负责，本模块不保存状态。
 */

export {
    // 消息截断与工具配对删除（主对话与 SubAgent 子对话共用同一套规则）
    truncateFrom,
    deleteLogicalMessage,
    mutateTranscript
} from './TranscriptMutation';
export type { TranscriptAdapter } from './TranscriptMutation';
export type {
    Content,
    ContentPart,
    AgentMessageCardInfo,
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

// 用量统计
export { aggregateUsageStats } from './usageStats';
export type { UsageStatsResult } from './usageStats';

// 待审批门（pending approval gate）
export { getPendingApprovalGate, getPendingApprovalGateMismatchReason } from './pendingApprovalGate';
export type { PendingApprovalGateExpectation } from './pendingApprovalGate';
