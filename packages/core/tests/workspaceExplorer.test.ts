import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { PlatformApplication } from '../../../apps/server/src/application';
import { openWorkspaceInExplorer, revealWorkspaceFile } from '../../../apps/desktop/src/workspaceExplorer';
import { fixture } from './fixtures';

test('资源管理器入口定位文件、打开目录和对话的实际工作区', async () => {
  const f = await fixture(); await f.store.close(); const app = await PlatformApplication.open({ dataDirectory: f.data });
  const shell = { openPath: jest.fn(async () => ''), showItemInFolder: jest.fn() };
  try {
    const nested = path.join(f.source, 'folder'), other = path.join(f.root, 'extra');
    await mkdir(nested); await mkdir(other); await writeFile(path.join(f.source, 'file.ts'), 'export {};');
    await writeFile(path.join(other, 'extra.ts'), 'export {};');
    const settings = app.settings.snapshot(); settings.settings.workspaces.push({ id: 'project', name: '项目', directory: f.source, deviceId: 'local',
      roots: [{ name: 'main', directory: f.source }, { name: 'extra', directory: other }] });
    await app.settings.save({ settings: settings.settings, expectedRevision: settings.revision });
    await revealWorkspaceFile(app, shell, 'owner', { workspaceId: 'project', path: '@main/file.ts' });
    expect(shell.showItemInFolder).toHaveBeenLastCalledWith(path.join(f.source, 'file.ts')); expect(shell.openPath).not.toHaveBeenCalled();
    await revealWorkspaceFile(app, shell, 'owner', { workspaceId: 'project', path: '@main/folder' });
    expect(shell.openPath).toHaveBeenLastCalledWith(nested);
    await revealWorkspaceFile(app, shell, 'owner', { workspaceId: 'project', path: '@extra/extra.ts' });
    expect(shell.showItemInFolder).toHaveBeenLastCalledWith(path.join(other, 'extra.ts'));
    await app.createConversation('owner', '对话', 'project', {}, [], { id: 'conversation' });
    await openWorkspaceInExplorer(app, shell, 'owner', { conversationId: 'conversation' });
    expect(shell.openPath).toHaveBeenLastCalledWith(f.source);
    await openWorkspaceInExplorer(app, shell, 'owner', { workspaceUri: pathToFileURL(other).toString() });
    expect(shell.openPath).toHaveBeenLastCalledWith(other);
    await expect(revealWorkspaceFile(app, shell, 'owner', { workspaceId: 'project', path: path.join(f.root, 'outside') })).rejects.toThrow('当前工作区');
    await expect(openWorkspaceInExplorer(app, shell, 'unknown', { workspaceId: 'project' })).rejects.toThrow('Owner access');
  } finally { await app.close(); await f.cleanup(); }
});
