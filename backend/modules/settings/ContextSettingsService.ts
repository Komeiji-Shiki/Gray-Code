/**
 * GrayCode - 上下文感知（Context Awareness）与诊断设置服务
 *
 * 从 SettingsManager.ts 拆分而来：负责上下文感知配置段与诊断配置段。
 * SettingsManager 聚合委托本服务。
 */

import type { ContextAwarenessConfig, DiagnosticsConfig } from './types';
import { DEFAULT_CONTEXT_AWARENESS_CONFIG, DEFAULT_DIAGNOSTICS_CONFIG } from './types';
import { SettingsCore } from './SettingsCore';

/**
 * 上下文感知配置服务
 *
 * 对应原 SettingsManager 的「上下文感知配置管理 / 诊断信息配置管理」段。
 */
export class ContextSettingsService {
    private core: SettingsCore;

    constructor(core: SettingsCore) {
        this.core = core;
    }

    // ========== 上下文感知配置管理 ==========

    /**
     * 获取上下文感知配置
     */
    getContextAwarenessConfig(): Readonly<ContextAwarenessConfig> {
        return this.core.getToolsConfigEntry('context_awareness', DEFAULT_CONTEXT_AWARENESS_CONFIG);
    }

    /**
     * 更新上下文感知配置
     */
    async updateContextAwarenessConfig(config: Partial<ContextAwarenessConfig>): Promise<void> {
        const oldConfig = this.getContextAwarenessConfig();
        await this.core.saveToolsConfigEntry('context_awareness', oldConfig, { ...oldConfig, ...config });
    }

    /**
     * 检查是否应该包含工作区文件树
     */
    shouldIncludeWorkspaceFiles(): boolean {
        return this.getContextAwarenessConfig().includeWorkspaceFiles;
    }

    /**
     * 获取文件树最大深度
     * @returns 最大深度，-1 表示无限制
     */
    getMaxFileDepth(): number {
        return this.getContextAwarenessConfig().maxFileDepth;
    }

    /**
     * 检查是否应该包含打开的标签页
     */
    shouldIncludeOpenTabs(): boolean {
        return this.getContextAwarenessConfig().includeOpenTabs;
    }

    /**
     * 获取打开标签页最大数量
     * @returns 最大数量，-1 表示无限制
     */
    getMaxOpenTabs(): number {
        return this.getContextAwarenessConfig().maxOpenTabs;
    }

    /**
     * 检查是否应该包含当前活动编辑器路径
     */
    shouldIncludeActiveEditor(): boolean {
        return this.getContextAwarenessConfig().includeActiveEditor;
    }

    /**
     * 获取自定义忽略模式
     */
    getContextIgnorePatterns(): string[] {
        return this.getContextAwarenessConfig().ignorePatterns || [];
    }

    // ========== 诊断信息配置管理 ==========

    /**
     * 获取诊断信息配置
     */
    getDiagnosticsConfig(): Readonly<DiagnosticsConfig> {
        return this.getContextAwarenessConfig().diagnostics || DEFAULT_DIAGNOSTICS_CONFIG;
    }

    /**
     * 更新诊断信息配置
     */
    async updateDiagnosticsConfig(config: Partial<DiagnosticsConfig>): Promise<void> {
        const contextConfig = this.getContextAwarenessConfig();
        const oldConfig = this.getDiagnosticsConfig();
        const newConfig = {
            ...oldConfig,
            ...config
        };
        
        await this.updateContextAwarenessConfig({
            ...contextConfig,
            diagnostics: newConfig
        });
    }

    /**
     * 检查诊断功能是否启用
     */
    isDiagnosticsEnabled(): boolean {
        return this.getDiagnosticsConfig().enabled;
    }

    /**
     * 设置诊断功能启用状态
     */
    async setDiagnosticsEnabled(enabled: boolean): Promise<void> {
        await this.updateDiagnosticsConfig({ enabled });
    }

    /**
     * 获取包含的诊断严重程度级别
     */
    getDiagnosticsSeverities(): string[] {
        return this.getDiagnosticsConfig().includeSeverities;
    }

    /**
     * 设置包含的诊断严重程度级别
     */
    async setDiagnosticsSeverities(severities: ('error' | 'warning' | 'information' | 'hint')[]): Promise<void> {
        await this.updateDiagnosticsConfig({ includeSeverities: severities });
    }
}
