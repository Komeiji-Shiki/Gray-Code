import { SubagentExecutionService } from '../../../apps/server/src/subagents/service';
import type { PlatformSubagent } from '../../../apps/server/src/subagents/types';

function fixture() {
  const invocation = { id: 'invocation-child', role: 'user', timestamp: 1,
    parts: [{ text: '# SubAgent Invocation\n\n## Agent System Prompt\nSYSTEM\n\n## Context\nCONTEXT_ONCE\n\n## User Prompt\nTASK_ONCE' }] };
  const record = { id: 'child', conversationId: 'child-conversation', invocation,
    profile: { systemPrompt: 'SYSTEM\nworkspace environment' }, eventSequence: 2 } as unknown as PlatformSubagent;
  const messages = [{ id: 'real-input', role: 'user', isUserInput: true, parts: [{ text: '# Context\nCONTEXT_ONCE\n\n## Task\nTASK_ONCE' }] }];
  const service = {
    get: async () => record,
    app: { storage: { historyInfo: async () => ({ total: 1, revision: 2 }),
      readHistoryWithFloors: async (_id: string, options?: { offset: number; limit: number }) => ({ total: 1, revision: 2,
        startIndex: options?.offset ?? 0, floorIndices: [0], messages: options ? messages.slice(options.offset, options.offset + options.limit) : [] }) } },
    activeIds: () => [], manifest: () => ({ runId: 'child' }),
  };
  return { record, invocation, messages, window: (options: { limit: number; endIndex: number }) => SubagentExecutionService.prototype.window.call(service, 'owner', 'child', options) };
}

test('监控配置项不重复真实Context/Task，保留原历史与展示索引', async () => {
  const f = fixture(); const before = JSON.stringify(f.record);
  const result = await f.window({ limit: 20, endIndex: 2 });
  const contents = result!.window.contents;
  const text = contents.map(content => content.parts.map(part => part.text ?? '').join('\n')).join('\n');
  expect(text.match(/CONTEXT_ONCE/g)).toHaveLength(1);
  expect(text.match(/TASK_ONCE/g)).toHaveLength(1);
  expect(text).toContain('SYSTEM');
  expect(contents.map(content => [content.id, content.index])).toEqual([['invocation-child', 0], ['real-input', 1]]);
  expect(result!.window).toMatchObject({ startIndex: 0, endIndex: 2, totalCount: 2, floorIndices: [1], hasMoreBefore: false, hasMoreAfter: false });
  expect(JSON.stringify(f.record.invocation)).toBe(JSON.stringify(JSON.parse(before).invocation));
  expect(contents[1].parts).toEqual(f.messages[0].parts);
});

test('只取真实输入页不插入配置，也不丢任务内容', async () => {
  const result = await fixture().window({ limit: 1, endIndex: 2 });
  expect(result!.window.contents).toHaveLength(1);
  expect(result!.window.contents[0]).toMatchObject({ id: 'real-input', index: 1 });
  expect(result!.window.contents[0].parts[0].text).toContain('TASK_ONCE');
  expect(result!.window).toMatchObject({ startIndex: 1, endIndex: 2, totalCount: 2, hasMoreBefore: true });
});
