import type { ModelInput } from '@graycode/contracts';
import { PlatformApplication } from '../../../apps/server/src/application';
import { ApplicationRouter } from '../../../apps/server/src/transport/router';
import { fixture } from './fixtures';

const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
describe('跨入口的对话实时输出', () => {
  let f: Awaited<ReturnType<typeof fixture>>; let app: PlatformApplication; let router: ApplicationRouter;
  let inputReady: ReturnType<typeof deferred<ModelInput>>; let finish: ReturnType<typeof deferred<void>>; let events: Record<string, any>[];
  const owner = { actorId: 'owner', clientId: 'desktop-first' }; const observer = { actorId: 'owner', clientId: 'desktop-second' };
  beforeEach(async () => {
    f = await fixture(); await f.store.close(); inputReady = deferred<ModelInput>(); finish = deferred<void>(); events = [];
    app = await PlatformApplication.open({ dataDirectory: f.data, models: { generate: async input => {
      input.onDelta?.([{ text: '已经生成的内容' }]); inputReady.resolve(input);
      await Promise.race([finish.promise, new Promise<void>(resolve => input.signal.addEventListener('abort', () => resolve(), { once: true }))]);
      return { role: 'model', parts: [{ text: '已经生成的内容，完整回复。' }] };
    } } });
    router = new ApplicationRouter(app); app.subscribe(event => { if (event.type === 'ui.message') events.push(event); });
  });
  afterEach(async () => { finish.resolve(); await app.close(); await f.cleanup(); });
  async function received(client: typeof owner) { return (await Promise.all(events.map(async event => await router.mayReceive(client, event) ? event.message.data : null))).filter(item => item !== null); }

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
});
