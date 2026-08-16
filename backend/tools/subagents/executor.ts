/**
 * SubAgents 执行器（壳模块）
 *
 * 拆分说明：实现已按职责迁移至 ./executor/ 子目录（abort 中止语义、capability 写能力口径、
 * context 上下文与工具解析、contextTrim 上下文裁剪、executeToolCall 工具执行、inbox 信箱剥离、
 * prompts 提示词组装、response 响应提取与用量归集、retry 错误重试、runLoop run 生命周期）。
 * 本文件仅保留对外导出面，既有 import（modules/api/chat、subagents 其他文件、测试）不受影响。
 */

export { SUBAGENT_TOOL_ABORT_GRACE_MS } from './executor/abort';
export {
    WRITE_CAPABILITY_TOOLS,
    agentLacksWriteCapability,
    setRunAllowedTools,
    getRunAllowedTools,
    clearRunAllowedTools
} from './executor/capability';
export {
    setSubAgentExecutorContext,
    getSubAgentExecutorContext,
    clearSharedToolResolvers,
    resolveSubAgentAvailableTools
} from './executor/context';
export { stripReplayedAgentInboxForModel } from './executor/inbox';
export {
    trimSubAgentHistoryForContext,
    compactSubAgentHistoryForContext,
    estimateSubAgentMessageTokens,
    estimateSubAgentHistoryTokens
} from './executor/contextTrim';
export { createDefaultExecutor, defaultExecutorFactory } from './executor/runLoop';
