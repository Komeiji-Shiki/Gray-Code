/**
 * LimCode - 设置导出/导入器
 *
 * 将插件设置打包为单个 JSON 文件，支持导出和导入。
 * 导出内容排除对话历史记录和检查点，仅包含：
 * - VSCode 设置 (limcode.*)
 * - 渠道配置 (Channel Configs)
 * - MCP 服务器配置
 * - Skills（自定义技能）
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import type { SettingsManager } from './SettingsManager';
import type { ConfigManager } from '../config/ConfigManager';
import type { ChannelConfig } from '../config/types';
import type { McpManager } from '../mcp/McpManager';
import type { McpServerConfig } from '../mcp/types';
import type { SkillsManager } from '../skills/SkillsManager';

/** 导出包的版本号 */
const EXPORT_FORMAT_VERSION = '1.0';

/** 完整的导出数据结构 */
export interface SettingsExportData {
    /** 导出格式版本 */
    version: string;
    /** 导出时间戳 */
    exportedAt: number;
    /** 插件版本 */
    limcodeVersion: string;
    /** VSCode 设置 (limcode.*) */
    vscodeSettings: Record<string, unknown>;
    /** 渠道配置列表 */
    channelConfigs: ChannelConfig[];
    /** MCP 服务器配置列表 */
    mcpServers: McpServerConfig[];
    /** Skills 列表 */
    skills: SkillExportData[];
}

/** 简化的 Skill 导出格式 */
export interface SkillExportData {
    id: string;
    name: string;
    description: string;
    content: string;
    source: string;
    enabled: boolean;
}

/** 导入结果 */
export interface ImportResult {
    success: boolean;
    imported: {
        vscodeSettings: boolean;
        channelConfigs: number;
        mcpServers: number;
        skills: number;
    };
    errors: string[];
}

/**
 * 设置导出/导入器
 *
 * 负责收集所有需要导出的插件设置数据，并支持从导出文件恢复。
 */
export class SettingsExporter {
    constructor(
        private readonly settingsManager: SettingsManager,
        private readonly configManager: ConfigManager,
        private readonly mcpManager: McpManager,
        private readonly skillsManager: SkillsManager,
        private readonly extensionVersion: string,
        private readonly legacySkillsDir: string
    ) {}

    /**
     * 收集所有需要导出的数据
     */
    async collectExportData(): Promise<SettingsExportData> {
        // 1. 读取 VSCode 设置 (limcode.*)
        const vscodeSettings = this.collectVSCodeSettings();

        // 2. 读取渠道配置
        const channelConfigs = await this.configManager.listConfigs();

        // 3. 读取 MCP 服务器配置
        const mcpServers = await this.mcpManager.listServerConfigs();

        // 4. 读取 Skills
        const skills = this.collectSkills();

        return {
            version: EXPORT_FORMAT_VERSION,
            exportedAt: Date.now(),
            limcodeVersion: this.extensionVersion,
            vscodeSettings,
            channelConfigs,
            mcpServers,
            skills
        };
    }

    /**
     * 将导出数据序列化为 JSON 字符串
     */
    async exportToJson(pretty: boolean = true): Promise<string> {
        const data = await this.collectExportData();
        return JSON.stringify(data, null, pretty ? 2 : undefined);
    }

    /**
     * 从 JSON 字符串解析导出数据
     */
    parseExportData(json: string): SettingsExportData {
        let data: unknown;
        try {
            data = JSON.parse(json);
        } catch (error: any) {
            throw new Error(`解析导出文件失败：${error.message}`);
        }

        if (!data || typeof data !== 'object') {
            throw new Error('导出文件格式无效：根元素必须是对象');
        }

        const obj = data as Record<string, unknown>;

        // 基本结构验证
        if (!obj.version || typeof obj.version !== 'string') {
            throw new Error('导出文件缺少 version 字段');
        }

        if (!Array.isArray(obj.channelConfigs)) {
            throw new Error('导出文件缺少 channelConfigs 数组');
        }

        if (!Array.isArray(obj.mcpServers)) {
            throw new Error('导出文件缺少 mcpServers 数组');
        }

        if (!Array.isArray(obj.skills)) {
            throw new Error('导出文件缺少 skills 数组');
        }

        if (!obj.vscodeSettings || typeof obj.vscodeSettings !== 'object') {
            throw new Error('导出文件缺少 vscodeSettings 对象');
        }

        return obj as unknown as SettingsExportData;
    }

