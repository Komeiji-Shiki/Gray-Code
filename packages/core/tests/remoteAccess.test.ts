import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { PlatformApplication } from '../../../apps/server/src/application';
import { ApplicationRouter } from '../../../apps/server/src/transport/router';
import { RemoteAccessService } from '../../../apps/server/src/transport/remoteAccess';
import { environmentSecretCodec } from '../../../apps/server/src/settings/environmentSecrets';
import { fixture } from './fixtures';

const until = async <T>(read: () => T | Promise<T>): Promise<T> => {
  for (let i = 0; i < 120; i++) { const result = await read(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error('远程状态未在预期时间内更新。');
};

test('远程设置随共享草稿保存，设备撤销与令牌轮换立即生效，关闭入口保留核心任务', async () => {
  const f = await fixture(); await f.store.close();
  const assets = path.join(f.root, 'web'); await mkdir(assets); await writeFile(path.join(assets, 'index.html'), '<p>Remote fixture</p>');
  const keyName = 'GRAYCODE_REMOTE_TEST_KEY'; const previousKey = process.env[keyName]; process.env[keyName] = randomBytes(32).toString('hex');
  const firstToken = randomBytes(32).toString('hex'); const nextToken = randomBytes(32).toString('hex');
  let release: (() => void) | undefined; let modelCalls = 0;
  const app = await PlatformApplication.open({ dataDirectory: f.data, secretCodec: environmentSecretCodec(keyName),
    remoteAccess: application => new RemoteAccessService(application, { clientDirectory: assets }), models: { generate: async input => {
      modelCalls++;
      await new Promise<void>(resolve => { release = resolve; input.signal.addEventListener('abort', () => resolve(), { once: true }); });
      return { role: 'model', parts: [{ text: '连接改变后任务继续完成。' }] };
    } } });
  const remote = app.remoteAccess!; const router = new ApplicationRouter(app); const desktop = { actorId: 'owner', clientId: 'desktop' };
  const ui = (type: string, data = {}) => router.call(desktop, 'ui.request', { type, data });
  const controller = new AbortController();
  let occupied: ReturnType<typeof createServer> | undefined;
  try {
    const uiEvents: Record<string, any>[] = []; const off = app.subscribe(event => { if (event.type === 'ui.view.changed') uiEvents.push(event); });
    await router.call(desktop, 'ui.view.set', { view: 'settings' }); off();
    expect(uiEvents[0]).toMatchObject({ clientId: 'desktop', view: 'settings' });
    expect(await router.mayReceive({ actorId: 'owner', clientId: 'another-device' }, uiEvents[0])).toBe(false);
    await remote.initialize(); expect(remote.status().state).toBe('disabled');
    const invalid = app.settings.snapshot();
    invalid.settings.remoteAccess = { enabled: true, port: 0, credentialRef: 'web_access', publicOrigin: 'http://wrong.invalid' };
    await expect(app.settings.save({ settings: invalid.settings, expectedRevision: invalid.revision, credentials: { web_access: firstToken } })).rejects.toThrow('HTTPS');
    delete invalid.settings.remoteAccess.publicOrigin;
    await expect(app.settings.save({ settings: invalid.settings, expectedRevision: invalid.revision, credentials: { web_access: 'short' } })).rejects.toThrow('32');
    expect(remote.status().port).toBeUndefined();
    await ui('ui.settings.begin');
    const draft = await ui('platform.settings.get') as any; draft.remoteAccess = { enabled: true, port: 0, credentialRef: 'web_access' };
    draft.accounts.push({ id: 'guest', displayName: '普通成员', role: 'guest', effects: [], workspaceIds: [] });
    await ui('platform.settings.update', { settings: draft, credentials: { web_access: firstToken } });
    expect(await ui('platform.remote.token')).toEqual({ token: firstToken });
    expect(remote.status().state).toBe('disabled');
    await ui('ui.settings.save'); await ui('ui.settings.end');
    expect(await ui('platform.remote.token')).toEqual({ token: firstToken });
    await until(() => remote.status().state === 'listening');
    expect(remote.keepsAlive).toBe(true);
    const sealed = await app.storage.getRecord('platform-secrets', 'web_access') as { encrypted: Uint8Array };
    expect(Buffer.from(sealed.encrypted).includes(Buffer.from(firstToken))).toBe(false);
    const address = remote.status().address!; const port = remote.status().port;
    const login = async (name: string, token: string) => {
      const response = await fetch(address + '/auth/login', { method: 'POST', headers: { Origin: address, 'Content-Type': 'application/json' }, body: JSON.stringify({ token, deviceName: name }) });
      expect(response.status).toBe(200); return response.headers.get('set-cookie')!.split(';')[0];
    };
    const rpc = (cookie: string, method = 'remote.status', params = {}) => fetch(address + '/rpc', { method: 'POST',
      headers: { Cookie: cookie, Origin: address, 'X-Graycode-Client': 'remote-fixture', 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params }) });
    const bearer = (token: string) => fetch(address + '/rpc', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'remote.status' }) });
    const phone = await login('手机', firstToken); const browser = await login('另一台浏览器', firstToken);
    const stream = await fetch(address + '/events?client=remote-fixture', { headers: { Cookie: phone }, signal: controller.signal });
    const finishedStream = stream.text();
    const phoneConnection = remote.status().connections.find(connection => connection.name === '手机')!;
    expect(phoneConnection.connected).toBe(true);
    await expect(router.call({ actorId: 'guest', clientId: 'guest' }, 'remote.status')).rejects.toThrow('Owner');
    await expect(router.call({ actorId: 'guest', clientId: 'guest' }, 'ui.request', { type: 'platform.remote.token' })).rejects.toThrow('Owner');
    const conversation = await app.createConversation('owner', '远程持续任务');
    const started = await rpc(phone, 'runs.start', { conversationId: conversation.id, requestKey: 'remote-once', agentId: 'default', text: '保持运行' });
    expect(started.status).toBe(200); const runId = (await started.json() as any).result.id; await until(() => release);
    await remote.revoke(phoneConnection.id); await expect(finishedStream).resolves.toContain(': connected');
    expect((await rpc(phone)).status).toBe(401); expect((await rpc(browser)).status).toBe(200);
    expect((await app.storage.getRun(runId))?.status).toBe('running');
    expect((await bearer(firstToken)).status).toBe(200);
    const rotate = app.settings.snapshot(); await app.settings.save({ settings: rotate.settings, expectedRevision: rotate.revision, credentials: { web_access: nextToken } });
    await until(() => remote.status().connections.length === 0);
    expect(remote.status().port).toBe(port);
    expect((await rpc(browser)).status).toBe(401); expect((await bearer(firstToken)).status).toBe(401); expect((await bearer(nextToken)).status).toBe(200);
    const currentPhone = await login('重新登录的手机', nextToken);
    const stoppingStream = await fetch(address + '/events?client=remote-fixture', { headers: { Cookie: currentPhone }, signal: controller.signal });
    const finishedStoppingStream = stoppingStream.text();
    const stopped = await rpc(currentPhone, 'remote.stop'); expect(stopped.status).toBe(200); expect(await stopped.json()).toEqual({ result: { success: true } });
    await expect(finishedStoppingStream).resolves.toContain(': connected');
    await until(() => remote.status().state === 'stopped'); expect(remote.keepsAlive).toBe(false);
    expect((await app.storage.getRun(runId))?.status).toBe('running');
    // 无关设置保存不能擅自重启用户刚刚停止的入口。
    const other = app.settings.snapshot(); other.settings.appearance.fontSize++;
    await app.settings.save({ settings: other.settings, expectedRevision: other.revision }); await new Promise(resolve => setTimeout(resolve, 40));
    expect(remote.status().state).toBe('stopped');
    occupied = createServer(); await new Promise<void>(resolve => occupied!.listen(0, '127.0.0.1', resolve));
    const conflict = app.settings.snapshot(); conflict.settings.remoteAccess!.port = (occupied.address() as any).port;
    await app.settings.save({ settings: conflict.settings, expectedRevision: conflict.revision }); await until(() => remote.status().state === 'error');
    expect(remote.status().error).toContain('EADDRINUSE');
    const repair = app.settings.snapshot(); repair.settings.remoteAccess!.port = 0;
    await app.settings.save({ settings: repair.settings, expectedRevision: repair.revision }); await until(() => remote.status().state === 'listening');
    release!(); expect((await app.runtime.wait(runId))?.status).toBe('completed'); expect(modelCalls).toBe(1);
  } finally {
    controller.abort(); if (occupied) await new Promise<void>(resolve => occupied!.close(() => resolve()));
    await app.close(); await f.cleanup();
    if (previousKey === undefined) delete process.env[keyName]; else process.env[keyName] = previousKey;
  }
});
