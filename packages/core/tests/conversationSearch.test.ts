import path from 'node:path';
import Database from 'better-sqlite3';
import { PlatformApplication } from '../../../apps/server/src/application';
import { ConversationNavigation } from '../../../apps/server/src/conversations/navigation';
import { fixture, message } from './fixtures';

test('侧边栏正文搜索覆盖置顶、手动列表和 Bot 对话，并随历史修改更新', async () => {
  const f = await fixture(); await f.store.close(); const app = await PlatformApplication.open({ dataDirectory: f.data });
  try {
    const navigation = new ConversationNavigation(app);
    for (const id of ['normal', 'pinned', 'bot']) await app.storage.initializeConversation({
      id, actorId: 'owner', title: `普通标题 ${id}`, createdAt: 1, updatedAt: 1,
      ...(id === 'bot' ? { custom: { botOrigin: { platform: 'discord' } } } : {}),
    }, [message(0, `${id} 海边的约定`), { id: `reply-${id}`, role: 'model', parts: [{ text: `${id} 回答里的蓝色地图` }] }]);
    await navigation.pin('owner', 'pinned', true);
    expect((await navigation.list('owner', { query: 'pinned 海边' })).pinned.map(item => item.id)).toEqual(['pinned']);
    const normalHit = (await navigation.list('owner', { query: 'normal 海边' })).items[0];
    expect(normalHit.id).toBe('normal');
    expect(normalHit.searchHit).toEqual({ messageIndex: 0, messageId: 'message_0', excerpt: 'normal 海边的约定' });
    expect((await navigation.list('owner', { query: '蓝色地图' })).items[0].searchHit)
      .toEqual({ messageIndex: 1, messageId: 'reply-normal', excerpt: 'normal 回答里的蓝色地图' });
    await app.storage.appendHistory('normal', [{ id: 'thought', role: 'model', parts: [{ text: '只在思考块里的紫色月亮', thought: true }] }]);
    expect((await navigation.list('owner', { query: '紫色月亮' })).items).toEqual([]);
    expect((await navigation.list('owner', { scope: 'bots', query: 'bot 海边' })).items.map(item => item.id)).toEqual(['bot']);
    expect((await navigation.list('owner', { query: '普通标题' })).items.map(item => item.id)).toEqual(['normal']);

    await app.storage.forkConversation('normal', { id: 'fork', actorId: 'owner', title: '分叉', createdAt: 2, updatedAt: 2 });
    expect((await navigation.list('owner', { query: 'normal 海边' })).items.map(item => item.id).sort()).toEqual(['fork', 'normal']);
    await app.storage.replaceHistory('normal', [message(1, '重新写下山上的约定')]);
    expect((await navigation.list('owner', { query: 'normal 海边' })).items.map(item => item.id)).toEqual(['fork']);
    expect((await navigation.list('owner', { query: '山上的约定' })).items.map(item => item.id)).toEqual(['normal']);
    await app.storage.deleteConversation('fork');
    expect((await navigation.list('owner', { query: 'normal 海边' })).items).toEqual([]);
  } finally { await app.close(); await f.cleanup(); }
});

test('旧版长对话正文分批建索引，最后一条消息最终可搜到', async () => {
  const f = await fixture();
  try {
    await f.store.createConversation({ id: 'long', actorId: 'owner', title: '普通标题', createdAt: 1, updatedAt: 1 });
    await f.store.appendHistory('long', Array.from({ length: 1100 }, (_, index) => message(index, index === 1099 ? '最后一条消息的星图坐标' : `消息 ${index}`)));
    await f.store.close();
    const db = new Database(path.join(f.data, 'platform.sqlite'));
    try {
      // 模拟实际第 9 版结构，验证升级时保留原历史并分批补建正文索引。
      db.exec(`DROP TRIGGER history_search_ai; DROP TRIGGER history_search_ad;
        DROP TABLE history_search_fts; DROP TABLE history_search;
        ALTER TABLE histories DROP COLUMN search_revision;
        ALTER TABLE histories DROP COLUMN search_position;
        PRAGMA user_version=9;`);
    } finally { db.close(); }
    const app = await PlatformApplication.open({ dataDirectory: f.data });
    try {
      const navigation = new ConversationNavigation(app);
      const first = await navigation.list('owner', { query: '星图坐标' });
      expect(first.searchIndexing).toBe(true);
      expect(first.items).toEqual([]);
      const second = await navigation.list('owner', { query: '星图坐标' });
      expect(second.searchIndexing).toBe(true);
      const last = await navigation.list('owner', { query: '星图坐标' });
      expect(last.searchIndexing).toBeUndefined();
      expect(last.items.map(item => item.id)).toEqual(['long']);
    } finally { await app.close(); }
  } finally { await f.cleanup(); }
});
