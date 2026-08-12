/**
 * GrayCode - 设置管理器（门面）
 *
 * 负责全局设置的管理、持久化和通知。
 *
 * 实现已按主题拆分（纯重构，行为零变化）：
 * - SettingsCore：共享状态（settings/storage/监听器）与基础设施（深合并、toolsConfig 读写）
 * - CheckpointSettingsService：存档点配置段
 * - PromptSettingsService：系统提示词/模式配置段
 * - ToolsSettingsService：工具启用/自动执行/工具配置/Shell/工具模式段
 * - MemorySettingsService：记忆配置段
 * - ContextSettingsService：上下文感知/诊断配置段
 * - PinnedFilesSettingsService：固定文件配置段
 * - SkillsSettingsService：Skills 配置段
 * - ImageToolsSettingsService：图像工具配置段
 * - ProxySettingsService：代理配置段
 * - SummarizeSettingsService：总结配置段
 * - TokenCountSettingsService：Token 计数配置段
 * - UISettingsService：UI 设置/公告版本段
 * - StoragePathSettingsService：存储路径配置段
 * - SubAgentsSettingsService：子代理配置段
 *
 * 本类聚合委托各服务，公共方法签名与导出保持不变。
 */

import type {
    GlobalSettings,
    SettingsChangeEvent,
    SettingsChangeListener,
    ToolsEnabledState,
    ToolAutoExecConfig,
    ProxySettings,
    ToolsConfig,
    ListFilesToolConfig,
    FindFilesToolConfig,
    ReadFileToolConfig,
    WriteFileToolConfig,
    SearchInFilesToolConfig,
    ApplyDiffToolConfig,
    DeleteFileToolConfig,
    ExecuteCommandToolConfig,
    ShellConfig,
    CheckpointConfig,
    SummarizeConfig,
    GenerateImageToolConfig,
    RemoveBackgroundToolConfig,
    CropImageToolConfig,
    ResizeImageToolConfig,
    RotateImageToolConfig,
    ContextAwarenessConfig,
    DiagnosticsConfig,
    PinnedFilesConfig,
    PinnedFileItem,
    SystemPromptConfig,
    PromptMode,
    PromptEntry,
    PromptAssemblyMode,
    PromptEntryRole,
    PromptEntryType,
    ResolvedPromptModeSnapshot,
    DynamicContextStrategy,
    StoragePathConfig,
    TokenCountConfig,
    SkillsConfig,
    SkillConfigItem,
    SubAgentsConfig,
    SubAgentConfigItem,
    HistorySearchToolConfig,
    MemoryToolConfig
} from './types';
import { DEFAULT_GLOBAL_SETTINGS } from './types';
import {
    SettingsCore,
    type SettingsStorage
} from './SettingsCore';
import { CheckpointSettingsService } from './CheckpointSettingsService';
import { PromptSettingsService } from './PromptSettingsService';
import { MemorySettingsService } from './MemorySettingsService';
import { ToolsSettingsService } from './ToolsSettingsService';
import { ContextSettingsService } from './ContextSettingsService';
import { PinnedFilesSettingsService } from './PinnedFilesSettingsService';
import { SkillsSettingsService } from './SkillsSettingsService';
import { ImageToolsSettingsService } from './ImageToolsSettingsService';
import { ProxySettingsService } from './ProxySettingsService';
import { SummarizeSettingsService } from './SummarizeSettingsService';
import { TokenCountSettingsService } from './TokenCountSettingsService';
import { UISettingsService } from './UISettingsService';
import { StoragePathSettingsService } from './StoragePathSettingsService';
import { SubAgentsSettingsService } from './SubAgentsSettingsService';

export type { SettingsStorage };

/**
 * 设置管理器
 *
 * 功能：
 * 1. 全局设置的读写
 * 2. 设置持久化
 * 3. 变更通知机制
 * 4. 工具启用/禁用管理
 */
export class SettingsManager {
    private core: SettingsCore;
    private checkpoint: CheckpointSettingsService;
    private prompt: PromptSettingsService;
    private memory: MemorySettingsService;
    private tools: ToolsSettingsService;
    private context: ContextSettingsService;
    private pinnedFiles: PinnedFilesSettingsService;
    private skills: SkillsSettingsService;
    private imageTools: ImageToolsSettingsService;
    private proxy: ProxySettingsService;
    private summarize: SummarizeSettingsService;
    private tokenCount: TokenCountSettingsService;
    private ui: UISettingsService;
    private storagePath: StoragePathSettingsService;
    private subagents: SubAgentsSettingsService;

