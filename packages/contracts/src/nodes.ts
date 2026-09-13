import type { ActorIdentity, RunRecord, WorkspaceDefinition } from './runtime';

/** 执行节点拥有独立存储与运行器，不能与网页登录的客户端记录混用。 */
export interface NodeGrant {
  actorId: string;
  workspaceIds: string[];
  tasks: boolean;
  computer: boolean;
}
export interface NodeListenerSettings { enabled: boolean; name: string; host: string; port: number }
export interface NodeCapabilities {
  nodeId: string; name: string; platform: string; protocol: 1;
  account: Pick<ActorIdentity, 'id' | 'displayName' | 'role'>;
  workspaces: Pick<WorkspaceDefinition, 'id' | 'name' | 'directory'>[];
  agents: { id: string; name: string }[];
  tasks: boolean; computer: boolean; screenshot: boolean;
}
export interface NodePeerSummary {
  id: string; nodeId: string; name: string; direction: 'incoming' | 'outgoing';
  state: 'online' | 'offline' | 'connecting' | 'revoked';
  createdAt: number; revokedAt?: number; lastSeenAt?: number; error?: string;
  address?: string; grant?: NodeGrant; capabilities?: NodeCapabilities;
}
export interface ExecutionNodeStatus {
  nodeId: string; settings: NodeListenerSettings; secureStorage: boolean;
  listener: { state: 'disabled' | 'listening' | 'error'; address?: string; fingerprint?: string; error?: string };
  interfaces: { name: string; address: string; internal: boolean }[];
  peers: NodePeerSummary[];
}
export interface NodeTaskInput {
  requestKey: string; workspaceId: string; agentId: string; text: string;
  /** 只能继续该配对关系已经创建的远端对话。 */
  conversationId?: string;
}
export interface NodeTaskDispatch {
  id: string; peerId: string; nodeId: string; requestKey: string; createdAt: number;
  state: 'pending' | 'accepted'; workspaceId: string; agentId: string;
  run?: RunRecord; error?: string;
}
export interface NodeTaskDiff { id: string; path: string; status: string; warning?: string }
