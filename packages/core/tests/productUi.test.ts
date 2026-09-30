import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { PlatformApplication } from '../../../apps/server/src/application';
import { ApplicationRouter } from '../../../apps/server/src/transport/router';
import { fixture } from './fixtures';
import { pathToFileURL } from 'node:url';
import type { WorkspaceDiff } from '../../../apps/server/src/workspace/diffs';

test('客户端清理后恢复代码模式和项目，空白会话首条输入不改变归属', async () => {
  const f = await fixture(); await f.store.close();
  const app = await PlatformApplication.open({ dataDirectory: f.data });
  const client = { actorId: 'owner', clientId: 'reconnected-code-client' };
  const ui = (type: string, data = {}) => app.productUi.call(client, type, data) as Promise<any>;
  try {
    const draft = await app.product.draft();
    draft.app.workspaces.push({ id: 'project', name: '原项目', directory: f.source, deviceId: 'local' });
    await app.product.save(draft);
    await ui('ui.context.set', { workspaceId: 'project', mode: 'code' });
    await app.productUi.clientClosed(client.clientId);
    await new Promise(resolve => setImmediate(resolve));
    const createDraft = jest.spyOn(app.product, 'draft');
    try {
      await ui('ui.conversation.focus', { conversationId: null, resynchronized: true });
      expect(createDraft).toHaveBeenCalledTimes(1);
      expect(await ui('getWorkspaceUri')).toBe(pathToFileURL(f.source).toString());
      const created = await ui('conversation.createConversation', { conversationId: 'after-reconnect', title: '重连后输入' });
      expect(created.workspaceId).toBe('project');
      expect((await app.conversation('owner', 'after-reconnect')).custom).toMatchObject({ platformMode: 'code' });
    } finally { createDraft.mockRestore(); }
  } finally { await app.close(); await f.cleanup(); }
});

test('界面状态按客户端隔离，固定桌面身份兼容旧记录并跨启动恢复', async () => {
  const f = await fixture(); await f.store.close();
  const app = await PlatformApplication.open({ dataDirectory: f.data });
  const desktop = { actorId: 'owner', clientId: 'desktop-process-one', uiStateKey: 'desktop' };
  const first = { actorId: 'owner', clientId: 'browser-tab-one' }, second = { actorId: 'owner', clientId: 'browser-tab-two' };
  const legacy = { desktopConversationId: 'legacy-conversation', preference: '保留' };
  try {
    await app.storage.putRecord({ namespace: 'ui-state', id: 'owner', value: legacy });
    expect(await app.productUi.call(desktop, 'ui.state.get')).toEqual(legacy);
    expect(await app.productUi.call(first, 'ui.state.get')).toEqual({ preference: '保留' });
    for (const [client, conversationId] of [[desktop, 'desktop-conversation'], [first, 'first-conversation'], [second, null]] as const)
      await app.productUi.call(client, 'ui.state.set', { value: { desktopConversationId: conversationId } });
    expect(await app.productUi.call(first, 'ui.state.get')).toEqual({ desktopConversationId: 'first-conversation' });
    expect(await app.productUi.call(second, 'ui.state.get')).toEqual({ desktopConversationId: null });
    expect(await app.productUi.call({ ...desktop, clientId: 'desktop-process-two' }, 'ui.state.get'))
      .toEqual({ desktopConversationId: 'desktop-conversation' });
    expect(await app.storage.getRecord('ui-state', 'owner')).toEqual(legacy);
  } finally { await app.close(); await f.cleanup(); }
});

