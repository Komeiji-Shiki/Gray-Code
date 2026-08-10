/**
 * Pinia Stores 统一导出
 */

export { useChatStore } from './chatStore'
export type { Conversation } from './chatStore'

export { useSettingsStore } from './settingsStore'
export type { SettingsTab } from './settingsStore'

export { useTerminalStore } from './terminalStore'
export type { TerminalOutputEvent, TerminalState } from './terminalStore'

export { useBackgroundTaskStore } from './backgroundTaskStore'

export {
  isBackgroundStartEvent,
  taskRecordFromStartEvent,
  applyCompletionEvent,
  buildCompletionReport
} from './backgroundTasks/reportBuilder'
export type {
  BackgroundTaskKind,
  BackgroundTaskStatus,
  BackgroundTaskRecord,
  TaskEventLike
} from './backgroundTasks/reportBuilder'

export {
  getAgentRunEventId,
  getAgentRunToolStableId,
  getAgentRunToolMatchCandidates
} from './agentRun/events'
export type {
  AgentRunEventSource,
  AgentRunLifecycleStatus,
  AgentRunEventEnvelope,
  AgentRunStartedEvent,
  AgentRunStatusChangedEvent,
  AgentRunMessageSnapshotEvent,
  AgentRunMessageTextDeltaEvent,
  AgentRunMessageFunctionCallDeltaEvent,
  AgentRunToolStatusPatch,
  AgentRunToolStatusEvent,
  AgentRunToolResultEvent,
  AgentRunEvent,
  AgentRunToolExecutionState,
  AgentRunState,
  AgentRunToolIdentity
} from './agentRun/events'

export {
  createInitialAgentRunState,
  replayAgentRunEvents,
  reduceAgentRunEvent
} from './agentRun/reducer'

export { selectMainChatView, selectSubAgentMonitorView } from './agentRun/selectors'
export type { MainChatView, SubAgentMonitorView } from './agentRun/selectors'
