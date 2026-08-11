/**
 * Skills 消息处理器
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import { t } from '../../backend/i18n';
import type { HandlerContext, MessageHandler } from '../types';
import { getSkillsManager } from '../../backend/modules/skills';
import { toolRegistry } from '../../backend/tools';
import type { SkillConfigItem } from '../../backend/modules/settings';

// ========== Skills 类型 ==========

export interface SkillItem {
    id: string;
    name: string;
    description: string;
    enabled: boolean;          // 是否在当前对话中启用
    /**
     * @deprecated 不再使用拼接注入模式。保留字段仅为前端兼容。
     */
    sendContent: boolean;      
    exists?: boolean;          // skill 是否存在
    source?: string;           // skill 来源
}

export interface SkillsConfigResponse {
    skills: SkillItem[];
}

const CONVERSATION_SKILLS_KEY = 'inputSkills';

function normalizeSkillConfigItems(raw: unknown): SkillConfigItem[] {
    if (!Array.isArray(raw)) return [];

    return raw
        .filter((item): item is SkillConfigItem => {
            return !!item
                && typeof (item as any).id === 'string'
                && typeof (item as any).name === 'string'
                && typeof (item as any).description === 'string'
                && typeof (item as any).enabled === 'boolean'
                && typeof (item as any).sendContent === 'boolean';
        })
        .map(item => ({ ...item }));
}

async function getConversationSkillsRaw(ctx: HandlerContext, conversationId: string): Promise<SkillConfigItem[] | null> {
    try {
        const raw = await ctx.conversationManager.getCustomMetadata(conversationId, CONVERSATION_SKILLS_KEY);
        if (raw === undefined) return null;
        return normalizeSkillConfigItems(raw);
    } catch {
        return null;
    }
}

async function saveConversationSkills(ctx: HandlerContext, conversationId: string, skills: SkillConfigItem[]): Promise<void> {
    await ctx.conversationManager.setCustomMetadata(conversationId, CONVERSATION_SKILLS_KEY, skills);
}

// ========== Skills 管理 ==========

/**
 * 获取所有 skills 列表
 */
export const getSkillsConfig: MessageHandler = async (data, requestId, ctx) => {
    try {
        const skillsManager = getSkillsManager();
        
        if (!skillsManager) {
            ctx.sendResponse(requestId, { skills: [] });
            return;
        }

        const conversationId = typeof data?.conversationId === 'string' ? data.conversationId.trim() : '';
        
        // 从 settingsManager 获取持久化的 skills 配置
        const savedConfig = ctx.settingsManager.getSkillsConfig() || { skills: [] };
        const conversationSkills = conversationId ? await getConversationSkillsRaw(ctx, conversationId) : null;
        const savedSkills = conversationSkills ?? savedConfig.skills;

        const savedSkillsMap = new Map<string, { enabled: boolean; sendContent: boolean }>();
        for (const skill of savedSkills) {
            savedSkillsMap.set(skill.id, { enabled: skill.enabled, sendContent: skill.sendContent });
        }
        
        // 获取所有 skills 并合并持久化配置（只读：本接口不修改任何全局/会话状态）。
        // 全局启用状态以 SkillsManager.enabledSkillIds 为唯一真源（与 getAllSkills 口径一致）；
        // 对话隔离模式优先取会话级配置，缺省回退全局运行时状态——不再用硬编码 true 兜底，
        // 避免把工具侧已禁用的 skill 静默重新启用（原实现 enableSkill/disableSkill +
        // updateSkillsConfig 写副作用已移除，同步改由显式写操作 setSkillEnabled 负责）。
        const allSkills = skillsManager.getAllSkills();
        const enabledSkillIds = new Set(skillsManager.getEnabledSkills().map(skill => skill.id));
        const skills: SkillItem[] = allSkills.map(skill => {
            const saved = savedSkillsMap.get(skill.id);
            const enabled = conversationId
                ? (saved?.enabled ?? enabledSkillIds.has(skill.id))
                : enabledSkillIds.has(skill.id);
            const sendContent = saved?.sendContent ?? true;  // 默认发送内容 (deprecated)

            return {
                id: skill.id,
                name: skill.name,
                description: skill.description,
                enabled,
                sendContent,
                exists: true,
                source: skill.source
            };
        });
        
        // 检查已保存但不再存在的 skills (保留它们在 UI 显示为已丢失)
        for (const savedSkill of savedSkills) {
            if (!allSkills.find(s => s.id === savedSkill.id)) {
                skills.push({
                    id: savedSkill.id,
                    name: savedSkill.name,
                    description: savedSkill.description,
                    enabled: savedSkill.enabled,
                    sendContent: savedSkill.sendContent,
                    exists: false
                });
            }
        }
        
        ctx.sendResponse(requestId, { skills });
    } catch (error: any) {
        ctx.sendError(requestId, 'GET_SKILLS_CONFIG_ERROR', error.message || 'Failed to get skills config');
    }
};