    constructor(storage: SettingsStorage) {
        this.core = new SettingsCore(storage);
        this.checkpoint = new CheckpointSettingsService(this.core);
        this.prompt = new PromptSettingsService(this.core);
        this.memory = new MemorySettingsService(this.core);
        this.tools = new ToolsSettingsService(this.core, this.memory);
        this.context = new ContextSettingsService(this.core);
        this.pinnedFiles = new PinnedFilesSettingsService(this.core);
        this.skills = new SkillsSettingsService(this.core);
        this.imageTools = new ImageToolsSettingsService(this.core);
        this.proxy = new ProxySettingsService(this.core);
        this.summarize = new SummarizeSettingsService(this.core);
        this.tokenCount = new TokenCountSettingsService(this.core);
        this.ui = new UISettingsService(this.core);
        this.storagePath = new StoragePathSettingsService(this.core);
        this.subagents = new SubAgentsSettingsService(this.core);
    }

    /**
     * 初始化：从存储加载设置
     */
    async initialize(): Promise<void> {
        const stored = await this.core.storage.load();
        if (stored) {
            // 使用深度合并处理所有配置，确保默认值不会因用户配置部分子字段而丢失
            this.core.settings = this.core.deepMergeConfig(this.core.cloneConfig(DEFAULT_GLOBAL_SETTINGS), stored) as GlobalSettings;

            // lastUpdated 需要使用最新的或当前时间
            this.core.settings.lastUpdated = stored.lastUpdated || Date.now();

            // 显式迁移内置模式的 toolPolicy（幂等仅未定制时填充默认值）
            await this.prompt.migratePromptModeToolPolicies();

            // 一次性迁移子代理旧全局开关 forceUseCurrentChannel → 逐代理 syncWithCurrentModel（幂等）
            await this.subagents.migrateForceUseCurrentChannel();
        }
    }

    /**
     * 从存储重新加载设置并广播变更事件。
     *
     * 用于导入设置后通知 PromptManager 等缓存持有者刷新。
     * 事件形态与 updateSettings 一致，确保现有监听器能识别。
     */
    reloadAndNotify(): Promise<void> {
        return this.core.reloadAndNotify();
    }

    /**
     * 获取完整设置
     */
    getSettings(): Readonly<GlobalSettings> {
        return this.core.getSettings();
    }

    /**
     * 按需读取指定设置键（轻量快照）。
     * 转发 SettingsCore.getScalarSettings：标量直返、对象/数组走深拷贝兜底，
     * 供只读标量消费点避免 getSettings() 全树深拷贝。
     */
    getScalarSettings<K extends keyof GlobalSettings>(...keys: K[]): Readonly<Pick<GlobalSettings, K>> {
        return this.core.getScalarSettings(...keys);
    }

    /**
     * 轻量读取更新检查相关设置（checkForUpdates / updateChannel / proxy）。
     * 转发 SettingsCore.getUpdateSettings。
     */
    getUpdateSettings(): Readonly<Pick<GlobalSettings, 'checkForUpdates' | 'updateChannel' | 'proxy'>> {
        return this.core.getUpdateSettings();
    }

    /**
     * 更新设置（部分更新）
     */
    updateSettings(updates: Partial<GlobalSettings>): Promise<void> {
        return this.core.updateSettings(updates);
    }

    // ========== 工具调用配置 ==========

    /**
     * 获取单回合最大工具调用次数
     */
    getMaxToolIterations(): number {
        return this.tools.getMaxToolIterations();
    }

    /**
     * 设置单回合最大工具调用次数
     *
     * @param value 最大次数，-1 表示无限制，正整数表示具体次数
     */
    setMaxToolIterations(value: number): Promise<void> {
        return this.tools.setMaxToolIterations(value);
    }

    // ========== 渠道管理 ==========

    /**
     * 获取当前激活的渠道 ID
     */
    getActiveChannelId(): string | undefined {
        return this.tools.getActiveChannelId();
    }

    /**
     * 设置激活的渠道 ID
     */
    setActiveChannelId(channelId: string): Promise<void> {
        return this.tools.setActiveChannelId(channelId);
    }

    // ========== 工具管理 ==========

    /**
     * 获取工具启用状态
     */
    getToolsEnabled(): Readonly<ToolsEnabledState> {
        return this.tools.getToolsEnabled();
    }

    /**
     * 检查工具是否启用
     *
     * @param toolName 工具名称
     * @returns 是否启用（未配置时默认启用）
     */
    isToolEnabled(toolName: string): boolean {
        return this.tools.isToolEnabled(toolName);
    }

    /**
     * 设置工具启用状态
     *
     * @param toolName 工具名称
     * @param enabled 是否启用
     */
    setToolEnabled(toolName: string, enabled: boolean): Promise<void> {
        return this.tools.setToolEnabled(toolName, enabled);
    }

    /**
     * 批量设置工具启用状态
     *
     * @param states 工具名称到启用状态的映射
     */
    setToolsEnabled(states: ToolsEnabledState): Promise<void> {
        return this.tools.setToolsEnabled(states);
    }

    /**
     * 获取启用的工具列表
     *
     * @param allTools 所有可用工具名称
     * @returns 启用的工具名称数组
     */
    getEnabledTools(allTools: string[]): string[] {
        return this.tools.getEnabledTools(allTools);
    }

