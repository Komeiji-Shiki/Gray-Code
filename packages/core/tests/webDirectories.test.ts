import path from 'node:path';
import { mkdir, writeFile, symlink, realpath } from 'node:fs/promises';
import { PlatformApplication } from '../../../apps/server/src/application';
import { ApplicationRouter } from '../../../apps/server/src/transport/router';
import { WebHost, directoryBreadcrumbs } from '../../../apps/server/src/transport/webHost';
import { fixture } from './fixtures';

test('电脑目录按自然顺序列出，包含目录链接，并能注册成实际工作区', async () => {
  const f = await fixture(); await f.store.close();
  const app = await PlatformApplication.open({ dataDirectory: f.data, documentsDirectory: path.join(f.root, 'documents') });
  try {
    const root = path.join(f.root, 'folders'); await mkdir(root);
    for (const name of ['project10', 'project2']) await mkdir(path.join(root, name));
    await writeFile(path.join(root, 'project2', 'hello.txt'), '电脑上的文件');
    await writeFile(path.join(root, 'not-a-folder.txt'), '不列为目录');
    await symlink(path.join(root, 'project2'), path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    const router = new ApplicationRouter(app), host = new WebHost(app, router), client = { actorId: 'owner', clientId: 'directory-test' };
    const listing = await host.call(client, 'host.directories', { path: root }) as { directories: { name: string; path: string }[]; breadcrumbs: { path: string }[] };
    expect(listing.directories.map(item => item.name)).toEqual(['linked', 'project2', 'project10']);
    expect(listing.breadcrumbs.at(-1)?.path).toBe(await realpath(root));
    const selected = await host.call(client, 'host.directories', { path: path.join(root, 'linked') }) as { name: string; directory: string };
    const workspace = await router.call(client, 'workspaces.add', { name: selected.name, directory: selected.directory }) as { id: string; directory: string };
    expect(workspace.directory).toBe(await realpath(path.join(root, 'project2')));
    expect(app.settings.snapshot().settings.workspaces.some(item => item.id === workspace.id)).toBe(true);
    await expect(host.call({ actorId: 'unknown', clientId: 'other' }, 'host.directories', { path: root })).rejects.toThrow('Owner');
  } finally { await app.close(); await f.cleanup(); }
});

test('目录导航保留 Windows 网络共享根与 POSIX 根路径', () => {
  expect(directoryBreadcrumbs('\\\\server\\share\\project\\src', path.win32).map(item => item.path))
    .toEqual(['\\\\server\\share\\', '\\\\server\\share\\project', '\\\\server\\share\\project\\src']);
  expect(directoryBreadcrumbs('/srv/project', path.posix).map(item => item.path)).toEqual(['/', '/srv', '/srv/project']);
});
