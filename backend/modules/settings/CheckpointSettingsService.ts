/**
 * GrayCode - 存档点（Checkpoint）设置服务
 *
 * 从 SettingsManager.ts 拆分而来：负责 checkpoint 配置段的读写、
 * 校验与存档点创建时机判断。SettingsManager 聚合委托本服务。
 */

import type { CheckpointConfig } from './types';
import { t } from '../../i18n';
import { validateCustomExclusionPatterns, DEFAULT_EXCLUSION_PROFILES } from '../checkpoint';
import { SettingsCore, deepMergeToolsConfig } from './SettingsCore';
import { DEFAULT_CHECKPOINT_CONFIG } from './types';

/**
 * 存档点配置服务
 *
 * 对应原 SettingsManager 的「存档点配置管理」段：
 * 读取/更新 checkpoint 配置（含排除配置校验）、工具前后备份判断、
 * 消息前后备份判断等。
 */
export class CheckpointSettingsService {
    private core: SettingsCore;

    constructor(core: SettingsCore) {
        this.core = core;
    }

    /**
     * 获取存档点配置
     */
    getCheckpointConfig(): Readonly<CheckpointConfig> {
        return this.core.getToolsConfigEntry('checkpoint', DEFAULT_CHECKPOINT_CONFIG);
    }

