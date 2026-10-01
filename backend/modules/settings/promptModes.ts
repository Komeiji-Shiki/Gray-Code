/**
 * GrayCode - 内置提示词模式定义
 *
 * 模板正文在 shared/defaultPromptTemplates.ts，本文件只组合模式、工具范围与默认配置。
 * types.ts 通过 `export * from './promptModes'` 重导出，旧引用路径保持兼容。
 */

import type { PromptMode, SystemPromptConfig } from './types';
import { MEMORY_TOOL_NAMES } from '../memory/types';
import {
    CODE_MODE_TEMPLATE,
    DESIGN_MODE_TEMPLATE,
    PLAN_MODE_TEMPLATE,
    ASK_MODE_TEMPLATE,
    REVIEW_MODE_TEMPLATE,
    DEFAULT_DYNAMIC_CONTEXT_TEMPLATE
} from '../../../shared/defaultPromptTemplates';

// 模板文本统一维护在 shared，设置界面的“恢复默认”与后端默认值同源。
export {
    CODE_MODE_TEMPLATE,
    DESIGN_MODE_TEMPLATE,
    PLAN_MODE_TEMPLATE,
    ASK_MODE_TEMPLATE,
    REVIEW_MODE_TEMPLATE,
    DEFAULT_DYNAMIC_CONTEXT_TEMPLATE
} from '../../../shared/defaultPromptTemplates';

/**
 * 默认静态系统提示词模板（历史导出名）。
 *
 * 与实际默认 Code 模式保持同一来源，避免旧调用方拿到不同于“恢复默认”的模板。
 */
export const DEFAULT_SYSTEM_PROMPT_TEMPLATE = CODE_MODE_TEMPLATE;


/**
 * 默认模式 ID（代码模式）
 */
export const DEFAULT_MODE_ID = 'code';

/**
 * 设计模式 ID
 */
export const DESIGN_MODE_ID = 'design';

/**
 * 计划模式 ID
 */
export const PLAN_MODE_ID = 'plan';

/**
 * 询问模式 ID
 */
export const ASK_MODE_ID = 'ask';

/**
 * 审查模式 ID
 */
export const REVIEW_MODE_ID = 'review';

/**
 * 代码模式（默认模式）
 */
export const CODE_PROMPT_MODE: PromptMode = {
    id: DEFAULT_MODE_ID,
    name: 'Code',
    icon: 'code',
    template: CODE_MODE_TEMPLATE,
    promptAssemblyMode: 'legacy',
    dynamicTemplateEnabled: true,
    dynamicTemplate: DEFAULT_DYNAMIC_CONTEXT_TEMPLATE
};

/**
 * 设计模式
 */
export const DESIGN_PROMPT_MODE: PromptMode = {
    id: DESIGN_MODE_ID,
    name: 'Design',
    icon: 'lightbulb',
    template: DESIGN_MODE_TEMPLATE,
    promptAssemblyMode: 'legacy',
    dynamicTemplateEnabled: true,
    dynamicTemplate: DEFAULT_DYNAMIC_CONTEXT_TEMPLATE,
    toolPolicy: [
        'read_file',
        'list_files',
        'find_files',
        'search_in_files',
        'goto_definition',
        'find_references',
        'get_symbols',
        'history_search',
        'todo_write',
        'todo_update',
        'create_progress',
        'update_progress',
        'record_progress_milestone',
        'validate_progress_document',
        'subagents',
        'create_design',
        'update_design',
        ...MEMORY_TOOL_NAMES
    ]
};

/**
 * 计划模式
 */
export const PLAN_PROMPT_MODE: PromptMode = {
    id: PLAN_MODE_ID,
    name: 'Plan',
    icon: 'list-unordered',
    template: PLAN_MODE_TEMPLATE,
    promptAssemblyMode: 'legacy',
    dynamicTemplateEnabled: true,
    dynamicTemplate: DEFAULT_DYNAMIC_CONTEXT_TEMPLATE,
    toolPolicy: [
        'read_file',
        'list_files',
        'find_files',
        'search_in_files',
        'goto_definition',
        'find_references',
        'get_symbols',
        'history_search',
        'todo_write',
        'todo_update',
        'create_progress',
        'update_progress',
        'record_progress_milestone',
        'validate_progress_document',
        'subagents',
        'create_plan',
        'update_plan',
        ...MEMORY_TOOL_NAMES
    ]
};

