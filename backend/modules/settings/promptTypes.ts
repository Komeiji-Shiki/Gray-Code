/**
 * GrayCode - 提示词（Prompt）相关设置类型
 *
 * 从 types.ts 拆分而来：types.ts 通过 `export *` 重导出，旧引用路径保持兼容。
 */

/**
 * 系统提示词模块定义
 *
 * 描述一个可用的提示词模块
 */
export interface PromptModule {
    /**
     * 模块 ID（唯一标识符）
     */
    id: string;
    
    /**
     * 模块名称
     */
    name: string;
    
    /**
     * 模块描述
     */
    description: string;
    
    /**
     * 使用示例
     */
    example?: string;
    
    /**
     * 是否需要特定配置才能生效
     */
    requiresConfig?: string;
}

/**
 * 动态上下文策略
 * - single: 仅存在一份动态上下文，保持当前请求插入策略
 * - preserve: 保留旧动态上下文原位不变，新回合上下文插到新回合位置
 */
export type DynamicContextStrategy = 'single' | 'preserve';

/**
 * 提示词组装方式。
 *
 * - legacy：使用传统 template / dynamicTemplate
 * - entries：使用 fast-tavern 风格 promptEntries，并由 chat_history 条目决定真实历史位置
 */
export type PromptAssemblyMode = 'legacy' | 'entries';

/**
 * 提示词预设条目类型。
 *
 * - prompt：普通提示词条目
 * - chat_history：真实聊天历史插入点
 */
export type PromptEntryType = 'prompt' | 'chat_history';

/** 预设模式中固定的聊天历史占位条目 ID。 */
export const CHAT_HISTORY_PROMPT_ENTRY_ID = 'chat-history';

/**
 * 提示词预设条目的角色。
 *
 * 普通 prompt 条目使用该角色；chat_history 条目的 role/content 会被忽略。
 * UI 使用 assistant 命名；后端发送给模型前会映射为内部 Content.role = model。
 */
export type PromptEntryRole = 'system' | 'user' | 'assistant';

/**
 * 提示词预设条目。
 *
 * 条目按 order 排序；enabled=false 时不参与组装。
 * - chat_history：真实对话历史插入点，不能发送成普通消息
 * - system：合并进系统提示词
 * - user：作为临时 user 上下文消息插入请求，不写入真实历史
 * - assistant：作为临时 model 上下文消息插入请求，不写入真实历史
 */
export interface PromptEntry {
    /** 条目 ID（同一模式内唯一） */
    id: string;

    /** 条目名称（用于显示） */
    name: string;

    /** 条目类型。旧配置未设置时视为 prompt。 */
    type?: PromptEntryType;

    /** 是否启用 */
    enabled: boolean;

    /** 条目角色 */
    role: PromptEntryRole;

    /** 提示词内容，支持 {{$MODULE}} 占位符 */
    content: string;

    /**
     * 伪造思考内容（仅 assistant 角色生效）。
     *
     * 非空时，组装请求会以 thought part（thought: true）附加在
     * 该临时 assistant 消息的正文之前，模拟一轮带思考过程的 AI 回复。
     * 是否随请求回传由渠道的 sendHistoryThoughts（发送历史思考内容）
     * 开关决定，与真实历史思考的语义保持一致。
     */
    fakeThought?: string;

    /** 排序值，小的在前 */
    order: number;
}

/**
 * 提示词模式定义
 * 
 * 每个模式包含独立的系统提示词和动态上下文配置
 */
export interface PromptMode {
    /**
     * 模式 ID（唯一标识）
     */
    id: string;
    
    /**
     * 模式名称（用于显示）
     */
    name: string;
    
    /**
     * 模式图标（codicon 名称，可选）
     */
    icon?: string;
    
    /**
     * 系统提示词模板
     */
    template: string;

    /**
     * 提示词组装方式。未设置时为 legacy，避免旧配置被 promptEntries 隐式接管。
     */
    promptAssemblyMode?: PromptAssemblyMode;
    
