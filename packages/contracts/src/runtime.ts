import type { PlatformMessage } from './index';

export type ToolEffect = 'public_read' | 'workspace_read' | 'workspace_write' | 'process_execute'
  | 'external_send' | 'data_delete' | 'private_browser' | 'desktop_control' | 'administration' | 'high_risk';
export type ApprovalMode = 'sensitive' | 'all_mutations';
export type AccountRole = 'owner' | 'member' | 'guest';

/** Created by a trusted adapter after authenticating the request or platform event. */
export interface ActorIdentity {
  id: string;
  displayName: string;
  role: AccountRole;
  effects: ToolEffect[];
  workspaceIds: string[] | '*';
  /** 默认允许当前 Bot 会话的专用目录，仍需具备相应的读写操作权限。 */
  botWorkspaceAccess?: boolean;
  /** 配置后只允许列出的 MCP 工具；未配置的旧账号继续使用原操作权限。 */
  mcpTools?: string[];
  /** 默认访客的权限模板账号；实际发言人仍使用独立的运行身份。 */
  permissionAccountId?: string;
  revoked?: boolean;
}

export interface WorkspaceRootDefinition { name: string; directory: string }
export interface WorkspaceDefinition {
  id: string; name: string; directory: string; deviceId: string;
  /** 对话自动创建的目录与手动添加的项目共用文件能力，但不列为独立项目。 */
  managedConversationId?: string;
  /** 完整目录列表，首项为命令等操作的默认目录；旧单目录记录继续使用 directory。 */
  roots?: WorkspaceRootDefinition[];
}
export interface ToolDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
export interface AgentDefinition {
  /** 智能体预先配置的模型；调用者临时覆盖仍单独校验权限。 */
  modelId?: string;
  promptModeId?: string;
  id: string;
  name: string;
  providerId: string;
  systemPrompt: string;
  toolNames: string[];
  approvalMode: ApprovalMode;
  toolApproval?: Record<string, 'auto' | 'ask' | 'deny'>;
  reviewerProviderId?: string;
  /** 缺省按操作类型审核；空数组不审核工具，明确列表只审核所选工具。 */
  reviewerToolNames?: string[];
  maxIterations: number;
}
export type RunStatus = 'queued' | 'running' | 'awaiting_approval' | 'awaiting_input' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export interface RunRecord {
  /** 实际运行器的设备身份，以及由配对服务捕获的发起设备。旧记录没有这些字段。 */
  executionNodeId?: string;
  nodeOrigin?: { peerId: string; controllerNodeId: string };
  /** 由宿主捕获的自动任务归属，公开运行请求不能指定。 */
  automationId?: string;
  id: string;
  requestKey: string;
  conversationId: string;
  actorId: string;
  agentId: string;
  workspaceId?: string;
  status: RunStatus;
  createdAt: number;
  updatedAt: number;
  error?: string;
  iteration: number;
  catalogVersion: string;
  continuationOf?: string;
}
export interface SavedRunConfiguration {
  nodeOrigin?: RunRecord['nodeOrigin'];
  automationId?: string;
  providerId: string; modelOverride?: string; reasoningEffort?: string; promptModeId?: string;
  /** 自动继续沿用原目录；null 表示原任务没有工作区，缺省只用于旧记录。 */
  workspace?: WorkspaceDefinition | null;
}
export interface RunEvent {
  runId: string;
  sequence: number;
  timestamp: number;
  type: 'run.created' | 'run.started' | 'run.completed' | 'run.failed' | 'run.cancelled' | 'run.interrupted'
    | 'message.saved' | 'tool.started' | 'tool.completed' | 'approval.requested' | 'approval.resolved'
    | 'question.asked' | 'question.answered' | 'question.expired' | 'run.waiting_input'
    | 'model.preparing' | 'model.started' | 'model.request' | 'model.streaming'
    | 'context.summary.started' | 'context.summary.completed' | 'context.summary.failed' | 'context.fallback';
  payload: Record<string, unknown>;
}
export interface ApprovalChoice {
  id: string; label: string; kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
}
export interface ApprovalDecision { accepted: boolean; choiceId?: string }
export interface ApprovalRequest {
  id: string;
  runId: string;
  actorId: string;
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  effects: ToolEffect[];
  workspaceId?: string;
  reason?: string;
  choices?: ApprovalChoice[];
}
export interface ModelRequestMetrics { inputItems: number; inputImages: number; nativeTools: number }
export interface ModelInput {
  /** 仅标注内部请求用途，不改变渠道、模型、工具或缓存标识。 */
  purpose?: 'summary' | 'memory';
  /** 核心捕获的回合资料，供应方适配器不直接发送此对象。 */
  turnContext?: Record<string, unknown>;
  /** 在供应方格式化完成后捕获请求正文；不包含认证请求头。 */
  onRequest?: (request: { protocol: string; model: string; body: unknown; metrics?: ModelRequestMetrics }) => Promise<void>;
  promptContext?: { beforeHistoryMessages: PlatformMessage[]; afterHistoryMessages: PlatformMessage[]; historyPlacement: 'entry' | 'legacy'; taskContextEmbedded?: boolean };
  conversationId: string;
  providerId: string;
  modelOverride?: string;
  reasoningEffort?: string;
  /** 宿主内部任务的独立输出预算，不修改已保存的渠道设置。 */
  maxOutputTokens?: number;
  taskContext?: { actor: Pick<ActorIdentity, 'id' | 'displayName' | 'role'>; workspace?: WorkspaceDefinition };
  systemPrompt: string;
  messages: PlatformMessage[];
  tools: ToolDeclaration[];
  signal: AbortSignal;
  onDelta?: (parts: Record<string, unknown>[]) => void;
}
export interface ModelProvider { generate(input: ModelInput): Promise<PlatformMessage> }
export interface ToolOutcome {
  attachments?: { mimeType: string; data: string; name?: string }[];
  success: boolean;
  code?: string;
  error?: string;
  data?: unknown;
  [key: string]: unknown;
}

export interface RunListOptions {
  conversationId?: string; actorId?: string; activeOnly?: boolean; limit?: number; beforeCreatedAt?: number;
  /** 按完成时间、运行标识升序恢复事件，同一毫秒内的多次完成也可分页读取。 */
  completedAfter?: { timestamp: number; runId: string };
}
export interface StartRunInput {
  promptModeId?: string;
  requestKey: string;
  conversationId: string;
  actorId: string;
  agentId: string;
  providerId?: string;
  modelOverride?: string;
  reasoningEffort?: string;
  workspaceId?: string;
  message: PlatformMessage;
}
/** Continue from committed history. No previous tool execution is replayed. */
export interface ContinueRunInput extends Omit<StartRunInput, 'message'> {
  expectedRevision: number;
}

export interface UserQuestion { title: string; options?: string[] }
export interface QuestionRequest {
  id: string;
  runId: string;
  actorId: string;
  questions: UserQuestion[];
  createdAt: number;
  expiresAt: number;
}
export interface QuestionFeedback { request: QuestionRequest; answers?: string[]; answeredBy?: string; timedOut: boolean }