/**
 * 询问模式
 */
export const ASK_PROMPT_MODE: PromptMode = {
    id: ASK_MODE_ID,
    name: 'Ask',
    icon: 'question',
    template: ASK_MODE_TEMPLATE,
    promptAssemblyMode: 'legacy',
    dynamicTemplateEnabled: true,
    dynamicTemplate: DEFAULT_DYNAMIC_CONTEXT_TEMPLATE,
    toolPolicy: [
        'read_file',
        'list_files',
        'find_files',
        'search_in_files',
        'goto_definition',
        'find_references',
        'get_symbols',
        'history_search',
        'todo_write',
        'todo_update',
        'subagents'
    ]
};

/**
 * 审查模式
 */
export const REVIEW_MODE_TOOL_POLICY: string[] = [
    'read_file',
    'list_files',
    'find_files',
    'search_in_files',
    'goto_definition',
    'find_references',
    'get_symbols',
    'history_search',
    'subagents',
    'create_review',
    'validate_review_document',
    'create_progress',
    'update_progress',
    'record_progress_milestone',
    'validate_progress_document',
    'record_review_milestone',
    'finalize_review',
    'reopen_review',
    ...MEMORY_TOOL_NAMES
];

export const REVIEW_PROMPT_MODE: PromptMode = {
    id: REVIEW_MODE_ID,
    name: 'Review',
    icon: 'eye',
    template: REVIEW_MODE_TEMPLATE,
    promptAssemblyMode: 'legacy',
    dynamicTemplateEnabled: true,
    dynamicTemplate: DEFAULT_DYNAMIC_CONTEXT_TEMPLATE,
    toolPolicy: REVIEW_MODE_TOOL_POLICY
};

/**
 * 默认提示词模式（向后兼容）
 */
export const DEFAULT_PROMPT_MODE = CODE_PROMPT_MODE;

/**
 * 内置模式的默认 toolPolicy 映射。
 *
 * key 为内置模式 ID，value 为默认工具策略列表。
 * 当用户未主动定制 toolPolicy（toolPolicyCustomized !== true）时，
 * 运行时从该映射拉取默认值。
 */
export const BUILTIN_MODE_TOOL_POLICIES: Record<string, readonly string[]> = {
    [DESIGN_MODE_ID]: DESIGN_PROMPT_MODE.toolPolicy || [],
    [PLAN_MODE_ID]: PLAN_PROMPT_MODE.toolPolicy || [],
    [ASK_MODE_ID]: ASK_PROMPT_MODE.toolPolicy || [],
    [REVIEW_MODE_ID]: REVIEW_PROMPT_MODE.toolPolicy || [],
};

/**
 * 默认系统提示词配置
 */
export const DEFAULT_SYSTEM_PROMPT_CONFIG: SystemPromptConfig = {
    currentModeId: DEFAULT_MODE_ID,
    modes: {
        [DEFAULT_MODE_ID]: CODE_PROMPT_MODE,
        [DESIGN_MODE_ID]: DESIGN_PROMPT_MODE,
        [PLAN_MODE_ID]: PLAN_PROMPT_MODE,
        [ASK_MODE_ID]: ASK_PROMPT_MODE,
        [REVIEW_MODE_ID]: REVIEW_PROMPT_MODE
    },
    template: CODE_MODE_TEMPLATE,
    dynamicTemplateEnabled: true,
    dynamicTemplate: DEFAULT_DYNAMIC_CONTEXT_TEMPLATE,
    dynamicContextStrategy: 'preserve',
    customPrefix: '',
    customSuffix: ''
};
