import { PlatformApplication } from '../../../apps/server/src/application';
import { ApplicationRouter } from '../../../apps/server/src/transport/router';
import { fixture } from './fixtures';

test('Bot 待发送接口按平台隔离，并保留主人授权与不确定消息重试确认', async () => {
  const f = await fixture(); await f.store.close();
  const app = await PlatformApplication.open({ dataDirectory: f.data });
  const router = new ApplicationRouter(app);
  const call = (platform: string, action: string, data = {}, actorId = 'owner') => router.call({ actorId, clientId: 'outbox-ui' }, 'ui.request', { type: `platform.${platform}.${action}`, data }) as Promise<any>;
  try {
    for (const platform of ['discord', 'onebot']) {
      await app.storage.putRecord({ namespace: `${platform}-outbox`, id: `${platform}-pending`, value: {
        route: { platform, botId: '900', channelId: 'group:30', actorId: 'owner', conversationId: 'conversation', platformUserId: '10' }, parts: [`${platform} 待确认回复`], next: 0,
      } });
    }
    for (const platform of ['discord', 'onebot']) {
      expect((await call(platform, 'outbox')).messages).toEqual([expect.objectContaining({ id: `${platform}-pending`, phase: 'unknown', preview: `${platform} 待确认回复` })]);
      await expect(call(platform, 'outbox', {}, 'unbound')).rejects.toThrow();
      await expect(call(platform, 'retryDelivery', { id: `${platform}-pending`, acknowledgeDuplicateRisk: true }, 'unbound')).rejects.toThrow();
      await expect(call(platform, 'retryDelivery', { id: `${platform}-pending` })).rejects.toThrow('明确确认');
      await call(platform, 'retryDelivery', { id: `${platform}-pending`, acknowledgeDuplicateRisk: true });
      expect((await call(platform, 'outbox')).messages[0].phase).toBe('queued');
    }
  } finally { await app.close(); await f.cleanup(); }
});

test('the existing UI protocol uses original settings services and streams core tool tasks with stable message IDs', async () => {
  const f = await fixture(); await f.store.close();
  const notifications: Record<string, any>[] = [];
  const app = await PlatformApplication.open({ dataDirectory: f.data, models: { generate: async input => {
    if (input.messages.some(message => message.parts.some(part => part.functionResponse))) return { role: 'model', parts: [{ text: 'Restored interface works.' }] };
    return { role: 'model', parts: [{ functionCall: { id: 'read', name: 'workspace_files', args: { action: 'list', path: '.' } } }] };
  } } });
  const router = new ApplicationRouter(app);
  const owner = { actorId: 'owner', clientId: 'original-ui' };
  const call = (type: string, data = {}) => router.call(owner, 'ui.request', { type, data }) as Promise<any>;
  app.subscribe(event => { if (event.type === 'ui.message') notifications.push(event); });
  try {
    await call('ui.settings.begin');
    const initial = app.settings.snapshot();
    const id = await call('config.createConfig', { name: 'Existing configuration', type: 'openai' });
    await call('config.updateConfig', { configId: id, updates: { url: 'http://localhost:1234/v1', model: 'fixture', options: { temperature: 0.7 }, optionsEnabled: { temperature: true } } });
    await call('settings.setActiveChannelId', { channelId: id });
    await call('updateUISettings', { ui: { appearance: { tpsBarEnabled: false } } });
    expect(app.settings.snapshot().revision).toBe(initial.revision);
    const platform = await call('platform.settings.get');
    platform.workspaces.push({ id: 'project', name: 'Fixture', directory: f.source, deviceId: 'local' });
    await call('platform.settings.update', { settings: platform });
    await call('ui.settings.save');
    expect((await app.product.channel(id))?.options).toMatchObject({ temperature: 0.7 });
    expect(app.product.features.ui?.appearance?.tpsBarEnabled).toBe(false);
    await call('ui.settings.end');
    await call('ui.context.set', { workspaceId: 'project' });
    await call('conversation.createConversation', { conversationId: 'original-chat', title: 'Original UI' });
    const result = await call('chatStream', { conversationId: 'original-chat', configId: id, messageId: 'stable-user-id', streamId: 'stream-one', message: 'List files.' });
    expect((await app.runtime.wait(result.runId))?.status).toBe('completed');
    const history = await call('conversation.getMessagesPaged', { conversationId: 'original-chat', limit: 120 });
    expect(history.messages[0].id).toBe('stable-user-id');
    const positioned = await call('conversation.getMessagesPaged', { conversationId: 'original-chat', offset: 1, limit: 1 });
    expect(positioned.messages).toHaveLength(1);
    expect(positioned.messages[0].index).toBe(1);
    expect(await call('conversation.getMessagePosition', { conversationId: 'original-chat', messageId: 'stable-user-id' })).toEqual({ index: 0 });
    // 应用同时发布原始客户端帧与供其他入口使用的后台帧，分别验证投递对象。
    const chunks = notifications.filter(event => event.message.type === 'streamChunk' && event.clientId === owner.clientId).map(event => event.message.data);
    expect(chunks.map(chunk => chunk.type)).toEqual(expect.arrayContaining(['toolsExecuting', 'toolIteration', 'complete']));
    expect(chunks.every(chunk => chunk.streamId === 'stream-one')).toBe(true);
    expect(chunks.at(-1).content.parts[0].text).toBe('Restored interface works.');
    const mirrors = notifications.filter(event => event.message.type === 'streamChunk' && event.excludeClientIds?.includes(owner.clientId));
    expect(mirrors.length).toBeGreaterThan(0);
    for (const event of mirrors) {
      expect(await router.mayReceive(owner, event)).toBe(false);
      expect(await router.mayReceive({ actorId: 'owner', clientId: 'another-ui' }, event)).toBe(true);
      expect(event.message.data.streamId).toBe(`background:${result.runId}`);
    }
    await expect(router.call({ actorId: 'nobody', clientId: 'bad' }, 'ui.request', { type: 'getSettings' })).rejects.toThrow();
  } finally { await app.close(); await f.cleanup(); }
});
