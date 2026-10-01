import { createServer, type Server } from 'node:http';
import type { PlatformMessage } from '@graycode/contracts';
import { PlatformApplication } from '../../../apps/server/src/application';
import { buildNoteGraph, createNoteReceipt, parseNoteEntries } from '../../../apps/server/src/context/noteGraph';
import { recallContextNotes } from '../../../apps/server/src/context/noteRecall';
import { runNoteGraphTool } from '../../../apps/server/src/context/noteTool';
import { memoryTokens } from '../src/storage/longMemory/text';
import { contextMessageText, legacyContextMessageText } from '../../../apps/server/src/context/textPage';
import { fixture } from './fixtures';

const source: PlatformMessage = { id: 'requirement', role: 'user', isUserInput: true, parts: [{ text: '保留缓存前缀。观察：原型已经完成，接下来检查窗口恢复。' }] };
function record(history: PlatformMessage[], entries: unknown[], now: number, callId = `record-${now}`) {
  const call: PlatformMessage = { id: `call-${callId}`, role: 'model', parts: [{ functionCall: { id: callId, name: 'context_notes', args: { action: 'record', entries } } }] };
  history.push(call);
  const receipt = createNoteReceipt(history, callId, parseNoteEntries(entries), now);
  history.push({ id: `result-${callId}`, role: 'user', isFunctionResponse: true,
    parts: [{ functionResponse: { id: callId, name: 'context_notes', response: { success: true, noteEvent: receipt } } }] });
  return Object.fromEntries(receipt.records.map(item => [item.key, item.id]));
}
const entry = (key: string, text: string, extra: Record<string, unknown> = {}) => ({ key, kind: 'decision', text,
  sources: [{ messageId: 'requirement', quote: '保留缓存前缀。' }], ...extra });

test('任务依赖能找回没有共同关键词的依据，替代关系尊重两个时间和当前分支', () => {
  const history = [structuredClone(source)];
  const ids = record(history, [entry('rule', '已有消息必须保持固定。', { kind: 'constraint' }),
    entry('choice', '读取结果作为后续工具消息保存。', { relations: [{ kind: 'requires', target: '@rule' }] }),
    entry('task', '处理恢复流程。', { kind: 'task', relations: [{ kind: 'requires', target: '@choice' }] })], 100);
  const branchBefore = structuredClone(history);
  const newer = record(history, [entry('replacement', '工具结果只追加，已经提供的内容只返回引用。', {
    validFrom: 150, relations: [{ kind: 'supersedes', target: ids.choice }, { kind: 'requires', target: ids.rule }] })], 200);
  const oldKnowledge = buildNoteGraph(history, 180, 180);
  expect(oldKnowledge.states.get(ids.choice)).toBe('current');
  const oldEffectiveTime = buildNoteGraph(history, 120, 250);
  expect(oldEffectiveTime.states.get(ids.choice)).toBe('current');
  const graph = buildNoteGraph(history, 180, 250);
  const recalled = recallContextNotes(graph, history, { taskId: ids.task, tokenBudget: 5000 }, []);
  expect(recalled.success).toBe(true);
  if (!('items' in recalled)) throw new Error('召回预算不足');
  expect(recalled.items.map(note => note.id)).toEqual(expect.arrayContaining([ids.task, newer.replacement, ids.rule]));
  expect(recalled.items.some(note => note.id === ids.choice)).toBe(false);
  expect(recalled.replacements).toContainEqual({ id: ids.choice, currentIds: [newer.replacement] });
  expect(buildNoteGraph(branchBefore, 300, 300).states.get(ids.choice)).toBe('current');
  expect(buildNoteGraph(branchBefore, 300, 300).notes.has(newer.replacement)).toBe(false);
});

