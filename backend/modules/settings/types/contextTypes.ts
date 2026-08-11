/**
 * GrayCode - 上下文感知（Context Awareness）与诊断相关设置类型
 *
 * 从 types.ts 拆分而来：types.ts 通过 `export *` 重导出，旧引用路径保持兼容。
 */

import { COMMON_IGNORE_PATTERNS } from './toolsTypes';

/**
 * VSCode 诊断严重程度
 *
 * 与 vscode.DiagnosticSeverity 对应：
 * - Error = 0
 * - Warning = 1
 * - Information = 2
 * - Hint = 3
 */
export type DiagnosticSeverity = 'error' | 'warning' | 'information' | 'hint';

/**
 * 诊断信息配置
 *
 * 控制是否将 VSCode 诊断信息（错误/警告/建议等）发送给 AI
 */
export interface DiagnosticsConfig {
    /**
     * 是否启用诊断信息功能
     * 默认: false
     */
    enabled: boolean;
    
    /**
     * 要包含的诊断严重程度级别
     * 默认: ['error', 'warning']
     */
    includeSeverities: DiagnosticSeverity[];
    
    /**
     * 是否只包含当前工作区的诊断
     * 默认: true
     */
    workspaceOnly: boolean;
    
    /**
     * 是否只包含打开文件的诊断
     * 默认: false
     */
    openFilesOnly: boolean;
    
    /**
     * 每个文件最大显示的诊断数量
     * -1 表示无限制
     * 默认: 10
     */
    maxDiagnosticsPerFile: number;
    
    /**
     * 最大显示的文件数量
     * -1 表示无限制
     * 默认: 20
     */
    maxFiles: number;
    
    [key: string]: unknown;
}

/**
 * 上下文感知配置
 *
 * 控制发送给 AI 的上下文信息
 */
export interface ContextAwarenessConfig {
    /**
     * 是否发送工作区文件树给 AI
     * 默认: true
     */
    includeWorkspaceFiles: boolean;
    
    /**
     * 文件层级最大深度
     * -1 表示无限制
     * 默认: 10
     */
    maxFileDepth: number;
    
    /**
     * 是否发送打开的标签页列表给 AI
     * 默认: true
     */
    includeOpenTabs: boolean;
    
    /**
     * 发送的标签页最大数量
     * -1 表示无限制
     * 默认: 20
     */
    maxOpenTabs: number;
    
    /**
     * 是否发送当前活动编辑器的路径给 AI
     * 默认: true
     */
    includeActiveEditor: boolean;
    
    /**
     * 诊断信息配置
     * 控制是否发送 VSCode 诊断信息给 AI
     */
    diagnostics?: DiagnosticsConfig;
    
    /**
     * 自定义忽略模式（支持通配符）
     * 匹配的文件/文件夹不会出现在文件树和标签页列表中
     * 例如: ["*\/node_modules", "*.log", ".git"]
     * 默认: []
     */
    ignorePatterns: string[];
    
    [key: string]: unknown;
}

/**
 * 默认诊断信息配置
 */
export const DEFAULT_DIAGNOSTICS_CONFIG: DiagnosticsConfig = {
    enabled: true,
    includeSeverities: ['error', 'warning'],
    workspaceOnly: true,
    openFilesOnly: false,
    maxDiagnosticsPerFile: 10,
    maxFiles: 20
};

/**
 * 默认上下文感知配置
 *
 * ignorePatterns 使用与 COMMON_IGNORE_PATTERNS 相同的默认规则
 */
export const DEFAULT_CONTEXT_AWARENESS_CONFIG: ContextAwarenessConfig = {
    includeWorkspaceFiles: true,
    maxFileDepth: 2,
    includeOpenTabs: true,
    maxOpenTabs: 20,
    includeActiveEditor: true,
    diagnostics: DEFAULT_DIAGNOSTICS_CONFIG,
    ignorePatterns: [...COMMON_IGNORE_PATTERNS]
};
