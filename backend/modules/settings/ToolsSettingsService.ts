/**
 * GrayCode - 工具（Tools）设置服务
 *
 * 从 SettingsManager.ts 拆分而来：负责工具启用/自动执行/工具配置、
 * Shell、工具模式、最大工具调用次数、激活渠道等配置段。
 * SettingsManager 聚合委托本服务。
 */

import type {
    ToolsEnabledState,
    ToolAutoExecConfig,
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
    HistorySearchToolConfig
} from './types';
import {
    DEFAULT_LIST_FILES_CONFIG,
    DEFAULT_FIND_FILES_CONFIG,
    DEFAULT_SEARCH_IN_FILES_CONFIG,
    DEFAULT_READ_FILE_CONFIG,
    DEFAULT_WRITE_FILE_CONFIG,
    DEFAULT_APPLY_DIFF_CONFIG,
    DEFAULT_DELETE_FILE_CONFIG,
    DEFAULT_TOOL_AUTO_EXEC_CONFIG,
    DEFAULT_HISTORY_SEARCH_CONFIG,
    getDefaultExecuteCommandConfig,
    DEFAULT_MAX_TOOL_ITERATIONS
} from './types';
import { MEMORY_TOOL_NAMES, isMemoryToolName } from '../memory/types';
import { SettingsCore } from './SettingsCore';
import { MemorySettingsService } from './MemorySettingsService';

/**
 * 工具设置服务
 *
 * 对应原 SettingsManager 的「工具调用配置 / 渠道管理 / 工具管理 /
 * 工具自动执行管理 / 工具配置管理 / 工具模式管理」各段。
 */
export class ToolsSettingsService {
    private core: SettingsCore;
    private memory: MemorySettingsService;

    constructor(core: SettingsCore, memory: MemorySettingsService) {
        this.core = core;
        this.memory = memory;
    }

    // ========== 工具调用配置 ==========

    /**
     * 获取单回合最大工具调用次数
     */
    getMaxToolIterations(): number {
        return this.core.settings.maxToolIterations ?? DEFAULT_MAX_TOOL_ITERATIONS;
    }

    /**
     * 设置单回合最大工具调用次数
     *
     * @param value 最大次数，-1 表示无限制，正整数表示具体次数
     */
    async setMaxToolIterations(value: number): Promise<void> {
        // -1 表示无限制，正整数表示具体次数，最小为 1
        // NaN/Infinity 等非法输入回退默认值，避免 Math.max(1, NaN) = NaN 被持久化
        const safeValue = value === -1
            ? -1
            : (Number.isFinite(value) ? Math.max(1, Math.floor(value)) : DEFAULT_MAX_TOOL_ITERATIONS);
        const oldValue = this.core.settings.maxToolIterations;
        this.core.settings.maxToolIterations = safeValue;
        this.core.settings.lastUpdated = Date.now();
        
        await this.core.storage.save(this.core.settings);
        
        this.core.notifyChange({
            type: 'tools',
            path: 'maxToolIterations',
            oldValue,
            newValue: safeValue,
            settings: this.core.settings
        });
    }

    // ========== 渠道管理 ==========

    /**
     * 获取当前激活的渠道 ID
     */
    getActiveChannelId(): string | undefined {
        return this.core.settings.activeChannelId;
    }

    /**
     * 设置激活的渠道 ID
     */
    async setActiveChannelId(channelId: string): Promise<void> {
        const oldValue = this.core.settings.activeChannelId;
        this.core.settings.activeChannelId = channelId;
        this.core.settings.lastUpdated = Date.now();
        
        await this.core.storage.save(this.core.settings);
        
        this.core.notifyChange({
            type: 'channel',
            path: 'activeChannelId',
            oldValue,
            newValue: channelId,
            settings: this.core.settings
        });
    }

    // ========== 工具管理 ==========

    /**
     * 获取工具启用状态
     */
    getToolsEnabled(): Readonly<ToolsEnabledState> {
        return { ...this.core.settings.toolsEnabled };
    }

    /**
     * 检查工具是否启用
     * 
     * @param toolName 工具名称
     * @returns 是否启用（未配置时默认启用）
     */
    isToolEnabled(toolName: string): boolean {
        if (isMemoryToolName(toolName) && !this.memory.isMemoryEnabled()) {
            return false;
        }
        // 如果未配置，默认启用
        return this.core.settings.toolsEnabled[toolName] !== false;
    }

