import { PlatformRuntime, RuntimeToolRegistry } from '@graycode/core';
import { fixture, metadata } from './fixtures';

test.each([
  ['cancelled', true], ['interrupted', true], ['cancelled', false],
] as const)('生成提前结束时仅保存收到的正文：%s，存在正文=%s', async (reason, hasText) => {
  const f = await fixture(), tools = new RuntimeToolRegistry();
  let ready!: () => void, rejectModel!: (error: Error) => void, generation = 0, executions = 0;
  const received = new Promise<void>(resolve => { ready = resolve; });
  tools.register({ declaration: { name: 'write', description: '写入', parameters: { type: 'object', properties: {} } },
    effects: () => ['workspace_write'], execute: async () => { executions++; return { success: true }; } });
  const references = [{ scopeId: 'fixture-scope', id: 'fixture-memory', version: 1 }];
  const runtime = new PlatformRuntime({ storage: f.store, tools,
    actor: async () => ({ id: 'owner', displayName: '测试', role: 'owner', effects: [], workspaceIds: '*' }),
    agent: async () => ({ id: 'test', name: '测试', providerId: 'fixture', modelId: 'requested-model', systemPrompt: '', approvalMode: 'sensitive', maxIterations: 2, toolNames: ['write'] }),
    workspace: async () => null,
    transformOutput: async ({ message }) => ({ ...message, longMemoryReferences: references }),
    models: { generate: async input => {
      if (++generation > 1) {
        expect(input.messages.at(-1)).toMatchObject({ incompleteReason: reason, parts: [{ text: '已生成的正文。' }] });
        return { role: 'model', parts: [{ text: '接续完成。' }] };
      }
      input.onDelta?.([{ text: '未完成的思考', thought: true }, { functionCall: { id: 'unfinished', name: 'write', args: '{' } }]);
      if (hasText) { input.onDelta?.([{ text: '已生成的' }]); input.onDelta?.([{ text: '正文。' }]); }
      return new Promise((resolve, reject) => {
        rejectModel = reject;
        input.signal.addEventListener('abort', () => {
          input.onDelta?.([{ text: '取消后迟到的输出' }]);
          reject(input.signal.reason);
        }, { once: true });
        ready();
      });
    } } });
  try {
    await runtime.initialize(); await f.store.createConversation(metadata('partial'));
    const run = await runtime.start({ actorId: 'owner', agentId: 'test', conversationId: 'partial', requestKey: 'partial',
      message: { role: 'user', parts: [{ text: '开始' }] } });
    await received;
    if (reason === 'cancelled') await runtime.cancel(run.id, 'owner');
    else rejectModel(new Error('模拟上游中断'));
    expect((await runtime.wait(run.id))?.status).toBe(reason === 'cancelled' ? 'cancelled' : 'failed');
    const history = await f.store.readFullHistory('partial');
    expect(executions).toBe(0);
    expect(history.messages).toHaveLength(hasText ? 2 : 1);
    if (hasText) {
      expect(history.messages[1]).toMatchObject({ role: 'model', modelVersion: 'requested-model', incompleteReason: reason, usageMetadataPartial: true,
        parts: [{ text: '已生成的正文。' }], longMemoryReferences: references });
      const continued = await runtime.continue({ actorId: 'owner', agentId: 'test', conversationId: 'partial',
        requestKey: 'continue-partial', expectedRevision: history.revision });
      expect((await runtime.wait(continued.id))?.status).toBe('completed');
      expect((await f.store.readFullHistory('partial')).messages).toHaveLength(3);
    }
  } finally { await runtime.close(); await f.cleanup(); }
});
