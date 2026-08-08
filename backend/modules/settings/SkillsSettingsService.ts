/**
 * GrayCode - Skills 设置服务
 *
 * 从 SettingsManager.ts 拆分而来：负责 Skills 配置段。
 * SettingsManager 聚合委托本服务。
 */

import type { SkillsConfig, SkillConfigItem } from './types';
import { DEFAULT_SKILLS_CONFIG } from './types';
import { SettingsCore } from './SettingsCore';

/**
 * Skills 配置服务
 *
 * 对应原 SettingsManager 的「Skills 配置管理」段。
 */
export class SkillsSettingsService {
    private core: SettingsCore;

    constructor(core: SettingsCore) {
        this.core = core;
    }

    /**
     * 获取 Skills 配置
     */
    getSkillsConfig(): Readonly<SkillsConfig> {
        return this.core.getToolsConfigEntry('skills', DEFAULT_SKILLS_CONFIG);
    }

    /**
     * 更新 Skills 配置
     */
    async updateSkillsConfig(config: Partial<SkillsConfig>): Promise<void> {
        const oldConfig = this.getSkillsConfig();
        await this.core.saveToolsConfigEntry('skills', oldConfig, { ...oldConfig, ...config });
    }

    /**
     * 获取 Skills 列表
     */
    getSkills(): SkillConfigItem[] {
        return this.getSkillsConfig().skills || [];
    }

    /**
     * 设置 Skill 启用状态
     */
    async setSkillEnabled(id: string, enabled: boolean, metadata?: { name?: string, description?: string }): Promise<void> {
        await this.core.serializeMutation(async () => {
            const current = this.getSkills();
            const index = current.findIndex(s => s.id === id);

            let skills: SkillConfigItem[];
            if (index === -1) {
                // 如果 skill 不存在，创建新的配置项
                skills = [
                    ...current,
                    {
                        id,
                        name: metadata?.name || id,
                        description: metadata?.description || '',
                        enabled,
                        sendContent: true
                    }
                ];
            } else {
                // 全程不可变更新：只替换目标项，其余项复用旧引用。
                // 原地修改活对象会让 updateSkillsConfig 内部取到的 oldConfig 已是修改后
                // 的状态（变更事件 old/new 深度相等），且 save 失败时内存已被污染。
                skills = current.map((s, i) => {
                    if (i !== index) {
                        return s;
                    }
                    return {
                        ...s,
                        enabled,
                        ...(metadata?.name ? { name: metadata.name } : {}),
                        ...(metadata?.description ? { description: metadata.description } : {})
                    };
                });
            }

            await this.updateSkillsConfig({ skills });
        });
    }

    /**
     * 移除 Skill 配置
     */
    async removeSkillConfig(id: string): Promise<void> {
        await this.core.serializeMutation(async () => {
            const skills = this.getSkills().filter(s => s.id !== id);
            await this.updateSkillsConfig({ skills });
        });
    }

    /**
     * 获取启用的 Skills
     */
    getEnabledSkills(): SkillConfigItem[] {
        return this.getSkills().filter(s => s.enabled);
    }
}
