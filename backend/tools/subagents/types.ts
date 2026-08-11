/**
 * SubAgents 工具类型定义
 *
 * 定义子代理的类型和接口
 */

import type { ResolvedPromptModeSnapshot } from '../../modules/settings/types';
import type { ChannelManager } from '../../modules/channel/ChannelManager';
import type { ToolRegistry } from '../ToolRegistry';
import type { McpManager } from '../../modules/mcp/McpManager';
import type { SettingsManager } from '../../modules/settings/SettingsManager';
import type { ConfigManager } from '../../modules/config/ConfigManager';
import type { ToolExecutionService } from '../../modules/api/chat/services/ToolExecutionService';
import type { UsageIndexMessage } from '../../modules/conversation/usageStats';

/**
 * 子代理类型
 * 
 * 可以通过 subAgentRegistry.register() 动态添加更多类型
 */
export type SubAgentType = string;

/**
 * Provider 自动重试耗尽后的 SubAgent 处理策略。
 *
 * 修改原因：SubAgent 复用 ChannelManager 自动重试后，仍需要决定重试耗尽时主工具是否立即失败。
 * 修改方式：在 SubAgent 运行时类型中声明同一组稳定枚举值，与 SettingsManager 的持久化字段保持一致。
 * 修改目的：让 executor、registry 和 Monitor 控制器共享同一语义，避免字符串特判散落。
 */
export type SubAgentFailureModeAfterRetries = 'fail_parent_tool' | 'wait_for_monitor_action';

/**
 * 子代理嵌套深度上限（F2：子 agent 开子子 agent）。
 *
 * 深度以 0 为基准：主模型=0，子 agent=1，子子 agent=2。
 * 派生子 agent 时 depth = 父 depth + 1；超过本上限（depth > 2）的嵌套派发会被拒绝并返回明确错误。
 */
export const MAX_SUBAGENT_NESTING_DEPTH = 2;

/**
 * 子代理渠道配置
 * 
 * 指定子代理使用的 AI 渠道和模型
 */
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

/**
 * 子代理工具配置
 * 
 * 控制子代理可使用的工具
 */
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

/**
 * 子代理配置
 */
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

/**
 * 子代理执行请求
 */
export interface SubAgentRequest {
    /** 代理类型 */
    agentType: SubAgentType;
    
    /** 用户提示词 */
    prompt: string;
    
    /** 附加上下文（可选） */
    context?: string;

    /**
     * 外部预分配的 SubAgent 运行实例 ID。
     *
     * 修改原因：主窗口工具卡片在 pending 阶段还没有 ToolResult，但需要立即显示并打开 Open details。
     * 修改方式：subagents handler 根据主工具调用 id 预先生成 runId，再交给默认 executor 使用。
     * 修改目的：pending、完成态和历史态都用同一个 runId 打开同一次 Monitor 运行。
     */
    runId?: string;

    /**
     * 是否后台模式（background: true 的 subagents 调用）。
     *
     * 修改原因：前台 SubAgent 的 abort 信号挂在主会话工具循环上，用户发新消息时旧流被 abort
     * 会连带杀掉前台 SubAgent；转后台（detach）机制需要区分前台/后台——后台 run 本就使用
     * 独立 AbortController，不应被 detach 影响（否则用户无法通过 TaskManager 取消后台任务）。
     */
    background?: boolean;

    /**
     * 延续之前的子代理对话的 runId。
     *
     * 当指定此参数时，新子代理会继承旧 run 的完整对话历史（transcript），
     * 而不是从零开始。旧 run 必须处于终态（completed / failed / cancelled），
     * 如果仍在运行中则拒绝延续。
     */
    continueFromRunId?: string;

    /**
     * 当前主对话 ID（每次工具调用由 handler 填充）。
     *
     * 修改原因：subagents 工具每次调用都携带当前会话上下文，默认 executor
     * 用它做 run 持久化归属和跨对话接续校验（F-06/F-09），自定义 executor
     * 也可以据此遵守会话边界。
     * 修改方式：request 字段优先于创建 executor 时的静态 context。
     */
    conversationId?: string;

    /** 对话元数据存储（当前调用携带，接续时只加载当前对话的持久化 run 快照） */
    conversationStore?: {
        getCustomMetadata(conversationId: string, key: string): Promise<unknown>;
        setCustomMetadata(conversationId: string, key: string, value: unknown): Promise<void>;
    };

    /** 父请求继承的提示词模式快照（当前调用携带） */
    promptModeSnapshot?: ResolvedPromptModeSnapshot;

    /**
     * 本 run 的嵌套深度（主模型=0，子 agent=1，子子 agent=2）。
     *
     * 修改原因（F2）：子 agent 可以再开子 agent，深度必须随 run 上下文逐层 +1，
     * 用于超限拒绝与 Monitor 元数据展示；缺省按 0（主模型直接派发）处理。
     *
     * L-8（R4 复查）：本字段仅允许框架注入——subagents handler 按
     * `context.subagentDepth + 1` 计算后传入，模型不可控；模型传入的值
     * 会被 executor 规范化为非负整数（非法值按 0 处理），不构成提权面。
     */
    depth?: number;

    /**
     * 派生本 run 的父 run 的 runId（主模型直接派发时缺省）。
     *
     * 修改原因（F2）：父 run 结束时需要级联清理其派生的子 run（含排队/后台），
     * 子 run 也要能把自己从父 run 的派生列表里摘除。
     */
    parentRunId?: string;

