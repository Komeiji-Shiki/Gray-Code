import type { TeamTask } from '@graycode/contracts';

export interface TeamScope { rootId: string; conversationId: string; memberId: string; runId: string; actorId: string }
export interface TeamBoard { sequence: number; revision: number | null; tasks: Map<string, TeamTask> }

export const blockedBy = (board: TeamBoard, task: Pick<TeamTask, 'dependencies'>) => task.dependencies.filter(id => board.tasks.get(id)?.status !== 'completed');
export const readyTasks = (board: TeamBoard) => [...board.tasks.values()]
  .filter(task => task.status === 'pending' && !task.owner && !blockedBy(board, task).length)
  .sort((a, b) => a.createdSequence - b.createdSequence);

/** 只允许已有任务作为依赖，检查整个候选图，防止间接循环造成永久等待。 */
export function dependenciesFor(board: TeamBoard, taskId: string, input: unknown): string[] {
  if (!Array.isArray(input) || input.some(id => typeof id !== 'string' || !board.tasks.has(id))) throw new Error('依赖必须是当前团队中已存在的任务 ID。');
  const dependencies = [...new Set(input as string[])];
  const visit = (id: string, visiting: Set<string>, visited: Set<string>) => {
    if (visiting.has(id)) throw new Error('任务依赖不能包含自身或形成循环。');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const next of id === taskId ? dependencies : board.tasks.get(id)?.dependencies ?? []) visit(next, visiting, visited);
    visiting.delete(id); visited.add(id);
  };
  visit(taskId, new Set(), new Set());
  return dependencies;
}

export function assertRevision(task: TeamTask, revision: unknown): void {
  if (revision !== task.revision) throw new Error(`任务版本已变化，请先重新读取任务。当前版本：${task.revision}。`);
}

export function assertOwner(task: TeamTask, scope: TeamScope): void {
  if (task.owner !== scope.memberId || task.ownerRunId !== scope.runId) throw new Error('只有领取该任务的当前执行轮次可以提交结果。旧运行需要重新领取。');
}
