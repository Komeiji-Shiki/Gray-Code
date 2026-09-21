export interface ExternalAgentProfile {
  id: string;
  name: string;
  enabled: boolean;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface ExternalAgentSession {
  id: string;
  profileId: string;
  profileName: string;
  actorId: string;
  workspaceId: string;
  directory: string;
  remoteSessionId?: string;
  status: 'idle' | 'running' | 'interrupted' | 'closed' | 'error';
  createdAt: number;
  updatedAt: number;
  lastRunId?: string;
  lastEvent: number;
  agentInfo?: { name: string; version: string };
  capabilities?: Record<string, unknown>;
  configOptions?: unknown[];
  modes?: unknown;
  error?: string;
}

export interface ExternalAgentEvent {
  sessionId: string;
  sequence: number;
  timestamp: number;
  runId?: string;
  type: string;
  data: unknown;
}
