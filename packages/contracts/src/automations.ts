import type { SavedRunConfiguration, RunStatus, WorkspaceDefinition } from './runtime';
import type { ProviderDefinition } from './providers';

export type AutomationSchedule =
  | { type: 'once'; at: number }
  | { type: 'interval'; everyMinutes: number; startAt: number }
  | { type: 'daily'; time: string; timeZone: string; weekDays?: number[] };

export interface AutomationUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  requests: number;
  estimatedRequests: number;
  unknownRequests: number;
}

export type AutomationStatus = 'active' | 'paused' | 'completed';
export type AutomationPauseReason = 'user' | 'restart' | 'error' | 'input';

export interface AutomationRecord {
  version: 1;
  id: string;
  kind: 'goal' | 'schedule';
  name: string;
  objective: string;
  conversationId: string;
  actorId: string;
  agentId: string;
  configuration: SavedRunConfiguration;
  status: AutomationStatus;
  createdAt: number;
  updatedAt: number;
  usage: AutomationUsage;
  schedule?: AutomationSchedule;
  missedRunPolicy?: 'skip' | 'once';
  nextRunAt?: number;
  currentRequestKey?: string;
  currentRunId?: string;
  lastRunId?: string;
  completedRuns: number;
  progress?: string;
  pauseReason?: AutomationPauseReason;
  error?: string;
  completedAt?: number;
  /** 模型报告完成或需要输入后，在本轮工具结果保存完毕时结束当前运行。 */
  finishRunId?: string;
  finishStatus?: 'completed' | 'paused';
  awaitingBackground?: boolean;
  followupPending?: boolean;
  /** 用户编辑了目标，下一轮作为新的用户输入捕获角色、世界书和动态上下文。 */
  pendingObjectiveChange?: boolean;
}

export interface AutomationCreate {
  kind: AutomationRecord['kind'];
  name: string;
  objective: string;
  conversationId?: string;
  workspaceId?: string;
  agentId: string;
  providerId: string;
  modelOverride?: string;
  reasoningEffort?: string;
  promptModeId?: string;
  schedule?: AutomationSchedule;
  missedRunPolicy?: 'skip' | 'once';
}

export interface AutomationView extends AutomationRecord { runStatus?: RunStatus }
export interface AutomationOptions {
  agents: { id: string; name: string }[];
  providers: ProviderDefinition[];
  workspaces: WorkspaceDefinition[];
  promptModes: { id: string; name: string }[];
  current: { conversationId?: string; workspaceId?: string; agentId: string; providerId: string; modelId: string; promptModeId: string; reasoningEffort?: string };
}