    // ========== 工具自动执行管理 ==========

    /**
     * 获取工具自动执行配置
     */
    getToolAutoExecConfig(): Readonly<ToolAutoExecConfig> {
        return this.tools.getToolAutoExecConfig();
    }

    /**
     * 检查工具是否可以自动执行（无需用户确认）
     *
     * @param toolName 工具名称
     * @returns true = 自动执行，false = 需要确认
     */
    isToolAutoExec(toolName: string): boolean {
        return this.tools.isToolAutoExec(toolName);
    }

    /**
     * 设置工具是否可以自动执行
     *
     * @param toolName 工具名称
     * @param autoExec true = 自动执行，false = 需要确认
     */
    setToolAutoExec(toolName: string, autoExec: boolean): Promise<void> {
        return this.tools.setToolAutoExec(toolName, autoExec);
    }

    /**
     * 批量设置工具自动执行配置
     */
    setToolAutoExecConfig(config: ToolAutoExecConfig): Promise<void> {
        return this.tools.setToolAutoExecConfig(config);
    }

    /**
     * 获取需要确认的工具列表
     *
     * @param allTools 所有可用工具名称
     * @returns 需要确认的工具名称数组
     */
    getToolsRequiringConfirmation(allTools: string[]): string[] {
        return this.tools.getToolsRequiringConfirmation(allTools);
    }

    // ========== 工具配置管理 ==========

    /**
     * 获取工具配置
     */
    getToolsConfig(): Readonly<ToolsConfig> {
        return this.tools.getToolsConfig();
    }

    /**
     * 获取 read_file 工具配置
     */
    getReadFileConfig(): Readonly<ReadFileToolConfig> {
        return this.tools.getReadFileConfig();
    }

    /**
     * 获取 write_file 工具配置
     */
    getWriteFileConfig(): Readonly<WriteFileToolConfig> {
        return this.tools.getWriteFileConfig();
    }

    /**
     * 获取 list_files 工具配置
     */
    getListFilesConfig(): Readonly<ListFilesToolConfig> {
        return this.tools.getListFilesConfig();
    }

    /**
     * 更新 list_files 工具配置
     */
    updateListFilesConfig(config: Partial<ListFilesToolConfig>): Promise<void> {
        return this.tools.updateListFilesConfig(config);
    }

    /**
     * 获取 find_files 工具配置
     */
    getFindFilesConfig(): Readonly<FindFilesToolConfig> {
        return this.tools.getFindFilesConfig();
    }

    /**
     * 更新 find_files 工具配置
     */
    updateFindFilesConfig(config: Partial<FindFilesToolConfig>): Promise<void> {
        return this.tools.updateFindFilesConfig(config);
    }

    /**
     * 获取 search_in_files 工具配置
     */
    getSearchInFilesConfig(): Readonly<SearchInFilesToolConfig> {
        return this.tools.getSearchInFilesConfig();
    }

    /**
     * 更新 search_in_files 工具配置
     */
    updateSearchInFilesConfig(config: Partial<SearchInFilesToolConfig>): Promise<void> {
        return this.tools.updateSearchInFilesConfig(config);
    }

    /**
     * 更新工具配置
     */
    updateToolConfig(toolName: string, config: Record<string, unknown>): Promise<void> {
        return this.tools.updateToolConfig(toolName, config);
    }

    /**
     * 获取 apply_diff 工具配置
     */
    getApplyDiffConfig(): Readonly<ApplyDiffToolConfig> {
        return this.tools.getApplyDiffConfig();
    }

    /**
     * 更新 apply_diff 工具配置
     */
    updateApplyDiffConfig(config: Partial<ApplyDiffToolConfig>): Promise<void> {
        return this.tools.updateApplyDiffConfig(config);
    }

    /**
     * 获取 history_search 工具配置
     */
    getHistorySearchConfig(): Readonly<HistorySearchToolConfig> {
        return this.tools.getHistorySearchConfig();
    }

    /**
     * 更新 history_search 工具配置
     */
    updateHistorySearchConfig(config: Partial<HistorySearchToolConfig>): Promise<void> {
        return this.tools.updateHistorySearchConfig(config);
    }

    /**
     * 获取 delete_file 工具配置
     */
    getDeleteFileConfig(): Readonly<DeleteFileToolConfig> {
        return this.tools.getDeleteFileConfig();
    }

    /**
     * 更新 delete_file 工具配置
     */
    updateDeleteFileConfig(config: Partial<DeleteFileToolConfig>): Promise<void> {
        return this.tools.updateDeleteFileConfig(config);
    }

    /**
     * 获取 execute_command 工具配置
     */
    getExecuteCommandConfig(): Readonly<ExecuteCommandToolConfig> {
        return this.tools.getExecuteCommandConfig();
    }

    /**
     * 更新 execute_command 工具配置
     */
    updateExecuteCommandConfig(config: Partial<ExecuteCommandToolConfig>): Promise<void> {
        return this.tools.updateExecuteCommandConfig(config);
    }

