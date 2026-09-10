import type { AgentDefinition, ModelInput, PlatformMessage, WorkspaceDefinition, SavedRunConfiguration } from '@graycode/contracts';
import type { SubAgentRunStatus } from '../../../../backend/tools/subagents/eventBus/types';
export interface PlatformSubagent {
  id: string;
  parentConversationId: string;
  parentRunId?: string;
  sourceToolCallId?: string;
  conversationId: string;
  actorId: string;
  agentName: string;
  profile: AgentDefinition;
  selection: Pick<ModelInput, 'providerId' | 'modelOverride' | 'reasoningEffort'>;
  invocation: PlatformMessage;
  /** 排队、后台执行和继续该子任务时均保留派发时的目录。 */
  workspace?: WorkspaceDefinition | null;
  /** 旧记录首次接续后的稳定对应关系，原始存档保持独立可读。 */
  legacyOrigin?: { conversationId: string; runId: string };
  /** 直接从历史监视器启动时，保存主人已选定的主对话配置。 */
  parentConfiguration?: SubagentParentConfiguration;
  depth: number;
  background: boolean;
  taskId?: string;
  createdAt: number;
  updatedAt: number;
  status: SubAgentRunStatus;
  contentRevision: number;
  eventSequence: number;
  contentCount: number;
  coreRunIds: string[];
  maxRuntime: number;
  failureMode: 'fail_parent_tool' | 'wait_for_monitor_action';
  error?: string;
}

export interface SubagentParentConfiguration { agentId: string; configuration: SavedRunConfiguration }
export interface SubagentLaunchContext {
  actorId: string; conversationId: string; runId?: string; toolCallId?: string;
  agent: AgentDefinition;
  modelSelection: Pick<ModelInput, 'providerId' | 'modelOverride' | 'reasoningEffort'>;
  workspace?: WorkspaceDefinition;
  parentConfiguration?: SubagentParentConfiguration;
}