    /**
     * 从导出数据导入设置
     *
     * @param data 导出数据
     * @param options 导入选项
     */
    async importFromData(
        data: SettingsExportData,
        options: { overwriteChannelConfigs?: boolean; overwriteMcpServers?: boolean; overwriteSkills?: boolean } = {}
    ): Promise<ImportResult> {
        const result: ImportResult = {
            success: true,
            imported: {
                vscodeSettings: false,
                channelConfigs: 0,
                mcpServers: 0,
                skills: 0
            },
            errors: []
        };

        // 1. 导入 VSCode 设置
        try {
            await this.importVSCodeSettings(data.vscodeSettings);
            result.imported.vscodeSettings = true;
        } catch (error: any) {
            result.errors.push(`导入 VSCode 设置失败：${error.message}`);
        }

        // 2. 导入渠道配置
        if (data.channelConfigs.length > 0) {
            try {
                const count = await this.importChannelConfigs(data.channelConfigs, {
                    overwrite: options.overwriteChannelConfigs ?? false
                });
                result.imported.channelConfigs = count;
            } catch (error: any) {
                result.errors.push(`导入渠道配置失败：${error.message}`);
            }
        }

        // 3. 导入 MCP 服务器配置
        if (data.mcpServers.length > 0) {
            try {
                const count = await this.importMcpServers(data.mcpServers, {
                    overwrite: options.overwriteMcpServers ?? false
                });
                result.imported.mcpServers = count;
            } catch (error: any) {
                result.errors.push(`导入 MCP 服务器配置失败：${error.message}`);
            }
        }

        // 4. 导入 Skills
        if (data.skills.length > 0) {
            try {
                const count = await this.importSkills(data.skills, {
                    overwrite: options.overwriteSkills ?? false
                });
                result.imported.skills = count;
            } catch (error: any) {
                result.errors.push(`导入 Skills 失败：${error.message}`);
            }
        }

        if (result.errors.length > 0) {
            result.success = false;
        }

        return result;
    }

    // ========== 私有方法 ==========

    /**
     * 收集所有 VSCode limcode.* 设置
     */
    private collectVSCodeSettings(): Record<string, unknown> {
        const config = vscode.workspace.getConfiguration('limcode');
        const result: Record<string, unknown> = {};

        // 列出所有 limcode.* 配置键
        const knownKeys = [
            'toolsConfig',
            'ui',
            'toolsEnabled',
            'toolAutoExec',
            'maxToolIterations',
            'defaultToolMode',
            'activeChannelId',
            'lastReadAnnouncementVersion',
            'proxy',
            'storagePath'
        ];

        for (const key of knownKeys) {
            const inspected = config.inspect(key);
            // 优先取 globalValue（用户全局设置），其次是 workspaceValue
            const value = inspected?.globalValue ?? inspected?.workspaceValue ?? inspected?.defaultValue;
            if (value !== undefined) {
                result[key] = value;
            }
        }

        return result;
    }

    /**
     * 导入 VSCode 设置
     */
    private async importVSCodeSettings(settings: Record<string, unknown>): Promise<void> {
        const config = vscode.workspace.getConfiguration('limcode');

        const updates: Array<Promise<void>> = [];
        for (const [key, value] of Object.entries(settings)) {
            // 跳过不存在的键或 undefined 值
            if (value === undefined) continue;

            // 使用 Global target 写入（和现有保存逻辑一致）
            // VSCode 的 Thenable 需要通过 Promise.resolve 转换为标准 Promise
            updates.push(
                Promise.resolve(config.update(key, value, vscode.ConfigurationTarget.Global)).then(() => {})
            );
        }

        if (updates.length > 0) {
            await Promise.all(updates);
            // 通知 SettingsManager 重新加载
            await this.settingsManager.initialize();
        }
    }