    /**
     * 获取启用的 Shell 列表
     */
    getEnabledShells(): ShellConfig[] {
        return this.tools.getEnabledShells();
    }

    /**
     * 获取默认 Shell 类型
     */
    getDefaultShell(): string {
        return this.tools.getDefaultShell();
    }

    /**
     * 设置默认 Shell
     */
    setDefaultShell(shellType: string): Promise<void> {
        return this.tools.setDefaultShell(shellType);
    }

    /**
     * 更新 Shell 配置
     */
    updateShellConfig(shellType: string, updates: Partial<ShellConfig>): Promise<void> {
        return this.tools.updateShellConfig(shellType, updates);
    }

    /**
     * 启用/禁用 Shell
     */
    setShellEnabled(shellType: string, enabled: boolean): Promise<void> {
        return this.tools.setShellEnabled(shellType, enabled);
    }

    // ========== 存档点配置管理 ==========

    /**
     * 获取存档点配置
     */
    getCheckpointConfig(): Readonly<CheckpointConfig> {
        return this.checkpoint.getCheckpointConfig();
    }

    /**
     * 更新存档点配置
     *
     * EX-12/L-4：保存前校验排除配置，拒绝危险/无意义的自定义排除规则
     * （空模式、绝对路径、纯 `!`、`..` 越界、换行注入），以及未知默认类别 id、
     * 非有限数值的单文件大小上限。
     */
    updateCheckpointConfig(config: Partial<CheckpointConfig>): Promise<void> {
        return this.checkpoint.updateCheckpointConfig(config);
    }

    /**
     * 检查工具是否需要在执行前创建备份
     */
    shouldCreateBeforeCheckpoint(toolName: string): boolean {
        return this.checkpoint.shouldCreateBeforeCheckpoint(toolName);
    }

    /**
     * 检查工具是否需要在执行后创建备份
     */
    shouldCreateAfterCheckpoint(toolName: string): boolean {
        return this.checkpoint.shouldCreateAfterCheckpoint(toolName);
    }

    /**
     * 启用/禁用存档点功能
     */
    setCheckpointEnabled(enabled: boolean): Promise<void> {
        return this.checkpoint.setCheckpointEnabled(enabled);
    }

    /**
     * 设置工具的备份阶段
     */
    setToolCheckpointPhase(toolName: string, before: boolean, after: boolean): Promise<void> {
        return this.checkpoint.setToolCheckpointPhase(toolName, before, after);
    }

    /**
     * 检查是否需要在用户消息前创建存档点
     */
    shouldCreateBeforeUserMessageCheckpoint(): boolean {
        return this.checkpoint.shouldCreateBeforeUserMessageCheckpoint();
    }

    /**
     * 检查是否需要在用户消息后创建存档点
     */
    shouldCreateAfterUserMessageCheckpoint(): boolean {
        return this.checkpoint.shouldCreateAfterUserMessageCheckpoint();
    }

    /**
     * 检查是否需要在模型消息前创建存档点
     */
    shouldCreateBeforeModelMessageCheckpoint(): boolean {
        return this.checkpoint.shouldCreateBeforeModelMessageCheckpoint();
    }

    /**
     * 检查是否需要在模型消息后创建存档点（不包含工具调用的纯文本回复）
     */
    shouldCreateAfterModelMessageCheckpoint(): boolean {
        return this.checkpoint.shouldCreateAfterModelMessageCheckpoint();
    }

    /**
     * 检查是否只在最外层创建模型消息存档点
     *
     * 当返回 true 时，连续工具调用时只在第一次和最后一次创建存档点
     * 当返回 false 时，每次迭代都创建存档点
     */
    isModelOuterLayerOnly(): boolean {
        return this.checkpoint.isModelOuterLayerOnly();
    }

    // ========== 工具模式管理 ==========

    /**
     * 获取默认工具模式
     */
    getDefaultToolMode(): 'function_call' | 'xml' | 'json' {
        return this.tools.getDefaultToolMode();
    }

    /**
     * 设置默认工具模式
     */
    setDefaultToolMode(mode: 'function_call' | 'xml' | 'json'): Promise<void> {
        return this.tools.setDefaultToolMode(mode);
    }

    // ========== 代理设置管理 ==========

    /**
     * 获取代理设置
     */
    getProxySettings(): Readonly<ProxySettings> {
        return this.proxy.getProxySettings();
    }

    /**
     * 获取有效的代理 URL
     *
     * 仅当代理启用且 URL 有效时返回代理地址
     * @returns 代理 URL 或 undefined
     */
    getEffectiveProxyUrl(): string | undefined {
        return this.proxy.getEffectiveProxyUrl();
    }

    /**
     * 是否跳过代理 TLS 证书校验（仅用于自签名证书调试）
     *
     * 默认 false：校验证书；只有用户显式开启时才跳过。
     */
    getProxyInsecureSkipVerify(): boolean {
        return this.proxy.getProxyInsecureSkipVerify();
    }

