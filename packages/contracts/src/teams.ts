/** 协作任务属于主会话；执行轮次与稳定的成员身份分别保存。 */
export interface TeamTask {
  id: string;
  title: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed';
  dependencies: string[];
  owner?: string;
  ownerRunId?: string;
  creator: string;
  revision: number;
  createdSequence: number;
  updatedSequence: number;
  result?: string;
}

export interface TeamEvent {
  sequence: number;
  type: 'task.created' | 'task.claimed' | 'task.completed' | 'task.released' | 'task.dependencies_changed' | 'message.queued' | 'member.changed';
  memberId: string;
  taskId?: string;
  taskRevision?: number;
  messageId?: string;
  conversationId?: string;
  status?: string;
}

export interface TeamWaitResult {
  reason: 'events' | 'ready_work' | 'no_progress' | 'timeout';
  sequence: number;
  latestSequence: number;
  hasMore: boolean;
  events: TeamEvent[];
  readyTaskIds: string[];
  noProgress: boolean;
}