test('召回按实际可见内容去重，换窗口恢复正文，显式读取仍可重看', () => {
  const history = [structuredClone(source)];
  const ids = record(history, [entry('rule', '保留缓存前缀。'), entry('detail', '恢复时沿任务关系查找来源。')], 100);
  const graph = buildNoteGraph(history, 200, 200);
  expect(graph.notes.get(ids.rule)?.confidence).toBe('confirmed');
  expect(graph.notes.get(ids.detail)?.confidence).toBe('inferred');
  const current = recallContextNotes(graph, history, { ids: [ids.rule, ids.detail], tokenBudget: 3000 }, history);
  if (!('items' in current)) throw new Error('召回预算不足');
  expect(current.items).toHaveLength(0);
  expect(current.alreadyProvided.map(item => item.id)).toEqual(expect.arrayContaining([ids.rule, ids.detail]));
  const window = { id: 'next-window', role: 'user', isSummary: true, contextMethod: 'notes', contextWindowId: 'w2', parts: [{ text: '继续原任务。' }] };
  history.push(window);
  const restored = recallContextNotes(graph, history, { ids: [ids.detail], tokenBudget: 3000 }, [source, window]);
  if (!('items' in restored)) throw new Error('召回预算不足');
  expect(restored.items.map(item => item.id)).toEqual([ids.detail]);
  const result: PlatformMessage = { id: 'recall-result', role: 'user', parts: [{ functionResponse: { name: 'context_notes', response: restored } }] };
  const repeated = recallContextNotes(graph, [...history, result], { ids: [ids.detail], tokenBudget: 3000 }, [window, result]);
  expect(repeated).toMatchObject({ items: [], alreadyProvided: [{ id: ids.detail, messageId: result.id, reason: 'recalled' }] });
  expect(runNoteGraphTool({ action: 'inspect', noteId: ids.detail }, history, undefined, [window, result])).toMatchObject({ text: '恢复时沿任务关系查找来源。' });
});

test('来源变化后停止召回，失败记录不生效，超预算时明确列出缺少的依赖', () => {
  const history = [structuredClone(source)];
  const ids = record(history, [entry('large', '必须保留完整条件，不能只看一半。'.repeat(160)),
    entry('task', '继续修复。', { kind: 'task', relations: [{ kind: 'requires', target: '@large' }] })], 100);
  const result = recallContextNotes(buildNoteGraph(history, 200, 200), history, { taskId: ids.task, tokenBudget: 500 }, []);
  expect(result.success).toBe(true);
  if (!('items' in result)) throw new Error('召回预算不足');
  expect(result.truncated).toBe(true); expect(result.missingDependencies).toContain(ids.large);
  expect(result.estimatedTokens).toBe(memoryTokens(JSON.stringify(result))); expect(result.estimatedTokens).toBeLessThanOrEqual(500);
  const changed = structuredClone(history); changed[0].parts = [{ text: '来源已更新。' }];
  expect(buildNoteGraph(changed, 200, 200).states.get(ids.task)).toBe('source_unavailable');
  const failed = structuredClone(history); (failed[2].parts[0].functionResponse as any).response.success = false;
  expect(buildNoteGraph(failed, 200, 200).notes.size).toBe(0);
  const invalid = [...history, { id: 'bad', role: 'model', parts: [{ functionCall: { id: 'bad-call', name: 'context_notes' } }] }];
  expect(() => createNoteReceipt(invalid, 'bad-call', parseNoteEntries([entry('a', 'A', { relations: [{ kind: 'supersedes', target: '@b' }] }),
    entry('b', 'B', { relations: [{ kind: 'supersedes', target: '@a' }] })]), 300)).toThrow('循环');
});