    /**
     * 更新存档点配置
     *
     * EX-12/L-4：保存前校验排除配置，拒绝危险/无意义的自定义排除规则
     * （空模式、绝对路径、纯 `!`、`..` 越界、换行注入），以及未知默认类别 id、
     * 非有限数值的单文件大小上限。
     */
    async updateCheckpointConfig(config: Partial<CheckpointConfig>): Promise<void> {
        // EX-CFG-2: 先浅拷贝（exclusion 为嵌套对象，单独拷贝一层），
        // 避免后续负数归一化直接改写调用方传入的对象（隐式副作用）。
        const configToSave: Partial<CheckpointConfig> = config.exclusion === undefined
            ? { ...config }
            : { ...config, exclusion: { ...config.exclusion } };

        const patternsToValidate: string[] = [
            ...(configToSave.exclusion?.customPatterns ?? []),
            ...(configToSave.customIgnorePatterns ?? [])
        ];
        if (patternsToValidate.length > 0) {
            const issues = validateCustomExclusionPatterns(patternsToValidate);
            if (issues.length > 0) {
                const detail = issues
                    .map(issue => `"${issue.pattern}" (${this.exclusionPatternIssueText(issue.reason)})`)
                    .join('; ');
                throw new Error(t('modules.settings.errors.invalidCheckpointExclusionPatterns', { detail }));
            }
        }

        // L-4 + EX-12-1: enabledProfiles key 必须已知类别；value 必须是 boolean
        // （字符串 "false" 为 truthy，会让"关闭"操作被静默忽略 → 拒绝保存）
        if (configToSave.exclusion?.enabledProfiles !== undefined) {
            const enabledProfiles = configToSave.exclusion.enabledProfiles;
            if (typeof enabledProfiles !== 'object' || Array.isArray(enabledProfiles)) {
                throw new Error(t('modules.settings.errors.invalidCheckpointExclusionProfiles', {
                    detail: String(enabledProfiles)
                }));
            }
            const knownIds = new Set<string>(DEFAULT_EXCLUSION_PROFILES.map(profile => profile.id));
            const unknownIds = Object.keys(enabledProfiles).filter(id => !knownIds.has(id));
            if (unknownIds.length > 0) {
                throw new Error(t('modules.settings.errors.invalidCheckpointExclusionProfiles', {
                    detail: unknownIds.join(', ')
                }));
            }
            const nonBooleanIds = Object.entries(enabledProfiles)
                .filter(([, value]) => typeof value !== 'boolean')
                .map(([id]) => id);
            if (nonBooleanIds.length > 0) {
                throw new Error(t('modules.settings.errors.invalidCheckpointExclusionProfiles', {
                    detail: nonBooleanIds.join(', ')
                }));
            }
        }

        // 每类别自定义模式覆盖校验：key 必须已知类别；值必须是字符串数组且模式合法
        if (configToSave.exclusion?.profilePatterns !== undefined) {
            const profilePatterns = configToSave.exclusion.profilePatterns;
            if (typeof profilePatterns !== 'object' || Array.isArray(profilePatterns)) {
                throw new Error(t('modules.settings.errors.invalidCheckpointExclusionProfiles', {
                    detail: String(profilePatterns)
                }));
            }
            const knownIds = new Set<string>(DEFAULT_EXCLUSION_PROFILES.map(profile => profile.id));
            const unknownIds = Object.keys(profilePatterns).filter(id => !knownIds.has(id));
            if (unknownIds.length > 0) {
                throw new Error(t('modules.settings.errors.invalidCheckpointExclusionProfiles', {
                    detail: unknownIds.join(', ')
                }));
            }
            for (const [id, patterns] of Object.entries(profilePatterns)) {
                if (!Array.isArray(patterns)) {
                    throw new Error(t('modules.settings.errors.invalidCheckpointExclusionProfiles', {
                        detail: id
                    }));
                }
                const issues = validateCustomExclusionPatterns(patterns);
                if (issues.length > 0) {
                    const detail = issues
                        .map(issue => `"${issue.pattern}" (${this.exclusionPatternIssueText(issue.reason)})`)
                        .join('; ');
                    throw new Error(t('modules.settings.errors.invalidCheckpointExclusionPatterns', { detail }));
                }
            }
        }

        // L-4: maxFileSizeBytes 非有限数值（NaN / 字符串）→ 拒绝保存
        if (configToSave.exclusion && configToSave.exclusion.maxFileSizeBytes !== undefined) {
            const size = configToSave.exclusion.maxFileSizeBytes;
            if (typeof size !== 'number' || !Number.isFinite(size)) {
                throw new Error(t('modules.settings.errors.invalidCheckpointMaxFileSize'));
            }
        }

        // 负数上限归一化为 0（0 = 不限制）；改写的是拷贝对象，不影响调用方
        if (configToSave.exclusion && typeof configToSave.exclusion.maxFileSizeBytes === 'number' && configToSave.exclusion.maxFileSizeBytes < 0) {
            configToSave.exclusion.maxFileSizeBytes = 0;
        }

        // EX-12-1: beforeTools / afterTools 必须是字符串数组
        if (configToSave.beforeTools !== undefined && !this.isStringArray(configToSave.beforeTools)) {
            throw new Error(t('modules.settings.errors.invalidCheckpointConfigField', { field: 'beforeTools' }));
        }
        if (configToSave.afterTools !== undefined && !this.isStringArray(configToSave.afterTools)) {
            throw new Error(t('modules.settings.errors.invalidCheckpointConfigField', { field: 'afterTools' }));
        }

        // EX-12-1: enabled 必须是 boolean
        if (configToSave.enabled !== undefined && typeof configToSave.enabled !== 'boolean') {
            throw new Error(t('modules.settings.errors.invalidCheckpointConfigField', { field: 'enabled' }));
        }

        // EX-12-1: maxCheckpoints 必须是有限整数；-1 是"无上限"哨兵（前端与默认配置沿用），
        // 其余负数 / 非整数 / NaN / Infinity / 字符串一律拒绝
        if (configToSave.maxCheckpoints !== undefined && !this.isValidMaxCheckpoints(configToSave.maxCheckpoints)) {
            throw new Error(t('modules.settings.errors.invalidCheckpointConfigField', { field: 'maxCheckpoints' }));
        }

        // EX-CFG-1: 保存前对嵌套字段（exclusion / messageCheckpoint）深合并，
        // 避免部分 exclusion 负载整体覆盖已保存的 profilePatterns / maxFileSizeBytes 等字段
        // 读-改-写整体入队串行：oldConfig 读取必须与写回在同一 mutator 内，否则并发
        // updateCheckpointConfig 基于队列外旧快照合并后整体写回会覆盖先写（静默丢更新）
        await this.core.serializeMutation(async () => {
            const oldConfig = this.getCheckpointConfig();
            await this.core.saveToolsConfigEntry('checkpoint', oldConfig, deepMergeToolsConfig(oldConfig, configToSave));
        });
    }

