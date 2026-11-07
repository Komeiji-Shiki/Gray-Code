import path from 'node:path';
import { mkdir, rm } from 'node:fs/promises';
import { PlatformApplication } from '../../../apps/server/src/application';
import { fixture } from './fixtures';

let f: Awaited<ReturnType<typeof fixture>>, app: PlatformApplication;
beforeEach(async () => {
  f = await fixture(); await f.store.close();
  app = await PlatformApplication.open({ dataDirectory: f.data });
});
afterEach(async () => { await app.close(); await f.cleanup(); });

test('已保存项目的目录被删除后，其他设置照常保存；改动该项目时仍校验目录', async () => {
  const directory = path.join(f.root, 'removed-project');
  await mkdir(directory);
  let snapshot = app.settings.snapshot();
  snapshot.settings.workspaces.push({ id: 'removed', name: 'removed', directory, deviceId: 'local' });
  await app.settings.save({ settings: snapshot.settings, expectedRevision: snapshot.revision });
  await rm(directory, { recursive: true });

  snapshot = app.settings.snapshot();
  snapshot.settings.appearance.theme = 'light';
  await app.settings.save({ settings: snapshot.settings, expectedRevision: snapshot.revision });
  expect(app.settings.read('appearance').appearance.theme).toBe('light');

  snapshot = app.settings.snapshot();
  snapshot.settings.workspaces.find(workspace => workspace.id === 'removed')!.name = 'renamed';
  await expect(app.settings.save({ settings: snapshot.settings, expectedRevision: snapshot.revision })).rejects.toMatchObject({ code: 'ENOENT' });
});