test('工具结果来源按模型可见文本记录偏移；旧回执的偏移换算到新文本，无法对应时去掉', () => {
  const tool: PlatformMessage = { id: 'tool-source', role: 'user', isFunctionResponse: true, parts: [{ functionResponse: { id: 'read-1', name: 'read_file',
    response: { success: true, data: { content: 'line "quoted" here' } } } }] };
  const current = contextMessageText(tool), legacy = legacyContextMessageText(tool);
  expect(current).toBe('[Tool result: read_file]\nline "quoted" here');
  expect(legacy).toContain('\\"quoted\\"');

  const history = [structuredClone(source), tool];
  const entries = [{ key: 'plain', kind: 'observation', text: '文件末尾是 here。', sources: [{ messageId: 'tool-source', quote: 'here' }] },
    { key: 'escaped', kind: 'observation', text: '文件含引号。', sources: [{ messageId: 'tool-source', quote: '"quoted"' }] }];
  history.push({ id: 'call-legacy', role: 'model', parts: [{ functionCall: { id: 'legacy', name: 'context_notes', args: { action: 'record', entries } } }] });
  const receipt = createNoteReceipt(history, 'legacy', parseNoteEntries(entries), 100);
  expect(receipt.textFormat).toBe(3);
  expect(receipt.records[0].sources[0].offset).toBe(current.indexOf('here'));

  // 模拟旧版本写入的回执：没有 textFormat，偏移按整段 JSON 文本计算。
  const legacyReceipt = structuredClone(receipt);
  delete legacyReceipt.textFormat;
  legacyReceipt.records[0].sources[0].offset = legacy.indexOf('here');
  legacyReceipt.records[1].sources[0] = { ...legacyReceipt.records[1].sources[0], offset: legacy.indexOf('\\"quoted\\"'), length: '\\"quoted\\"'.length };
  history.push({ id: 'result-legacy', role: 'user', isFunctionResponse: true,
    parts: [{ functionResponse: { id: 'legacy', name: 'context_notes', response: { success: true, noteEvent: legacyReceipt } } }] });
  const graph = buildNoteGraph(history, 200, 200);
  const ids = Object.fromEntries(legacyReceipt.records.map(item => [item.key, item.id]));
  expect(graph.states.get(ids.plain)).toBe('current');
  expect(graph.notes.get(ids.plain)?.sources[0]).toMatchObject({ messageId: 'tool-source', offset: current.indexOf('here'), length: 4 });
  expect(graph.notes.get(ids.escaped)?.sources[0].offset).toBeUndefined();
  expect(graph.states.get(ids.escaped)).toBe('current');

  // 中间版本的回执：工具结果偏移无法换算，去掉偏移但来源仍然有效。
  const previous = structuredClone(receipt);
  previous.textFormat = 2;
  const middle = [...history.slice(0, 3), { id: 'result-middle', role: 'user', isFunctionResponse: true,
    parts: [{ functionResponse: { id: 'legacy', name: 'context_notes', response: { success: true, noteEvent: previous } } }] }] as PlatformMessage[];
  const middleGraph = buildNoteGraph(middle, 200, 200);
  expect(middleGraph.states.get(ids.plain)).toBe('current');
  expect(middleGraph.notes.get(ids.plain)?.sources[0].offset).toBeUndefined();
});