    /**
     * 设置工具启用状态
     * 
     * @param toolName 工具名称
     * @param enabled 是否启用
     */
    async setToolEnabled(toolName: string, enabled: boolean): Promise<void> {
        if (enabled && isMemoryToolName(toolName) && !this.memory.isMemoryEnabled()) {
            throw new Error('Permanent memory is disabled. Enable it in Memory settings before enabling memory tools.');
        }
        const oldValue = { ...this.core.settings.toolsEnabled };
        // 整体替换对象（与 setToolsEnabled 一致）：任何存储实现都不会因对象引用复用而漏写
        this.core.settings.toolsEnabled = {
            ...this.core.settings.toolsEnabled,
            [toolName]: enabled
        };
        this.core.settings.lastUpdated = Date.now();
        
        await this.core.storage.save(this.core.settings);
        
        this.core.notifyChange({
            type: 'tools',
            path: 'toolsEnabled',
            oldValue,
            newValue: this.core.settings.toolsEnabled,
            settings: this.core.settings
        });
    }

    /**
     * 批量设置工具启用状态
     * 
     * @param states 工具名称到启用状态的映射
     */
    async setToolsEnabled(states: ToolsEnabledState): Promise<void> {
        const oldValue = { ...this.core.settings.toolsEnabled };
        // 语义与 setToolEnabled 保持一致：记忆功能关闭时不允许启用记忆工具，
        // 统一抛错而不是静默丢弃（避免 UI 无感知地丢失用户操作）。
        // 注意：错误信息保持与 setToolEnabled 相同的硬编码文案——i18n 化需要
        // 在 backend/i18n 新增 key，超出本模块改动范围，故两者共用同一文案。
        if (!this.memory.isMemoryEnabled()) {
            for (const toolName of MEMORY_TOOL_NAMES) {
                if (states[toolName] === true) {
                    throw new Error('Permanent memory is disabled. Enable it in Memory settings before enabling memory tools.');
                }
            }
        }
        const normalizedStates = { ...states };
        this.core.settings.toolsEnabled = {
            ...this.core.settings.toolsEnabled,
            ...normalizedStates
        };
        this.core.settings.lastUpdated = Date.now();
        
        await this.core.storage.save(this.core.settings);
        
        this.core.notifyChange({
            type: 'tools',
            path: 'toolsEnabled',
            oldValue,
            newValue: this.core.settings.toolsEnabled,
            settings: this.core.settings
        });
    }

    /**
     * 获取启用的工具列表
     *
     * @param allTools 所有可用工具名称
     * @returns 启用的工具名称数组
     */
    getEnabledTools(allTools: string[]): string[] {
        return allTools.filter(name => this.isToolEnabled(name));
    }

    // ========== 工具自动执行管理 ==========

    /**
     * 获取工具自动执行配置
     */
    getToolAutoExecConfig(): Readonly<ToolAutoExecConfig> {
        // 拷贝返回：未配置时直接返回模块级 DEFAULT_TOOL_AUTO_EXEC_CONFIG 活引用，
        // 调用方原地修改会污染全局默认值。
        const config = this.core.settings.toolAutoExec;
        return config ? { ...config } : { ...DEFAULT_TOOL_AUTO_EXEC_CONFIG };
    }

    /**
     * 检查工具是否可以自动执行（无需用户确认）
     *
     * @param toolName 工具名称
     * @returns true = 自动执行，false = 需要确认
     */
    isToolAutoExec(toolName: string): boolean {
        const config = this.core.settings.toolAutoExec || DEFAULT_TOOL_AUTO_EXEC_CONFIG;
        // 如果未配置，默认自动执行
        if (config[toolName] === undefined) {
            return true;
        }
        return config[toolName];
    }

    /**
     * 设置工具是否可以自动执行
     *
     * @param toolName 工具名称
     * @param autoExec true = 自动执行，false = 需要确认
     */
    async setToolAutoExec(toolName: string, autoExec: boolean): Promise<void> {
        const oldConfig = { ...this.getToolAutoExecConfig() };
        
        if (!this.core.settings.toolAutoExec) {
            this.core.settings.toolAutoExec = { ...DEFAULT_TOOL_AUTO_EXEC_CONFIG };
        }
        // 整体替换对象：任何存储实现都不会因对象引用复用而漏写（同 setToolEnabled）
        this.core.settings.toolAutoExec = {
            ...this.core.settings.toolAutoExec,
            [toolName]: autoExec
        };
        this.core.settings.lastUpdated = Date.now();
        
        await this.core.storage.save(this.core.settings);
        
        this.core.notifyChange({
            type: 'tools',
            path: 'toolAutoExec', // 修正 path 为父对象路径或针对特定工具的正确结构
            oldValue: oldConfig,
            newValue: this.core.settings.toolAutoExec,
            settings: this.core.settings
        });
    }

