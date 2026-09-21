import { PlatformRuntime, RuntimeToolRegistry } from '@graycode/core';
import type { PlatformMessage } from '@graycode/contracts';
import { fixture, message, metadata } from './fixtures';

describe('模型历史增量读取与局部更新', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeEach(async () => { f = await fixture(); });
  afterEach(async () => { await f.cleanup(); });

  test('追加、跨段修改与无变化更新保留完整历史、图片和分支', async () => {
    await f.store.createConversation(metadata('delta'));
    const original = Array.from({ length: 400 }, (_, index) => message(index));
    original[0].parts.push({ inlineData: { mimeType: 'image/png', data: Buffer.from('原图片').toString('base64') } });
    await f.store.appendHistory('delta', original);
    let snapshot = await f.store.readConversationState('delta', undefined, { runId: 'reader' });
    let reconstructed = snapshot.history.messages;
    await f.store.appendHistory('delta', [message(400), message(401)]);
    let delta = await f.store.readConversationState('delta', undefined, { runId: 'reader', revision: snapshot.history.revision });
    expect(delta.history.startIndex).toBe(400); expect(delta.history.messages).toHaveLength(2);
    reconstructed = [...reconstructed.slice(0, delta.history.startIndex), ...delta.history.messages]; snapshot = delta;
    await f.store.forkConversation('delta', metadata('fork'));
    const updated = { ...message(127), parts: [{ text: '局部修订' }], futureMetadata: { kept: true } };
    await f.store.commitConversation({ conversationId: 'delta', expectedRevision: snapshot.history.revision, messageUpdates: [{ index: 127, message: updated }] });
    delta = await f.store.readConversationState('delta', undefined, { runId: 'reader', revision: snapshot.history.revision });
    expect(delta.history.startIndex).toBe(127);
    reconstructed = [...reconstructed.slice(0, delta.history.startIndex), ...delta.history.messages];
    expect(reconstructed).toEqual((await f.store.readFullHistory('delta')).messages);
    expect(reconstructed[0].parts).toEqual(original[0].parts);
    expect((await f.store.readHistory('fork', { offset: 127, limit: 1 })).messages[0]).toEqual(message(127));
    const unchanged = await f.store.commitConversation({ conversationId: 'delta', expectedRevision: delta.history.revision, messageUpdates: [{ index: 127, message: updated }] });
    expect(unchanged.revision).toBe(delta.history.revision);
    const empty = await f.store.readConversationState('delta', undefined, { runId: 'reader', revision: delta.history.revision });
    expect(empty.history.startIndex).toBe(402); expect(empty.history.messages).toEqual([]);
  });

  test('回收、错误的基准版本与运行结束均使读取重新取得完整快照', async () => {
    await f.store.createConversation(metadata('reset'));
    const run = { id: 'cursor-run', requestKey: 'cursor-key', actorId: 'owner', agentId: 'test', conversationId: 'reset',
      status: 'queued' as const, createdAt: 1, updatedAt: 1, iteration: 0, catalogVersion: 'test' };
    await f.store.createRun(run, message(0));
    await f.store.appendRunEvent({ runId: run.id, type: 'run.started', payload: {}, update: { status: 'running' } });
    let state = await f.store.readConversationState('reset', undefined, { runId: run.id });
    const read = () => f.store.readConversationState('reset', undefined, { runId: run.id, revision: state.history.revision });
    expect((await read()).history.messages).toEqual([]);
    await f.store.collectGarbage(); expect((await read()).history.messages).toEqual([message(0)]);
    expect((await f.store.readConversationState('reset', undefined, { runId: run.id, revision: -1 })).history.startIndex).toBe(0);
    await f.store.appendRunEvent({ runId: run.id, type: 'run.completed', payload: {}, update: { status: 'completed' } });
    state = await read(); expect(state.history.startIndex).toBe(0); expect(state.history.messages).toEqual([message(0)]);
  });

  test('局部更新失败会回滚，单独修改消息仍同步会话元数据', async () => {
    await f.store.createConversation(metadata('patch'));
    await f.store.appendHistory('patch', [message(0)]);
    const before = await f.store.readConversationState('patch');
    await expect(f.store.commitConversation({ conversationId: 'patch', expectedRevision: before.history.revision,
      messageUpdates: [{ index: 0, message: message(0, '替换') }, { index: 9, message: message(9) }] })).rejects.toThrow('超出范围');
    expect(await f.store.readConversationState('patch')).toEqual(before);
    const result = await f.store.commitConversation({ conversationId: 'patch', expectedRevision: before.history.revision,
      messageUpdates: [{ index: 0, message: message(0, '替换') }] });
    const after = await f.store.readConversationState('patch');
    expect(after.history.messages[0].parts).toEqual([{ text: '替换' }]); expect(after.metadataToken).toBe(result.metadataToken);
    expect(after.metadata.updatedAt).toBeGreaterThanOrEqual(before.metadata.updatedAt!);
  });

  test('连续工具图片请求与完整历史逐项一致，已有请求前缀保持不变', async () => {
    const registry = new RuntimeToolRegistry(); let frames = 0;
    registry.register({ declaration: { name: 'observe_fixture', description: '测试截图', parameters: { type: 'object', properties: {} } },
      effects: () => ['public_read'], execute: async () => ({ success: true, data: { frame: ++frames },
        attachments: [{ mimeType: 'image/png', data: Buffer.from('frame-' + frames).toString('base64') }] }) });
    const inputs: PlatformMessage[][] = [];
    const runtime = new PlatformRuntime({ storage: f.store, tools: registry,
      actor: async () => ({ id: 'owner', displayName: '测试', role: 'owner', effects: [], workspaceIds: '*' }),
      agent: async () => ({ id: 'test', name: '测试', providerId: 'fixture', systemPrompt: '固定前缀', approvalMode: 'sensitive', maxIterations: 4, toolNames: ['observe_fixture'] }),
      workspace: async () => null, models: { generate: async input => {
        expect(input.messages).toEqual((await f.store.readFullHistory('visual')).messages);
        const previous = inputs.at(-1);
        if (previous) expect(JSON.stringify(input.messages.slice(0, previous.length))).toBe(JSON.stringify(previous));
        inputs.push(structuredClone(input.messages));
        return frames < 3 ? { role: 'model', parts: [{ functionCall: { id: 'frame-' + frames, name: 'observe_fixture', args: {} } }] }
          : { role: 'model', parts: [{ text: '完成' }] };
      } } });
    try {
      await runtime.initialize(); await f.store.createConversation(metadata('visual'));
      const run = await runtime.start({ actorId: 'owner', agentId: 'test', conversationId: 'visual', requestKey: 'visual', message: { role: 'user', parts: [{ text: '连续观察' }] } });
      expect((await runtime.wait(run.id))?.status).toBe('completed');
      expect(inputs).toHaveLength(4);
      expect(inputs.at(-1)!.flatMap(value => value.parts).filter(part => part.inlineData)).toHaveLength(3);
    } finally { await runtime.close(); }
  });
});