describe('真实 HTTP 请求中的笔记事件与召回快照', () => {
  let f: Awaited<ReturnType<typeof fixture>>, app: PlatformApplication, server: Server;
  let requests: any[], serverError: Error | undefined;
  beforeEach(async () => { f = await fixture(); await f.store.close(); requests = []; });
  afterEach(async () => { await app?.close(); if (server) await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }); await f.cleanup(); });
  test('记录、去重、切换上下文和更新仅追加结果，重启及复制会话后仍可召回', async () => {
    let ids: Record<string, string> = {};
    server = createServer(async (request, response) => {
      try {
        const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')); requests.push(body);
        const results = body.messages.filter((message: any) => message.role === 'tool').map((message: any) => JSON.parse(message.content));
        for (const result of results) if (result.noteEvent) ids = { ...ids, ...Object.fromEntries(result.noteEvent.records.map((item: any) => [item.key, item.id])) };
        const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
        switch (requests.length) {
          case 1: calls.push({ name: 'context_notes', args: { action: 'record', entries: [entry('rule', '旧请求前缀保持不变。', { kind: 'constraint' }),
            entry('task', '恢复取消流程。', { kind: 'task', relations: [{ kind: 'requires', target: '@rule' }] })] } }); break;
          case 2: calls.push({ name: 'context_notes', args: { action: 'recall', taskId: ids.task, tokenBudget: 2500 } }); break;
          case 3: calls.push({ name: 'new_context', args: {} }); break;
          case 4: calls.push({ name: 'context_notes', args: { action: 'recall', taskId: ids.task, tokenBudget: 2500 } }); break;
          case 5: calls.push({ name: 'context_notes', args: { action: 'record', entries: [entry('updated', '已召回的内容保持固定，更新作为新的工具结果追加。', {
            relations: [{ kind: 'supersedes', target: ids.rule }] })] } }); break;
          case 6: calls.push({ name: 'context_notes', args: { action: 'recall', taskId: ids.task, tokenBudget: 2500 } }); break;
        }
        const delta = calls.length ? { tool_calls: calls.map((call, index) => ({ index, id: `call-${requests.length}-${index}`, type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.args) } })) } : { content: '已恢复相关依据，继续任务。' };
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.end(`data: ${JSON.stringify({ id: `response-${requests.length}`, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: calls.length ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
      } catch (error) { serverError = error as Error; response.writeHead(500); response.end('fixture error'); }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    app = await PlatformApplication.open({ dataDirectory: f.data });
    const draft = await app.product.draft();
    const providerId = await draft.configs.createConfig({ type: 'openai', name: '笔记图 HTTP 夹具', enabled: true,
      url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, model: 'fixture', apiKey: '', timeout: 5000,
      contextManagementEnabled: false, autoSummarizeMethod: 'notes', maxContextTokens: 32000 });
    await draft.settings.savePromptMode({ id: 'notes-http', name: '笔记图夹具', template: 'Continue the task.', dynamicTemplate: '', dynamicTemplateEnabled: false, toolPolicy: [] });
    await app.product.save(draft);
    await app.storage.createConversation({ id: 'graph', actorId: 'owner', createdAt: Date.now(), updatedAt: Date.now() });
    await app.storage.appendHistory('graph', [{ id: 'first', role: 'user', isUserInput: true, parts: [{ text: '实现任务。' }] }, source]);
    const run = await app.runtime.start({ actorId: 'owner', agentId: 'default', conversationId: 'graph', requestKey: 'notes-http',
      providerId, promptModeId: 'notes-http', message: { id: 'latest', role: 'user', parts: [{ text: '继续处理恢复流程。' }] } });
    expect(await app.runtime.wait(run.id)).toMatchObject({ status: 'completed' });
    expect(serverError).toBeUndefined(); expect(requests).toHaveLength(7);
    for (const index of [0, 1, 3, 4, 5]) {
      expect(requests[index + 1].tools).toEqual(requests[index].tools);
      expect(requests[index + 1].messages.slice(0, requests[index].messages.length)).toEqual(requests[index].messages);
    }
    const output = (index: number) => JSON.parse(requests[index].messages.filter((message: any) => message.role === 'tool').at(-1).content);
    expect(output(2)).toMatchObject({ items: [], alreadyProvided: expect.arrayContaining([expect.objectContaining({ id: ids.task })]) });
    expect(output(4).items.map((item: any) => item.id)).toEqual(expect.arrayContaining([ids.task, ids.rule]));
    expect(output(6).items).toHaveLength(0);
    expect(output(6).replacements).toContainEqual({ id: ids.rule, currentIds: [ids.updated] });
    const state = await app.storage.readFullHistory('graph');
    const fork = await app.conversations.fork('owner', 'graph', state.messages.length - 1, { conversationId: 'graph-copy' });
    expect(fork.success).toBe(true);
    await app.close(); app = await PlatformApplication.open({ dataDirectory: f.data });
    const copied = await app.storage.readFullHistory('graph-copy');
    const graph = buildNoteGraph(copied.messages);
    expect(graph.states.get(ids.rule)).toBe('superseded'); expect(graph.states.get(ids.updated)).toBe('current');
    expect(graph.notes.get(ids.task)?.relations).toContainEqual({ kind: 'requires', target: ids.rule });
  });
});
