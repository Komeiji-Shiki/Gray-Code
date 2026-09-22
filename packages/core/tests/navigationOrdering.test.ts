import { PlatformApplication } from '../../../apps/server/src/application';
import { ConversationNavigation } from '../../../apps/server/src/conversations/navigation';
import { NavigationOrderingStore } from '../../../apps/server/src/conversations/navigationOrdering';
import { fixture } from './fixtures';

test('手动排列的旧对话跨分页和重启保留顺序，所有对话仍可完整找到', async () => {
  const f = await fixture(); await f.store.close();
  let app = await PlatformApplication.open({ dataDirectory: f.data });
  try {
    for (let index = 0; index < 75; index++) await app.storage.createConversation({ id: `id-${index}`, actorId: 'owner', title: `会话 ${index}`, createdAt: 100 - index, updatedAt: 100 - index });
    const ids = Array.from({ length: 40 }, (_, index) => `id-${74 - index}`);
    const order = new NavigationOrderingStore(app);
    await order.reorder('owner', { kind: 'conversations', ids, revision: 0 });
    await new ConversationNavigation(app).rename('owner', ids[39], '已修改标题');
    await app.close(); app = await PlatformApplication.open({ dataDirectory: f.data });
    const navigation = new ConversationNavigation(app);
    const first = await navigation.list('owner');
    expect(first.items.map(item => item.id)).toEqual(ids.slice(0, 30));
    const seen = first.items.map(item => item.id); let cursor = first.nextCursor;
    while (cursor) { const page = await navigation.list('owner', { cursor }); seen.push(...page.items.map(item => item.id)); cursor = page.nextCursor; }
    expect(seen.slice(0, 40)).toEqual(ids); expect(seen).toHaveLength(75); expect(new Set(seen).size).toBe(75);
    expect((await navigation.list('owner', { query: '会话 74' })).items.map(item => item.id)).toEqual(['id-74']);
    const saved = await new NavigationOrderingStore(app).get('owner');
    await new NavigationOrderingStore(app).reorder('owner', { kind: 'groups', ids: ['general'], revision: saved.revision });
    await expect(navigation.list('owner', { cursor: first.nextCursor })).rejects.toThrow('顺序已变化');
  } finally { await app.close(); await f.cleanup(); }
});

test('项目、置顶和草稿保存显示顺序，拖动不会改变项目归属', async () => {
  const f = await fixture(); await f.store.close(); const app = await PlatformApplication.open({ dataDirectory: f.data });
  try {
    const settings = app.settings.snapshot();
    settings.settings.workspaces.push({ id: 'project-a', name: '项目 A', directory: f.source, deviceId: 'local' }, { id: 'project-b', name: '项目 B', directory: f.root, deviceId: 'local' });
    await app.settings.save({ settings: settings.settings, expectedRevision: settings.revision });
    await app.createConversation('owner', 'A', 'project-a', {}, [], { id: 'a' });
    await app.createConversation('owner', 'B', 'project-b', {}, [], { id: 'b' });
    const navigation = new ConversationNavigation(app), order = new NavigationOrderingStore(app);
    await expect(order.reorder('owner', { kind: 'conversations', ids: ['a', 'b'], revision: 0 })).rejects.toThrow('同一分组');
    let saved = await order.reorder('owner', { kind: 'groups', ids: ['general', 'project-b', 'project-a'], revision: 0 });
    expect(saved.groups).toEqual(['general', 'project-b', 'project-a']);
    saved = await order.reorder('owner', { kind: 'drafts', ids: ['draft-b', 'draft-a'], revision: saved.revision });
    expect(saved.drafts).toEqual(['draft-b', 'draft-a']);
    await navigation.pin('owner', 'a', true); await navigation.pin('owner', 'b', true);
    await order.reorder('owner', { kind: 'pinned', ids: ['b', 'a'], revision: saved.revision });
    expect((await navigation.list('owner')).pinned.map(item => item.id)).toEqual(['b', 'a']);
    expect((await app.conversation('owner', 'a')).workspaceId).toBe('project-a');
    expect((await app.conversation('owner', 'b')).workspaceId).toBe('project-b');
    await expect(order.reorder('unknown', { kind: 'groups', ids: ['general'], revision: 0 })).rejects.toThrow('Owner access');
  } finally { await app.close(); await f.cleanup(); }
});