test('手动总结等待模型时仍能切换会话和读取设置，取消后原文保持不变', async () => {
  const f = await fixture(); await f.store.close();
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const app = await PlatformApplication.open({ dataDirectory: f.data, models: { generate: async input => {
    entered();
    await new Promise<void>((_resolve, reject) => {
      input.signal.throwIfAborted();
      input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true });
    });
    throw new Error('取消后不应继续生成');
  } } });
  const router = new ApplicationRouter(app);
  const call = (type: string, data = {}) => router.call({ actorId: 'owner', clientId: 'summary-ui' }, 'ui.request', { type, data }) as Promise<any>;
  let pending: Promise<any> | undefined;
  try {
    const draft = await app.product.draft();
    const providerId = await draft.configs.createConfig({ name: '总结夹具', type: 'openai', enabled: true, url: 'http://127.0.0.1:1/v1', model: 'fixture', apiKey: '', timeout: 1000 });
    draft.app.workspaces.push({ id: 'summary-workspace', name: '总结工作区', directory: f.source, deviceId: 'local' });
    await app.product.save(draft);
    await call('ui.context.set', { mode: 'code', workspaceId: 'summary-workspace' });
    await call('conversation.createConversation', { conversationId: 'summary-origin', title: '总结中' });
    await app.storage.appendHistory('summary-origin', [{ id: 'user', role: 'user', parts: [{ text: '保留原文' }] }, { id: 'model', role: 'model', parts: [{ text: '已有回复' }] }]);
    pending = call('summarizeContext', { conversationId: 'summary-origin', configId: providerId });
    await started;
    let responsive = false;
    const interaction = call('conversation.createConversation', { conversationId: 'summary-other', title: '其他对话' })
      .then(() => call('getSettings')).then(() => { responsive = true; });
    try {
      // 模型由取消信号结束；这个有界等待只用于证明界面请求不必等模型完成。
      await Promise.race([interaction, new Promise(resolve => setTimeout(resolve, 1000))]);
      expect(responsive).toBe(true);
      expect(app.context.isSummarizing('summary-origin')).toBe(true);
      await expect(call('summarizeContext', { conversationId: 'summary-origin', configId: providerId })).rejects.toThrow('已经在总结');
    } finally { await call('cancelSummarizeRequest', { conversationId: 'summary-origin' }); }
    expect(await pending).toMatchObject({ success: false, error: { code: 'ABORTED' } });
    await interaction;
    expect(app.context.isSummarizing('summary-origin')).toBe(false);
    expect((await app.storage.readFullHistory('summary-origin')).messages.map(message => message.id)).toEqual(['user', 'model']);
  } finally {
    await app.close(); await pending; await f.cleanup();
  }
});

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

test('设置页仅在显式显示时按需读取已保存的渠道 API Key', async () => {
  const f = await fixture(); await f.store.close();
  const key = randomBytes(32);
  const app = await PlatformApplication.open({ dataDirectory: f.data, secretCodec: {
    encrypt: async text => { const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv);
      const content = Buffer.concat([cipher.update(text), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), content]); },
    decrypt: async data => { const bytes = Buffer.from(data); const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      cipher.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString(); }
  } });
  const router = new ApplicationRouter(app);
  const call = (type: string, data = {}) => router.call({ actorId: 'owner', clientId: 'key-ui' }, 'ui.request', { type, data }) as Promise<any>;
  try {
    await call('ui.settings.begin');
    const id = await call('config.createConfig', { name: '测试渠道', type: 'openai' });
    await call('config.updateConfig', { configId: id, updates: { apiKey: 'saved-test-key' } });
    await call('ui.settings.save');
    expect((await call('config.getConfig', { configId: id })).apiKey).toBe('••••••••');
    expect(await call('config.revealApiKey', { configId: id })).toEqual({ apiKey: 'saved-test-key' });
    await call('config.updateConfig', { configId: id, updates: { apiKey: 'unsaved-test-key' } });
    expect(await call('config.revealApiKey', { configId: id })).toEqual({ apiKey: 'unsaved-test-key' });
    await expect(call('config.revealApiKey', { configId: 'missing' })).rejects.toThrow('渠道不存在');
  } finally { await app.close(); await f.cleanup(); }
});

