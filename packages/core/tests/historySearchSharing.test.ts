import path from 'node:path';
import Database from 'better-sqlite3';
import { PlatformStorage } from '@graycode/core';
import { openDatabase, SCHEMA_VERSION } from '../src/storage/schema';
import { fixture, message, metadata } from './fixtures';

test('分叉共用正文索引，消息身份和位置仍由各自历史决定', async () => {
  const f = await fixture();
  try {
    await f.store.initializeConversation(metadata('source'), [
      message(0, '共享开端'), message(1, '共享中段'), message(2, '仅原会话尾部'),
    ]);
    await f.store.forkConversation('source', metadata('fork'), { beforeIndex: 2 });
    expect((await f.store.searchConversationIds('仅原会话尾部')).matches.map(hit => hit.id)).toEqual(['source']);
    await f.store.close();
    const db = new Database(path.join(f.data, 'platform.sqlite'));
    try {
      expect(db.prepare('SELECT count(*) AS n FROM history_search').get()).toEqual({ n: 3 });
      expect(db.prepare('SELECT count(*) AS n FROM history_search_fts_docsize').get()).toEqual({ n: 3 });
    } finally { db.close(); }
    f.store = await PlatformStorage.open(f.data);
    await f.store.appendHistory('source', [{ ...message(3, '共享中段'), id: 'duplicate-body', role: 'user' }]);
    const hits = (await f.store.searchConversationIds('共享')).matches.sort((a, b) => a.id.localeCompare(b.id));
    expect(hits).toEqual([
      { id: 'fork', messageIndex: 1, messageId: 'message_1', excerpt: '共享中段' },
      { id: 'source', messageIndex: 3, messageId: 'duplicate-body', excerpt: '共享中段' },
    ]);
    await f.store.deleteConversation('source');
    await f.store.collectGarbage();
    expect((await f.store.searchConversationIds('共享中段')).matches).toEqual([hits[0]]);
    await f.store.deleteConversation('fork');
    await f.store.collectGarbage();
    expect((await f.store.statistics()).objects).toBe(0);
    await f.store.close();
    const empty = new Database(path.join(f.data, 'platform.sqlite'));
    try {
      expect(empty.prepare('SELECT count(*) AS n FROM history_search').get()).toEqual({ n: 0 });
      expect(empty.prepare('SELECT count(*) AS n FROM history_search_fts_docsize').get()).toEqual({ n: 0 });
    } finally { empty.close(); }
  } finally { await f.cleanup(); }
});

test('共享正文已经索引时，部分索引的历史仍只公开已完成前缀', async () => {
  const f = await fixture();
  try {
    await f.store.initializeConversation(metadata('source'), Array.from({ length: 1100 }, (_, index) =>
      message(index, index === 1099 ? '末尾星图坐标' : `前缀 ${index}`)));
    await f.store.forkConversation('source', metadata('pending'));
    await f.store.close();
    const db = new Database(path.join(f.data, 'platform.sqlite'));
    try {
      db.prepare(`UPDATE histories SET search_revision=-1,search_position=0
        WHERE id=(SELECT history_id FROM conversations WHERE id='pending')`).run();
    } finally { db.close(); }
    f.store = await PlatformStorage.open(f.data);
    const first = await f.store.searchConversationIds('星图坐标');
    expect(first.indexing).toBe(true);
    expect(first.matches.map(hit => hit.id)).toEqual(['source']);
    const second = await f.store.searchConversationIds('星图坐标');
    expect(second.indexing).toBe(true);
    expect(second.matches.map(hit => hit.id)).toEqual(['source']);
    const last = await f.store.searchConversationIds('星图坐标');
    expect(last.indexing).toBe(false);
    expect(last.matches.map(hit => hit.id).sort()).toEqual(['pending', 'source']);
  } finally { await f.cleanup(); }
});

test('第 10 版正文索引升级时按内容去重并保留部分构建进度', async () => {
  const f = await fixture();
  const texts = Array.from({ length: 1100 }, (_, index) => index === 1099 ? '升级后末尾星图' : `旧版正文 ${index}`);
  const messages = texts.map((text, index) => message(index, text));
  try {
    await f.store.initializeConversation(metadata('source'), messages);
    await f.store.forkConversation('source', metadata('partial'));
    await f.store.close();
    const db = new Database(path.join(f.data, 'platform.sqlite'));
    try {
      // 真实第 10 版按历史和位置保存正文，尚未完成的前缀外没有索引记录。
      db.exec(`DROP TRIGGER history_search_ai; DROP TRIGGER history_search_ad;
        DROP TABLE history_search_fts; DROP TABLE history_search;
        DROP INDEX entries_by_body;
        CREATE TABLE history_search (
          id INTEGER PRIMARY KEY, history_id TEXT NOT NULL REFERENCES histories(id) ON DELETE CASCADE,
          position INTEGER NOT NULL, message_id TEXT, text TEXT NOT NULL, normalized TEXT NOT NULL,
          UNIQUE(history_id,position)
        );
        CREATE VIRTUAL TABLE history_search_fts USING fts5(normalized,content='history_search',content_rowid='id',tokenize='trigram');
        CREATE TRIGGER history_search_ai AFTER INSERT ON history_search BEGIN
          INSERT INTO history_search_fts(rowid,normalized) VALUES(new.id,new.normalized);
        END;
        CREATE TRIGGER history_search_ad AFTER DELETE ON history_search BEGIN
          INSERT INTO history_search_fts(history_search_fts,rowid,normalized) VALUES('delete',old.id,old.normalized);
        END;
        UPDATE histories SET search_revision=-1,search_position=500 WHERE id=(SELECT history_id FROM conversations WHERE id='partial');
        PRAGMA user_version=10;`);
      const insert = db.prepare('INSERT INTO history_search(history_id,position,message_id,text,normalized) VALUES(?,?,?,?,?)');
      const histories = db.prepare('SELECT id,search_position FROM histories').all() as Array<{ id: string; search_position: number }>;
      db.transaction(() => {
        for (const history of histories) for (let index = 0; index < history.search_position; index++) {
          const text = texts[index];
          insert.run(history.id, index, messages[index].id, text, text.toLowerCase());
        }
      })();
      expect(db.prepare('SELECT count(*) AS n FROM history_search').get()).toEqual({ n: 1600 });
    } finally { db.close(); }
    const upgraded = openDatabase(path.join(f.data, 'platform.sqlite'));
    try {
      expect(upgraded.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
      expect(upgraded.prepare('SELECT count(*) AS n FROM history_search').get()).toEqual({ n: 1100 });
      expect(upgraded.prepare('SELECT count(*) AS n FROM history_search_fts_docsize').get()).toEqual({ n: 1100 });
      expect(upgraded.prepare(`SELECT search_revision,search_position FROM histories
        WHERE id=(SELECT history_id FROM conversations WHERE id='partial')`).get()).toEqual({ search_revision: -1, search_position: 500 });
    } finally { upgraded.close(); }
    f.store = await PlatformStorage.open(f.data);
    const first = await f.store.searchConversationIds('末尾星图');
    expect(first.indexing).toBe(true);
    expect(first.matches.map(hit => hit.id)).toEqual(['source']);
    const last = await f.store.searchConversationIds('末尾星图');
    expect(last.indexing).toBe(false);
    expect(last.matches.map(hit => hit.id).sort()).toEqual(['partial', 'source']);
    expect((await f.store.readHistory('partial', { limit: 1 })).messages).toEqual(messages.slice(-1));
    expect((await f.store.verify()).ok).toBe(true);
  } finally { await f.cleanup(); }
});