    /** 排除模式校验失败的局部原因文案（EX-12） */
    private exclusionPatternIssueText(reason: string): string {
        const key = `modules.settings.errors.exclusionPatternReason.${reason}` as const;
        const localized = t(key);
        return localized === key ? reason : localized;
    }

    /** EX-12-1: 是否字符串数组（beforeTools / afterTools） */
    private isStringArray(value: unknown): value is string[] {
        return Array.isArray(value) && value.every(item => typeof item === 'string');
    }

    /**
     * EX-12-1: maxCheckpoints 是否为合法值。
     *
     * 必须是有限整数；-1 为"无上限"哨兵（默认配置与前端沿用），
     * 其余负数、非整数、NaN / Infinity、字符串一律非法。
     */
    private isValidMaxCheckpoints(value: unknown): value is number {
        return typeof value === 'number' && Number.isInteger(value) && value >= -1;
    }

    /**
     * 检查工具是否需要在执行前创建备份
     */
    shouldCreateBeforeCheckpoint(toolName: string): boolean {
        const config = this.getCheckpointConfig();
        return config.enabled && config.beforeTools.includes(toolName);
    }

    /**
     * 检查工具是否需要在执行后创建备份
     */
    shouldCreateAfterCheckpoint(toolName: string): boolean {
        const config = this.getCheckpointConfig();
        return config.enabled && config.afterTools.includes(toolName);
    }

    /**
     * 启用/禁用存档点功能
     */
    async setCheckpointEnabled(enabled: boolean): Promise<void> {
        await this.updateCheckpointConfig({ enabled });
    }

    /**
     * 设置工具的备份阶段
     */
    async setToolCheckpointPhase(toolName: string, before: boolean, after: boolean): Promise<void> {
        await this.core.serializeMutation(async () => {
            const config = this.getCheckpointConfig();
            const beforeTools = [...config.beforeTools];
            const afterTools = [...config.afterTools];

            const beforeIndex = beforeTools.indexOf(toolName);
            if (before && beforeIndex === -1) {
                beforeTools.push(toolName);
            } else if (!before && beforeIndex !== -1) {
                beforeTools.splice(beforeIndex, 1);
            }

            const afterIndex = afterTools.indexOf(toolName);
            if (after && afterIndex === -1) {
                afterTools.push(toolName);
            } else if (!after && afterIndex !== -1) {
                afterTools.splice(afterIndex, 1);
            }

            await this.updateCheckpointConfig({ beforeTools, afterTools });
        });
    }

    /**
     * 检查是否需要在用户消息前创建存档点
     */
    shouldCreateBeforeUserMessageCheckpoint(): boolean {
        const config = this.getCheckpointConfig();
        return config.enabled && (config.messageCheckpoint?.beforeMessages?.includes('user') ?? false);
    }

    /**
     * 检查是否需要在用户消息后创建存档点
     */
    shouldCreateAfterUserMessageCheckpoint(): boolean {
        const config = this.getCheckpointConfig();
        return config.enabled && (config.messageCheckpoint?.afterMessages?.includes('user') ?? false);
    }

    /**
     * 检查是否需要在模型消息前创建存档点
     */
    shouldCreateBeforeModelMessageCheckpoint(): boolean {
        const config = this.getCheckpointConfig();
        return config.enabled && (config.messageCheckpoint?.beforeMessages?.includes('model') ?? false);
    }

    /**
     * 检查是否需要在模型消息后创建存档点（不包含工具调用的纯文本回复）
     */
    shouldCreateAfterModelMessageCheckpoint(): boolean {
        const config = this.getCheckpointConfig();
        return config.enabled && (config.messageCheckpoint?.afterMessages?.includes('model') ?? false);
    }

    /**
     * 检查是否只在最外层创建模型消息存档点
     *
     * 当返回 true 时，连续工具调用时只在第一次和最后一次创建存档点
     * 当返回 false 时，每次迭代都创建存档点
     */
    isModelOuterLayerOnly(): boolean {
        const config = this.getCheckpointConfig();
        // 默认为 true（只在最外层创建）
        return config.messageCheckpoint?.modelOuterLayerOnly ?? true;
    }
}
