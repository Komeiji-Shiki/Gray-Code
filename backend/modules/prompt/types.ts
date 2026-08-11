/**
 * GrayCode - 系统提示词类型定义
 */

/**
 * 系统提示词配置
 */
export interface PromptConfig {
    /** 是否包含工作区文件树 */
    includeWorkspaceFiles?: boolean
    
    /** 文件树最大深度 */
    maxDepth?: number
    
    /** 自定义提示词前缀 */
    prefix?: string
    
    /** 自定义提示词后缀 */
    suffix?: string
}

/**
 * 系统提示词上下文
 */
export interface PromptContext {
    /** 工作区根路径 */
    workspaceRoot?: string
    
    /** 当前时间 */
    currentTime?: string
    
    /** 用户时区 */
    timezone?: string
    
    /** 操作系统 */
    os?: string
}

/**
 * 系统提示词段落
 */
export interface PromptSection {
    /** 段落ID */
    id: string
    
    /** 段落标题 */
    title?: string
    
    /** 段落内容 */
    content: string
    
    /** 优先级（数字越小优先级越高） */
    priority?: number
}