    /**
     * 批量设置工具自动执行配置
     */
    async setToolAutoExecConfig(config: ToolAutoExecConfig): Promise<void> {
        const oldConfig = this.getToolAutoExecConfig();
        this.core.settings.toolAutoExec = {
            ...this.core.settings.toolAutoExec,
            ...config
        };
        this.core.settings.lastUpdated = Date.now();
        
        await this.core.storage.save(this.core.settings);
        
        this.core.notifyChange({
            type: 'tools',
            path: 'toolAutoExec',
            oldValue: oldConfig,
            newValue: this.core.settings.toolAutoExec,
            settings: this.core.settings
        });
    }

    /**
     * 获取需要确认的工具列表
     *
     * @param allTools 所有可用工具名称
     * @returns 需要确认的工具名称数组
     */
    getToolsRequiringConfirmation(allTools: string[]): string[] {
        return allTools.filter(name => !this.isToolAutoExec(name));
    }

    // ========== 工具配置管理 ==========

    /**
     * 获取工具配置
     */
    getToolsConfig(): Readonly<ToolsConfig> {
        // 深拷贝返回：直接返回活引用会让调用方原地修改污染未保存的设置状态
        return this.core.settings.toolsConfig ? this.core.cloneConfig(this.core.settings.toolsConfig) : {};
    }

    /**
     * 获取 read_file 工具配置
     */
    getReadFileConfig(): Readonly<ReadFileToolConfig> {
        return this.core.getToolsConfigEntry('read_file', DEFAULT_READ_FILE_CONFIG);
    }

    /**
     * 获取 write_file 工具配置
     */
    getWriteFileConfig(): Readonly<WriteFileToolConfig> {
        return this.core.getToolsConfigEntry('write_file', DEFAULT_WRITE_FILE_CONFIG);
    }

    /**
     * 获取 list_files 工具配置
     */
    getListFilesConfig(): Readonly<ListFilesToolConfig> {
        return this.core.getToolsConfigEntry('list_files', DEFAULT_LIST_FILES_CONFIG);
    }
    
    /**
     * 更新 list_files 工具配置
     */
    async updateListFilesConfig(config: Partial<ListFilesToolConfig>): Promise<void> {
        const oldConfig = this.getListFilesConfig();
        await this.core.saveToolsConfigEntry('list_files', oldConfig, { ...oldConfig, ...config });
    }
    
    /**
     * 获取 find_files 工具配置
     */
    getFindFilesConfig(): Readonly<FindFilesToolConfig> {
        return this.core.getToolsConfigEntry('find_files', DEFAULT_FIND_FILES_CONFIG);
    }
    
    /**
     * 更新 find_files 工具配置
     */
    async updateFindFilesConfig(config: Partial<FindFilesToolConfig>): Promise<void> {
        const oldConfig = this.getFindFilesConfig();
        await this.core.saveToolsConfigEntry('find_files', oldConfig, { ...oldConfig, ...config });
    }
    
    /**
     * 获取 search_in_files 工具配置
     */
    getSearchInFilesConfig(): Readonly<SearchInFilesToolConfig> {
        return this.core.getToolsConfigEntry('search_in_files', DEFAULT_SEARCH_IN_FILES_CONFIG);
    }
    
    /**
     * 更新 search_in_files 工具配置
     */
    async updateSearchInFilesConfig(config: Partial<SearchInFilesToolConfig>): Promise<void> {
        const oldConfig = this.getSearchInFilesConfig();
        await this.core.saveToolsConfigEntry('search_in_files', oldConfig, { ...oldConfig, ...config });
    }
    
    /**
     * 更新工具配置
     */
    async updateToolConfig(toolName: string, config: Record<string, unknown>): Promise<void> {
        const oldConfig = this.core.settings.toolsConfig?.[toolName] || {};
        await this.core.saveToolsConfigEntry(toolName, oldConfig, { ...oldConfig, ...config });
    }
    
    /**
     * 获取 apply_diff 工具配置
     */
    getApplyDiffConfig(): Readonly<ApplyDiffToolConfig> {
        return this.core.getToolsConfigEntry('apply_diff', DEFAULT_APPLY_DIFF_CONFIG);
    }
    