    /**
     * 导入渠道配置
     */
    private async importChannelConfigs(
        configs: ChannelConfig[],
        options: { overwrite: boolean }
    ): Promise<number> {
        let imported = 0;

        for (const cfg of configs) {
            try {
                const existing = await this.configManager.getConfig(cfg.id);

                if (existing) {
                    if (!options.overwrite) {
                        // 跳过已存在的配置
                        continue;
                    }
                    // 更新现有配置（保留原始 id 和创建时间）
                    await this.configManager.updateConfig(cfg.id, cfg);
                } else {
                    // 新配置：直接通过 importConfig 导入（保留原始 id）
                    await this.configManager.importConfig(cfg, { overwrite: true });
                }

                imported++;
            } catch (error: any) {
                console.error(`[SettingsExporter] Failed to import channel config ${cfg.id}:`, error);
                throw new Error(`导入渠道配置 "${cfg.name || cfg.id}" 失败：${error.message}`);
            }
        }

        return imported;
    }

    /**
     * 导入 MCP 服务器配置
     */
    private async importMcpServers(
        servers: McpServerConfig[],
        options: { overwrite: boolean }
    ): Promise<number> {
        let imported = 0;

        for (const server of servers) {
            try {
                const existing = await this.mcpManager.getServer(server.id);

                if (existing) {
                    if (!options.overwrite) {
                        continue;
                    }
                    await this.mcpManager.updateServer(server.id, server);
                } else {
                    await this.mcpManager.createServer(server);
                }

                imported++;
            } catch (error: any) {
                console.error(`[SettingsExporter] Failed to import MCP server ${server.id}:`, error);
                throw new Error(`导入 MCP 服务器 "${server.name || server.id}" 失败：${error.message}`);
            }
        }

        return imported;
    }

    /**
     * 收集所有 Skills
     */
    private collectSkills(): SkillExportData[] {
        const skills = this.skillsManager.getAllSkills();
        return skills.map(skill => ({
            id: skill.id,
            name: skill.name,
            description: skill.description,
            content: skill.content,
            source: skill.source,
            enabled: this.skillsManager.isSkillEnabled(skill.id)
        }));
    }

    /**
     * 导入 Skills
     */
    private async importSkills(
        skills: SkillExportData[],
        options: { overwrite: boolean }
    ): Promise<number> {
        let imported = 0;

        for (const skillData of skills) {
            try {
                const existing = this.skillsManager.getSkill(skillData.id);

                if (existing && !options.overwrite) {
                    continue;
                }

                // 将 skill 写入 legacy skills 目录
                const skillDir = path.join(this.legacySkillsDir, skillData.id);
                await fs.mkdir(skillDir, { recursive: true });

                const skillFile = path.join(skillDir, 'SKILL.md');
                const content = this.buildSkillMarkdown(skillData);
                await fs.writeFile(skillFile, content, 'utf-8');

                imported++;
            } catch (error: any) {
                console.error(`[SettingsExporter] Failed to import skill ${skillData.id}:`, error);
                throw new Error(`导入 Skill "${skillData.name || skillData.id}" 失败：${error.message}`);
            }
        }

        // 刷新 SkillsManager 以加载新导入的 skills
        if (imported > 0) {
            await this.skillsManager.refresh();
        }

        return imported;
    }

    /**
     * 构建 SKILL.md 的 Markdown 内容
     */
    private buildSkillMarkdown(skill: SkillExportData): string {
        const lines: string[] = [];
        lines.push('---');
        lines.push(`name: ${skill.name}`);
        lines.push(`description: ${skill.description}`);
        lines.push('---');
        lines.push('');
        lines.push(skill.content);
        return lines.join('\n');
    }
}
