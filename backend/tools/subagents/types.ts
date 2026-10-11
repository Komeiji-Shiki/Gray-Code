/** 平台子代理和预设共用的配置与嵌套限制。 */

export type SubAgentType = string;

export type SubAgentFailureModeAfterRetries = 'fail_parent_tool' | 'wait_for_monitor_action';

export const MAX_SUBAGENT_NESTING_DEPTH = 2;

export interface SubAgentChannelConfig {
    /** 渠道 ID（对应 ConfigManager 中的配置 ID） */
    channelId: string;
    
    /** 模型 ID（可选，使用渠道默认模型） */
    modelId?: string;

    /**
     * 是否与派发时当前会话的渠道/模型同步（逐代理开关）。
     *
     * 勾选后该子代理忽略自身固定的 channelId/modelId，运行时统一改用派发方当前
     * 正在使用的渠道与模型（channelConfigId + channelModelId），与 General Worker
     * 的继承口径一致（含 modelId——只换渠道不换模型会落到渠道默认模型，默认模型
     * 配额/权限与主模型不同时报错）。未勾选（默认）时使用自身固定渠道与模型。
     */
    syncWithCurrentModel?: boolean;
}

export interface SubAgentToolsConfig {
    /**
     * 工具过滤模式
     * - 'all': 使用所有已注册的工具（内置 + MCP）
     * - 'builtin': 仅使用内置工具
     * - 'mcp': 仅使用 MCP 工具
     * - 'whitelist': 仅使用白名单中的工具
     * - 'blacklist': 排除黑名单中的工具
     */
    mode: 'all' | 'builtin' | 'mcp' | 'whitelist' | 'blacklist';
    
    /** 工具列表（白名单/黑名单模式下使用，兼容旧版配置） */
    list?: string[];
    
    /** 工具白名单（mode 为 'whitelist' 时使用） */
    whitelist?: string[];
    
    /** 工具黑名单（mode 为 'blacklist' 时使用） */
    blacklist?: string[];
    
    /** 是否包含 MCP 工具（mode 为 'builtin' 时忽略） */
    includeMcp?: boolean;
}

export interface SubAgentConfig {
    /** 代理类型（唯一标识符） */
    type: SubAgentType;
    
    /** 代理名称（显示名称） */
    name: string;
    
    /** 代理描述（供主 AI 理解何时使用） */
    description: string;
    
    /** 代理系统提示词 */
    systemPrompt: string;
    
    /** 渠道配置（使用哪个 AI 渠道和模型） */
    channel: SubAgentChannelConfig;
    
    /** 工具配置（使用哪些工具） */
    tools: SubAgentToolsConfig;
    
    /** 最大迭代次数（防止无限循环，默认 50，-1 表示无限制） */
    maxIterations?: number;
    
    /** 最大运行时间（秒，默认 1800，-1 表示无限制） */
    maxRuntime?: number;

    /**
     * Provider 自动重试耗尽后的处理策略。
     *
     * 修改原因：单个 SubAgent 需要能覆盖全局默认策略，决定失败后是否等待 Monitor 操作。
     * 修改方式：字段保持可选，运行时由 settings 全局默认值补齐。
     * 修改目的：兼容旧配置，并为后续暂停/等待状态机提供明确策略输入。
     */
    failureModeAfterRetries?: SubAgentFailureModeAfterRetries;
    
    /** 是否启用（禁用的代理不会出现在工具列表中） */
    enabled?: boolean;
}
