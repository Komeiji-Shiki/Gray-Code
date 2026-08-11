/**
 * GrayCode - Skills 相关设置类型
 *
 * 从 types.ts 拆分而来：types.ts 通过 `export *` 重导出，旧引用路径保持兼容。
 */

/**
 * Skills 配置项
 */
export interface SkillConfigItem {
    /**
     * Skill ID
     */
    id: string;
    
    /**
     * Skill 名称
     */
    name: string;
    
    /**
     * Skill 描述
     */
    description: string;
    
    /**
     * 是否在当前对话中启用
     */
    enabled: boolean;
    
    /**
     * @deprecated 不再使用拼接注入模式。保留字段仅为向后兼容配置解析。
     * Skills 现在通过 read_skill 工具按需读取。
     */
    sendContent: boolean;
}

/**
 * Skills 配置
 */
export interface SkillsConfig {
    /**
     * Skills 配置列表
     */
    skills: SkillConfigItem[];
    
    [key: string]: unknown;
}

/**
 * 默认 Skills 配置
 */
export const DEFAULT_SKILLS_CONFIG: SkillsConfig = {
    skills: []
};
