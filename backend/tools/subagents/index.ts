/**
 * SubAgents 工具模块
 *
 * 导出所有子代理相关的工具和类型
 */

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
    type SubAgentRunContentWindowOptions,
    type SubAgentRunConversationStore
} from './runEventBus';

// 分离转后台任务桥
export { registerDetachedSubAgentTask } from './detachedTaskBridge';
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
} from '../../core/services/agentMailbox';

// 导出 agent_send_message 工具
export {
    createAgentSendMessageTool,
    getAgentSendMessageTool,
    getAgentSendMessageToolDeclaration,
    agentSendMessageHandler
} from './agentSendMessage';

// 静态导入注册函数（与上方 re-export 共用同一模块实例，替代原函数内 require）
import { getSubAgentsTool } from './subagents';
import { getAgentSendMessageTool } from './agentSendMessage';

/**
 * 获取所有 SubAgents 工具的注册函数
 * @returns 注册函数数组
 */
export function getSubAgentsToolRegistrations() {
    return [
        getSubAgentsTool,
        getAgentSendMessageTool
    ];
}
