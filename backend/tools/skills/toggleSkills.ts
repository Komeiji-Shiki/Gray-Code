/**
 * LimCode - Skills Toggle Tool
 *
 * Allows AI to dynamically toggle whether to send skill content
 * Tool parameters are dynamically generated, each parameter corresponds to a skill
 */

import type { Tool, ToolDeclaration, ToolResult, ToolRegistration } from '../types';
import { getSkillsManager } from '../../modules/skills';

/**
 * 将技能名清洗为 Claude API 兼容的参数名
 * 
 * Claude API 要求工具名和参数名匹配 ^[a-zA-Z0-9_-]{1,64}$
 * 对于包含非 ASCII 字符的技能名（如中文），需要转换为安全的 ASCII 标识符
 * 
 * @param name 原始技能名
 * @returns 清洗后的 ASCII 安全参数名
 */
function sanitizeParamName(name: string): string {
    // 如果已经是合法的 ASCII 参数名，直接返回
    if (/^[a-zA-Z0-9_-]+$/.test(name)) {
        return name;
    }
    
    // 将非 ASCII 字符替换为下划线，合并连续下划线，去除首尾下划线
    let sanitized = name.replace(/[^a-zA-Z0-9_-]/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '');
    
    // 如果清洗后为空（全是非 ASCII 字符），使用 skill_ 前缀加哈希
    if (!sanitized) {
        // 简单哈希：将每个字符的 charCode 求和取模
        let hash = 0;
        for (let i = 0; i < name.length; i++) {
            hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
        }
        sanitized = `skill_${Math.abs(hash).toString(36)}`;
    }
    
    // 确保以字母开头（JSON Schema 属性名最佳实践）
    if (/^[0-9]/.test(sanitized)) {
        sanitized = `s_${sanitized}`;
    }
    
    return sanitized;
}

/**
 * Dynamically generate skills tool declaration
 *
 * Generate tool parameters based on currently enabled skills
 * Only enabled skills are included in the tool parameters
 */
export function generateSkillsToolDeclaration(): ToolDeclaration {
    const skillsManager = getSkillsManager();
    const properties: Record<string, any> = {};
    
    if (skillsManager) {
        // Only include enabled skills in tool parameters
        const enabledSkills = skillsManager.getEnabledSkills();
        
        for (const skill of enabledSkills) {
            // 清洗参数名以确保 Claude API 兼容性
            // 非 ASCII 字符（如中文技能名）会被转换为安全的 ASCII 标识符
            const paramName = sanitizeParamName(skill.name);
            properties[paramName] = {
                type: 'boolean',
                description: skill.description
            };
        }
    }
    
    return {
        name: 'toggle_skills',
        description: 'Toggle whether to send skill content to the conversation. Skills are user-defined knowledge modules that provide specialized context and instructions. Each parameter is a skill name - set to true to send content, false to stop sending. The skill content will be included in subsequent messages. Enable a skill when you need its specific content for the current task; disable it when no longer needed to save conversation space.',
        category: 'skills',
        parameters: {
            type: 'object',
            properties,
            required: []  // All parameters are optional
        }
    };
}

/**
 * Skills toggle tool handler function
 */
async function handleToggleSkills(args: Record<string, boolean>): Promise<ToolResult> {
    const skillsManager = getSkillsManager();
    
    if (!skillsManager) {
        return {
            success: false,
            error: 'Skills manager not initialized'
        };
    }
    
    // Track not found skills
    const notFound: string[] = [];
    
    // 构建双向映射：sanitized name -> skill id, original name -> skill id
    // 这样无论 AI 使用原始名还是清洗后的名称调用，都能正确找到技能
    const skills = skillsManager.getAllSkills();
    const paramToId: Record<string, string> = {};
    for (const skill of skills) {
        // 用清洗后的名称作为主键（与 tool declaration 中一致）
        const paramName = sanitizeParamName(skill.name);
        paramToId[paramName] = skill.id;
        // 同时保留原始名称映射，增强容错
        paramToId[skill.name] = skill.id;
    }
    
    // Process each argument
    for (const [name, shouldSend] of Object.entries(args)) {
        const skillId = paramToId[name];
        
        if (!skillId) {
            notFound.push(name);
            continue;
        }
        
        // 1. 同步到内存状态 (SkillsManager)
        skillsManager.setSkillSendContent(skillId, shouldSend);
        
        // 2. 持久化到设置 (SettingsManager)
        // 获取全局 settingsManager 引用
        const { getGlobalSettingsManager } = await import('../../core/settingsContext');
        const settingsManager = getGlobalSettingsManager();
        if (settingsManager) {
            // 注意：这里由于 skillId 已经从 skillsManager 获取，肯定存在
            // 我们通过 settingsManager 保存启用状态，并同步最新的元数据
            const skill = skillsManager.getSkill(skillId);
            await settingsManager.setSkillSendContent(skillId, shouldSend, {
                name: skill?.name,
                description: skill?.description
            });
        }
    }
    
    // If some skills not found, return partial success
    if (notFound.length > 0) {
        return {
            success: true,
            error: `Some skills not found: ${notFound.join(', ')}`
        };
    }
    
    return {
        success: true
    };
}

/**
 * Get Skills tool
 *
 * Returns dynamically generated skills toggle tool
 */
export function getSkillsTool(): Tool {
    return {
        declaration: generateSkillsToolDeclaration(),
        handler: handleToggleSkills
    };
}

/**
 * Get Skills tool registration function
 */
export function getSkillsToolRegistration(): ToolRegistration {
    return () => getSkillsTool();
}

/**
 * Check if there are enabled skills
 *
 * If no skills are enabled, this tool should not be sent
 */
export function hasAvailableSkills(): boolean {
    const skillsManager = getSkillsManager();
    return skillsManager !== null && skillsManager.getEnabledSkills().length > 0;
}