    /**
     * 更新代理设置
     */
    updateProxySettings(proxySettings: Partial<ProxySettings>): Promise<void> {
        return this.proxy.updateProxySettings(proxySettings);
    }

    /**
     * 设置代理启用状态
     */
    setProxyEnabled(enabled: boolean): Promise<void> {
        return this.proxy.setProxyEnabled(enabled);
    }

    /**
     * 设置代理 URL
     */
    setProxyUrl(url: string | undefined): Promise<void> {
        return this.proxy.setProxyUrl(url);
    }

    // ========== 总结配置管理 ==========

    /**
     * 获取总结配置
     */
    getSummarizeConfig(): Readonly<SummarizeConfig> {
        return this.summarize.getSummarizeConfig();
    }

    /**
     * 更新总结配置
     */
    updateSummarizeConfig(config: Partial<SummarizeConfig>): Promise<void> {
        return this.summarize.updateSummarizeConfig(config);
    }

    // ========== 记忆配置管理 ==========

    /**
     * 长期记忆总开关。
     */
    isMemoryEnabled(): boolean {
        return this.memory.isMemoryEnabled();
    }

    /**
     * 获取记忆工具配置
     */
    getMemoryConfig(): Readonly<MemoryToolConfig> {
        return this.memory.getMemoryConfig();
    }

    /**
     * 更新记忆工具配置
     */
    updateMemoryConfig(config: Partial<MemoryToolConfig>): Promise<void> {
        return this.memory.updateMemoryConfig(config);
    }

    // ========== 图像生成配置管理 ==========

    /**
     * 获取图像生成工具配置
     */
    getGenerateImageConfig(): Readonly<GenerateImageToolConfig> {
        return this.imageTools.getGenerateImageConfig();
    }

    /**
     * 更新图像生成工具配置
     */
    updateGenerateImageConfig(config: Partial<GenerateImageToolConfig>): Promise<void> {
        return this.imageTools.updateGenerateImageConfig(config);
    }

    // ========== 抠图工具配置管理 ==========

    /**
     * 获取抠图工具配置
     */
    getRemoveBackgroundConfig(): Readonly<RemoveBackgroundToolConfig> {
        return this.imageTools.getRemoveBackgroundConfig();
    }

    /**
     * 更新抠图工具配置
     */
    updateRemoveBackgroundConfig(config: Partial<RemoveBackgroundToolConfig>): Promise<void> {
        return this.imageTools.updateRemoveBackgroundConfig(config);
    }

    // ========== 裁切图片工具配置管理 ==========

    /**
     * 获取裁切图片工具配置
     */
    getCropImageConfig(): Readonly<CropImageToolConfig> {
        return this.imageTools.getCropImageConfig();
    }

    /**
     * 更新裁切图片工具配置
     */
    updateCropImageConfig(config: Partial<CropImageToolConfig>): Promise<void> {
        return this.imageTools.updateCropImageConfig(config);
    }

    // ========== 缩放图片工具配置管理 ==========

    /**
     * 获取缩放图片工具配置
     */
    getResizeImageConfig(): Readonly<ResizeImageToolConfig> {
        return this.imageTools.getResizeImageConfig();
    }

    /**
     * 更新缩放图片工具配置
     */
    updateResizeImageConfig(config: Partial<ResizeImageToolConfig>): Promise<void> {
        return this.imageTools.updateResizeImageConfig(config);
    }

    // ========== 旋转图片工具配置管理 ==========

    /**
     * 获取旋转图片工具配置
     */
    getRotateImageConfig(): Readonly<RotateImageToolConfig> {
        return this.imageTools.getRotateImageConfig();
    }

    /**
     * 更新旋转图片工具配置
     */
    updateRotateImageConfig(config: Partial<RotateImageToolConfig>): Promise<void> {
        return this.imageTools.updateRotateImageConfig(config);
    }

    // ========== 上下文感知配置管理 ==========

    /**
     * 获取上下文感知配置
     */
    getContextAwarenessConfig(): Readonly<ContextAwarenessConfig> {
        return this.context.getContextAwarenessConfig();
    }

    /**
     * 更新上下文感知配置
     */
    updateContextAwarenessConfig(config: Partial<ContextAwarenessConfig>): Promise<void> {
        return this.context.updateContextAwarenessConfig(config);
    }

    /**
     * 检查是否应该包含工作区文件树
     */
    shouldIncludeWorkspaceFiles(): boolean {
        return this.context.shouldIncludeWorkspaceFiles();
    }

    /**
     * 获取文件树最大深度
     * @returns 最大深度，-1 表示无限制
     */
    getMaxFileDepth(): number {
        return this.context.getMaxFileDepth();
    }

    /**
     * 检查是否应该包含打开的标签页
     */
    shouldIncludeOpenTabs(): boolean {
        return this.context.shouldIncludeOpenTabs();
    }

