import type { RuntimeTool } from '@graycode/core';
import type { PlatformApplication } from '../application';

export function teamTools(app: PlatformApplication): RuntimeTool[] {
  return [
    {
      declaration: { name: 'team_tasks', description: 'Coordinate shared tasks in this main conversation and its subagents. Create tasks with dependencies, then atomically claim_ready to take the oldest unclaimed task whose dependencies are complete. list returns compact tasks; get reads details. claim/complete/release/set_dependencies require the current expectedRevision. Only the claiming execution can complete a task; the main agent can explicitly release abandoned work. Failed or stopped owners keep their claims until released. Share concrete task IDs with workers; use team_wait with the returned sequence when work depends on other members.',
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
      declaration: { name: 'team_wait', description: 'Wait for persisted team changes after the sequence returned by team_tasks or an earlier team_wait. Reads missed events before sleeping and returns up to 50 compact events. Continue with the returned sequence if hasMore. Waiting releases the current subagent concurrency slot. When readyTaskIds is nonempty, claim work. If noProgress is true, no other active member or ready task can advance the team: resolve blocked work, report the blocker or finish instead of repeatedly polling. Timeout defaults to 30 seconds, maximum 60 seconds. This tool never restarts failed or paused members.',
        parameters: { type: 'object', additionalProperties: false, required: ['afterSequence'], properties: {
          afterSequence: { type: 'integer', minimum: 0 }, timeoutMs: { type: 'integer', minimum: 0, maximum: 60000 },
        } } },
      effects: () => [],
      execute: async (args, context) => ({ success: true, ...await app.teams.wait(await app.teams.scope(context), Number(args.afterSequence), Number(args.timeoutMs ?? 30000), context.signal) }),
    },
  ];
}
