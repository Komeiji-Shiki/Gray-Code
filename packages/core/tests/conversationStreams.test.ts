import type { ModelInput, PlatformMessage, RunRecord } from '@graycode/contracts';
import { PlatformApplication } from '../../../apps/server/src/application';
import { ApplicationRouter } from '../../../apps/server/src/transport/router';
import { fixture } from './fixtures';

const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
describe('跨入口的对话实时输出', () => {
  let f: Awaited<ReturnType<typeof fixture>>; let app: PlatformApplication; let router: ApplicationRouter;
  let inputReady: ReturnType<typeof deferred<ModelInput>>; let finish: ReturnType<typeof deferred<void>>; let events: Record<string, any>[];
  let modelError: Error | undefined; let streamedParts: PlatformMessage['parts'];
  const owner = { actorId: 'owner', clientId: 'desktop-first' }; const observer = { actorId: 'owner', clientId: 'desktop-second' };
  beforeEach(async () => {
    f = await fixture(); await f.store.close(); inputReady = deferred<ModelInput>(); finish = deferred<void>(); events = [];
    modelError = undefined; streamedParts = [{ text: '已经生成的内容' }];
    app = await PlatformApplication.open({ dataDirectory: f.data, models: { generate: async input => {
      input.onDelta?.(streamedParts); inputReady.resolve(input);
      await Promise.race([finish.promise, new Promise<void>(resolve => input.signal.addEventListener('abort', () => resolve(), { once: true }))]);
      if (modelError) throw modelError;
      return { role: 'model', parts: [{ text: '已经生成的内容，完整回复。' }] };
    } } });
    router = new ApplicationRouter(app); app.subscribe(event => { if (event.type === 'ui.message') events.push(event); });
  });
  afterEach(async () => { finish.resolve(); await app.close(); await f.cleanup(); });
  async function received(client: typeof owner) { return (await Promise.all(events.map(async event => await router.mayReceive(client, event) ? event.message.data : null))).filter(item => item !== null); }

  test.each([true, false])('流式错误向所有客户端携带已保存内容，刷新后仍存在，含正文=%s', async hasText => {
    streamedParts = [{ text: '已经生成的思考', thought: true }, ...(hasText ? [{ text: '已经生成的正文' }] : [])];
    modelError = new Error('OpenAI 在流式响应中返回错误: 上游流在终态事件之前中断');
    const conversation = await app.createConversation('owner', '部分回复');
    const result = await app.productUi.chat.start(owner, { conversationId: conversation.id, streamId: 'failed-stream', configId: 'fixture', message: '开始' }, await app.product.draft()) as { runId: string };
    await inputReady.promise; finish.resolve();
    expect((await app.runtime.wait(result.runId))?.status).toBe('failed');
    const saved = (await app.storage.readFullHistory(conversation.id)).messages.at(-1)!;
    expect(saved).toMatchObject({ role: 'model', incompleteReason: 'interrupted', parts: streamedParts });
    for (const client of [owner, observer]) {
      const error = (await received(client)).find(item => item.type === 'error');
      expect(error).toMatchObject({ error: { code: 'API_ERROR', message: modelError.message }, content: { id: saved.id, parts: streamedParts } });
    }
    expect(await app.productUi.chat.resumeConversationStream(observer, conversation.id)).toEqual({ active: false, latestMessageId: saved.id });
  });

  test('Bot 入口任务可在桌面接续已有输出，同一历史继续更新并由桌面停止', async () => {
    const conversation = await app.createConversation('owner', 'Bot 发起的对话');
    const run = await app.runtime.start({ requestKey: 'discord:fixture-event', actorId: 'owner', conversationId: conversation.id, agentId: 'default', message: { role: 'user', parts: [{ text: '外部入口消息' }] } });
    await inputReady.promise;
    expect(await app.productUi.chat.resumeConversationStream(observer, conversation.id)).toEqual({ active: true });
    const snapshot = (await received(observer)).find(item => item.resumeSnapshot);
    expect(snapshot.chunk.contentSnapshot.parts).toEqual([{ text: '已经生成的内容' }]);
    expect(snapshot.streamId).toBe(`background:${run.id}`);
    await app.productUi.chat.cancel(observer, conversation.id); expect((await app.runtime.wait(run.id))?.status).toBe('cancelled');
    expect((await received(observer)).filter(item => item.type === 'cancelled')).toHaveLength(1);
  });

  test('桌面发起的输出对每个客户端只投递一次，刷新后的客户端从快照接续至完成', async () => {
    const conversation = await app.createConversation('owner', '多客户端对话');
    const result = await app.productUi.chat.start(owner, { conversationId: conversation.id, streamId: 'original-stream', configId: 'fixture', message: '开始' }, await app.product.draft()) as { runId: string };
    await inputReady.promise;
    expect((await received(owner)).filter(item => item.chunk?.delta?.some((part: any) => part.text))).toHaveLength(1);
    expect((await received(observer)).filter(item => item.chunk?.delta?.some((part: any) => part.text))).toHaveLength(1);
    await app.productUi.chat.resumeConversationStream(owner, conversation.id);
    const live = await inputReady.promise; live.onDelta?.([{ text: '，继续输出' }]); finish.resolve();
    expect((await app.runtime.wait(result.runId))?.status).toBe('completed');
    const frames = await received(owner);
    expect(frames.filter(item => item.type === 'complete')).toHaveLength(1);
    expect(frames.at(-1).content.parts[0].text).toBe('已经生成的内容，完整回复。');
    expect(frames.filter(item => item.chunk?.delta?.some((part: any) => part.text === '，继续输出'))).toHaveLength(1);
    const idle = await app.productUi.chat.resumeConversationStream(observer, conversation.id);
    expect(idle.active).toBe(false); expect(idle.latestMessageId).toBe((await app.storage.readHistory(conversation.id, { limit: 1 })).messages[0].id);
    const value = app.settings.snapshot(); value.settings.accounts.push({ id: 'guest', role: 'guest', displayName: '访客', effects: [], workspaceIds: [] });
    await app.settings.save({ settings: value.settings, expectedRevision: value.revision });
    expect(await received({ actorId: 'guest', clientId: 'other' })).toEqual([]);
  });

  test('停止旧任务返回时对话已释放，紧接着的新回合不会被判为对话忙', async () => {
    const conversation = await app.createConversation('owner', '替换当前回合');
    const first = await app.productUi.chat.start(owner, { conversationId: conversation.id, streamId: 'replace-first', configId: 'fixture', message: '开始' }, await app.product.draft()) as { runId: string };
    await inputReady.promise;
    await app.productUi.chat.cancel(owner, conversation.id);
    // 取消返回时旧任务必须已经结算完（工具结果与终态事件都已落盘）
    expect(app.runtime.activeCount).toBe(0);
    expect((await app.storage.getRun(first.runId))?.status).toBe('cancelled');
    // 一个对话同时只允许一个活跃任务：旧任务尚未释放时这里会收到 STORAGE_BUSY
    const second = await app.productUi.chat.start(owner, { conversationId: conversation.id, streamId: 'replace-second', configId: 'fixture', message: '替换当前回合' }, await app.product.draft()) as { runId: string };
    expect(second.runId).not.toBe(first.runId);
  });

  test('等待对话空闲：空闲时立即返回，任务未释放时按时限返回不空闲', async () => {
    const conversation = await app.createConversation('owner', '空闲探测');
    expect(await app.productUi.call(owner, 'chat.awaitConversationIdle', { conversationId: conversation.id })).toEqual({ idle: true });
    const started = await app.productUi.chat.start(owner, { conversationId: conversation.id, streamId: 'idle-probe', configId: 'fixture', message: '开始' }, await app.product.draft()) as { runId: string };
    await inputReady.promise;
    expect(await app.productUi.chat.awaitIdle(conversation.id, 200)).toEqual({ idle: false });
    finish.resolve();
    expect((await app.runtime.wait(started.runId))?.status).toBe('completed');
    expect(await app.productUi.chat.awaitIdle(conversation.id, 200)).toEqual({ idle: true });
  });

  test('没有本进程控制器的活跃记录按固定间隔等待，不忙轮询存储', async () => {
    const conversation = await app.createConversation('owner', '遗留任务');
    const run: RunRecord = { id: 'unowned', requestKey: 'unowned', conversationId: conversation.id, actorId: 'owner',
      agentId: 'default', status: 'queued', createdAt: Date.now(), updatedAt: Date.now(), iteration: 0, catalogVersion: 'fixture' };
    await app.storage.createRun(run, { role: 'user', parts: [{ text: '遗留输入' }] });
    const reads = jest.spyOn(app.storage, 'listRuns');
    expect(await app.productUi.chat.awaitIdle(conversation.id, 220)).toEqual({ idle: false });
    expect(reads.mock.calls.length).toBeLessThanOrEqual(5);
  });
});