    /**
     * 获取打开标签页最大数量
     * @returns 最大数量，-1 表示无限制
     */
    getMaxOpenTabs(): number {
        return this.context.getMaxOpenTabs();
    }

    /**
     * 检查是否应该包含当前活动编辑器路径
     */
    shouldIncludeActiveEditor(): boolean {
        return this.context.shouldIncludeActiveEditor();
    }

    /**
     * 获取自定义忽略模式
     */
    getContextIgnorePatterns(): string[] {
        return this.context.getContextIgnorePatterns();
    }

    // ========== 诊断信息配置管理 ==========

    /**
     * 获取诊断信息配置
     */
    getDiagnosticsConfig(): Readonly<DiagnosticsConfig> {
        return this.context.getDiagnosticsConfig();
    }

    /**
     * 更新诊断信息配置
     */
    updateDiagnosticsConfig(config: Partial<DiagnosticsConfig>): Promise<void> {
        return this.context.updateDiagnosticsConfig(config);
    }

    /**
     * 检查诊断功能是否启用
     */
    isDiagnosticsEnabled(): boolean {
        return this.context.isDiagnosticsEnabled();
    }

    /**
     * 设置诊断功能启用状态
     */
    setDiagnosticsEnabled(enabled: boolean): Promise<void> {
        return this.context.setDiagnosticsEnabled(enabled);
    }

    /**
     * 获取包含的诊断严重程度级别
     */
    getDiagnosticsSeverities(): string[] {
        return this.context.getDiagnosticsSeverities();
    }

    /**
     * 设置包含的诊断严重程度级别
     */
    setDiagnosticsSeverities(severities: ('error' | 'warning' | 'information' | 'hint')[]): Promise<void> {
        return this.context.setDiagnosticsSeverities(severities);
    }

    // ========== 固定文件配置管理 ==========

    /**
     * 获取固定文件配置
     */
    getPinnedFilesConfig(): Readonly<PinnedFilesConfig> {
        return this.pinnedFiles.getPinnedFilesConfig();
    }

    /**
     * 更新固定文件配置
     */
    updatePinnedFilesConfig(config: Partial<PinnedFilesConfig>): Promise<void> {
        return this.pinnedFiles.updatePinnedFilesConfig(config);
    }

    /**
     * 获取固定文件列表
     */
    getPinnedFiles(): PinnedFileItem[] {
        return this.pinnedFiles.getPinnedFiles();
    }

    /**
     * 获取启用的固定文件列表
     */
    getEnabledPinnedFiles(): PinnedFileItem[] {
        return this.pinnedFiles.getEnabledPinnedFiles();
    }

    /**
     * 添加固定文件
     * @param path 文件路径（相对于工作区）
     * @param workspaceUri 工作区 URI
     * @returns 新添加的文件项
     */
    addPinnedFile(path: string, workspaceUri: string): Promise<PinnedFileItem> {
        return this.pinnedFiles.addPinnedFile(path, workspaceUri);
    }

    /**
     * 获取当前工作区的固定文件列表
     * @param workspaceUri 当前工作区 URI
     */
    getPinnedFilesForWorkspace(workspaceUri: string): PinnedFileItem[] {
        return this.pinnedFiles.getPinnedFilesForWorkspace(workspaceUri);
    }

    /**
     * 获取当前工作区启用的固定文件列表
     * @param workspaceUri 当前工作区 URI
     */
    getEnabledPinnedFilesForWorkspace(workspaceUri: string): PinnedFileItem[] {
        return this.pinnedFiles.getEnabledPinnedFilesForWorkspace(workspaceUri);
    }

    /**
     * 移除固定文件
     * @param id 文件 ID
     */
    removePinnedFile(id: string): Promise<void> {
        return this.pinnedFiles.removePinnedFile(id);
    }

    /**
     * 切换固定文件的启用状态
     * @param id 文件 ID
     * @param enabled 是否启用
     */
    setPinnedFileEnabled(id: string, enabled: boolean): Promise<void> {
        return this.pinnedFiles.setPinnedFileEnabled(id, enabled);
    }

    /**
     * 更新固定文件路径
     * @param id 文件 ID
     * @param newPath 新路径
     */
    updatePinnedFilePath(id: string, newPath: string): Promise<void> {
        return this.pinnedFiles.updatePinnedFilePath(id, newPath);
    }

    /**
     * 清空所有固定文件
     */
    clearPinnedFiles(): Promise<void> {
        return this.pinnedFiles.clearPinnedFiles();
    }

    /**
     * 检查文件是否已固定
     * @param path 文件路径
     */
    isFilePinned(path: string): boolean {
        return this.pinnedFiles.isFilePinned(path);
    }

    /**
     * 获取固定文件段落标题
     */
    getPinnedFilesSectionTitle(): string {
        return this.pinnedFiles.getPinnedFilesSectionTitle();
    }