/**
 * 检查 skills 是否存在
 */
export const checkSkillsExistence: MessageHandler = async (data, requestId, ctx) => {
    try {
        const skills = Array.isArray(data?.skills)
            ? data.skills.filter((skill: unknown): skill is { id: string } =>
                !!skill && typeof skill === 'object' && typeof (skill as { id?: unknown }).id === 'string')
            : [];
        const skillsManager = getSkillsManager();
        
        if (!skillsManager || skills.length === 0) {
            ctx.sendResponse(requestId, { skills: [] });
            return;
        }
        
        const skillsWithExistence = skills.map((skill: { id: string }) => {
            const exists = skillsManager.getSkill(skill.id) !== undefined;
            return { id: skill.id, exists };
        });
        
        ctx.sendResponse(requestId, { skills: skillsWithExistence });
    } catch (error: any) {
        ctx.sendError(requestId, 'CHECK_SKILLS_EXISTENCE_ERROR', error.message || 'Failed to check skills existence');
    }
};

/**
 * 更新 skill 的启用状态
 */
export const setSkillEnabled: MessageHandler = async (data, requestId, ctx) => {
    try {
        const { id, enabled, conversationId } = data;
        const normalizedConversationId = typeof conversationId === 'string' ? conversationId.trim() : '';

        // 获取实时元数据（名称、描述）
        const skillsManager = getSkillsManager();
        const skill = skillsManager?.getSkill(id);

        if (normalizedConversationId) {
            // 深拷贝后再修改：settingsManager.getSkills() 返回共享引用，浅拷贝只复制数组，
            // 原地修改 target 会污染全局内存配置并破坏对话隔离（R2-08 复查）。
            const skills = ((await getConversationSkillsRaw(ctx, normalizedConversationId))
                ?? ctx.settingsManager.getSkills())
                .map(s => ({ ...s }));

            const target = skills.find(s => s.id === id);
            if (target) {
                target.enabled = !!enabled;
                if (skill?.name) target.name = skill.name;
                if (skill?.description) target.description = skill.description;
            } else {
                skills.push({
                    id,
                    name: skill?.name || id,
                    description: skill?.description || '',
                    enabled: !!enabled,
                    sendContent: true
                });
            }

            await saveConversationSkills(ctx, normalizedConversationId, skills);
            ctx.sendResponse(requestId, { success: true });
            return;
        }
        
        // 保存到持久化配置（带上最新的名称和描述）
        await ctx.settingsManager.setSkillEnabled(id, enabled, {
            name: skill?.name,
            description: skill?.description
        });
        
        // 同步到 SkillsManager
        if (skillsManager) {
            if (enabled) {
                skillsManager.enableSkill(id);
            } else {
                skillsManager.disableSkill(id);
            }
        }
        
        // 刷新 read_skill 工具声明，使工具描述中的 Skill 列表反映最新的启用状态。
        // 不刷新的话，用户在面板中改了开关，AI 看到的可用 Skill 列表不会更新。
        toolRegistry.refreshTool('read_skill');
        
        ctx.sendResponse(requestId, { success: true });
    } catch (error: any) {
        ctx.sendError(requestId, 'SET_SKILL_ENABLED_ERROR', error.message || 'Failed to set skill enabled');
    }
};

/**
 * 移除不存在的 skill 配置
 */
export const removeSkillConfig: MessageHandler = async (data, requestId, ctx) => {
    try{
        const { id, conversationId } = data;
        const normalizedConversationId = typeof conversationId === 'string' ? conversationId.trim() : '';

        if (normalizedConversationId) {
            // 深拷贝后再过滤：避免与 SettingsManager 共享引用（同 setSkillEnabled）
            const skills = ((await getConversationSkillsRaw(ctx, normalizedConversationId))
                ?? ctx.settingsManager.getSkills())
                .map(s => ({ ...s }));

            const updated = skills.filter(s => s.id !== id);
            if (updated.length !== skills.length) {
                await saveConversationSkills(ctx, normalizedConversationId, updated);
            }
            ctx.sendResponse(requestId, { success: true });
            return;
        }

        await ctx.settingsManager.removeSkillConfig(id);
        ctx.sendResponse(requestId, { success: true });
    } catch (error: any) {
        ctx.sendError(requestId, 'REMOVE_SKILL_CONFIG_ERROR', error.message || 'Failed to remove skill config');
    }
};

