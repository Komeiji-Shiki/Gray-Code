import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { PlatformApplication } from '../../../apps/server/src/application';
import { ApplicationRouter } from '../../../apps/server/src/transport/router';
import { fixture } from './fixtures';

test('项目移除可保留或显式清理对话，磁盘文件和机器人会话保留，重新添加恢复项目', async () => {
  const f = await fixture(); await f.store.close(); let app = await PlatformApplication.open({ dataDirectory: f.data });
  let router = new ApplicationRouter(app); const client = { actorId: 'owner', clientId: 'projects' };
  const ui = (type: string, data = {}) => router.call(client, 'ui.request', { type, data }) as Promise<any>;
  try {
    await writeFile(path.join(f.source, 'keep.txt'), '磁盘文件必须保留');
    const workspace = await router.call(client, 'workspaces.add', { directory: f.source, name: '示例项目' }) as { id: string };
    const target = { workspaceId: workspace.id };
    const add = (id: string, bot = false) => app.storage.initializeConversation({ id, actorId: 'owner', title: id, createdAt: 1, updatedAt: 1,
      workspaceId: workspace.id, workspaceUri: pathToFileURL(f.source).href, ...(bot ? { custom: { botOrigin: { platform: 'discord' } } } : {}) }, [{ role: 'user', parts: [{ text: id }] }]);
    await add('first'); await add('second'); await add('bot_kept', true); await ui('conversation.pin', { conversationId: 'first', pinned: true });
    await ui('projects.rename', { ...target, name: '项目的新名称' });
    expect((await ui('conversation.navigation')).workspaces[0].name).toBe('项目的新名称');
    await ui('projects.remove', target);
    expect((await ui('conversation.navigation')).workspaces).toEqual([]);
    expect((await app.storage.readHistory('first')).total).toBe(1);
    expect((await app.storage.getConversation('second'))?.workspaceId).toBe(workspace.id);
    await app.close(); app = await PlatformApplication.open({ dataDirectory: f.data }); router = new ApplicationRouter(app);
    expect((await ui('conversation.navigation')).workspaces).toEqual([]);
    await router.call(client, 'workspaces.add', { directory: f.source });
    expect((await ui('conversation.navigation')).workspaces[0].name).toBe('项目的新名称');
    const old = await ui('projects.previewRemoval', target); expect(old.count).toBe(2);
    await add('third');
    await expect(ui('projects.remove', { ...target, deleteConversations: true, token: old.token })).rejects.toThrow('列表已经变化');
    expect(await app.storage.getConversation('first')).not.toBeNull();
    const preview = await ui('projects.previewRemoval', target); expect(preview.count).toBe(3);
    expect((await ui('projects.remove', { ...target, deleteConversations: true, token: preview.token })).deletedIds.sort()).toEqual(['first', 'second', 'third']);
    expect(await app.storage.getConversation('first')).toBeNull(); expect((await app.storage.readHistory('bot_kept')).total).toBe(1);
    expect(await readFile(path.join(f.source, 'keep.txt'), 'utf8')).toBe('磁盘文件必须保留');
    expect((await ui('conversation.navigation', { scope: 'bots' })).items.map((item: any) => item.id)).toEqual(['bot_kept']);
  } finally { await app.close(); await f.cleanup(); }
});

test('旧对话生成的项目也能重命名和移除，同名目录彼此独立', async () => {
  const f = await fixture(); await f.store.close(); const app = await PlatformApplication.open({ dataDirectory: f.data });
  const router = new ApplicationRouter(app), client = { actorId: 'owner', clientId: 'legacy-projects' };
  const ui = (type: string, data = {}) => router.call(client, 'ui.request', { type, data }) as Promise<any>;
  try {
    const directory = path.join(f.root, 'missing', 'project'), other = path.join(f.root, 'other', 'project'); await mkdir(other, { recursive: true });
    for (const [id, root] of [['old', directory], ['other', other]]) await app.storage.initializeConversation({ id, actorId: 'owner', title: id, createdAt: 1, updatedAt: 1, workspaceUri: pathToFileURL(root).href }, []);
    const target = { workspaceUri: pathToFileURL(directory).href };
    await ui('projects.rename', { ...target, name: '旧项目' });
    expect((await ui('conversation.navigation')).items.find((item: any) => item.id === 'old').projectName).toBe('旧项目');
    await ui('projects.remove', target);
    expect((await ui('conversation.navigation')).items.map((item: any) => item.id)).toEqual(['other']);
    expect(await app.storage.getConversation('old')).not.toBeNull();
    await expect(router.call({ ...client, actorId: 'unknown' }, 'ui.request', { type: 'projects.remove', data: target })).rejects.toThrow();
  } finally { await app.close(); await f.cleanup(); }
});