test('删除当前工作区后仍可退出设置、停止对话和切换工作区，并同步清空旧 URI', async () => {
  const f = await fixture(); await f.store.close(); const app = await PlatformApplication.open({ dataDirectory: f.data });
  const clients = ['settings-end', 'cancel-stale', 'switch-stale'].map(clientId => ({ actorId: 'owner', clientId }));
  const events: Record<string, any>[] = []; app.subscribe(event => { if (event.type === 'ui.message') events.push(event); });
  try {
    const draft = await app.product.draft();
    draft.app.workspaces.push({ id: 'removed', name: '待删除', directory: f.source, deviceId: 'local' },
      { id: 'remaining', name: '保留', directory: f.root, deviceId: 'local' }); await app.product.save(draft);
    const conversation = await app.createConversation('owner', '失效工作区中的对话', 'removed');
    for (const client of clients) await app.productUi.call(client, 'ui.context.set', { workspaceId: 'removed' });
    await app.productUi.call(clients[0], 'ui.settings.begin');
    const before = app.settings.snapshot(); before.settings.workspaces = before.settings.workspaces.filter(workspace => workspace.id !== 'removed');
    await app.settings.save({ settings: before.settings, expectedRevision: before.revision });
    await expect(app.productUi.call(clients[0], 'ui.settings.end')).resolves.toBeUndefined();
    expect(await app.productUi.call(clients[1], 'cancelStream', { conversationId: conversation.id })).toEqual({ success: true });
    expect(await app.productUi.call(clients[1], 'getWorkspaceUri')).toBeNull();
    await app.productUi.call(clients[2], 'ui.context.set', { workspaceId: 'remaining' });
    expect(await app.productUi.call(clients[2], 'getWorkspaceUri')).toBe(pathToFileURL(f.root).toString());
    for (const client of clients) expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ clientId: client.clientId, message: { type: 'workspaceUri', data: null } }),
    ]));
    expect((await app.storage.getConversation(conversation.id))?.workspaceId).toBe('removed');
  } finally { await app.close(); await f.cleanup(); }
});

test('断开立即解除退出阻塞，排队写入和设置草稿仍可重连恢复', async () => {
  const f = await fixture(); await f.store.close(); const app = await PlatformApplication.open({ dataDirectory: f.data });
  const client = { actorId: 'owner', clientId: 'detached-draft' };
  let enter!: () => void, release!: () => void; const entered = new Promise<void>(resolve => { enter = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; }); let pending: Promise<unknown> | undefined;
  try {
    await app.productUi.call(client, 'ui.settings.begin');
    const draft = app.product.draft.bind(app.product);
    const held = jest.spyOn(app.product, 'draft').mockImplementationOnce(async () => { enter(); await gate; return draft(); });
    pending = app.productUi.call(client, 'ui.settings.discard'); await entered;
    await app.productUi.clientClosed(client.clientId);
    expect(await app.productUi.hasDirtyPreferences()).toBe(false);
    app.productUi.clientConnected(client.clientId); release(); await pending; held.mockRestore();
    const id = await app.productUi.call(client, 'config.createConfig', { name: '离线草稿', type: 'openai' });
    expect(await app.productUi.hasDirtyPreferences()).toBe(true);
    expect(await app.productUi.hasClientDirtyPreferences(client.clientId)).toBe(true);
    expect(await app.productUi.hasClientDirtyPreferences('unopened-client')).toBe(false);
    await app.productUi.clientClosed(client.clientId);
    expect(await app.productUi.hasDirtyPreferences()).toBe(false);
    expect(await app.productUi.hasDirtyPreferences(true)).toBe(true);
    expect(await app.productUi.hasClientDirtyPreferences(client.clientId)).toBe(true);
    expect(await app.productUi.hasDirtyPreferences(true, client.clientId)).toBe(false);
    app.productUi.clientConnected(client.clientId);
    expect(await app.productUi.hasDirtyPreferences()).toBe(true);
    expect(await app.productUi.call(client, 'config.getConfig', { configId: id })).toMatchObject({ id, name: '离线草稿' });
  } finally { release(); await pending; jest.restoreAllMocks(); await app.close(); await f.cleanup(); }
});

