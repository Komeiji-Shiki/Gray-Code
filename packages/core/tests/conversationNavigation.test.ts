import { pathToFileURL } from 'node:url';
import { PlatformApplication } from '../../../apps/server/src/application';
import { ConversationNavigation } from '../../../apps/server/src/conversations/navigation';
import { fixture } from './fixtures';

test('侧边导航从存储分页搜索，置顶与重命名可保留，项目归属和子任务过滤正确', async () => {
  const f = await fixture(); await f.store.close(); const app = await PlatformApplication.open({ dataDirectory: f.data });
  try {
    const settings = app.settings.snapshot(); settings.settings.workspaces.push({ id: 'workspace', name: '示例项目', directory: f.source, deviceId: 'local' });
    await app.settings.save({ settings: settings.settings, expectedRevision: settings.revision });
    for (let index = 0; index < 65; index++) await app.storage.createConversation({ id: `id-${64 - index}`, actorId: 'owner', title: index === 0 ? '很早以前的猫猫对话' : `示例 ${index}`,
      createdAt: index, updatedAt: index, ...(index % 2 ? { workspaceUri: pathToFileURL(f.source).toString() } : {}) });
    jest.spyOn(app.subagents, 'childConversationIds').mockReturnValue(new Set(['id-1']));
    const navigation = new ConversationNavigation(app);
    const first = await navigation.list('owner'); expect(first.items).toHaveLength(30); expect(first.items[0].id).toBe('id-0'); expect(first.items.some(item => item.id === 'id-1')).toBe(false);
    expect(first.items.find(item => item.id === 'id-3')?.workspaceId).toBe('workspace');
    const second = await navigation.list('owner', { cursor: first.nextCursor });
    expect(second.items).toHaveLength(30); expect(second.items.every(item => !first.items.some(previous => previous.id === item.id))).toBe(true);
    expect((await navigation.list('owner', { query: '猫猫' })).items.map(item => item.id)).toEqual(['id-64']);
    await navigation.pin('owner', 'id-64', true); const pinned = await navigation.list('owner');
    expect(pinned.pinned.map(item => item.id)).toEqual(['id-64']); expect(pinned.pinned[0].pinnedAt).toBeGreaterThan(0);
    await navigation.rename('owner', 'id-64', '新的猫猫标题');
    expect((await navigation.list('owner', { query: '新' })).pinned[0].title).toBe('新的猫猫标题');
    await navigation.pin('owner', 'id-64', false); expect((await navigation.list('owner')).pinned).toEqual([]);
    await expect(navigation.list('unknown')).rejects.toThrow('Owner access');
  } finally { await app.close(); await f.cleanup(); }
});
