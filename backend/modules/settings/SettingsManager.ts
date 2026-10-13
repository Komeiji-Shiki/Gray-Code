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
    ResolvedPromptModeSnapshot,
    DynamicContextStrategy,
    StoragePathConfig,
    TokenCountConfig,
    SkillsConfig,
    SkillConfigItem,
    SubAgentsConfig,
    SubAgentConfigItem,
    SubAgentConfigUpdate,
    HistorySearchToolConfig,
    MemoryToolConfig,
} from './types';
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

    async initialize(): Promise<void> {
        if (await this.core.initialize()) {
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

    updateSettings(updates: Partial<GlobalSettings>): Promise<void> {
        return this.core.updateSettings(updates);
    }

    // ========== 工具调用配置 ==========

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

    getActiveChannelId(): string | undefined {
        return this.tools.getActiveChannelId();
    }

    setActiveChannelId(channelId: string): Promise<void> {
        return this.tools.setActiveChannelId(channelId);
    }

    // ========== 工具管理 ==========

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

    resetToolAutoExec(toolName: string): Promise<void> {
        return this.tools.resetToolAutoExec(toolName);
    }

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

    getToolsConfig(): Readonly<ToolsConfig> {
        return this.tools.getToolsConfig();
    }

    getReadFileConfig(): Readonly<ReadFileToolConfig> {
        return this.tools.getReadFileConfig();
    }

    getWriteFileConfig(): Readonly<WriteFileToolConfig> {
        return this.tools.getWriteFileConfig();
    }

    getListFilesConfig(): Readonly<ListFilesToolConfig> {
        return this.tools.getListFilesConfig();
    }

    updateListFilesConfig(config: Partial<ListFilesToolConfig>): Promise<void> {
        return this.tools.updateListFilesConfig(config);
    }

    getFindFilesConfig(): Readonly<FindFilesToolConfig> {
        return this.tools.getFindFilesConfig();
    }

    updateFindFilesConfig(config: Partial<FindFilesToolConfig>): Promise<void> {
        return this.tools.updateFindFilesConfig(config);
    }

    getSearchInFilesConfig(): Readonly<SearchInFilesToolConfig> {
        return this.tools.getSearchInFilesConfig();
    }

    updateSearchInFilesConfig(config: Partial<SearchInFilesToolConfig>): Promise<void> {
        return this.tools.updateSearchInFilesConfig(config);
    }

    updateToolConfig(toolName: string, config: Record<string, unknown>): Promise<void> {
        return this.tools.updateToolConfig(toolName, config);
    }

    getApplyDiffConfig(): Readonly<ApplyDiffToolConfig> {
        return this.tools.getApplyDiffConfig();
    }

    updateApplyDiffConfig(config: Partial<ApplyDiffToolConfig>): Promise<void> {
        return this.tools.updateApplyDiffConfig(config);
    }

    getHistorySearchConfig(): Readonly<HistorySearchToolConfig> {
        return this.tools.getHistorySearchConfig();
    }

    updateHistorySearchConfig(config: Partial<HistorySearchToolConfig>): Promise<void> {
        return this.tools.updateHistorySearchConfig(config);
    }

    getDeleteFileConfig(): Readonly<DeleteFileToolConfig> {
        return this.tools.getDeleteFileConfig();
    }

    updateDeleteFileConfig(config: Partial<DeleteFileToolConfig>): Promise<void> {
        return this.tools.updateDeleteFileConfig(config);
    }

    getExecuteCommandConfig(): Readonly<ExecuteCommandToolConfig> {
        return this.tools.getExecuteCommandConfig();
    }

    updateExecuteCommandConfig(config: Partial<ExecuteCommandToolConfig>): Promise<void> {
        return this.tools.updateExecuteCommandConfig(config);
    }

    getEnabledShells(): ShellConfig[] {
        return this.tools.getEnabledShells();
    }

    getDefaultShell(): string {
        return this.tools.getDefaultShell();
    }

    setDefaultShell(shellType: string): Promise<void> {
        return this.tools.setDefaultShell(shellType);
    }

    updateShellConfig(shellType: string, updates: Partial<ShellConfig>): Promise<void> {
        return this.tools.updateShellConfig(shellType, updates);
    }

    setShellEnabled(shellType: string, enabled: boolean): Promise<void> {
        return this.tools.setShellEnabled(shellType, enabled);
    }

    // ========== 存档点配置管理 ==========

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

    shouldCreateBeforeCheckpoint(toolName: string): boolean {
        return this.checkpoint.shouldCreateBeforeCheckpoint(toolName);
    }

    shouldCreateAfterCheckpoint(toolName: string): boolean {
        return this.checkpoint.shouldCreateAfterCheckpoint(toolName);
    }

    setCheckpointEnabled(enabled: boolean): Promise<void> {
        return this.checkpoint.setCheckpointEnabled(enabled);
    }

    setToolCheckpointPhase(toolName: string, before: boolean, after: boolean): Promise<void> {
        return this.checkpoint.setToolCheckpointPhase(toolName, before, after);
    }

    shouldCreateBeforeUserMessageCheckpoint(): boolean {
        return this.checkpoint.shouldCreateBeforeUserMessageCheckpoint();
    }

    shouldCreateAfterUserMessageCheckpoint(): boolean {
        return this.checkpoint.shouldCreateAfterUserMessageCheckpoint();
    }

    shouldCreateBeforeModelMessageCheckpoint(): boolean {
        return this.checkpoint.shouldCreateBeforeModelMessageCheckpoint();
    }

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

    getDefaultToolMode(): 'function_call' | 'xml' | 'json' {
        return this.tools.getDefaultToolMode();
    }

    setDefaultToolMode(mode: 'function_call' | 'xml' | 'json'): Promise<void> {
        return this.tools.setDefaultToolMode(mode);
    }

    // ========== 代理设置管理 ==========

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

    updateProxySettings(proxySettings: Partial<ProxySettings>): Promise<void> {
        return this.proxy.updateProxySettings(proxySettings);
    }

    setProxyEnabled(enabled: boolean): Promise<void> {
        return this.proxy.setProxyEnabled(enabled);
    }

    setProxyUrl(url: string | undefined): Promise<void> {
        return this.proxy.setProxyUrl(url);
    }

    // ========== 总结配置管理 ==========

    getSummarizeConfig(): Readonly<SummarizeConfig> {
        return this.summarize.getSummarizeConfig();
    }

    updateSummarizeConfig(config: Partial<SummarizeConfig>): Promise<void> {
        return this.summarize.updateSummarizeConfig(config);
    }

    // ========== 记忆配置管理 ==========

    isMemoryEnabled(): boolean {
        return this.memory.isMemoryEnabled();
    }

    getMemoryConfig(): Readonly<MemoryToolConfig> {
        return this.memory.getMemoryConfig();
    }

    updateMemoryConfig(config: Partial<MemoryToolConfig>): Promise<void> {
        return this.memory.updateMemoryConfig(config);
    }

    // ========== 图像生成配置管理 ==========

    getGenerateImageConfig(): Readonly<GenerateImageToolConfig> {
        return this.imageTools.getGenerateImageConfig();
    }

    updateGenerateImageConfig(config: Partial<GenerateImageToolConfig>): Promise<void> {
        return this.imageTools.updateGenerateImageConfig(config);
    }

    // ========== 抠图工具配置管理 ==========

    getRemoveBackgroundConfig(): Readonly<RemoveBackgroundToolConfig> {
        return this.imageTools.getRemoveBackgroundConfig();
    }

    updateRemoveBackgroundConfig(config: Partial<RemoveBackgroundToolConfig>): Promise<void> {
        return this.imageTools.updateRemoveBackgroundConfig(config);
    }

    // ========== 裁切图片工具配置管理 ==========

    getCropImageConfig(): Readonly<CropImageToolConfig> {
        return this.imageTools.getCropImageConfig();
    }

    updateCropImageConfig(config: Partial<CropImageToolConfig>): Promise<void> {
        return this.imageTools.updateCropImageConfig(config);
    }

    // ========== 缩放图片工具配置管理 ==========

    getResizeImageConfig(): Readonly<ResizeImageToolConfig> {
        return this.imageTools.getResizeImageConfig();
    }

    updateResizeImageConfig(config: Partial<ResizeImageToolConfig>): Promise<void> {
        return this.imageTools.updateResizeImageConfig(config);
    }

    // ========== 旋转图片工具配置管理 ==========

    getRotateImageConfig(): Readonly<RotateImageToolConfig> {
        return this.imageTools.getRotateImageConfig();
    }

    updateRotateImageConfig(config: Partial<RotateImageToolConfig>): Promise<void> {
        return this.imageTools.updateRotateImageConfig(config);
    }

    // ========== 上下文感知配置管理 ==========

    getContextAwarenessConfig(): Readonly<ContextAwarenessConfig> {
        return this.context.getContextAwarenessConfig();
    }

    updateContextAwarenessConfig(config: Partial<ContextAwarenessConfig>): Promise<void> {
        return this.context.updateContextAwarenessConfig(config);
    }

    shouldIncludeWorkspaceFiles(): boolean {
        return this.context.shouldIncludeWorkspaceFiles();
    }

    getMaxFileDepth(): number {
        return this.context.getMaxFileDepth();
    }

    shouldIncludeOpenTabs(): boolean {
        return this.context.shouldIncludeOpenTabs();
    }

    getMaxOpenTabs(): number {
        return this.context.getMaxOpenTabs();
    }

    shouldIncludeActiveEditor(): boolean {
        return this.context.shouldIncludeActiveEditor();
    }

    getContextIgnorePatterns(): string[] {
        return this.context.getContextIgnorePatterns();
    }

    // ========== 诊断信息配置管理 ==========

    getDiagnosticsConfig(): Readonly<DiagnosticsConfig> {
        return this.context.getDiagnosticsConfig();
    }

    updateDiagnosticsConfig(config: Partial<DiagnosticsConfig>): Promise<void> {
        return this.context.updateDiagnosticsConfig(config);
    }

    isDiagnosticsEnabled(): boolean {
        return this.context.isDiagnosticsEnabled();
    }

    setDiagnosticsEnabled(enabled: boolean): Promise<void> {
        return this.context.setDiagnosticsEnabled(enabled);
    }

    getDiagnosticsSeverities(): string[] {
        return this.context.getDiagnosticsSeverities();
    }

    getPinnedFilesConfig(): Readonly<PinnedFilesConfig> {
        return this.pinnedFiles.getPinnedFilesConfig();
    }

    updatePinnedFilesConfig(config: Partial<PinnedFilesConfig>): Promise<void> {
        return this.pinnedFiles.updatePinnedFilesConfig(config);
    }

    getPinnedFiles(): PinnedFileItem[] {
        return this.pinnedFiles.getPinnedFiles();
    }

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

    getPinnedFilesForWorkspace(workspaceUri: string): PinnedFileItem[] {
        return this.pinnedFiles.getPinnedFilesForWorkspace(workspaceUri);
    }

    getEnabledPinnedFilesForWorkspace(workspaceUri: string): PinnedFileItem[] {
        return this.pinnedFiles.getEnabledPinnedFilesForWorkspace(workspaceUri);
    }

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

    clearPinnedFiles(): Promise<void> {
        return this.pinnedFiles.clearPinnedFiles();
    }

    isFilePinned(path: string): boolean {
        return this.pinnedFiles.isFilePinned(path);
    }

    getPinnedFilesSectionTitle(): string {
        return this.pinnedFiles.getPinnedFilesSectionTitle();
    }

    // ========== Skills 配置管理 ==========

    getSkillsConfig(): Readonly<SkillsConfig> {
        return this.skills.getSkillsConfig();
    }

    updateSkillsConfig(config: Partial<SkillsConfig>): Promise<void> {
        return this.skills.updateSkillsConfig(config);
    }

    getSkills(): SkillConfigItem[] {
        return this.skills.getSkills();
    }

    setSkillEnabled(id: string, enabled: boolean, metadata?: { name?: string, description?: string }): Promise<void> {
        return this.skills.setSkillEnabled(id, enabled, metadata);
    }

    removeSkillConfig(id: string): Promise<void> {
        return this.skills.removeSkillConfig(id);
    }

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

    resolveDynamicContextStrategy(
        modeSnapshot?: ResolvedPromptModeSnapshot,
        override?: DynamicContextStrategy
    ): DynamicContextStrategy {
        return this.prompt.resolveDynamicContextStrategy(modeSnapshot, override);
    }

    updateSystemPromptConfig(config: Partial<SystemPromptConfig>): Promise<void> {
        return this.prompt.updateSystemPromptConfig(config);
    }

    getDefaultPromptModeId(): string {
        return this.prompt.getDefaultPromptModeId();
    }

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

    getCurrentPromptModeId(): string {
        return this.prompt.getCurrentPromptModeId();
    }

    getCurrentPromptMode(): PromptMode | null {
        return this.prompt.getCurrentPromptMode();
    }

    getAllPromptModes(): PromptMode[] {
        return this.prompt.getAllPromptModes();
    }

    setCurrentPromptMode(modeId: string): Promise<void> {
        return this.prompt.setCurrentPromptMode(modeId);
    }

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

    deletePromptMode(modeId: string): Promise<void> {
        return this.prompt.deletePromptMode(modeId);
    }

    getSystemPromptTemplate(): string {
        return this.prompt.getSystemPromptTemplate();
    }

    getDynamicContextTemplate(): string {
        return this.prompt.getDynamicContextTemplate();
    }

    isDynamicTemplateEnabled(): boolean {
        return this.prompt.isDynamicTemplateEnabled();
    }

    getSystemPromptPrefix(): string {
        return this.prompt.getSystemPromptPrefix();
    }

    getSystemPromptSuffix(): string {
        return this.prompt.getSystemPromptSuffix();
    }

    // ========== Token 计数配置管理 ==========

    getTokenCountConfig(): Readonly<TokenCountConfig> {
        return this.tokenCount.getTokenCountConfig();
    }

    updateTokenCountConfig(config: Partial<TokenCountConfig>): Promise<void> {
        return this.tokenCount.updateTokenCountConfig(config);
    }

    /**
     * 检查指定渠道的 Token 计数是否已启用
     *
     * @param channelType 渠道类型 (gemini, openai, anthropic, openai-responses)
     * @returns 是否启用
     */
    isTokenCountEnabled(channelType: 'gemini' | 'gemini-interactions' | 'openai' | 'anthropic' | 'openai-responses'): boolean {
        return this.tokenCount.isTokenCountEnabled(channelType);
    }

    // ========== UI 设置管理 ==========

    getUISettings() {
        return this.ui.getUISettings();
    }

    updateUISettings(uiSettings: Partial<NonNullable<GlobalSettings['ui']>>): Promise<void> {
        return this.ui.updateUISettings(uiSettings);
    }

    // ========== 公告版本管理 ==========

    getLastReadAnnouncementVersion(): string | undefined {
        return this.ui.getLastReadAnnouncementVersion();
    }

    setLastReadAnnouncementVersion(version: string): Promise<void> {
        return this.ui.setLastReadAnnouncementVersion(version);
    }

    // ========== 事件监听 ==========

    addChangeListener(listener: SettingsChangeListener): void {
        this.core.addChangeListener(listener);
    }

    removeChangeListener(listener: SettingsChangeListener): void {
        this.core.removeChangeListener(listener);
    }

    // ========== 存储路径管理 ==========

    getStoragePathConfig(): Readonly<StoragePathConfig> {
        return this.storagePath.getStoragePathConfig();
    }

    getCustomDataPath(): string | undefined {
        return this.storagePath.getCustomDataPath();
    }

    updateStoragePathConfig(config: Partial<StoragePathConfig>): Promise<void> {
        return this.storagePath.updateStoragePathConfig(config);
    }

    setCustomDataPath(path: string | undefined): Promise<void> {
        return this.storagePath.setCustomDataPath(path);
    }

    markMigrationStarted(): Promise<void> {
        return this.storagePath.markMigrationStarted();
    }

    markMigrationCompleted(): Promise<void> {
        return this.storagePath.markMigrationCompleted();
    }

    markMigrationFailed(error: string): Promise<void> {
        return this.storagePath.markMigrationFailed(error);
    }

    // ========== 工具方法 ==========

    reset(): Promise<void> {
        return this.core.reset();
    }

    // ========== 子代理管理 ==========

    getSubAgentsConfig(): SubAgentsConfig {
        return this.subagents.getSubAgentsConfig();
    }

    getSubAgents(): SubAgentConfigItem[] {
        return this.subagents.getSubAgents();
    }

    getSubAgent(type: string): SubAgentConfigItem | undefined {
        return this.subagents.getSubAgent(type);
    }

    addSubAgent(agent: SubAgentConfigItem): Promise<void> {
        return this.subagents.addSubAgent(agent);
    }

    updateSubAgent(type: string, updates: SubAgentConfigUpdate): Promise<boolean> {
        return this.subagents.updateSubAgent(type, updates);
    }

    deleteSubAgent(type: string): Promise<boolean> {
        return this.subagents.deleteSubAgent(type);
    }

    updateSubAgentsConfig(config: Partial<SubAgentsConfig>): Promise<void> {
        return this.subagents.updateSubAgentsConfig(config);
    }
}