test('未打开设置页的有效远端更新仍被计为脏草稿，离线退出统计和随后打开设置都保留它', async () => {
  const f = await fixture(); await f.store.close(); const app = await PlatformApplication.open({ dataDirectory: f.data });
  const client = { actorId: 'owner', clientId: 'implicit-remote-draft' };
  const profiles = [{ id: 'unsaved-profile', name: '未打开设置的草稿', command: 'node', args: ['--version'], enabled: false }];
  try {
    expect(await app.productUi.call(client, 'platform.externalAgents.update', { profiles })).toEqual({ success: true });
    expect(await app.productUi.call(client, 'ui.settings.status')).toMatchObject({ dirty: true });
    expect(await app.productUi.hasDirtyPreferences()).toBe(true);
    expect(await app.productUi.hasClientDirtyPreferences(client.clientId)).toBe(true);
    expect(app.settings.snapshot().settings.externalAgents).not.toEqual(profiles);
    await app.productUi.clientClosed(client.clientId);
    expect(await app.productUi.hasDirtyPreferences()).toBe(false);
    expect(await app.productUi.hasDirtyPreferences(true)).toBe(true);
    expect(await app.productUi.hasDirtyPreferences(true, client.clientId)).toBe(false);
    expect(await app.productUi.hasClientDirtyPreferences(client.clientId)).toBe(true);
    expect(await app.productUi.call(client, 'ui.settings.begin')).toMatchObject({ dirty: true });
    expect(await app.productUi.call(client, 'platform.externalAgents.get')).toEqual(profiles);
    await app.productUi.call(client, 'ui.settings.save');
    expect(app.settings.snapshot().settings.externalAgents).toEqual(profiles);
    expect(await app.productUi.hasClientDirtyPreferences(client.clientId)).toBe(false);
  } finally { await app.close(); await f.cleanup(); }
});

test('Diff 预览使用提案所属工作区和精确记录，保留多文件入口及超过百条的历史目标', async () => {
  const f = await fixture(); await f.store.close(); const app = await PlatformApplication.open({ dataDirectory: f.data });
  const client = { actorId: 'owner', clientId: 'diff-identity' }; const events: Record<string, any>[] = [];
  app.subscribe(event => { if (event.type === 'workspace.diff.open') events.push(event); });
  try {
    const draft = await app.product.draft();
    draft.app.workspaces.push({ id: 'proposal-workspace', name: '提案', directory: f.source, deviceId: 'local' },
      { id: 'selected-workspace', name: '当前界面', directory: f.root, deviceId: 'local' }); await app.product.save(draft);
    const conversation = await app.createConversation('owner', 'Diff 归属', 'proposal-workspace');
    await app.productUi.call(client, 'ui.context.set', { workspaceId: 'selected-workspace' });
    const target: WorkspaceDiff = { id: 'older-target', conversationId: conversation.id, workspaceId: 'proposal-workspace',
      path: 'real/target.txt', originalText: '旧', proposedText: '新', baseHash: null, status: 'accepted', toolCallId: 'multiple-files', createdAt: 1 };
    await app.storage.putRecord({ namespace: 'workspace-diffs', id: target.id, ownerId: conversation.id, value: target });
    const pending = { ...target, id: 'pending-target', path: 'real/pending.txt', status: 'pending' as const, createdAt: 2 };
    await app.storage.putRecord({ namespace: 'workspace-diffs', id: pending.id, ownerId: conversation.id, value: pending });
    for (let i = 0; i < 100; i++) {
      const value = { ...target, id: `newer-${i}`, toolCallId: `other-${i}`, createdAt: i + 3 };
      await app.storage.putRecord({ namespace: 'workspace-diffs', id: value.id, ownerId: conversation.id, value });
    }
    const newest = await app.diffs.list('owner', 'proposal-workspace');
    expect(newest).toHaveLength(100); expect(newest.some(value => value.id === target.id)).toBe(false);
    const included = await app.diffs.list('owner', 'proposal-workspace', target.id);
    expect(included).toHaveLength(100); expect(included.at(-1)?.id).toBe(target.id);
    await expect(app.diffs.list('owner', 'selected-workspace', target.id)).rejects.toThrow();
    await expect(app.diffs.list('owner', 'proposal-workspace', 123 as unknown as string)).rejects.toThrow();
    await app.productUi.call(client, 'diff.openPreview', { toolId: target.toolCallId, filePaths: [target.path, pending.path] });
    expect(events.at(-1)).toMatchObject({ clientId: client.clientId, workspaceId: pending.workspaceId, conversationId: conversation.id,
      path: pending.path, id: pending.id, toolCallId: pending.toolCallId });
    await app.productUi.call(client, 'diff.openPreview', { toolId: target.toolCallId, result: { diffContentId: target.id } });
    expect(events.at(-1)).toMatchObject({ workspaceId: target.workspaceId, path: target.path, id: target.id });
    const other = await app.createConversation('owner', '复用模型工具标识', 'selected-workspace');
    await app.storage.putRecord({ namespace: 'workspace-diffs', id: 'ambiguous-target', ownerId: other.id,
      value: { ...target, id: 'ambiguous-target', conversationId: other.id, workspaceId: 'selected-workspace' } });
    const count = events.length;
    await expect(app.productUi.call(client, 'diff.openPreview', { toolId: target.toolCallId })).rejects.toThrow();
    await expect(app.productUi.call(client, 'diff.openPreview', { toolId: 'missing-tool' })).rejects.toThrow();
    expect(events).toHaveLength(count);
  } finally { await app.close(); await f.cleanup(); }
});

