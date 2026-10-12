import path from 'node:path';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { PlatformApplication } from '../../../apps/server/src/application';
import { ApplicationRouter } from '../../../apps/server/src/transport/router';
import { fixture } from './fixtures';

describe('自动对话工作区释放', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let app: PlatformApplication;
  const client = { actorId: 'owner', clientId: 'workspace-cleanup-test' };

  beforeEach(async () => {
    f = await fixture();
    await f.store.close();
    app = await PlatformApplication.open({ dataDirectory: f.data, documentsDirectory: path.join(f.root, 'Documents') });
  });
  afterEach(async () => { await app.close(); await f.cleanup(); });

  const createAutomatic = async (id: string) => {
    const conversation = await app.createConversation('owner', id, undefined, undefined, undefined, { id, automaticWorkspace: true });
    return app.workspace('owner', conversation.workspaceId!, []);
  };
  const createBot = async (id: string) => {
    const workspaceId = await app.botWorkspaces.get({ platform: 'discord', botId: 'bot', channelId: 'channel', direct: false }, id);
    await app.createConversation('owner', id, workspaceId, undefined, undefined, { id });
    return app.workspace('owner', workspaceId, []);
  };
  const deleteConversation = (id: string) => new ApplicationRouter(app).call(client, 'ui.request', {
    type: 'conversation.deleteConversation', data: { conversationId: id },
  });

  test.each(['普通', 'Bot'])('删除%s对话后移除工作区条目与空目录', async kind => {
    const id = kind === '普通' ? 'automatic-empty' : 'bot_empty';
    const workspace = await (kind === '普通' ? createAutomatic(id) : createBot(id));
    await access(workspace.directory);

    await expect(deleteConversation(id)).resolves.toEqual({ success: true });

    expect(await app.storage.getConversation(id)).toBeNull();
    expect(app.settings.find('workspaces', workspace.id)).toBeUndefined();
    await expect(access(workspace.directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('删除对话只释放登记，保留非空工作区及其用户文件', async () => {
    const workspace = await createAutomatic('automatic-files');
    const nested = path.join(workspace.directory, '用户内容');
    await mkdir(nested);
    await writeFile(path.join(nested, '保留.txt'), '保留全部用户文件');

    await deleteConversation('automatic-files');

    expect(app.settings.find('workspaces', workspace.id)).toBeUndefined();
    expect(await readFile(path.join(nested, '保留.txt'), 'utf8')).toBe('保留全部用户文件');
  });

  test('已保存为普通项目的自动目录随对话删除仍然保留', async () => {
    const workspace = await createAutomatic('promoted-project');
    await new ApplicationRouter(app).call(client, 'workspaces.add', { directory: workspace.directory, name: '保留项目' });

    await deleteConversation('promoted-project');

    expect(app.settings.find('workspaces', workspace.id)).toMatchObject({ id: workspace.id, name: '保留项目' });
    expect(app.settings.find('workspaces', workspace.id)?.managedConversationId).toBeUndefined();
    await access(workspace.directory);
  });

  test('启动清理普通和 Bot 孤儿工作区，保留有效对话、普通项目及非空目录', async () => {
    const live = await createAutomatic('live-conversation');
    const empty = await createAutomatic('orphan-empty');
    const files = await createAutomatic('orphan-files');
    const bot = await createBot('bot_orphan');
    const manual = await new ApplicationRouter(app).call(client, 'workspaces.add', { directory: f.source, name: '普通项目' }) as { id: string };
    await writeFile(path.join(files.directory, '保留.txt'), '重启后仍然保留');
    // 模拟旧版本删除对话后留下的登记，启动应复用正常删除的释放规则。
    for (const id of ['orphan-empty', 'orphan-files', 'bot_orphan']) await app.storage.deleteConversation(id);
    await app.close();

    app = await PlatformApplication.open({ dataDirectory: f.data, documentsDirectory: path.join(f.root, 'Documents') });

    expect(app.settings.read('workspaces').workspaces.map(workspace => workspace.id).sort()).toEqual([live.id, manual.id].sort());
    await expect(access(empty.directory)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(bot.directory)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(path.join(files.directory, '保留.txt'), 'utf8')).toBe('重启后仍然保留');
    await access(live.directory);
    await access(f.source);
  });
});
