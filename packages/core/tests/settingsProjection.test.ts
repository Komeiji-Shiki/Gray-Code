import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { PlatformApplication } from '../../../apps/server/src/application';
import { ApplicationRouter } from '../../../apps/server/src/transport/router';
import type { ProviderDefinition, SettingsSnapshot } from '@graycode/contracts';
import { SettingsTransfer } from '../../../apps/server/src/settings/transfer';
import { fixture } from './fixtures';

describe('one settings transaction across legacy and platform entry points', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let app: PlatformApplication;
  let router: ApplicationRouter;
  const key = randomBytes(32);
  const codec = {
    encrypt: async (text: string) => { const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv);
      const content = Buffer.concat([cipher.update(text), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), content]); },
    decrypt: async (data: Uint8Array) => { const bytes = Buffer.from(data); const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      cipher.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString(); },
  };
  const owner = { actorId: 'owner', clientId: 'settings-client' };
  const call = (type: string, data = {}) => router.call(owner, 'ui.request', { type, data }) as Promise<any>;
  const profile = (id: string): ProviderDefinition => ({ id, name: id, protocol: 'openai', endpoint: 'http://localhost:1234/v1',
    model: 'initial', models: [], timeoutMs: 5000, stream: false, generation: {}, capabilities: {
      outputTokenParameter: 'protocol_default', strictTools: 'protocol_default', reasoningParameter: 'protocol_default',
      reasoningLevels: ['low', 'high'], reasoningSignature: 'native',
      compatibility: { deepSeekUserId: false, deepSeekVision: false, openCodeSession: false, nativePdf: false },
    } });
  beforeEach(async () => { f = await fixture(); await f.store.close(); app = await PlatformApplication.open({ dataDirectory: f.data, secretCodec: codec }); router = new ApplicationRouter(app); });
  afterEach(async () => { await app.close(); await f.cleanup(); });

  test('恢复检查读取后台实际草稿状态，包含其他已打开的设置客户端', async () => {
    await call('getSettings'); // 与桌面启动一致，先完成旧设置的初始化迁移。
    expect(await app.productUi.hasDirtyPreferences()).toBe(false);
    const other = { actorId: 'owner', clientId: 'other-settings-client' };
    await router.call(other, 'ui.request', { type: 'ui.settings.begin', data: {} });
    expect(await app.productUi.hasDirtyPreferences()).toBe(false);
    await router.call(other, 'ui.request', { type: 'settings.setActiveChannelId', data: { channelId: 'fixture-channel' } });
    expect(await app.productUi.hasDirtyPreferences()).toBe(true);
    await router.call(other, 'ui.request', { type: 'ui.settings.discard', data: {} });
    expect(await app.productUi.hasDirtyPreferences()).toBe(false);
  });

  test('direct provider changes refresh idle UI, preserve advanced options and reject stale open drafts', async () => {
    await call('getSettings'); // An idle client existed before the API edit.
    let snapshot = app.settings.snapshot(); snapshot.settings.providers = [profile('first'), profile('removed')];
    await app.settings.save({ settings: snapshot.settings, expectedRevision: snapshot.revision });
    const first = await app.product.draft();
    await first.configs.updateConfig('first', { options: { top_p: 0.8 }, optionsEnabled: { top_p: true } });
    await app.product.save(first);
    await call('ui.settings.begin');
    snapshot = app.settings.snapshot();
    snapshot.settings.providers = [{ ...snapshot.settings.providers[0], model: 'new-model', endpoint: 'http://localhost:4321/v1',
      generation: { temperature: 0.3, maxOutputTokens: 777, reasoningEffort: 'high' } }, profile('added')];
    await router.call(owner, 'settings.save', { settings: snapshot.settings, expectedRevision: snapshot.revision });
    await expect(call('ui.settings.save')).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    expect(await app.product.channel('removed')).toBeNull();
    expect(await app.product.channel('first')).toMatchObject({ model: 'new-model', url: 'http://localhost:4321/v1',
      options: { top_p: 0.8, temperature: 0.3, max_tokens: 777, reasoning: { effort: 'high' } } });
    await call('ui.settings.discard'); await call('ui.settings.save'); await call('ui.settings.end');
    expect(app.settings.snapshot().settings.providers.map(p => p.id)).toEqual(['first', 'added']);
    expect(app.settings.snapshot().settings.providers[0].generation).toMatchObject({ temperature: 0.3, maxOutputTokens: 777, reasoningEffort: 'high' });
    snapshot = app.settings.snapshot(); snapshot.settings.providers[0].name = 'Visible immediately';
    await app.settings.save({ settings: snapshot.settings, expectedRevision: snapshot.revision });
    expect((await call('config.getConfig', { configId: 'first' })).name).toBe('Visible immediately');
  });

  test('Responses 的 Codex 回传格式在保存、能力投影和重启后保留，并允许切回官方格式', async () => {
    const draft = await app.product.draft();
    const id = await draft.configs.createConfig({ type: 'openai-responses', enabled: true, timeout: 5000,
      url: 'http://localhost:1234/v1', name: 'Responses', model: 'fixture', apiKey: '' });
    await draft.configs.updateConfig(id, { sendHistoryThoughtSignatures: true });
    await app.product.save(draft);
    const update = async (updates: Record<string, unknown>) => {
      await call('ui.settings.begin');
      await call('config.updateConfig', { configId: id, updates });
      await call('ui.settings.save'); await call('ui.settings.end');
    };
    const signature = () => app.settings.snapshot().settings.providers.find(value => value.id === id)?.capabilities.reasoningSignature;
    const projectCapability = async (enabled: boolean) => {
      const snapshot = app.settings.snapshot();
      snapshot.settings.providers.find(value => value.id === id)!.capabilities.compatibility.openCodeSession = enabled;
      await app.settings.save({ settings: snapshot.settings, expectedRevision: snapshot.revision });
    };

    await update({ reasoningSignatureMode: 'codex' });
    expect(signature()).toBe('codex');
    await projectCapability(true);
    expect(await call('config.getConfig', { configId: id })).toMatchObject({ reasoningSignatureMode: 'codex', sendHistoryThoughtSignatures: true });

    await update({ sendHistoryThoughtSignatures: false });
    expect(signature()).toBe('none');
    await projectCapability(false);
    expect(await app.product.channel(id)).toMatchObject({ reasoningSignatureMode: 'codex', sendHistoryThoughtSignatures: false });
    await app.close(); app = await PlatformApplication.open({ dataDirectory: f.data, secretCodec: codec }); router = new ApplicationRouter(app);
    expect(await call('config.getConfig', { configId: id })).toMatchObject({ reasoningSignatureMode: 'codex', sendHistoryThoughtSignatures: false });

    await update({ sendHistoryThoughtSignatures: true });
    expect(signature()).toBe('codex');
    await update({ reasoningSignatureMode: 'official' });
    expect(signature()).toBe('native');
    expect(await app.product.channel(id)).toMatchObject({ reasoningSignatureMode: 'official', sendHistoryThoughtSignatures: true });
  });

  test('Chat Completions 工具附件的发送位置在保存、档案投影和重启后保留，旧档案缺省为内联', async () => {
    const draft = await app.product.draft();
    const id = await draft.configs.createConfig({ type: 'openai', enabled: true, timeout: 5000,
      url: 'http://localhost:1234/v1', name: 'Chat', model: 'fixture', apiKey: '' });
    await app.product.save(draft);
    const compatibility = () => app.settings.snapshot().settings.providers.find(value => value.id === id)!.capabilities.compatibility;
    expect(compatibility().toolMediaUserMessage).toBe(false);
    expect(await app.product.channel(id)).toMatchObject({ toolMediaUserMessageEnabled: false });

    await call('ui.settings.begin');
    await call('config.updateConfig', { configId: id, updates: { toolMediaUserMessageEnabled: true } });
    await call('ui.settings.save'); await call('ui.settings.end');
    expect(compatibility().toolMediaUserMessage).toBe(true);
    await app.close(); app = await PlatformApplication.open({ dataDirectory: f.data, secretCodec: codec }); router = new ApplicationRouter(app);
    expect(await call('config.getConfig', { configId: id })).toMatchObject({ toolMediaUserMessageEnabled: true });

    // 本次之前保存的档案没有这个字段，读取时仍按内联发送。
    const snapshot = app.settings.snapshot();
    delete snapshot.settings.providers.find(value => value.id === id)!.capabilities.compatibility.toolMediaUserMessage;
    await app.settings.save({ settings: snapshot.settings, expectedRevision: snapshot.revision });
    expect(await app.product.channel(id)).toMatchObject({ toolMediaUserMessageEnabled: false });
  });

  test('seals custom payloads and feature credentials with the same revision and restores them on restart', async () => {
    const draft = await app.product.draft();
    const id = await draft.configs.createConfig({ type: 'openai', enabled: true, timeout: 5000, url: 'http://localhost:1234/v1', name: 'Secrets', model: 'fixture',
      apiKey: 'fixture-primary', customHeadersEnabled: true, customHeaders: [{ key: 'X-Private', value: 'fixture-header', enabled: true }],
      customBody: { mode: 'advanced', json: '{"opaque":"fixture-body"}' } });
    await draft.settings.updateToolConfig('generate_image', { apiKey: 'fixture-feature' } as any);
    await app.product.save(draft);
    let snapshot = app.settings.snapshot();
    snapshot.settings.providers.push({ ...profile('direct'), customBody: { opaque: 'fixture-direct' } });
    await app.settings.save({ settings: snapshot.settings, expectedRevision: snapshot.revision });
    const stored = JSON.stringify([await app.storage.getRecord('product-settings', 'main'), await app.storage.getRecord('platform-settings', 'main')]);
    for (const secret of ['fixture-primary', 'fixture-header', 'fixture-body', 'fixture-feature', 'fixture-direct']) expect(stored).not.toContain(secret);
    expect((await app.product.channel(id))?.apiKey).toBe('fixture-primary');
    await app.close(); app = await PlatformApplication.open({ dataDirectory: f.data, secretCodec: codec }); router = new ApplicationRouter(app);
    expect((await app.product.channel(id))?.customHeaders?.[0].value).toBe('fixture-header');
    expect((await app.product.channel(id))?.customBody?.json).toContain('fixture-body');
    expect(app.product.features.toolsConfig?.generate_image?.apiKey).toBe('fixture-feature');
    expect(app.settings.snapshot().settings.providers.find(p => p.id === 'direct')?.customBody).toEqual({ opaque: 'fixture-direct' });
    snapshot = app.settings.snapshot();
    const competing = await Promise.allSettled([1, 2].map(fontSize => app.settings.save({ settings: { ...snapshot.settings,
      appearance: { ...snapshot.settings.appearance, fontSize: 14 + fontSize } }, expectedRevision: snapshot.revision })));
    expect(competing.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  });

  test('渠道只保存 provider 表示不了的附加选项：只改高级选项不动 provider，关闭的温度记住原值', async () => {
    const draft = await app.product.draft();
    const id = await draft.configs.createConfig({ type: 'anthropic', enabled: true, timeout: 5000, url: 'http://localhost:1234/v1', name: 'Claude',
      model: 'fixture', apiKey: '', promptCachingTtl: '1h', models: [{ id: 'fixture', name: 'Fixture', contextWindow: 200000 }],
      options: { temperature: 0.4, max_tokens: 4096, thinking: { type: 'adaptive', effort: 'custom', effortCustom: 'turbo' } },
      optionsEnabled: { temperature: false, max_tokens: true, thinking: true } } as any);
    await app.product.save(draft);
    const provider = () => app.settings.snapshot().settings.providers.find(value => value.id === id)!;
    const stored = async () => ((await app.storage.getRecord('product-settings', 'main')) as any).channels.find((value: any) => value.id === id);
    expect(provider().generation).toEqual({ maxOutputTokens: 4096 });
    // 共享字段只在 provider 里；关闭的温度、协议专属字段与模型附加信息留在渠道。
    expect(await stored()).toMatchObject({ type: 'anthropic', promptCachingTtl: '1h', options: { temperature: 0.4, thinking: { effort: 'custom' } },
      models: [{ id: 'fixture', contextWindow: 200000 }] });
    for (const field of ['url', 'model', 'name', 'timeout', 'preferStream', 'sendHistoryThoughtSignatures']) expect(await stored()).not.toHaveProperty(field);
    expect((await stored()).options).not.toHaveProperty('max_tokens');

    const revision = app.settings.snapshot().revision;
    const before = structuredClone(provider());
    await call('ui.settings.begin');
    await call('config.updateConfig', { configId: id, updates: { options: { temperature: 0.4, max_tokens: 4096, top_p: 0.9,
      thinking: { type: 'adaptive', effort: 'custom', effortCustom: 'turbo' } }, optionsEnabled: { temperature: false, max_tokens: true, thinking: true, top_p: true } } });
    await call('ui.settings.save'); await call('ui.settings.end');
    expect(app.settings.snapshot().revision).toBeGreaterThan(revision);
    expect(provider()).toEqual(before);

    // provider 设置推理强度后，Anthropic 的自定义强度按 effortCustom 回写，不再把字面量 custom 当强度。
    let snapshot = app.settings.snapshot();
    snapshot.settings.providers.find(value => value.id === id)!.generation.reasoningEffort = 'high';
    await app.settings.save({ settings: snapshot.settings, expectedRevision: snapshot.revision });
    expect(await app.product.channel(id)).toMatchObject({ options: { thinking: { type: 'adaptive', effort: 'high' } }, optionsEnabled: { thinking: true } });
    await call('ui.settings.begin');
    await call('config.updateConfig', { configId: id, updates: { options: { ...(await app.product.channel(id))!.options,
      thinking: { type: 'adaptive', effort: 'custom', effortCustom: 'turbo' }, temperature: 0.4 }, optionsEnabled: { ...(await app.product.channel(id))!.optionsEnabled, temperature: true } } });
    await call('ui.settings.save'); await call('ui.settings.end');
    expect(provider().generation).toEqual({ maxOutputTokens: 4096, temperature: 0.4, reasoningEffort: 'turbo' });
    expect(await app.product.channel(id)).toMatchObject({ options: { top_p: 0.9, thinking: { effort: 'custom', effortCustom: 'turbo' } } });

    // 设置页关闭温度：provider 不再发送温度，渠道保留最后的数值供下次开启。
    await call('ui.settings.begin');
    await call('config.updateConfig', { configId: id, updates: { optionsEnabled: { ...(await app.product.channel(id))!.optionsEnabled, temperature: false } } });
    await call('ui.settings.save'); await call('ui.settings.end');
    expect(provider().generation).toEqual({ maxOutputTokens: 4096, reasoningEffort: 'turbo' });
    await app.close(); app = await PlatformApplication.open({ dataDirectory: f.data, secretCodec: codec }); router = new ApplicationRouter(app);
    expect(await app.product.channel(id)).toMatchObject({ promptCachingTtl: '1h', models: [{ id: 'fixture', name: 'Fixture', contextWindow: 200000 }],
      options: { temperature: 0.4, max_tokens: 4096, top_p: 0.9 }, optionsEnabled: { temperature: false, max_tokens: true, top_p: true } });
  });

  test('旧版本保存的完整渠道仍可读取，重叠字段以 provider 为准；provider 换协议后旧协议选项不再套用', async () => {
    const draft = await app.product.draft();
    const id = await draft.configs.createConfig({ type: 'openai', enabled: true, timeout: 5000, url: 'http://localhost:1234/v1', name: 'Chat',
      model: 'fixture', apiKey: '', autoSummarizeMethod: 'notes', options: { temperature: 0.2, top_p: 0.5 }, optionsEnabled: { temperature: true, top_p: true } } as any);
    await app.product.save(draft);
    // 模拟旧格式：完整渠道，且端点与温度和 provider 不一致。
    const record = structuredClone(await app.storage.getRecord('product-settings', 'main')) as any;
    const legacy = { ...await app.product.channel(id), apiKey: '', url: 'http://stale.invalid/v1', model: 'stale', retryCount: 7,
      options: { temperature: 0.9, top_p: 0.5 }, optionsEnabled: { temperature: true, top_p: true } };
    record.channels = record.channels.map((value: any) => value.id === id ? legacy : value);
    await app.storage.commitRecords([{ namespace: 'product-settings', id: 'main', value: record }]);
    await app.close(); app = await PlatformApplication.open({ dataDirectory: f.data, secretCodec: codec }); router = new ApplicationRouter(app);
    expect(await app.product.channel(id)).toMatchObject({ url: 'http://localhost:1234/v1', model: 'fixture', retryCount: 7,
      options: { temperature: 0.2, top_p: 0.5 }, optionsEnabled: { temperature: true, top_p: true } });

    const snapshot = app.settings.snapshot();
    snapshot.settings.providers.find(value => value.id === id)!.protocol = 'anthropic';
    await app.settings.save({ settings: snapshot.settings, expectedRevision: snapshot.revision });
    const switched = await app.product.channel(id);
    expect(switched).toMatchObject({ type: 'anthropic', autoSummarizeMethod: 'notes', options: { temperature: 0.2, max_tokens: undefined } });
    expect(switched?.options).not.toHaveProperty('top_p');
    expect(switched).not.toHaveProperty('retryCount', 7);
  });

  test('导出再导入保留渠道的全部附加选项与 provider 独有字段', async () => {
    const draft = await app.product.draft();
    const id = await draft.configs.createConfig({ type: 'openai-responses', enabled: true, timeout: 5000, url: 'http://localhost:1234/v1', name: 'Responses',
      model: 'fixture', apiKey: '', promptCacheKeyEnabled: true, sendHistoryThoughtSignatures: false, reasoningSignatureMode: 'deepseek',
      options: { max_output_tokens: 2048, reasoning: { effort: 'high', summary: 'auto' } }, optionsEnabled: { max_output_tokens: true, reasoning: true } } as any);
    await app.product.save(draft);
    let snapshot = app.settings.snapshot();
    snapshot.settings.providers.find(value => value.id === id)!.capabilities.reasoningLevels = ['high'];
    await app.settings.save({ settings: snapshot.settings, expectedRevision: snapshot.revision });
    const before = { channel: await app.product.channel(id), provider: app.settings.snapshot().settings.providers.find(value => value.id === id) };
    expect(before.channel).toMatchObject({ reasoningSignatureMode: 'deepseek', sendHistoryThoughtSignatures: false, promptCacheKeyEnabled: true });

    const transfer = new SettingsTransfer(app);
    const exported = await transfer.export(await app.product.draft());
    const cleared = await app.product.draft();
    await cleared.configs.deleteConfig(id);
    await app.product.save(cleared);
    expect(await app.product.channel(id)).toBeNull();
    const imported = await app.product.draft();
    await transfer.import(imported, exported, true);
    await app.product.save(imported);
    snapshot = app.settings.snapshot();
    // 导入按覆盖语义刷新更新时间，其余字段完整保留。
    expect({ ...await app.product.channel(id), updatedAt: 0 }).toEqual({ ...before.channel, updatedAt: 0 });
    expect(snapshot.settings.providers.find(value => value.id === id)).toEqual(before.provider);
  });

  test('reports activation failure as a committed save, without leaving a dirty draft', async () => {
    await call('ui.settings.begin');
    await call('updateUISettings', { ui: { appearance: { tpsBarEnabled: false } } });
    const revision = app.settings.snapshot().revision;
    jest.spyOn(app.mcp, 'synchronize').mockRejectedValueOnce(new Error('fixture connection unavailable'));
    const result = await call('ui.settings.save') as SettingsSnapshot;
    expect(result.revision).toBeGreaterThan(revision);
    expect(result.activationWarnings).toEqual(['fixture connection unavailable']);
    expect(await call('ui.settings.status')).toMatchObject({ dirty: false, revision: result.revision });
    expect(app.product.features.ui?.appearance?.tpsBarEnabled).toBe(false);
    expect(await app.storage.getRecord('product-settings', 'main')).toMatchObject({ features: { ui: { appearance: { tpsBarEnabled: false } } } });
  });
});
