import { createDefaultExecutor, subAgentRunEventBus, subAgentConcurrencyLimiter } from '../../tools/subagents';
import { SubAgentRunEventBus } from '../../tools/subagents/runEventBus';
import { createSubAgentConfig } from '../__fixtures__/subagentFixtures';
import type { SubAgentExecutorContext } from '../../tools/subagents';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test('legacy模型阶段只在实际请求存在时提供目标楼层，暂停/终态不保留', () => {
  const bus = new SubAgentRunEventBus();
  bus.createRun('stage', 'Worker', undefined, { initialContents: [{ role: 'user', parts: [{ text: 'task' }] }] });
  expect(bus.getManifest('stage')!.streamingContentIndex).toBeNull();
  bus.emit({ runId: 'stage', type: 'model_started' });
  expect(bus.getManifest('stage')!.streamingContentIndex).toBe(1);
  bus.emit({ runId: 'stage', type: 'llm_delta', payload: { delta: [{ text: 'first' }] } });
  expect(bus.getManifest('stage')!.streamingContentIndex).toBe(1);
  bus.emit({ runId: 'stage', type: 'model_finished' });
  bus.appendContent('stage', { role: 'model', parts: [{ text: 'done' }] });
  bus.emit({ runId: 'stage', type: 'tool_started' });
  expect(bus.getManifest('stage')!.status).toBe('running');
  expect(bus.getManifest('stage')!.streamingContentIndex).toBeNull();
  for (const type of ['run_paused', 'run_awaiting_monitor_action', 'run_completed', 'run_failed', 'run_cancelled', 'run_interrupted'] as const) {
    bus.emit({ runId: 'stage', type: 'run_resumed' });
    bus.emit({ runId: 'stage', type: 'model_started' });
    bus.emit({ runId: 'stage', type });
    expect(bus.getManifest('stage')!.streamingContentIndex).toBeNull();
  }
});

test('legacy真实executor在首delta前发布待输出位置，结束后清空且不新增持久占位', async () => {
  const runId = 'monitor-first-delta';
  const entered = deferred<void>();
  const response = deferred<any>();
  const context: SubAgentExecutorContext = {
    channelManager: { generate: jest.fn(() => { entered.resolve(); return response.promise; }) } as any,
    toolRegistry: { getAllDeclarations: () => [] } as any,
    configManager: { getConfig: async () => ({ id: 'channel_1', name: 'Test', type: 'custom', toolMode: 'function_call', multimodalToolsEnabled: false }) } as any
  };
  const executor = createDefaultExecutor(createSubAgentConfig(), context);
  const task = executor({ agentType: 'tester', prompt: 'task', runId });
  try {
    await entered.promise;
    const before = subAgentRunEventBus.getSnapshot(runId)!;
    const index = before.contents.length;
    expect(subAgentRunEventBus.getManifest(runId)!.streamingContentIndex).toBe(index);
    expect(before.contents.at(-1)?.role).toBe('user');
    response.resolve({ content: { role: 'model', parts: [{ text: 'done' }] }, model: 'test' });
    const result = await task;
    expect(result.success).toBe(true);
    expect(subAgentRunEventBus.getSnapshot(runId)!.contents).toHaveLength(index + 1);
    expect(subAgentRunEventBus.getManifest(runId)!.streamingContentIndex).toBeNull();
  } finally {
    response.resolve({ content: { role: 'model', parts: [{ text: 'done' }] }, model: 'test' });
    await task;
    subAgentConcurrencyLimiter.release(runId);
  }
});
