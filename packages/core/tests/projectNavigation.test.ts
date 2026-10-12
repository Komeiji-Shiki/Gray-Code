import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import type { ConversationNavigationResult } from '@graycode/contracts';
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

test('跨过超过 30 条其他会话仍返回旧项目最近对话', async () => {
  const f = await fixture(); await f.store.close();
  const app = await PlatformApplication.open({ dataDirectory: f.data });
  const router = new ApplicationRouter(app), client = { actorId: 'owner', clientId: 'project-selection' };
  const ui = (type: string, data = {}) => router.call(client, 'ui.request', { type, data });
  try {
    const draft = app.settings.snapshot();
    // 同目录的两个显式工作区仍属于各自项目，不能用目录匹配扩大筛选范围。
    draft.settings.workspaces.push(
      { id: 'old-project', name: '旧项目', directory: f.source, deviceId: 'local' },
      { id: 'other-project', name: '其他项目', directory: f.source, deviceId: 'local' },
    );
    await app.settings.save({ settings: draft.settings, expectedRevision: draft.revision });
    const workspaceUri = pathToFileURL(f.source).href;
    for (let index = 0; index < 32; index++) await app.storage.initializeConversation({
      id: `old-${index}`, actorId: 'owner', title: `旧项目对话 ${index}`, createdAt: index, updatedAt: index,
      workspaceId: 'old-project', workspaceUri, custom: { platformMode: 'code' },
    }, []);
    for (let index = 0; index < 35; index++) await app.storage.initializeConversation({
      id: `other-${index}`, actorId: 'owner', title: `更新的其他对话 ${index}`, createdAt: 100 + index, updatedAt: 100 + index,
      workspaceId: 'other-project', workspaceUri, custom: { platformMode: 'code' },
    }, []);
    const globalPage = await ui('conversation.navigation', { scope: 'personal' }) as ConversationNavigationResult;
    expect(globalPage.items).toHaveLength(30);
    expect(globalPage.items.every(item => item.workspaceId === 'other-project')).toBe(true);
    await ui('conversation.pin', { conversationId: 'old-0', pinned: true });
    await ui('conversation.pin', { conversationId: 'other-0', pinned: true });
    const query = { scope: 'personal', workspaceId: 'old-project' };
    const first = await ui('conversation.navigation', query) as ConversationNavigationResult;
    expect(first.items).toHaveLength(30);
    expect(first.items[0].id).toBe('old-31');
    expect(first.pinned.map(item => item.id)).toEqual(['old-0']);
    const second = await ui('conversation.navigation', { ...query, cursor: first.nextCursor }) as ConversationNavigationResult;
    expect(second.items.map(item => item.id)).toEqual(['old-1']);
    expect(second.nextCursor).toBeUndefined();
    expect([...first.items, ...second.items].every(item => item.workspaceId === 'old-project')).toBe(true);
    expect(new Set([...first.items, ...second.items, ...first.pinned].map(item => item.id)).size).toBe(32);

    await expect(ui('conversation.navigation', { scope: 'personal', workspaceId: 'missing-project' }))
      .rejects.toThrow('Workspace or account is unavailable.');
  } finally { await app.close(); await f.cleanup(); }
});
