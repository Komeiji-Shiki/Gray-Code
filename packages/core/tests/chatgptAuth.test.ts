import { createCipheriv, createDecipheriv, randomBytes, webcrypto } from 'node:crypto';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { RuntimeToolRegistry } from '@graycode/core';
import { SettingsService } from '../../../apps/server/src/settings/service';
import { ChatGPTService } from '../../../apps/server/src/chatgpt/service';
import { DIRECT_SCOPE, OPENAI_ISSUER } from '../../../apps/server/src/chatgpt/oauth';
import { ProviderModelAdapter } from '../../../apps/server/src/model/adapter';
import { resolveCapabilities } from '../../../apps/server/src/model/capabilities';
import { OpenAIResponsesFormatter } from '../../../backend/modules/channel/formatters/openai-responses';
import { getModels } from '../../../backend/modules/channel/modelList';
import * as productIdentity from '../../../backend/core/productIdentity';
import { TokenCountService } from '../../../backend/modules/channel/TokenCountService';
import type { ProviderDefinition } from '@graycode/contracts';

describe('ChatGPT 官方订阅登录', () => {
  let service: ChatGPTService, settings: SettingsService<any>;
  let records: Map<string, { value: any; revision: number }>;
  let fetcher: jest.Mock, publicKey: any, privateKey: any;
  let identity: { clientId: string; subject: string; nonce: string; scope: string; expires: number };
  let refreshRequests: number;
  let earliestRefresh: number | string | undefined;
  const signal = () => new AbortController().signal;
  const json = (value: any, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
  async function token() {
    const idToken = await new SignJWT({ email: identity.subject + '@example.test', nonce: identity.nonce })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).setIssuer(OPENAI_ISSUER)
      .setAudience(identity.clientId).setSubject(identity.subject).setIssuedAt().setExpirationTime('1h').sign(privateKey);
    return { access_token: 'test-access-' + identity.subject, refresh_token: 'test-refresh-' + identity.subject,
      id_token: idToken, token_type: 'Bearer', scope: identity.scope, expires_in: identity.expires,
      ...(earliestRefresh !== undefined ? { earliest_refresh_at: earliestRefresh } : {}) };
  }
  async function login(clientId = 'oaiapp_first', subject = 'first', scope = DIRECT_SCOPE, newAccount = false) {
    const { url } = await service.start('channel', 'window', undefined, newAccount);
    const authorize = new URL(url);
    identity = { clientId, subject, nonce: authorize.searchParams.get('nonce')!, scope, expires: 60 };
    const callback = new URL(authorize.searchParams.get('redirect_uri')!);
    callback.search = new URLSearchParams({ code: 'test-code', state: authorize.searchParams.get('state')!, client_id: clientId }).toString();
    const response = await fetch(callback);
    expect(response.status).toBe(200);
    return authorize;
  }
  beforeAll(() => {
    if (!globalThis.crypto) Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
  });
  beforeEach(async () => {
    ({ publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true }));
    records = new Map(); refreshRequests = 0; earliestRefresh = undefined;
    const key = randomBytes(32);
    const codec = {
      encrypt: async (text: string) => {
        const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
        const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
        return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
      },
      decrypt: async (bytes: Uint8Array) => {
        const raw = Buffer.from(bytes), decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
        decipher.setAuthTag(raw.subarray(12, 28));
        return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
      },
    };
    const storage = {
      getRecord: async (namespace: string, id: string) => records.get(namespace + ':' + id)?.value ?? null,
      getVersionedRecord: async (namespace: string, id: string) => records.get(namespace + ':' + id) ?? { value: null, revision: null },
      listRecords: async (namespace: string) => [...records.keys()].filter(key => key.startsWith(namespace + ':')).map(key => key.slice(namespace.length + 1)),
      commitRecords: async (mutations: any[]) => mutations.map(mutation => {
        const key = mutation.namespace + ':' + mutation.id, before = records.get(key);
        if (mutation.expectedRevision !== undefined && mutation.expectedRevision !== (before?.revision ?? null)) throw new Error('CONFLICT');
        const revision = (before?.revision ?? 0) + 1;
        if (mutation.delete) records.delete(key); else records.set(key, { value: mutation.value, revision });
        return { namespace: mutation.namespace, id: mutation.id, revision: mutation.delete ? null : revision };
      }),
    };
    settings = new SettingsService(storage as any, new RuntimeToolRegistry(), codec);
    await settings.initialize();
    await settings.updateCredential('channel_key', () => 'test-existing-api-key');
    fetcher = jest.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/jwks.json')) return json({ keys: [{ ...await exportJWK(publicKey), kid: 'test-key', alg: 'RS256', use: 'sig' }] });
      if (url.endsWith('/openid-configuration')) return json({ revocation_endpoint: OPENAI_ISSUER + '/oauth/revoke' });
      if (url.endsWith('/oauth/revoke')) return new Response(null, { status: 200 });
      const form = new URLSearchParams(String(init?.body));
      if (form.get('grant_type') === 'authorization_code') {
        expect(form.get('client_id')).toBe(identity.clientId);
        expect(form.get('code_verifier')).toBeTruthy();
        expect(form.get('resource')).toBe('https://api.openai.com/v1');
        return json(await token());
      }
      if (form.get('grant_type') === 'refresh_token') {
        refreshRequests++;
        await new Promise(resolve => setTimeout(resolve, 1));
        return json({ access_token: 'test-renewed', refresh_token: 'test-rotated', expires_in: 3600 });
      }
      throw new Error('Unexpected request: ' + url);
    });
    const app = { storage, settings, product: { runtimeSettings: () => ({ getEffectiveProxyUrl: () => undefined }) } } as any;
    service = new ChatGPTService(app, fetcher);
    (service as any).testApp = app;
  });
  afterEach(async () => { await service?.close(); jest.restoreAllMocks(); });

  test('自动回调校验身份，独立加密保存账户，并复用注册进行重新登录', async () => {
    const app = (service as any).testApp;
    const unavailable = new ChatGPTService({ ...app, settings: new SettingsService(app.storage, new RuntimeToolRegistry()) }, fetcher);
    await expect(unavailable.start('channel', 'window')).rejects.toThrow('加密');
    unavailable.close();
    const revision = settings.snapshot().revision;
    const authorize = await login();
    expect(authorize.searchParams.get('client_id')).toBe('dynamic_agent_client');
    expect(authorize.searchParams.get('agent_name_hint')).toBe('GrayCode');
    expect(authorize.searchParams.get('ext_agent_host_id')).toMatch(/^urn:uuid:/);
    const status = await service.status('channel', 'window');
    expect(status.accounts).toEqual([expect.objectContaining({ email: 'first@example.test', planEnabled: true })]);
    expect(JSON.stringify(status)).not.toContain('test-access');
    expect(settings.snapshot().revision).toBe(revision);
    expect(await settings.credential('channel_key')).toBe('test-existing-api-key');
    expect(JSON.stringify([...records.values()])).not.toContain('test-refresh');
    const returning = await service.start('channel', 'window');
    expect(new URL(returning.url).searchParams.get('client_id')).toBe('oaiapp_first');
    expect(new URL(returning.url).searchParams.has('agent_name_hint')).toBe(false);
  });

  test('续期合并并发请求，保留轮换令牌，重启读取，并分别切换与退出账户', async () => {
    await login();
    expect(await Promise.all(Array.from({ length: 6 }, () => service.accessToken('channel', signal()))))
      .toEqual(Array(6).fill('test-renewed'));
    expect(refreshRequests).toBe(1);
    const restartedSettings = new SettingsService((service as any).testApp.storage, new RuntimeToolRegistry(), (settings as any).secrets);
    await restartedSettings.initialize();
    const restarted = new ChatGPTService({ ...(service as any).testApp, settings: restartedSettings }, fetcher);
    expect(await restarted.accessToken('channel', signal())).toBe('test-renewed');
    restarted.close();
    await login('oaiapp_second', 'second', DIRECT_SCOPE, true);
    await service.select('channel', 'window', 'oaiapp_first');
    expect(await service.accessToken('channel', signal())).toBe('test-renewed');
    const result = await service.disconnect('channel', 'window', 'oaiapp_first');
    expect(result.revoked).toBe(true);
    expect(result.accounts).toEqual([expect.objectContaining({ clientId: 'oaiapp_first', connected: false }),
      expect.objectContaining({ clientId: 'oaiapp_second', connected: true })]);
    expect(await settings.credential('channel_key')).toBe('test-existing-api-key');
    await expect(service.accessToken('channel', signal())).rejects.toThrow('登录');
  });

  test.each(['seconds', 'iso'])('保存最早续期时间并在允许前保留有效登录（%s）', async kind => {
    const now = Date.now(), earliest = Math.ceil((now + 30_000) / 1000) * 1000;
    earliestRefresh = kind === 'seconds' ? earliest / 1000 : new Date(earliest).toISOString();
    await login();
    const reference = settings.snapshot().credentialIds.find(id => id.startsWith('chatgpt_'))!;
    const account = JSON.parse((await settings.credential(reference))!).accounts[0];
    expect(account.earliestRefreshAt).toBe(earliest);
    expect(await service.accessToken('channel', signal())).toBe('test-access-first');
    await expect((service as any).refresh('channel', account)).rejects.toMatchObject({ code: 'refresh_not_ready' });
    expect(refreshRequests).toBe(0);
    expect((await service.status('channel', 'window')).accounts[0].connected).toBe(true);
    jest.spyOn(Date, 'now').mockReturnValue(earliest + 1);
    expect(await service.accessToken('channel', signal())).toBe('test-renewed');
    expect(refreshRequests).toBe(1);
  });

  test('轮换后身份验证暂时失败，重启从加密记录恢复且不再使用旧续期令牌', async () => {
    await login();
    const app = (service as any).testApp;
    await service.close();
    let unavailableKeys = true;
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/jwks.json') && unavailableKeys) return json({}, 503);
      if (new URLSearchParams(String(init?.body)).get('grant_type') === 'refresh_token') {
        refreshRequests++;
        return json({ ...await token(), access_token: 'test-recovered-access', refresh_token: 'test-recovered-refresh', expires_in: 3600 });
      }
      return original(url, init);
    });
    service = new ChatGPTService(app, fetcher);
    await expect(service.accessToken('channel', signal())).rejects.toThrow();
    const reference = settings.snapshot().credentialIds.find(id => id.startsWith('chatgpt_'))!;
    expect(JSON.parse((await settings.credential(reference))!).accounts[0].pendingRefresh.data.refresh_token).toBe('test-recovered-refresh');
    expect(JSON.stringify([...records.values()])).not.toContain('test-recovered-refresh');
    await service.close(); unavailableKeys = false;
    const restartedSettings = new SettingsService(app.storage, new RuntimeToolRegistry(), (settings as any).secrets);
    await restartedSettings.initialize();
    service = new ChatGPTService({ ...app, settings: restartedSettings }, fetcher);
    expect(await service.accessToken('channel', signal())).toBe('test-recovered-access');
    expect(refreshRequests).toBe(1);
    const recovered = JSON.parse((await restartedSettings.credential(reference))!).accounts[0];
    expect(recovered.refreshToken).toBe('test-recovered-refresh');
    expect(recovered.pendingRefresh).toBeUndefined();
  });

  test('正常退出等待进行中的续期保存完成', async () => {
    await login();
    let begin!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { begin = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (url: string, init?: RequestInit) => {
      if (new URLSearchParams(String(init?.body)).get('grant_type') === 'refresh_token') { begin(); await blocked; }
      return original(url, init);
    });
    const access = service.accessToken('channel', signal());
    await started;
    let closed = false;
    const close = service.close().then(() => { closed = true; });
    await new Promise(resolve => setImmediate(resolve));
    expect(closed).toBe(false);
    release(); await close;
    expect(await access).toBe('test-renewed');
    const reference = settings.snapshot().credentialIds.find(id => id.startsWith('chatgpt_'))!;
    expect(JSON.parse((await settings.credential(reference))!).accounts[0].refreshToken).toBe('test-rotated');
  });

  test('拒绝错误 state 和身份 nonce，未授权订阅时不发送模型请求', async () => {
    const { url } = await service.start('channel', 'window');
    const authorize = new URL(url), callback = new URL(authorize.searchParams.get('redirect_uri')!);
    identity = { clientId: 'oaiapp_first', subject: 'first', nonce: 'wrong-nonce', scope: DIRECT_SCOPE, expires: 60 };
    callback.search = new URLSearchParams({ code: 'test-code', state: 'wrong-state', client_id: identity.clientId }).toString();
    await expect(service.complete('channel', 'other-window', callback.href)).rejects.toThrow('待完成');
    await expect(service.complete('channel', 'window', callback.href)).rejects.toThrow('不匹配');
    expect(fetcher).not.toHaveBeenCalled();
    callback.searchParams.set('state', authorize.searchParams.get('state')!);
    await expect(service.complete('channel', 'window', callback.href)).rejects.toThrow('校验');
    expect((await service.status('channel', 'window')).accounts).toEqual([]);
    await login('oaiapp_identity', 'identity', 'openid profile email');
    expect((await service.status('channel', 'window')).accounts[0].planEnabled).toBe(false);
    await expect(service.accessToken('channel', signal())).rejects.toThrow('订阅');
  });

  test.each([undefined, { mode: 'explicit' }])('最终订阅请求强制流式、清理覆盖参数并保留命名空间工具与思考历史（%j）', async (cacheOptions) => {
    const profile: ProviderDefinition = { id: 'channel', name: 'ChatGPT', protocol: 'openai-responses', authMode: 'chatgpt',
      endpoint: 'https://example.test/v1', model: 'gpt-6.1-sol', models: [], stream: false, timeoutMs: 1000,
      generation: { temperature: 0.7, maxOutputTokens: 100 },
      customBody: cacheOptions ? { prompt_cache_options: cacheOptions, prompt_cache_key: 'custom-cache-session' } : {},
      customHeaders: { Session_Id: 'old-custom-session' },
      capabilities: { outputTokenParameter: 'max_tokens', strictTools: 'protocol_default', reasoningParameter: 'protocol_default',
        reasoningLevels: [], reasoningSignature: 'none', compatibility: { openCodeSession: true, deepSeekUserId: false,
          deepSeekVision: true, nativePdf: false } } };
    const adapter = new ProviderModelAdapter({ profile: async () => profile, credential: async () => 'api-key',
      chatgpt: async () => ({ token: 'subscription-token', identity: 'oaiapp_test' }) });
    const input = { providerId: 'channel', conversationId: 'test', systemPrompt: 'Stable system',
      messages: [{ role: 'model' as const, parts: [{ thought: true, text: 'Inspect first',
        thoughtSignatures: { 'openai-responses': 'subscription-reasoning' },
        openaiResponsesReasoning: { id: 'rs_subscription', summary: [{ type: 'summary_text' as const, text: 'Inspect first' }],
          content: [{ type: 'reasoning_text' as const, text: 'Inspect first' }] } }] },
        { role: 'user' as const, parts: [{ text: 'hello' }] }], tools: [{ name: 'inspect', description: 'Inspect',
        parameters: { type: 'object', properties: {} } }], maxOutputTokens: 200, signal: signal() };
    const preview = await adapter.preview(input);
    expect(preview.body).toEqual(expect.objectContaining({ stream: true, store: false, instructions: 'Stable system' }));
    expect(preview.body).not.toHaveProperty('max_tokens');
    expect(preview.body).not.toHaveProperty('max_output_tokens');
    expect(preview.body).not.toHaveProperty('temperature');
    expect(preview.body).not.toHaveProperty('prompt_cache_options');
    expect(preview.body.tools[0]).toEqual(expect.objectContaining({ type: 'namespace', name: 'graycode' }));
    expect(preview.body.input[0]).toEqual({ type: 'reasoning', id: 'rs_subscription',
      encrypted_content: 'subscription-reasoning', summary: [{ type: 'summary_text', text: 'Inspect first' }] });
    expect(resolveCapabilities(profile, profile.model)).toMatchObject({ reasoningSignature: 'codex',
      compatibility: { openCodeSession: false, deepSeekVision: false } });
    const normal = new OpenAIResponsesFormatter().buildRequest({ configId: 'normal', history: [] },
      { id: 'normal', name: 'normal', type: 'openai-responses', url: 'https://example.test/v1', apiKey: 'api-key', model: 'test',
        options: { stream: false, temperature: 0.7 }, optionsEnabled: { temperature: true } } as any);
    expect(normal.body.temperature).toBe(0.7);
    expect(normal.stream).toBe(false);
    expect(normal.headers).not.toHaveProperty('session_id');
    const terminal = { type: 'response.completed', response: { usage: { input_tokens: 1839, output_tokens: 5, total_tokens: 1844,
      input_tokens_details: { cached_tokens: 1664 } } } };
    const output = { type: 'response.output_item.done', output_index: 0,
      item: { type: 'message', id: 'msg_cache_test', role: 'assistant', content: [{ type: 'output_text', text: 'OK' }] } };
    const network = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(`data: ${JSON.stringify(output)}\n\ndata: ${JSON.stringify(terminal)}\n\n`));
    const generated = await adapter.generate(input);
    const headers = new Headers(network.mock.calls[0][1]?.headers);
    expect(headers.get('authorization')).toBe('Bearer subscription-token');
    if (cacheOptions) expect(headers.get('session_id')).toBe('custom-cache-session');
    else {
      expect(headers.get('session_id')).toMatch(/^graycode_[a-f0-9]{64}$/);
      expect(headers.get('session_id')).not.toContain('test');
    }
    expect(generated.usageMetadata).toMatchObject({ cachedContentTokenCount: 1664 });
  });

  test('订阅模型列表读取账户目录，默认 Token 计数不调用不支持的远程接口', async () => {
    jest.spyOn(productIdentity, 'getProductVersion').mockReturnValue('2.0.0-pre.4');
    const network = jest.spyOn(globalThis, 'fetch').mockResolvedValue(json({ models: [
      { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1-Sol', visibility: 'list' },
      { slug: 'account-model', display_name: 'Account model', visibility: 'list' },
      { slug: 'hidden-model', visibility: 'hidden' },
    ] }));
    const config = { id: 'models', name: 'models', type: 'openai-responses', authMode: 'chatgpt', url: 'https://example.test/v1',
      apiKey: 'synthetic-model-list-token', model: 'account-model', timeout: 1000 } as any;
    expect(await getModels(config)).toEqual([
      { id: 'gpt-6.1-sol', name: 'GPT-6.1-Sol' },
      { id: 'account-model', name: 'Account model' },
    ]);
    expect(network.mock.calls[0][0]).toBe('https://api.openai.com/v1/models?client_version=2.0.0-pre.4');
    network.mockClear();
    const count = await new TokenCountService().countTokensWithChannelConfig(config, [{ role: 'user', parts: [{ text: 'hello' }] }]);
    expect(count.success).toBe(true);
    expect(network).not.toHaveBeenCalled();
  });
});