    // ========== Skills 配置管理 ==========

    /**
     * 获取 Skills 配置
     */
    getSkillsConfig(): Readonly<SkillsConfig> {
        return this.skills.getSkillsConfig();
    }

    /**
     * 更新 Skills 配置
     */
    updateSkillsConfig(config: Partial<SkillsConfig>): Promise<void> {
        return this.skills.updateSkillsConfig(config);
    }

    /**
     * 获取 Skills 列表
     */
    getSkills(): SkillConfigItem[] {
        return this.skills.getSkills();
    }

    /**
     * 设置 Skill 启用状态
     */
    setSkillEnabled(id: string, enabled: boolean, metadata?: { name?: string, description?: string }): Promise<void> {
        return this.skills.setSkillEnabled(id, enabled, metadata);
    }

    /**
     * 移除 Skill 配置
     */
    removeSkillConfig(id: string): Promise<void> {
        return this.skills.removeSkillConfig(id);
    }

    /**
     * 获取启用的 Skills
     */
    getEnabledSkills(): SkillConfigItem[] {
        return this.skills.getEnabledSkills();
    }

    // ========== 系统提示词配置管理 ==========

    /**
     * 获取系统提示词配置
     *
     * 版本迁移：
     * - 老版本：没有 modes 字段 -> 迁移为代码模式 + 设计模式 + 计划模式 + 询问模式 + 审查模式
     * - 新版本：已有 modes 但缺少内置模式 -> 补齐缺失的内置模式（design/plan/ask/review）
     */
    getSystemPromptConfig(): Readonly<SystemPromptConfig> {
        return this.prompt.getSystemPromptConfig();
    }

    /**
     * 解析本次请求应使用的动态上下文策略
     */
    resolveDynamicContextStrategy(
        modeSnapshot?: ResolvedPromptModeSnapshot,
        override?: DynamicContextStrategy
    ): DynamicContextStrategy {
        return this.prompt.resolveDynamicContextStrategy(modeSnapshot, override);
    }

    /**
     * 更新系统提示词配置
     */
    updateSystemPromptConfig(config: Partial<SystemPromptConfig>): Promise<void> {
        return this.prompt.updateSystemPromptConfig(config);
    }

    /**
     * 获取默认提示词模式 ID
     */
    getDefaultPromptModeId(): string {
        return this.prompt.getDefaultPromptModeId();
    }

    /**
     * 获取默认提示词模式
     */
    getDefaultPromptMode(): PromptMode | null {
        return this.prompt.getDefaultPromptMode();
    }

    /**
     * 解析提示词模式快照
     *
     * 优先使用传入的 modeId；如果未提供或无效，则回退到设置中的默认模式。
     */
    resolvePromptMode(modeId?: string): ResolvedPromptModeSnapshot {
        return this.prompt.resolvePromptMode(modeId);
    }

    /**
     * 获取当前激活的模式 ID（向后兼容，语义等同于默认模式 ID）
     */
    getCurrentPromptModeId(): string {
        return this.prompt.getCurrentPromptModeId();
    }

    /**
     * 获取当前激活的模式（向后兼容，语义等同于默认模式）
     */
    getCurrentPromptMode(): PromptMode | null {
        return this.prompt.getCurrentPromptMode();
    }

    /**
     * 获取所有模式
     */
    getAllPromptModes(): PromptMode[] {
        return this.prompt.getAllPromptModes();
    }

    /**
     * 设置默认提示词模式
     */
    setCurrentPromptMode(modeId: string): Promise<void> {
        return this.prompt.setCurrentPromptMode(modeId);
    }

    /**
     * 添加或更新模式
     */
    savePromptMode(mode: PromptMode): Promise<void> {
        return this.prompt.savePromptMode(mode);
    }

    /**
     * 重命名提示词模式。
     *
     * 只更新模式显示名，不用前端传回的整份模式快照覆盖已保存配置，避免新建模式
     * 在编辑过程中重命名时把模板、条目或工具策略回滚成旧值。
     */
    renamePromptMode(modeId: string, name: string): Promise<PromptMode> {
        return this.prompt.renamePromptMode(modeId, name);
    }

    /**
     * 删除模式
     */
    deletePromptMode(modeId: string): Promise<void> {
        return this.prompt.deletePromptMode(modeId);
    }

    /**
     * 获取系统提示词模板（根据当前模式）
     */
    getSystemPromptTemplate(): string {
        return this.prompt.getSystemPromptTemplate();
    }

    /**
     * 获取动态上下文模板（根据当前模式）
     */
    getDynamicContextTemplate(): string {
        return this.prompt.getDynamicContextTemplate();
    }

    /**
     * 检查动态上下文是否启用（根据当前模式）
     */
    isDynamicTemplateEnabled(): boolean {
        return this.prompt.isDynamicTemplateEnabled();
    }

    /**
     * 获取自定义前缀
     */
    getSystemPromptPrefix(): string {
        return this.prompt.getSystemPromptPrefix();
    }

