import type { RuntimeTool } from '@graycode/core';
import type { PlatformApplication } from '../application';

export function teamTools(app: PlatformApplication): RuntimeTool[] {
  return [
    {
      declaration: { name: 'team_tasks', description: 'Coordinate tasks shared by this main conversation and its sub-agents. Create tasks with dependencies, then use claim_ready to atomically claim the oldest unclaimed task whose dependencies are complete. list returns compact summaries and get returns full details. claim, complete, release and set_dependencies require the task\'s current expectedRevision. Only the execution that claimed a task can complete it; the main agent can explicitly release abandoned work, and claims held by failed or stopped members stay in place until released. Give workers concrete task IDs, and when your work depends on other members, call team_wait with the returned sequence.',
        parameters: { type: 'object', additionalProperties: false, required: ['action'], properties: {
          action: { type: 'string', enum: ['list', 'get', 'create', 'claim_ready', 'claim', 'complete', 'release', 'set_dependencies'] },
          taskId: { type: 'string' }, expectedRevision: { type: 'integer', minimum: 1 },
          title: { type: 'string', minLength: 1, maxLength: 240 }, description: { type: 'string', maxLength: 16000 }, result: { type: 'string', maxLength: 16000 },
          dependencies: { type: 'array', items: { type: 'string' }, uniqueItems: true },
          status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
          afterCreatedSequence: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100 },
        } } },
      effects: () => [],
      execute: async (args, context) => ({ success: true, ...await app.teams.tasks(await app.teams.scope(context), args, context.signal) }),
    },
    {
      declaration: { name: 'team_wait', description: 'Wait for saved team changes after the sequence returned by team_tasks or an earlier team_wait. Events you missed are returned without waiting, up to 50 compact events per call; if hasMore is true, call again with the returned sequence. While waiting, a sub-agent gives up its concurrency slot. When readyTaskIds is nonempty, claim that work. noProgress=true means no other active member or ready task can move the team forward: resolve the blocked work, report the blocker or finish, rather than waiting again. timeoutMs defaults to 30 seconds, up to 60 seconds. This tool never restarts failed or paused members.',
        parameters: { type: 'object', additionalProperties: false, required: ['afterSequence'], properties: {
          afterSequence: { type: 'integer', minimum: 0 }, timeoutMs: { type: 'integer', minimum: 0, maximum: 60000 },
        } } },
      effects: () => [],
      execute: async (args, context) => ({ success: true, ...await app.teams.wait(await app.teams.scope(context), Number(args.afterSequence), Number(args.timeoutMs ?? 30000), context.signal) }),
    },
  ];
}
