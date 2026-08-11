/**
 * LimCode Backend - 后端模块入口
 */

// 核心公共件：业务代码仍可按需直连相对路径，此处提供统一导出入口（避免命名冲突，未做 export *）
export { Logger, LogLevel } from './core/logger';
export {
    initializeProductMetadata,
    getProductMetadata,
    getProductVersion,
    createGrayCodeMcpClientInfo
} from './core/productMetadata';
export type { ProductMetadata } from './core/productMetadata';
export {
    setChatInputFocused,
    addChatFocusRestoreNotifier,
    shouldRestoreChatInputFocus,
    restoreChatInputFocus
} from './core/chatFocusGuard';
export {
    FileWriteLockManager,
    fileWriteLockManager,
    normalizeLockPath,
    resolveLockPath,
    getWritePathsForCall
} from './core/fileWriteLockManager';
export type {
    LockHolder,
    LockConflict,
    TryAcquireResult
} from './core/fileWriteLockManager';
export {
    setGlobalSettingsManager,
    getGlobalSettingsManager,
    setGlobalConfigManager,
    getGlobalConfigManager,
    setGlobalChannelManager,
    getGlobalChannelManager,
    setGlobalToolRegistry,
    getGlobalToolRegistry,
    setGlobalDiffStorageManager,
    getGlobalDiffStorageManager,
    setGlobalMcpManager,
    getGlobalMcpManager,
    getGlobalContext,
    initGlobalContext,
    clearGlobalContext
} from './core/settingsContext';
export type { GlobalContext } from './core/settingsContext';
export type {
    ConversationRunScope,
    SubAgentRunScope,
    RunScope,
    RunControllerStatus,
    RunControllerCapabilities,
    RunControllerSnapshot,
    IRunController
} from './core/RunController';

// 对话管理模块
export {
    ConversationManager,
    VSCodeStorageAdapter,
    FileSystemStorageAdapter
} from './modules/conversation';
export type {
    IStorageAdapter,
    Content,
    ContentPart,
    ConversationHistory,
    ConversationMetadata,
    ConversationData,
    MessagePosition,
    MessageFilter,
    HistorySnapshot,
    ConversationStats,
    MessageEdit,
    MessageInsert,
    ImageMimeType,
    AudioMimeType,
    VideoMimeType,
    DocumentMimeType,
    SupportedMimeType,
    MultimediaType,
    JsonReference,
    FunctionResponseMimeType
} from './modules/conversation';

// 配置管理模块
export {
    ConfigManager,
    MementoStorageAdapter,
    HybridStorageAdapter
} from './modules/config';
export type {
    ConfigStorageAdapter,
    ChannelType,
    BaseChannelConfig,
    GeminiConfig,
    OpenAIConfig,
    AnthropicConfig,
    ChannelConfig,
    CreateConfigInput,
    UpdateConfigInput,
    ConfigStats,
    ValidationResult,
    ExportOptions,
    ImportOptions,
    ConfigFilter,
    ConfigSortOptions
} from './modules/config';

// 渠道管理模块
export * from './modules/channel';

// MCP模块
export * from './modules/mcp';

// API模块
export * from './modules/api';