/**
 * 刷新 skills 列表
 */
export const refreshSkills: MessageHandler = async (data, requestId, ctx) => {
    try {
        const skillsManager = getSkillsManager();
        
        if (skillsManager) {
            await skillsManager.refresh();
        }
        
        // 刷新 read_skill 工具声明，使新扫描到的 Skill 反映到工具描述中
        toolRegistry.refreshTool('read_skill');
        
        ctx.sendResponse(requestId, { success: true });
    } catch (error: any) {
        ctx.sendError(requestId, 'REFRESH_SKILLS_ERROR', error.message || 'Failed to refresh skills');
    }
};

/**
 * 获取 skills 目录路径
 */
export const getSkillsDirectory: MessageHandler = async (data, requestId, ctx) => {
    try {
        const skillsManager = getSkillsManager();
        
        if (skillsManager) {
            ctx.sendResponse(requestId, { path: skillsManager.getSkillsDirectory() });
        } else {
            ctx.sendResponse(requestId, { path: null });
        }
    } catch (error: any) {
        ctx.sendError(requestId, 'GET_SKILLS_DIRECTORY_ERROR', error.message || 'Failed to get skills directory');
    }
};

/**
 * 打开目录
 * 
 * 如果目录不存在则先创建，防止 revealFileInOS 对不存在路径报错
 * （用户点击"打开 Skills 目录"时，~/.graycode/skills/ 可能尚未创建）
 * 
 * 安全限制：只允许打开 skillsManager 管理的目录，拒绝任意路径
 * （webview 传入的路径不可信，任意路径意味着可在用户机器任意位置创建目录并打开）
 */
export const openDirectory: MessageHandler = async (data, requestId, ctx) => {
    try {
        const { path: dirPath } = data;
        const skillsManager = getSkillsManager();
        const allowedPath = skillsManager?.getSkillsDirectory();
        const fs = await import('fs');
        const pathMod = await import('path');

        if (typeof dirPath !== 'string' || !dirPath.trim() || typeof allowedPath !== 'string' || !allowedPath) {
            ctx.sendError(requestId, 'OPEN_DIRECTORY_DENIED', 'Only the skills directory can be opened.');
            return;
        }

        // 解析路径为绝对路径后，必须位于 allowedPath 之内（含相等）
        const resolvedTarget = pathMod.resolve(dirPath);
        const resolvedAllowed = pathMod.resolve(allowedPath);
        const withinAllowed =
            resolvedTarget === resolvedAllowed ||
            resolvedTarget.startsWith(resolvedAllowed + pathMod.sep);

        if (!withinAllowed) {
            ctx.sendError(requestId, 'OPEN_DIRECTORY_DENIED', 'Only the skills directory can be opened.');
            return;
        }

        if (!fs.existsSync(resolvedTarget)) {
            await fs.promises.mkdir(resolvedTarget, { recursive: true });
        }

        const uri = vscode.Uri.file(resolvedTarget);
        // revealFileInOS 在各平台行为一致（资源管理器中选中目标目录）；
        // env.openExternal(file uri) 在部分平台会退化为打开默认文件管理器根目录。
        await vscode.commands.executeCommand('revealFileInOS', uri);
        ctx.sendResponse(requestId, { success: true });
    } catch (error: any) {
        ctx.sendError(requestId, 'OPEN_DIRECTORY_ERROR', error.message || 'Failed to open directory');
    }
};

/**
 * 注册 Skills 处理器
 */
export function registerSkillsHandlers(registry: Map<string, MessageHandler>): void {
    registry.set('getSkillsConfig', getSkillsConfig);
    registry.set('checkSkillsExistence', checkSkillsExistence);
    registry.set('setSkillEnabled', setSkillEnabled);
    registry.set('removeSkillConfig', removeSkillConfig);
    registry.set('refreshSkills', refreshSkills);
    registry.set('getSkillsDirectory', getSkillsDirectory);
    registry.set('openDirectory', openDirectory);
}
