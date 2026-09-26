/**
 * 首条消息自动命名（独立宿主）。
 *
 * 独立宿主新建对话先以占位标题落库（ui.mode.new / conversation.createConversation），首条消息
 * 不再经过「以消息创建对话」的旧流程；不补命名时所有桌面对话会一直停在「新对话」。
 */

import { PlatformApplication } from '../../../apps/server/src/application';
import { backfillPlaceholderTitles } from '../../../apps/server/src/conversations/autoTitles';
import { fixture } from './fixtures';

describe('首条消息自动命名', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let app: PlatformApplication;
  const owner = { actorId: 'owner', clientId: 'desktop-first' };

  beforeEach(async () => {
    f = await fixture(); await f.store.close();
    app = await PlatformApplication.open({ dataDirectory: f.data,
      models: { generate: async () => ({ role: 'model', parts: [{ text: '收到。' }] }) } });
  });
  afterEach(async () => { await app.close(); await f.cleanup(); });

  test('占位标题的空对话在首条消息后按消息摘要命名并广播元数据变更', async () => {
    const conversation = await app.createConversation('owner', '新对话');
    const events: Record<string, any>[] = [];
    app.subscribe(event => { if (event.type === 'conversation.changed') events.push(event); });

    const started = await app.productUi.chat.start(owner, { conversationId: conversation.id, streamId: 'title-1',
      configId: 'fixture', message: '  帮我检查   打包脚本  ' }, await app.product.draft()) as { runId: string };
    await app.runtime.wait(started.runId);

    expect((await app.storage.getConversation(conversation.id))?.title).toBe('帮我检查 打包脚本');
    expect(events).toEqual([expect.objectContaining({ conversationId: conversation.id, metadataOnly: true })]);
  });

  test('已命名对话不被覆盖，非空历史的占位标题也不因后续消息改名', async () => {
    const titled = await app.createConversation('owner', '已经有标题');
    const first = await app.productUi.chat.start(owner, { conversationId: titled.id, streamId: 'title-2',
      configId: 'fixture', message: '新的消息' }, await app.product.draft()) as { runId: string };
    await app.runtime.wait(first.runId);
    expect((await app.storage.getConversation(titled.id))?.title).toBe('已经有标题');

    const placeholder = await app.createConversation('owner', '新对话');
    await app.storage.appendHistory(placeholder.id, [{ role: 'user', parts: [{ text: '历史消息' }] }]);
    const second = await app.productUi.chat.start(owner, { conversationId: placeholder.id, streamId: 'title-3',
      configId: 'fixture', message: '再发一条' }, await app.product.draft()) as { runId: string };
    await app.runtime.wait(second.runId);
    expect((await app.storage.getConversation(placeholder.id))?.title).toBe('新对话');
  });

  test('启动补齐把历史遗留的占位标题按首条用户消息命名，且只执行一次', async () => {
    const conversation = await app.createConversation('owner', '新对话');
    await app.storage.appendHistory(conversation.id, [
      { role: 'user', parts: [{ text: '  这是   第一句话  ' }] },
      { role: 'model', parts: [{ text: '好的' }] },
    ]);
    // 只有工具响应、没有真实用户文本的对话保持占位标题。
    const legacy = await app.createConversation('owner', '新对话');
    await app.storage.appendHistory(legacy.id, [{ role: 'user', isFunctionResponse: true,
      parts: [{ functionResponse: { id: 'call_1', name: 'read_file', response: { success: true } } }] }]);

    expect(await backfillPlaceholderTitles(app)).toBe(1);
    expect((await app.storage.getConversation(conversation.id))?.title).toBe('这是 第一句话');
    expect((await app.storage.getConversation(legacy.id))?.title).toBe('新对话');
    // 一次性标记：再次调用直接跳过
    expect(await backfillPlaceholderTitles(app)).toBe(0);
  });

  test('首条消息的自动命名不覆盖读取之后发生的手动改名和其他元数据', async () => {
    const conversation = await app.createConversation('owner', '新对话');
    const commit = app.storage.commitConversation.bind(app.storage);
    jest.spyOn(app.storage, 'commitConversation').mockImplementationOnce(async value => {
      const latest = (await app.storage.getConversation(conversation.id))!;
      await app.storage.saveMetadata({ ...latest, title: '主人指定的标题', custom: { concurrentSetting: true } });
      return commit(value);
    });
    const started = await app.productUi.chat.start(owner, { conversationId: conversation.id, streamId: 'title-race',
      configId: 'fixture', message: '自动标题' }, await app.product.draft()) as { runId: string };
    await app.runtime.wait(started.runId);
    expect(await app.storage.getConversation(conversation.id)).toMatchObject({ title: '主人指定的标题', custom: { concurrentSetting: true } });
  });

  test('历史标题补齐遇到暂时读取失败后，下次仍会重试', async () => {
    const conversation = await app.createConversation('owner', '新对话');
    await app.storage.appendHistory(conversation.id, [{ role: 'user', parts: [{ text: '待补齐的标题' }] }]);
    jest.spyOn(app.storage, 'readHistory').mockRejectedValueOnce(new Error('temporary read failure'));
    const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await backfillPlaceholderTitles(app)).toBe(0);
      expect(await backfillPlaceholderTitles(app)).toBe(1);
      expect((await app.storage.getConversation(conversation.id))?.title).toBe('待补齐的标题');
    } finally { warning.mockRestore(); }
  });
});
