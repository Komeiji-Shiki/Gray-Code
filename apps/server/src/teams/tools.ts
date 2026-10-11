import type { RuntimeTool } from '@graycode/core';
import type { PlatformApplication } from '../application';

export function teamTools(app: PlatformApplication): RuntimeTool[] {
  return [
    {
      declaration: {
        name: 'team_tasks',
        description:
          '协调主会话及其子代理共享的任务。'
          + '创建任务并声明依赖后，用 claim_ready 原子领取依赖已完成的最早未领取任务。'
          + 'list 返回摘要，get 返回详情；'
          + 'claim、complete、release、set_dependencies 需传入当前 expectedRevision。'
          + '只有领取任务的执行才能完成任务；'
          + '主代理可明确释放遗留任务，失败或停止成员的占用会保留到释放。'
          + '给成员提供具体任务 ID；'
          + '依赖其他成员进展时，用返回的 sequence 调用 team_wait。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['action'],
          properties: {
            action: { type: 'string', enum: ['list', 'get', 'create', 'claim_ready', 'claim', 'complete', 'release', 'set_dependencies'] },
            taskId: { type: 'string' },
            expectedRevision: { type: 'integer', minimum: 1 },
            title: { type: 'string', minLength: 1, maxLength: 240 },
            description: { type: 'string', maxLength: 16000 },
            result: { type: 'string', maxLength: 16000 },
            dependencies: { type: 'array', items: { type: 'string' }, uniqueItems: true },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
            afterCreatedSequence: { type: 'integer', minimum: 0 },
            limit: { type: 'integer', minimum: 1, maximum: 100 },
          },
        },
      },
      effects: () => [],
      execute: async (args, context) => ({ success: true, ...(await app.teams.tasks(await app.teams.scope(context), args, context.signal)) }),
    },
    {
      declaration: {
        name: 'team_wait',
        description:
          '等待 team_tasks 或上次 team_wait 返回的 sequence 之后的团队变更。'
          + '已有未读事件立即返回，每次最多 50 条；'
          + 'hasMore 为 true 时使用返回的 sequence 继续。'
          + '子代理等待期间释放并发名额。'
          + 'readyTaskIds 非空时应领取任务；'
          + 'noProgress=true 表示没有活跃成员或可领取任务能够继续推进，应处理或报告阻塞，或结束任务。'
          + 'timeoutMs 默认 30 秒、最多 60 秒。'
          + '本工具不会重启失败或暂停的成员。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['afterSequence'],
          properties: {
            afterSequence: { type: 'integer', minimum: 0 },
            timeoutMs: { type: 'integer', minimum: 0, maximum: 60000 },
          },
        },
      },
      effects: () => [],
      execute: async (args, context) => ({
        success: true,
        ...(await app.teams.wait(await app.teams.scope(context), Number(args.afterSequence), Number(args.timeoutMs ?? 30000), context.signal)),
      }),
    },
  ];
}