test('真实嵌套工具结果中的提案身份限定卡片范围，复用工具标识和文件路径仍精确预览', async () => {
  const f = await fixture(); await f.store.close(); const app = await PlatformApplication.open({ dataDirectory: f.data });
  const client = { actorId: 'owner', clientId: 'nested-diff-result' }; const events: Record<string, any>[] = [];
  app.subscribe(event => { if (event.type === 'workspace.diff.open') events.push(event); });
  try {
    const draft = await app.product.draft();
    draft.app.workspaces.push({ id: 'nested-workspace', name: '嵌套结果', directory: f.source, deviceId: 'local' }); await app.product.save(draft);
    const conversation = await app.createConversation('owner', '复用调用标识', 'nested-workspace');
    const first: WorkspaceDiff = { id: 'older-card', conversationId: conversation.id, workspaceId: 'nested-workspace', path: 'same-file.txt',
      originalText: '初始', proposedText: '旧卡片结果', baseHash: null, status: 'accepted', toolCallId: 'reused-tool', createdAt: 1 };
    const second: WorkspaceDiff = { ...first, id: 'newer-card', proposedText: '新卡片结果', status: 'pending', createdAt: 2 };
    const save = (value: WorkspaceDiff) => app.storage.putRecord({ namespace: 'workspace-diffs', id: value.id, ownerId: value.conversationId, value });
    await save(first); await save(second);
    const openSingle = (value: WorkspaceDiff) => app.productUi.call(client, 'diff.openPreview', {
      toolId: value.toolCallId, toolName: 'apply_diff', filePaths: [value.path],
      result: { success: value.status === 'accepted', data: { path: value.path, diffContentId: value.id, pendingDiffId: value.id } },
    });
    await openSingle(first); expect(events.at(-1)?.id).toBe(first.id);
    await openSingle(second); expect(events.at(-1)?.id).toBe(second.id);
    second.status = 'accepted'; await save(second);
    await openSingle(first); expect(events.at(-1)?.id).toBe(first.id);
    await openSingle(second); expect(events.at(-1)?.id).toBe(second.id);
    const member: WorkspaceDiff = { ...first, id: 'batch-member', path: 'second-file.txt', status: 'pending', createdAt: 3 };
    const unrelated: WorkspaceDiff = { ...first, id: 'other-card-pending', path: 'outside-card.txt', status: 'pending', createdAt: 0 };
    await save(member); await save(unrelated);
    const openBatch = (values: WorkspaceDiff[]) => app.productUi.call(client, 'diff.openPreview', {
      toolId: first.toolCallId, toolName: 'write_file', filePaths: values.map(value => value.path),
      result: { success: true, data: { results: values.map(value => ({ path: value.path, success: true, diffContentId: value.id, pendingDiffId: value.id })) } },
    });
    await openBatch([first, member]); expect(events.at(-1)?.id).toBe(member.id);
    member.status = 'accepted'; await save(member);
    await openBatch([second, member]); expect(events.at(-1)?.id).toBe(second.id);
    const count = events.length;
    await expect(app.productUi.call(client, 'diff.openPreview', { toolId: first.toolCallId, filePaths: [first.path],
      result: { success: true, data: { results: [{ path: first.path, action: 'unchanged' }] } } })).rejects.toThrow();
    await expect(app.productUi.call(client, 'diff.openPreview', { toolId: first.toolCallId, id: unrelated.id,
      result: { success: true, data: { diffContentId: first.id, pendingDiffId: first.id } } })).rejects.toThrow();
    expect(events).toHaveLength(count);
  } finally { await app.close(); await f.cleanup(); }
});