    /**
     * 是否启用动态上下文模板
     */
    dynamicTemplateEnabled: boolean;
    
    /**
     * 动态上下文模板
     */
    dynamicTemplate: string;

    /**
     * 动态上下文策略。未设置时继承全局 system_prompt.dynamicContextStrategy。
     */
    dynamicContextStrategy?: DynamicContextStrategy;

    /**
     * fast-tavern 风格的有序预设条目。
     *
     * 仅 promptAssemblyMode === 'entries' 时参与组装。
     */
    promptEntries?: PromptEntry[];
    
    /**
     * 工具策略（allowlist）
     * 未设置时继承 code 工具集
     */
    toolPolicy?: string[];

    /**
     * 用户是否主动定制过 toolPolicy。
     *
     * - false / undefined：未定制，运行时由内置默认 toolPolicy 填充
     * - true：用户主动设定过（含主动设为 undefined 以继承上游）
     *
     * 由 savePromptMode 在保存时由前端传入或推断设置。
     */
    toolPolicyCustomized?: boolean;
}

/**
 * 已解析的提示词模式快照
 *
 * 运行中的请求应使用这个快照，而不是读取全局当前模式。
 */
export type ResolvedPromptModeSnapshot = PromptMode;

/**
 * 系统提示词配置
 *
 * 允许用户自定义系统提示词模板
 * 支持多模式配置，不同模式可以有不同的提示词
 * 注意：此功能始终启用，不可关闭
 */
export interface SystemPromptConfig {
    /**
     * 当前激活的模式 ID
     * 默认为 'default'
     */
    currentModeId: string;
    
    /**
     * 所有模式配置
     * key 为模式 ID
     */
    modes: Record<string, PromptMode>;
    
    /**
     * 自定义提示词模板（默认模式的模板，向后兼容）
     *
     * 支持使用以下模块占位符（使用 {{$xxx}} 格式）：
     * - {{$ENVIRONMENT}} - 环境信息（工作区、操作系统、时区、语言）
     * - {{$CONTEXT_BADGE_FORMAT}} - lim-context 徽章结构说明（标题/正文/二进制标记）
     * - {{$WORKSPACE_FILES}} - 工作区文件树
     * - {{$OPEN_TABS}} - 打开的标签页
     * - {{$ACTIVE_EDITOR}} - 当前活动编辑器
     * - {{$PINNED_FILES}} - 固定文件内容
     * - {{$TOOLS}} - 工具定义（XML 或 Function Call）
     * - {{$MCP_TOOLS}} - MCP 工具定义
     *
     * 模块之间可以添加任意文字
     */
    template: string;
    
    /**
     * 自定义前缀内容
     * 在模板中使用 {{CUSTOM_PREFIX}} 引用
     */
    customPrefix: string;
    
    /**
     * 自定义后缀内容
     * 在模板中使用 {{CUSTOM_SUFFIX}} 引用
     */
    customSuffix: string;
    
    /**
     * 是否启用动态上下文模板（默认模式，向后兼容）
     *
     * 当启用时，会将动态上下文（文件树、诊断、固定文件等）作为消息发送给 AI
     * 当禁用时，不发送动态上下文消息
     *
     * 默认: true
     */
    dynamicTemplateEnabled: boolean;
    
    /**
     * 动态上下文模板（默认模式，向后兼容）
     *
     * 支持以下模块占位符（使用 {{$xxx}} 格式）：
     * - {{$WORKSPACE_FILES}} - 工作区文件树
     * - {{$OPEN_TABS}} - 打开的标签页
     * - {{$ACTIVE_EDITOR}} - 当前活动编辑器
     * - {{$DIAGNOSTICS}} - 诊断信息
     * - {{$PINNED_FILES}} - 固定文件内容
     *
     * 每次请求时动态生成，不存储到历史记录中
     */
    dynamicTemplate: string;

