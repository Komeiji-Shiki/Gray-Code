import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { PlatformApplication } from '../../../apps/server/src/application';
import { ApplicationRouter } from '../../../apps/server/src/transport/router';
import type { ProviderDefinition, SettingsSnapshot } from '@graycode/contracts';
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