    /**
     * 继承自父 run 的可用工具限制（H-1，R4 复查）。
     *
     * 嵌套派发时由 subagents handler 从父 run 的可用工具集复制（仅框架注入，
     * 模型不可控）；executor 解析出本 run 的工具后取交集：
     * `最终可用工具 = 自身配置解析结果 ∩ inheritedToolFilter`，
     * 防止 mode='all' 的 General Worker（或其他子代理）获得父代理自身
     * 没有的写/执行权限。主模型直接派发时缺省（不限制）。
     */
    inheritedToolFilter?: string[];
}

/**
 * 工具调用记录
 */
export interface SubAgentToolCall {
    /** 工具名称 */
    tool: string;
    
    /** 工具参数 */
    args: Record<string, unknown>;
    
    /** 执行结果 */
    result: unknown;
    
    /** 是否成功 */
    success: boolean;
    
    /** 执行时间（毫秒） */
    duration?: number;
}

/**
 * 子代理执行结果
 */
export interface SubAgentResult {
    /** 是否成功 */
    success: boolean;
    
    /** 代理响应内容 */
    response?: string;

    /**
     * 实际模型版本（优先使用渠道返回的 modelVersion）
     *
     * 用于在 UI 中展示“子代理实际运行的模型”
     */
    modelVersion?: string;
    
    /** 执行步骤数 */
    steps?: number;

    /**
     * SubAgent 运行实例 ID。
     *
     * 修改原因：主聊天工具块和 SubAgent Monitor 需要用同一个稳定 ID 定位运行过程。
     * 修改方式：由默认执行器创建 runId，并随最终结果返回。
     * 修改目的：不把内部事件写入主历史，也能从主卡片打开对应的运行详情。
     */
    runId?: string;
    
    /** 使用的工具调用记录 */
    toolCalls?: SubAgentToolCall[];
    
    /** 错误信息 */
    error?: string;
    
    /** 是否被取消 */
    cancelled?: boolean;
}

/**
 * 子代理执行上下文
 * 
 * 提供执行器所需的依赖
 */
export interface SubAgentExecutorContext {
    /** 渠道管理器（用于调用 AI） */
    channelManager: ChannelManager;
    
    /** 工具注册器（用于获取内置工具） */
    toolRegistry: ToolRegistry;
    
    /** MCP 管理器（用于获取 MCP 工具） */
    mcpManager?: McpManager;
    
    /** 设置管理器 */
    settingsManager?: SettingsManager;

    /**
     * 配置管理器。
     *
     * 修改原因：SubAgent 的 provider 配置独立于主会话，但工具执行仍需要读取该 provider 的多模态和 toolMode 能力。
     * 修改方式：把 ConfigManager 注入执行上下文，由 SubAgent 在每次 run 中解析自己的 channel 配置。
     * 修改目的：避免 SubAgent 工具执行时因拿不到渠道配置而退化为 multimodalEnabled=false。
     */
    configManager?: ConfigManager;

    /**
     * 共享工具执行服务。
     *
     * 修改原因：SubAgent 不能再复制 ToolExecutionService 的工具参数校验、MCP、多模态打包和工具配置注入逻辑。
     * 修改方式：通过上下文注入 ChatHandler 持有的 ToolExecutionService 实例；执行时仍传入 SubAgent 自己的 provider 配置。
     * 修改目的：共享工具执行内核，但保持 SubAgent 模型能力、toolMode 和多模态开关独立于主会话。
     */
    toolExecutionService?: ToolExecutionService;

    /** 对话 ID，用于把 SubAgent 内部记录保存到 conversation 子记录 */
    conversationId?: string;

    /** 对话元数据存储，用于保存 subAgentRuns 子记录 */
    conversationStore?: {
        getCustomMetadata(conversationId: string, key: string): Promise<unknown>;
        setCustomMetadata(conversationId: string, key: string, value: unknown): Promise<void>;
    };

    /** 父请求继承下来的提示词模式快照（可选） */
    promptModeSnapshot?: ResolvedPromptModeSnapshot;

    /**
     * 用量归集回调（可选）：把子代理消耗的 token 追加到主会话的用量索引。
     *
     * 修改原因：子代理的 token 消耗此前不进入任何用量统计，UsagePage 看不到子代理开销。
     * 修改方式：由宿主（ChatViewProvider）注入 ConversationManager 的归集入口；
     *          未注入或主会话归属缺失时跳过归集（不写索引）。
     */
    usageIndexAppend?: (conversationId: string, messages: UsageIndexMessage[]) => Promise<void>;
}

/**
 * 子代理注册表项
 */
export interface SubAgentRegistryEntry {
    /** 代理配置 */
    config: SubAgentConfig;
    
    /** 代理执行器（可选，使用默认执行器） */
    executor?: SubAgentExecutor;
}

/**
 * 子代理执行器函数类型
 */
export type SubAgentExecutor = (
    request: SubAgentRequest,
    abortSignal?: AbortSignal
) => Promise<SubAgentResult>;

/**
 * 子代理执行器工厂函数类型
 * 
 * 用于创建带上下文的执行器
 */
export type SubAgentExecutorFactory = (
    config: SubAgentConfig,
    context: SubAgentExecutorContext
) => SubAgentExecutor;