    /**
     * 动态上下文保留策略
     *
     * single: 仅在当前请求中插入一份动态上下文，保持现状
     * preserve: 保留每个回合缓存的动态上下文原位，不改写旧上下文
     */
    dynamicContextStrategy: DynamicContextStrategy;
    
    [key: string]: unknown;
}

/**
 * 可用的提示词模块列表
 *
 * 注意：name、description、requiresConfig 等字段将在前端通过 i18n 翻译键显示
 * 这里使用英文作为后备值
 */
export const AVAILABLE_PROMPT_MODULES: PromptModule[] = [
    {
        id: 'ENVIRONMENT',
        name: 'Environment Info',
        description: 'Contains workspace path, operating system, current time, timezone, and user language',
        example: `====

ENVIRONMENT

Current Workspace: /path/to/project
Operating System: Windows 11
Current Time: 2024-01-01T12:00:00.000Z
Timezone: Asia/Shanghai
User Language: zh-CN
Please respond using the user's language by default.`
    },
    {
        id: 'WORKSPACE_FILES',
        name: 'Workspace Files',
        description: 'Lists files and directory structure in the workspace, affected by context awareness settings',
        example: `====

WORKSPACE FILES

The following is a list of files in the current workspace:

src/
  main.ts
  utils/
    helper.ts`,
        requiresConfig: 'Context Awareness > Send Workspace Files'
    },
    {
        id: 'OPEN_TABS',
        name: 'Open Tabs',
        description: 'Lists currently open file tabs in the editor',
        example: `====

OPEN TABS

Currently open files in editor:
  - src/main.ts
  - src/utils/helper.ts`,
        requiresConfig: 'Context Awareness > Send Open Tabs'
    },
    {
        id: 'ACTIVE_EDITOR',
        name: 'Active Editor',
        description: 'Shows the currently active file path',
        example: `====

ACTIVE EDITOR

Currently active file: src/main.ts`,
        requiresConfig: 'Context Awareness > Send Active Editor'
    },
    {
        id: 'DIAGNOSTICS',
        name: 'Diagnostics',
        description: 'Shows VSCode diagnostics (errors, warnings, hints) from the workspace',
        example: `====

DIAGNOSTICS

The following diagnostics were found in the workspace:

src/main.ts:
  Line 10: [Error] Cannot find name 'foo'.
  Line 25: [Warning] 'bar' is declared but never used.

src/utils/helper.ts:
  Line 5: [Error] Property 'x' does not exist on type 'Y'.`,
        requiresConfig: 'Context Awareness > Diagnostics'
    },
    {
        id: 'PINNED_FILES',
        name: 'Pinned Files Content',
        description: 'Shows full content of user-pinned files',
        example: `====

PINNED FILES CONTENT

The following are pinned files...

--- README.md ---
# Project Title
...`,
        requiresConfig: 'Add files via the pinned files button next to input'
    },
    {
        id: 'CONTEXT_BADGE_FORMAT',
        name: 'Context Badge Format',
        description: 'Explains how <lim-context ...>...</lim-context> is structured, including title/body and binary badges',
        example: `====

CONTEXT BADGE FORMAT

<lim-context type="file" path="example-report.pdf" binary="true" title="example-report.pdf (example)">

</lim-context>

- title attribute is the chip title shown to users
- body text between tags is the actual content body
- when binary="true", body is intentionally empty and should not be parsed as text`
    },
    {
        id: 'TOOLS',
        name: 'Tools Definition',
        description: 'Generates tool definitions in XML or Function Call format based on channel config',
        example: `====

TOOLS

You have access to these tools:

## read_file
Description: Read file content
...`
    },
    {
        id: 'MCP_TOOLS',
        name: 'MCP Tools',
        description: 'Additional tool definitions from MCP servers',
        example: `====

MCP TOOLS

Additional tools from MCP servers:
...`,
        requiresConfig: 'Configure and connect servers in MCP Settings'
    }
];
