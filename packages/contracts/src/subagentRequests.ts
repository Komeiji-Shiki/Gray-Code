import type { ApprovalRequest, QuestionRequest } from './runtime';

/** 监视器读取的请求直接沿用运行器审批与问题结构。 */
export interface SubagentPendingRequests {
  approvals: ApprovalRequest[];
  questions: QuestionRequest[];
}

export interface SubagentRequestSource {
  subagentRunId: string;
  agentName: string;
}

export type ConversationSubagentApproval = ApprovalRequest & SubagentRequestSource;
export type ConversationSubagentQuestion = QuestionRequest & SubagentRequestSource;
export interface ConversationSubagentPendingRequests {
  approvals: ConversationSubagentApproval[];
  questions: ConversationSubagentQuestion[];
}

export interface SubagentControlResult {
  success: boolean;
  active: boolean;
  status?: string;
  pending?: boolean;
}
