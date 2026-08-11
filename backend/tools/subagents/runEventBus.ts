/**
 * SubAgent 运行时事件总线（壳模块）。
 *
 * 拆分说明：实现已按职责迁移至 ./eventBus/ 子目录（types 类型/常量、protocol 事件协议、
 * transcript 转录组装、SubAgentRunEventBusCore 事件核心、persist 持久化、SubAgentRunEventBus
 * 导出类与单例）。本文件仅保留对外导出面——事件协议（subagentMonitor.event / manifest
 * 前端契约）逐字保留，既有 import（webview 面板、runController、detachedTaskBridge、
 * SubAgentTranscriptRepository、executor、测试）不受影响。
 */

export { SUBAGENT_RUNS_METADATA_KEY } from './eventBus/types';
export type {
    SubAgentRunEvent,
    SubAgentRunStatus,
    SubAgentRunPersistedRecord,
    SubAgentRunSnapshot,
    SubAgentRunManifest,
    SubAgentRunContentWindow,
    SubAgentRunContentWindowOptions,
    SubAgentRunConversationStore
} from './eventBus/types';
export { SubAgentRunEventBus, subAgentRunEventBus } from './eventBus/SubAgentRunEventBus';
