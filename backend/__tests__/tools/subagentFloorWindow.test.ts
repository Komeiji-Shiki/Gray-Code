import type { Content } from '../../modules/conversation/types';
import { createRunContentWindow } from '../../tools/subagents/eventBus/contentWindow';
import { SubAgentRunEventBus } from '../../tools/subagents/runEventBus';
import type { SubAgentRunSnapshot } from '../../tools/subagents/eventBus/types';

const text = (id: string, role: Content['role'], value = id): Content => ({ id, role, parts: [{ text: value }] });
const invocation = (id: string): Content => text(id, 'user', '# SubAgent Invocation\n\n## Agent System Prompt\nSystem\n\n## User Prompt\nTask');
const history = (): Content[] => [
  invocation('invocation'), text('input', 'user'),
  { id: 'call', role: 'model', parts: [{ functionCall: { id: 'tool', name: 'read_file', args: {} } }] },
  { id: 'result', role: 'user', parts: [{ functionResponse: { id: 'tool', name: 'read_file', response: { result: 'tool body' } } }] },
  text('answer', 'model'), invocation('continuation'), text('follow-up', 'user'), text('last', 'model'),
];

function snapshot(contents: Content[]): SubAgentRunSnapshot {
  return { runId: 'floors', status: 'completed', createdAt: 1, updatedAt: 2, contentRevision: 4, eventSequence: 8,
    contents: contents.map((content, index) => ({ ...content, index })), events: [], contextCompactions: [] };
}

test('legacy/VSCode 尾窗与上翻共享全局楼层，Invocation与工具响应不计楼且保留原索引', () => {
  const run = snapshot(history()); const before = JSON.stringify(run);
  const tail = createRunContentWindow(run, { limit: 2 })!;
  const older = createRunContentWindow(run, { endIndex: tail.startIndex, limit: 4 })!;
  expect(tail).toMatchObject({ startIndex: 6, endIndex: 8, totalCount: 8, floorIndices: [1, 2, 4, 6, 7], contentRevision: 4 });
  expect(tail.contents.map(content => content.index)).toEqual([6, 7]);
  expect(older.floorIndices).toEqual(tail.floorIndices);
  expect(older.contents.map(content => [content.id, content.index])).toEqual([['call', 2], ['result', 3], ['answer', 4], ['continuation', 5]]);
  expect(JSON.stringify(run)).toBe(before);
  tail.contents[0].parts[0].text = 'local edit';
  expect(run.contents[6].parts[0].text).toBe('follow-up');
});

test('只排除正式调用说明；提及标题的真实输入和总结正常计楼，显式工具响应标记不计楼', () => {
  const run = snapshot([invocation('card'), text('mention', 'user', 'Explain # SubAgent Invocation'),
    text('heading', 'user', '# SubAgent Invocation\nA real task'),
    text('summary', 'user', 'Context summary'), { ...text('flagged-result', 'user'), isFunctionResponse: true }]);
  expect(createRunContentWindow(run)!.floorIndices).toEqual([1, 2, 3]);
  expect(createRunContentWindow({ ...run, transcriptLoaded: false })).toBeUndefined();
});

test('删除与重试替换后全局楼层按新修订重算，旧窗口保持原快照', () => {
  const bus = new SubAgentRunEventBus();
  bus.createRun('floors', 'Worker', {}, { initialContents: history() });
  const before = bus.getContentWindow('floors', { limit: 2 })!;
  bus.replaceContents('floors', history().filter(content => content.id !== 'answer'));
  const deleted = bus.getContentWindow('floors', { limit: 2 })!;
  expect(deleted.floorIndices).toEqual([1, 2, 5, 6]);
  expect(deleted.contentRevision).toBeGreaterThan(before.contentRevision);
  bus.replaceContents('floors', history().slice(0, 2));
  bus.appendContent('floors', text('retried-answer', 'model'));
  const retried = bus.getContentWindow('floors', { limit: 1 })!;
  expect(retried).toMatchObject({ startIndex: 2, endIndex: 3, totalCount: 3, floorIndices: [1, 2] });
  expect(retried.contents[0]).toMatchObject({ id: 'retried-answer', index: 2 });
  expect(before.floorIndices).toEqual([1, 2, 4, 6, 7]);
});
