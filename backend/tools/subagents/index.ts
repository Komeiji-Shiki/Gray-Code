/**
 * SubAgents 工具模块
 *
 * 导出所有子代理相关的工具和类型
 */

import type { Tool } from '../types';

// 导出类型
export type {
    SubAgentType,
    SubAgentConfig,
    SubAgentRequest,
    SubAgentResult,
    SubAgentToolCall,
    SubAgentChannelConfig,
    SubAgentToolsConfig,
    SubAgentFailureModeAfterRetries,
    SubAgentRegistryEntry,
    SubAgentExecutor,
    SubAgentExecutorContext,
    SubAgentExecutorFactory
} from './types';

// F2：嵌套深度上限常量
export { MAX_SUBAGENT_NESTING_DEPTH } from './types';

// 导出注册器
export { SubAgentRegistry, subAgentRegistry } from './registry';

// 导出执行器
export {
    setSubAgentExecutorContext,
    getSubAgentExecutorContext,
    resolveSubAgentAvailableTools,
    createDefaultExecutor,
    defaultExecutorFactory
} from './executor';

// 导出并发信号量
export {
    SubAgentConcurrencyLimiter,
    SubAgentQueueCancelledError,
    subAgentConcurrencyLimiter
} from './concurrencyLimiter';

// 导出预设模板
export {
    SUB_AGENT_PRESETS,
    getSubAgentPreset,
    type SubAgentPreset
} from './presets';

// 导出运行事件总线和控制器
export {
    subAgentRunEventBus,
    SUBAGENT_RUNS_METADATA_KEY,
    type SubAgentRunEvent,
    type SubAgentRunSnapshot,
    type SubAgentRunStatus,
    type SubAgentRunManifest,
    type SubAgentRunContentWindow,
    type SubAgentRunContentWindowOptions
} from './runEventBus';
export { SubAgentTranscriptRepository } from './SubAgentTranscriptRepository';
export {
    subAgentRunController,
    type SubAgentControlAction,
    type SubAgentRunControlState
} from './runController';

// 导出工具
export { 
    createSubAgentsTool, 
    getSubAgentsTool,
    getSubAgentsToolDeclaration,
    hasAvailableSubAgent,
    refreshSubAgentsTool,
    registerSubAgents 
} from './subagents';

// 导出 agent 消息信箱（A-COMM）
export {
    agentMailbox,
    AgentMailbox,
    MAIN_SESSION_RUN_ID,
    MAIN_AGENT_NAME,
    MAX_HOP_DEPTH,
    type AgentMessage,
    type AgentSendMessageInput,
    type AgentSendMessageResult
} from './agentMailbox';

// 导出 agent.sendMessage 工具
export {
    createAgentSendMessageTool,
    getAgentSendMessageTool,
    getAgentSendMessageToolDeclaration,
    agentSendMessageHandler
} from './agentSendMessage';

/**
 * 获取所有 SubAgents 工具
 * @returns 所有 SubAgents 工具的数组
 */
export function getAllSubAgentsTools(): Tool[] {
    const { getSubAgentsTool } = require('./subagents');
    const { getAgentSendMessageTool } = require('./agentSendMessage');
    
    return [
        getSubAgentsTool(),
        getAgentSendMessageTool()
    ];
}

/**
 * 获取所有 SubAgents 工具的注册函数
 * @returns 注册函数数组
 */
export function getSubAgentsToolRegistrations() {
    const { getSubAgentsTool } = require('./subagents');
    const { getAgentSendMessageTool } = require('./agentSendMessage');
    
    return [
        getSubAgentsTool,
        getAgentSendMessageTool
    ];
}
