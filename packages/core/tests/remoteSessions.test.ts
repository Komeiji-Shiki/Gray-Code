import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { PlatformApplication } from '../../../apps/server/src/application';
import { ApplicationRouter } from '../../../apps/server/src/transport/router';
import { RemoteAccessService } from '../../../apps/server/src/transport/remoteAccess';
import { environmentSecretCodec } from '../../../apps/server/src/settings/environmentSecrets';
import { fixture } from './fixtures';

test('网页登录跨核心重启保留，退出和撤销持久生效，停止入口后换回旧令牌也不恢复旧登录', async () => {
  const f = await fixture(); await f.store.close();
  const assets = path.join(f.root, 'web'); await mkdir(assets); await writeFile(path.join(assets, 'index.html'), '<p>Login fixture</p>');
  const keyName = 'GRAYCODE_SESSION_TEST_KEY'; const previousKey = process.env[keyName]; process.env[keyName] = randomBytes(32).toString('hex');
  const token = randomBytes(32).toString('hex');
  const open = () => PlatformApplication.open({ dataDirectory: f.data, secretCodec: environmentSecretCodec(keyName),
    remoteAccess: app => new RemoteAccessService(app, { clientDirectory: assets }) });
  let app = await open();
  const address = () => app.remoteAccess!.status().address!;
  const login = async (name: string) => {
    const response = await fetch(address() + '/auth/login', { method: 'POST', headers: { Origin: address(), 'Content-Type': 'application/json' }, body: JSON.stringify({ token, deviceName: name }) });
    expect(response.status).toBe(200); expect(response.headers.get('set-cookie')).toContain('Max-Age=31536000');
    return response.headers.get('set-cookie')!.split(';')[0];
  };
  const status = (cookie: string) => fetch(address() + '/auth/session', { headers: { Cookie: cookie } }).then(value => value.status);
  const restart = async () => { await app.close(); app = await open(); await app.remoteAccess!.initialize(); };
  try {
    const snapshot = app.settings.snapshot(); snapshot.settings.remoteAccess = { enabled: true, port: 0, credentialRef: 'web_access' };
    await app.settings.save({ settings: snapshot.settings, expectedRevision: snapshot.revision, credentials: { web_access: token } });
    await app.remoteAccess!.initialize();
    const phone = await login('手机'); const tablet = await login('平板');
    const saved = JSON.stringify(await app.storage.getRecord('web-sessions', 'owner'));
    expect(saved).not.toContain(phone.slice(phone.indexOf('=') + 1)); expect(saved).not.toContain(token);
    await restart();
    expect(await status(phone)).toBe(200); expect(await status(tablet)).toBe(200);
    expect(app.remoteAccess!.status().connections.every(connection => connection.expiresAt === undefined)).toBe(true);
    const router = new ApplicationRouter(app);
    expect(await router.call({ actorId: 'owner', clientId: 'reopened-settings' }, 'ui.request', { type: 'platform.remote.token' })).toEqual({ token });
    await app.remoteAccess!.revoke(app.remoteAccess!.status().connections.find(connection => connection.name === '手机')!.id);
    const logout = await fetch(address() + '/auth/logout', { method: 'POST', headers: { Origin: address(), Cookie: tablet } });
    expect(logout.status).toBe(200);
    await restart(); expect(await status(phone)).toBe(401); expect(await status(tablet)).toBe(401);
    const last = await login('最后一个设备');
    await app.remoteAccess!.close();
    for (const value of [randomBytes(32).toString('hex'), token]) {
      const update = app.settings.snapshot();
      await app.settings.save({ settings: update.settings, expectedRevision: update.revision, credentials: { web_access: value } });
    }
    await restart(); expect(await status(last)).toBe(401);
  } finally {
    await app.close(); await f.cleanup();
    if (previousKey === undefined) delete process.env[keyName]; else process.env[keyName] = previousKey;
  }
});