    /**
     * 获取自定义后缀
     */
    getSystemPromptSuffix(): string {
        return this.prompt.getSystemPromptSuffix();
    }

    // ========== Token 计数配置管理 ==========

    /**
     * 获取 Token 计数配置
     */
    getTokenCountConfig(): Readonly<TokenCountConfig> {
        return this.tokenCount.getTokenCountConfig();
    }

    /**
     * 更新 Token 计数配置
     */
    updateTokenCountConfig(config: Partial<TokenCountConfig>): Promise<void> {
        return this.tokenCount.updateTokenCountConfig(config);
    }

    /**
     * 检查指定渠道的 Token 计数是否已启用
     *
     * @param channelType 渠道类型 (gemini, openai, anthropic, openai-responses)
     * @returns 是否启用
     */
    isTokenCountEnabled(channelType: 'gemini' | 'openai' | 'anthropic' | 'openai-responses'): boolean {
        return this.tokenCount.isTokenCountEnabled(channelType);
    }

    // ========== UI 设置管理 ==========

    /**
     * 获取 UI 设置
     */
    getUISettings() {
        return this.ui.getUISettings();
    }

    /**
     * 更新 UI 设置
     */
    updateUISettings(uiSettings: Partial<NonNullable<GlobalSettings['ui']>>): Promise<void> {
        return this.ui.updateUISettings(uiSettings);
    }

    // ========== 公告版本管理 ==========

    /**
     * 获取用户上次查看的公告版本
     */
    getLastReadAnnouncementVersion(): string | undefined {
        return this.ui.getLastReadAnnouncementVersion();
    }

    /**
     * 设置用户上次查看的公告版本
     */
    setLastReadAnnouncementVersion(version: string): Promise<void> {
        return this.ui.setLastReadAnnouncementVersion(version);
    }

    // ========== 事件监听 ==========

    /**
     * 添加设置变更监听器
     */
    addChangeListener(listener: SettingsChangeListener): void {
        this.core.addChangeListener(listener);
    }

    /**
     * 移除设置变更监听器
     */
    removeChangeListener(listener: SettingsChangeListener): void {
        this.core.removeChangeListener(listener);
    }

    // ========== 存储路径管理 ==========

    /**
     * 获取存储路径配置
     */
    getStoragePathConfig(): Readonly<StoragePathConfig> {
        return this.storagePath.getStoragePathConfig();
    }

    /**
     * 获取自定义数据存储路径
     * 如果未设置返回 undefined
     */
    getCustomDataPath(): string | undefined {
        return this.storagePath.getCustomDataPath();
    }

    /**
     * 更新存储路径配置
     */
    updateStoragePathConfig(config: Partial<StoragePathConfig>): Promise<void> {
        return this.storagePath.updateStoragePathConfig(config);
    }

    /**
     * 设置自定义数据存储路径
     * 设置后需要迁移数据
     */
    setCustomDataPath(path: string | undefined): Promise<void> {
        return this.storagePath.setCustomDataPath(path);
    }

    /**
     * 标记迁移开始
     */
    markMigrationStarted(): Promise<void> {
        return this.storagePath.markMigrationStarted();
    }

    /**
     * 标记迁移完成
     */
    markMigrationCompleted(): Promise<void> {
        return this.storagePath.markMigrationCompleted();
    }

    /**
     * 标记迁移失败
     */
    markMigrationFailed(error: string): Promise<void> {
        return this.storagePath.markMigrationFailed(error);
    }

    // ========== 工具方法 ==========

    /**
     * 重置为默认设置
     */
    reset(): Promise<void> {
        return this.core.reset();
    }

    // ========== 子代理管理 ==========

    /**
     * 获取子代理配置
     */
    getSubAgentsConfig(): SubAgentsConfig {
        return this.subagents.getSubAgentsConfig();
    }

    /**
     * 获取所有子代理
     */
    getSubAgents(): SubAgentConfigItem[] {
        return this.subagents.getSubAgents();
    }

    /**
     * 获取单个子代理
     */
    getSubAgent(type: string): SubAgentConfigItem | undefined {
        return this.subagents.getSubAgent(type);
    }

    /**
     * 添加子代理
     */
    addSubAgent(agent: SubAgentConfigItem): Promise<void> {
        return this.subagents.addSubAgent(agent);
    }

    /**
     * 更新子代理
     */
    updateSubAgent(type: string, updates: Partial<SubAgentConfigItem>): Promise<boolean> {
        return this.subagents.updateSubAgent(type, updates);
    }

    /**
     * 删除子代理
     */
    deleteSubAgent(type: string): Promise<boolean> {
        return this.subagents.deleteSubAgent(type);
    }

    /**
     * 更新子代理配置
     */
    updateSubAgentsConfig(config: Partial<SubAgentsConfig>): Promise<void> {
        return this.subagents.updateSubAgentsConfig(config);
    }
}

