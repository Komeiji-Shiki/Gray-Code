/**
 * LimCode - 设置模块
 *
 * 导出设置相关的所有接口和实现
 */

export { SettingsManager } from './SettingsManager';
export type { SettingsStorage } from './SettingsManager';
export { FileSettingsStorage, MemorySettingsStorage } from './storage';
export { VSCodeSettingsStorage } from './VSCodeSettingsStorage';
export { StoragePathManager } from './StoragePathManager';
export { SettingsExporter } from './SettingsExporter';
export type { SettingsExportData, SkillExportData, ImportResult } from './SettingsExporter';
export type {
    GlobalSettings,
    ToolsEnabledState,
    SettingsChangeEvent,
    SettingsChangeListener,
    ProxySettings,
    ToolsConfig,
    ListFilesToolConfig,
    ApplyDiffToolConfig,
    ReadFileToolConfig,
    WriteFileToolConfig,
    OutsideWorkspaceReadAccess,
    OutsideWorkspaceWriteAccess,
    ExecuteCommandToolConfig,
    ShellConfig,
    StoragePathConfig,
    StorageStats,
    SandboxToolConfig,
    SandboxLanguage
} from './types';
export {
    DEFAULT_GLOBAL_SETTINGS,
    DEFAULT_READ_FILE_CONFIG,
    DEFAULT_WRITE_FILE_CONFIG,
    DEFAULT_LIST_FILES_CONFIG,
    DEFAULT_APPLY_DIFF_CONFIG,
    getDefaultExecuteCommandConfig,
    getDefaultSandboxConfig,
    SANDBOX_LANGUAGES,
    MACHINE_SCOPE_KEYS
} from './types';
export { BUILTIN_MODE_TOOL_POLICIES } from './promptModes';

// 摘要设置类型与默认值
export {
    DEFAULT_KEEP_RECENT_TOKENS,
    DEFAULT_MAX_AUTO_SUMMARIZE_ATTEMPTS_PER_TURN,
    DEFAULT_SUMMARIZE_MAX_INPUT_RATIO,
    clampMaxAutoSummarizeAttempts,
    clampSummarizeMaxInputRatio,
    DEFAULT_SUMMARIZE_CONFIG
} from './summarizeTypes';
export type { SummarizeConfig } from './summarizeTypes';

// 检查点设置类型与默认值
export {
    DEFAULT_MESSAGE_CHECKPOINT_CONFIG,
    DEFAULT_CHECKPOINT_CONFIG
} from './checkpointTypes';
export type {
    MessageCheckpointConfig,
    CheckpointConfig
} from './checkpointTypes';

// 模式工具策略
export {
    isPlanPathAllowed,
    isDesignPathAllowed,
    isReviewPathAllowed,
    isProgressPathAllowed,
    GENERAL_FILE_WRITE_TOOLS,
    isSearchInFilesReplaceForbidden
} from './modeToolsPolicy';

// 聚合类型重导出（与 settings/types.ts 聚合入口保持一致，覆盖 PinnedFileItem、
// SkillConfigItem、SubAgentConfigItem、PromptEntry、ResolvedPromptModeSnapshot、
// DynamicContextStrategy、TokenCountChannelConfig/TokenCountConfig 等子域类型）
export * from './types';