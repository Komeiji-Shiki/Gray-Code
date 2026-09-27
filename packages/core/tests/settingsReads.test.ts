import { PlatformApplication } from '../../../apps/server/src/application';
import { ApplicationRouter } from '../../../apps/server/src/transport/router';
import { fixture } from './fixtures';

let f: Awaited<ReturnType<typeof fixture>>, app: PlatformApplication;
beforeEach(async () => {
  f = await fixture(); await f.store.close();
  app = await PlatformApplication.open({ dataDirectory: f.data });
  const snapshot = app.settings.snapshot();
  snapshot.settings.workspaces.push({ id: 'project', name: 'fixture', directory: f.source, deviceId: 'local' });
  snapshot.settings.accounts.push({ id: 'reader', displayName: '只读成员', role: 'member', workspaceIds: ['project'], effects: ['workspace_read'] });
  await app.settings.save({ settings: snapshot.settings, expectedRevision: snapshot.revision });
});
afterEach(async () => { await app.close(); await f.cleanup(); });

test('局部读取与记录查找返回独立副本，修改返回值不能扩大账号权限或改动工作区', () => {
  const selected = app.settings.read('accounts', 'appearance');
  selected.accounts.find(account => account.id === 'reader')!.effects.push('workspace_write');
  selected.appearance.theme = 'light';
  const actor = app.actor('reader')!;
  actor.effects.push('workspace_write');
  (actor.workspaceIds as string[]).push('other');
  app.workspace('reader', 'project', ['workspace_read']).name = '调用方修改';
  expect(app.actor('reader')).toMatchObject({ effects: ['workspace_read'], workspaceIds: ['project'] });
  expect(() => app.workspace('reader', 'project', ['workspace_write'])).toThrow();
  expect(app.settings.find('workspaces', 'project')?.name).toBe('fixture');
  expect(app.settings.read('appearance').appearance.theme).toBe('dark');
  expect(app.settings.find('providers', undefined)).toBeUndefined();
  expect(app.settings.read('botGuestAccountId')).toEqual({});
});

test('权限查询和事件分发不遍历无关的模型目录，缺失账号也只读取身份字段', async () => {
  const current = (app.settings as any).current.settings;
  const descriptor = Object.getOwnPropertyDescriptor(current, 'providers')!;
  Object.defineProperty(current, 'providers', { configurable: true, enumerable: true, get: () => { throw new Error('不应读取无关模型目录'); } });
  try {
    expect(app.actor('owner')?.role).toBe('owner');
    expect(app.actor('missing')).toBeNull();
    expect(app.workspace('reader', 'project', ['workspace_read']).id).toBe('project');
    expect(await new ApplicationRouter(app).mayReceive({ actorId: 'owner', clientId: 'events' }, { type: 'fixture' })).toBe(true);
  } finally { Object.defineProperty(current, 'providers', descriptor); }
});

test('每次读取当前已提交的权限；撤权立即生效，过期草稿不能覆盖新状态', async () => {
  const stale = app.settings.snapshot();
  const latest = app.settings.snapshot();
  latest.settings.accounts.find(account => account.id === 'reader')!.revoked = true;
  await app.settings.save({ settings: latest.settings, expectedRevision: latest.revision });
  expect(app.actor('reader')).toBeNull();
  expect(() => app.workspace('reader', 'project', ['workspace_read'])).toThrow('unavailable');
  stale.settings.accounts.find(account => account.id === 'reader')!.displayName = '过期草稿';
  await expect(app.settings.save({ settings: stale.settings, expectedRevision: stale.revision })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  expect(app.settings.find('accounts', 'reader')).toMatchObject({ displayName: '只读成员', revoked: true });
  expect(app.actor('reader')).toBeNull();
});
