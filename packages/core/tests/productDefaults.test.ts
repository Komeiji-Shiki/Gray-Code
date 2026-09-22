import path from 'node:path';
import { access, mkdir, writeFile, readFile } from 'node:fs/promises';
import { PlatformApplication } from '../../../apps/server/src/application';
import { ApplicationRouter } from '../../../apps/server/src/transport/router';
import { ConversationNavigation } from '../../../apps/server/src/conversations/navigation';
import { fixture } from './fixtures';

test('对话和代码分别应用预设，未选项目的新对话有独立文档目录，手动项目保持原目录', async () => {
  const f = await fixture(); await f.store.close(); const documents = path.join(f.root, 'Documents');
  const app = await PlatformApplication.open({ dataDirectory: f.data, documentsDirectory: documents });
  const router = new ApplicationRouter(app); const client = { actorId: 'owner', clientId: 'defaults-test' };
  const ui = (type: string, data: Record<string, any> = {}) => router.call(client, 'ui.request', { type, data }) as Promise<any>;
  try {
    await ui('ui.settings.begin');
    const presets = await ui('getPromptModes'); const base = presets.modes[0];
    for (const id of ['chat-preset', 'code-preset']) await ui('savePromptMode', { mode: { ...base, id, name: id } });
    await ui('platform.modes.update', { mode: 'chat', promptModeId: 'chat-preset' });
    await ui('platform.modes.update', { mode: 'code', promptModeId: 'code-preset' });
    await ui('ui.settings.save'); await ui('ui.settings.end');
    await ui('ui.context.set', { mode: 'chat' });
    expect((await ui('getPromptModes')).currentModeId).toBe('chat-preset');
    const first = await ui('conversation.createConversation', { conversationId: 'first', title: '普通对话' });
    const firstMetadata = await app.conversation('owner', 'first');
    expect(firstMetadata.custom).toMatchObject({ platformMode: 'chat', promptModeConfig: { modeId: 'chat-preset' } });
    const workspace = app.workspace('owner', first.workspaceId, []);
    expect(workspace.managedConversationId).toBe('first'); expect(path.relative(documents, workspace.directory)).toMatch(/^graycode[\\/]\d{4}-\d{2}-\d{2}[\\/]/);
    await access(workspace.directory); await writeFile(path.join(workspace.directory, '保留.txt'), '保留原目录内容');
    const second = await ui('conversation.createConversation', { conversationId: 'second', title: '另一个普通对话' });
    expect(second.workspaceId).not.toBe(first.workspaceId); expect(await readFile(path.join(workspace.directory, '保留.txt'), 'utf8')).toBe('保留原目录内容');
    const navigation = await new ConversationNavigation(app).list('owner');
    expect(navigation.workspaces).toHaveLength(0); expect(navigation.items.every(item => item.automaticWorkspace)).toBe(true);
    const project = path.join(f.root, 'explicit'); await mkdir(project);
    const manual = await router.call(client, 'workspaces.add', { directory: project, name: '手动项目' }) as { id: string };
    await ui('ui.context.set', { mode: 'code', workspaceId: manual.id });
    expect((await ui('getPromptModes')).currentModeId).toBe('code-preset');
    const third = await ui('conversation.createConversation', { conversationId: 'third', title: '代码对话' });
    expect(third.workspaceId).toBe(manual.id);
    expect((await app.conversation('owner', 'third')).custom).toMatchObject({ platformMode: 'code', promptModeConfig: { modeId: 'code-preset' } });
    const custom = await ui('conversation.createConversation', { conversationId: 'custom', title: '手动选择', promptModeId: 'chat-preset' });
    expect((await app.conversation('owner', 'custom')).custom).toMatchObject({ promptModeConfig: { modeId: 'chat-preset' } });
    expect(custom.workspaceId).toBe(manual.id);
    const promoted = await router.call(client, 'workspaces.add', { directory: workspace.directory, name: '保存为项目' }) as any;
    expect(promoted.id).toBe(workspace.id); expect(promoted.managedConversationId).toBeUndefined();
  } finally { await app.close(); await f.cleanup(); }
});

test('从代码项目切到对话模式后，两种新建入口都创建专用工作区', async () => {
  const f = await fixture(); await f.store.close(); const documents = path.join(f.root, 'Documents');
  const app = await PlatformApplication.open({ dataDirectory: f.data, documentsDirectory: documents });
  const router = new ApplicationRouter(app); const client = { actorId: 'owner', clientId: 'mode-workspace-test' };
  const ui = (type: string, data: Record<string, any> = {}) => router.call(client, 'ui.request', { type, data }) as Promise<any>;
  try {
    const project = path.join(f.root, 'code-project'); await mkdir(project);
    const manual = await router.call(client, 'workspaces.add', { directory: project, name: '代码项目' }) as { id: string };
    await ui('ui.context.set', { mode: 'code', workspaceId: manual.id });
    const code = await ui('conversation.createConversation', { conversationId: 'code-first', title: '代码会话' });
    expect(code.workspaceId).toBe(manual.id);
    await ui('ui.mode.select', { mode: 'chat', conversationId: 'code-first' });
    const chat = await ui('conversation.createConversation', { conversationId: 'chat-next', title: '独立对话' });
    const workspace = app.workspace('owner', chat.workspaceId, []);
    expect(workspace.id).not.toBe(manual.id);
    expect(workspace.managedConversationId).toBe('chat-next');
    expect(path.relative(documents, workspace.directory)).toMatch(/^graycode[\\/]/);
    await access(workspace.directory);
    const created = await ui('ui.mode.new', { mode: 'chat', workspaceId: manual.id });
    const other = await app.conversation('owner', created.conversationId);
    expect(other.workspaceId).not.toBe(manual.id); expect(other.workspaceId).not.toBe(chat.workspaceId);
    expect(app.workspace('owner', String(other.workspaceId), []).managedConversationId).toBe(other.id);
    expect((await app.conversation('owner', 'code-first')).workspaceId).toBe(manual.id);
    const inProject = await ui('ui.mode.new', { mode: 'code', workspaceId: manual.id });
    expect((await app.conversation('owner', inProject.conversationId)).workspaceId).toBe(manual.id);
  } finally { await app.close(); await f.cleanup(); }
});