    /**
     * 更新 apply_diff 工具配置
     */
    async updateApplyDiffConfig(config: Partial<ApplyDiffToolConfig>): Promise<void> {
        const oldConfig = this.getApplyDiffConfig();
        const newConfig = {
            ...oldConfig,
            ...config
        };
        if (typeof newConfig.autoSaveDelay === 'number' && Number.isFinite(newConfig.autoSaveDelay)) {
            newConfig.autoSaveDelay = Math.max(50, newConfig.autoSaveDelay);
        }
        await this.core.saveToolsConfigEntry('apply_diff', oldConfig, newConfig);
    }

    /**
     * 获取 history_search 工具配置
     */
    getHistorySearchConfig(): Readonly<HistorySearchToolConfig> {
        return this.core.getToolsConfigEntry('history_search', DEFAULT_HISTORY_SEARCH_CONFIG);
    }

    /**
     * 更新 history_search 工具配置
     */
    async updateHistorySearchConfig(config: Partial<HistorySearchToolConfig>): Promise<void> {
        const oldConfig = this.getHistorySearchConfig();
        await this.core.saveToolsConfigEntry('history_search', oldConfig, { ...oldConfig, ...config });
    }

    
    /**
     * 获取 delete_file 工具配置
     */
    getDeleteFileConfig(): Readonly<DeleteFileToolConfig> {
        return this.core.getToolsConfigEntry('delete_file', DEFAULT_DELETE_FILE_CONFIG);
    }
    
    /**
     * 更新 delete_file 工具配置
     */
    async updateDeleteFileConfig(config: Partial<DeleteFileToolConfig>): Promise<void> {
        const oldConfig = this.getDeleteFileConfig();
        await this.core.saveToolsConfigEntry('delete_file', oldConfig, { ...oldConfig, ...config });
    }
    
    /**
     * 获取 execute_command 工具配置
     */
    getExecuteCommandConfig(): Readonly<ExecuteCommandToolConfig> {
        return this.core.getToolsConfigEntry('execute_command', getDefaultExecuteCommandConfig());
    }
    
    /**
     * 更新 execute_command 工具配置
     */
    async updateExecuteCommandConfig(config: Partial<ExecuteCommandToolConfig>): Promise<void> {
        const oldConfig = this.getExecuteCommandConfig();
        await this.core.saveToolsConfigEntry('execute_command', oldConfig, { ...oldConfig, ...config });
    }
    
    /**
     * 获取启用的 Shell 列表
     */
    getEnabledShells(): ShellConfig[] {
        const config = this.getExecuteCommandConfig();
        return config.shells.filter(shell => shell.enabled);
    }
    
    /**
     * 获取默认 Shell 类型
     */
    getDefaultShell(): string {
        return this.getExecuteCommandConfig().defaultShell;
    }
    
    /**
     * 设置默认 Shell
     */
    async setDefaultShell(shellType: string): Promise<void> {
        await this.updateExecuteCommandConfig({ defaultShell: shellType });
    }
    
    /**
     * 更新 Shell 配置
     */
    async updateShellConfig(shellType: string, updates: Partial<ShellConfig>): Promise<void> {
        const config = this.getExecuteCommandConfig();
        const shells = config.shells.map(shell =>
            shell.type === shellType ? { ...shell, ...updates } : shell
        );
        await this.updateExecuteCommandConfig({ shells });
    }
    
    /**
     * 启用/禁用 Shell
     */
    async setShellEnabled(shellType: string, enabled: boolean): Promise<void> {
        await this.updateShellConfig(shellType, { enabled });
    }

    // ========== 工具模式管理 ==========

    /**
     * 获取默认工具模式
     */
    getDefaultToolMode(): 'function_call' | 'xml' | 'json' {
        return this.core.settings.defaultToolMode || 'function_call';
    }

    /**
     * 设置默认工具模式
     */
    async setDefaultToolMode(mode: 'function_call' | 'xml' | 'json'): Promise<void> {
        const oldValue = this.core.settings.defaultToolMode;
        this.core.settings.defaultToolMode = mode;
        this.core.settings.lastUpdated = Date.now();
        
        await this.core.storage.save(this.core.settings);
        
        this.core.notifyChange({
            type: 'toolMode',
            path: 'defaultToolMode',
            oldValue,
            newValue: mode,
            settings: this.core.settings
        });
    }
}
