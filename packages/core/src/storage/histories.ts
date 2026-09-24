import { randomUUID } from 'node:crypto';
import type { SqliteConnection } from './schema';
import type { PlatformMessage, PageOptions, RuntimeHistoryCursor } from '@graycode/contracts';
import { ObjectStore } from './objects';
import { assertIdentifier, invalid, PlatformStorageError } from '../errors';

const SEGMENT_ENTRIES = 128;
interface HistoryRow { id: string; message_count: number; revision: number; search_revision: number; search_position: number }
interface SpanRow { start_index: number; segment_id: number; segment_offset: number; count: number }
interface EntryRow { body_hash: Buffer; message_id: string | null; role: string; timestamp: number | null }

function searchableText(message: Pick<PlatformMessage, 'parts'>): string {
  return Array.isArray(message.parts) ? message.parts.flatMap(part => typeof part?.text === 'string' && part.thought !== true ? [part.text] : []).join('\n') : '';
}

/** Sequence spans are small indexes. Forks share spans; message content is immutable. */
export class HistoryStore {
  private readonly cursorSnapshots = new Map<string, { historyId: string; revision: number; spans: SpanRow[] }>();
  constructor(private readonly db: SqliteConnection, private readonly objects: ObjectStore) {}

  releaseCursor(runId: string): void { this.cursorSnapshots.delete(runId); }
  clearCursors(): void { this.cursorSnapshots.clear(); }

  readIncremental(id: string, cursor: RuntimeHistoryCursor) {
    const info = this.info(id);
    const spans = this.db.prepare('SELECT * FROM history_spans WHERE history_id=? ORDER BY start_index').all(id) as SpanRow[];
    const previous = this.cursorSnapshots.get(cursor.runId);
    let startIndex = 0;
    if (previous?.historyId === id && previous.revision === cursor.revision) {
      // 段内条目不可变；段身份、偏移和长度即可确定共享前缀，无需解压旧消息。
      for (let index = 0; index < Math.min(previous.spans.length, spans.length); index++) {
        const before = previous.spans[index], after = spans[index];
        if (before.segment_id !== after.segment_id || before.segment_offset !== after.segment_offset || before.start_index !== after.start_index) break;
        startIndex += Math.min(before.count, after.count);
        if (before.count !== after.count) break;
      }
    }
    const rows = this.rows(id, startIndex, info.message_count);
    if (rows.length !== info.message_count - startIndex) throw new PlatformStorageError('CORRUPT_DATA', 'History sequence contains missing entries.');
    const messages = rows.map(row => this.decode(row));
    this.cursorSnapshots.set(cursor.runId, { historyId: id, revision: info.revision, spans });
    return { total: info.message_count, startIndex, revision: info.revision, messages };
  }

  create(): string {
    const id = randomUUID();
    this.db.prepare('INSERT INTO histories(id,search_revision,search_position) VALUES(?,0,0)').run(id);
    return id;
  }

  /** 每次搜索只补建有限数量的旧消息，避免长对话阻塞其他存储操作。 */
  advanceSearchIndex(): boolean {
    const insert = this.db.prepare('INSERT INTO history_search(history_id,position,message_id,text,normalized) VALUES(?,?,?,?,?)');
    let budget = 512;
    for (let histories = 0; histories < 16 && budget > 0; histories++) {
      const pending = this.db.prepare(`SELECT c.history_id FROM conversations c JOIN histories h ON h.id=c.history_id
        WHERE h.search_revision<>h.revision ORDER BY c.updated_at DESC LIMIT 1`).get() as { history_id: string } | undefined;
      if (!pending) return false;
      const id = pending.history_id;
      this.db.transaction(() => {
      const info = this.info(id);
      const end = Math.min(info.message_count, info.search_position + budget);
      const rows = this.rows(id, info.search_position, end);
      if (rows.length !== end - info.search_position) throw new PlatformStorageError('CORRUPT_DATA', 'History sequence contains missing entries.');
      rows.forEach((row, offset) => {
        const text = searchableText(this.objects.getValue<Pick<PlatformMessage, 'parts'>>(row.body_hash, { fields: ['parts'], omitBinary: true }));
        if (text) insert.run(id, info.search_position + offset, row.message_id, text, text.toLowerCase());
      });
      this.db.prepare('UPDATE histories SET search_position=?,search_revision=? WHERE id=?')
        .run(end, end === info.message_count ? info.revision : -1, id);
      budget -= rows.length;
      })();
    }
    return !!this.db.prepare(`SELECT 1 FROM conversations c JOIN histories h ON h.id=c.history_id
      WHERE h.search_revision<>h.revision LIMIT 1`).get();
  }

  info(id: string): HistoryRow {
    const row = this.db.prepare('SELECT * FROM histories WHERE id=?').get(id) as HistoryRow | undefined;
    if (!row) throw new PlatformStorageError('NOT_FOUND', 'Conversation history does not exist.');
    return row;
  }

  checkRevision(id: string, expected?: number): HistoryRow {
    const info = this.info(id);
    if (expected !== undefined && (!Number.isSafeInteger(expected) || expected !== info.revision)) {
      throw new PlatformStorageError('REVISION_CONFLICT', `History changed: expected revision ${expected}, current revision ${info.revision}.`);
    }
    return info;
  }

  page(id: string, options: PageOptions = {}): { total: number; startIndex: number; revision: number; messages: PlatformMessage[] } {
    const info = this.info(id);
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) invalid('Page limit must be between 1 and 1000.');
    if (options.offset !== undefined && options.beforeIndex !== undefined) invalid('Use either offset or beforeIndex.');
    for (const value of [options.offset, options.beforeIndex]) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) invalid('Page positions must be nonnegative integers.');
    }
    const end = options.offset !== undefined
      ? Math.min(info.message_count, options.offset + limit)
      : Math.min(info.message_count, options.beforeIndex ?? info.message_count);
    const start = options.offset !== undefined ? Math.min(info.message_count, options.offset) : Math.max(0, end - limit);
    const rows = this.rows(id, start, end);
    if (rows.length !== end - start) throw new PlatformStorageError('CORRUPT_DATA', 'History sequence contains missing entries.');
    return { total: info.message_count, startIndex: start, revision: info.revision, messages: rows.map(row => this.decode(row)) };
  }

  append(id: string, messages: PlatformMessage[]): void {
    if (!Array.isArray(messages)) invalid('Messages must be an array.');
    if (!messages.length) return;
    const info = this.info(id);
    const indexed = info.search_revision === info.revision;
    const entries = messages.map(message => this.encode(message));
    let tail = this.db.prepare('SELECT * FROM history_spans WHERE history_id=? ORDER BY start_index DESC LIMIT 1').get(id) as SpanRow | undefined;
    let length = tail ? Number((this.db.prepare('SELECT count(*) AS n FROM segment_entries WHERE segment_id=?').get(tail.segment_id) as { n: number }).n) : 0;
    let total = info.message_count;
    const insertEntry = this.db.prepare('INSERT INTO segment_entries(segment_id,ordinal,body_hash,message_id,role,timestamp) VALUES(?,?,?,?,?,?)');
    for (const entry of entries) {
      // Appending after a fork never overwrites a prefix visible to another history.
      if (!tail || tail.segment_offset + tail.count !== length || length >= SEGMENT_ENTRIES) {
        const segmentId = Number(this.db.prepare('INSERT INTO segments DEFAULT VALUES').run().lastInsertRowid);
        tail = { start_index: total, segment_id: segmentId, segment_offset: 0, count: 0 };
        length = 0;
      }
      insertEntry.run(tail.segment_id, length, entry.body_hash, entry.message_id, entry.role, entry.timestamp);
      tail.count++;
      length++;
      total++;
      this.db.prepare(`INSERT INTO history_spans(history_id,start_index,segment_id,segment_offset,count) VALUES(?,?,?,?,?)
        ON CONFLICT(history_id,start_index) DO UPDATE SET count=excluded.count`)
        .run(id, tail.start_index, tail.segment_id, tail.segment_offset, tail.count);
    }
    this.db.prepare('UPDATE histories SET message_count=?,revision=revision+1 WHERE id=?').run(total, id);
    if (indexed) {
      const insert = this.db.prepare('INSERT INTO history_search(history_id,position,message_id,text,normalized) VALUES(?,?,?,?,?)');
      messages.forEach((message, offset) => {
        const text = searchableText(message);
        if (text) insert.run(id, info.message_count + offset, message.id ?? null, text, text.toLowerCase());
      });
      this.db.prepare('UPDATE histories SET search_revision=?,search_position=? WHERE id=?').run(info.revision + 1, total, id);
    }
  }

  replace(id: string, messages: PlatformMessage[]): void {
    if (!Array.isArray(messages)) invalid('Messages must be an array.');
    const info = this.info(id);
    const old = this.rows(id, 0, info.message_count);
    if (old.length !== info.message_count) throw new PlatformStorageError('CORRUPT_DATA', 'Cannot replace corrupt history.');
    let prefix = 0;
    for (; prefix < Math.min(old.length, messages.length); prefix++) {
      const next = this.encode(messages[prefix]);
      const previous = old[prefix];
      if (!this.sameEntry(next, previous)) break;
    }
    if (prefix === old.length && prefix === messages.length) return;
    this.truncate(id, prefix);
    if (prefix < messages.length) this.append(id, messages.slice(prefix));
    // A replacement is one externally visible mutation, regardless of internal truncate/append.
    this.db.prepare('UPDATE histories SET revision=?,search_revision=? WHERE id=?')
      .run(info.revision + 1, info.search_revision === info.revision ? info.revision + 1 : -1, id);
  }

  patch(id: string, updates: { index: number; message: PlatformMessage }[]): void {
    if (!updates.length) return;
    const info = this.info(id);
    const changes = new Map<number, PlatformMessage>();
    let start = info.message_count;
    for (const { index, message } of updates) {
      if (!Number.isSafeInteger(index) || index < 0 || index >= info.message_count) invalid('历史更新位置超出范围。');
      changes.set(index, message); start = Math.min(start, index);
    }
    const rows = this.rows(id, start, info.message_count);
    if (rows.length !== info.message_count - start) throw new PlatformStorageError('CORRUPT_DATA', 'History sequence contains missing entries.');
    let firstChanged = info.message_count;
    for (const [index, message] of changes) {
      if (this.sameEntry(this.encode(message), rows[index - start])) changes.delete(index);
      else firstChanged = Math.min(firstChanged, index);
    }
    if (!changes.size) return;
    const messages = rows.slice(firstChanged - start).map(row => this.decode(row));
    for (const [index, message] of changes) messages[index - firstChanged] = message;
    this.truncate(id, firstChanged);
    this.append(id, messages);
    this.db.prepare('UPDATE histories SET revision=?,search_revision=? WHERE id=?')
      .run(info.revision + 1, info.search_revision === info.revision ? info.revision + 1 : -1, id);
  }

  private sameEntry(left: EntryRow, right: EntryRow): boolean {
    return left.body_hash.equals(right.body_hash) && left.message_id === right.message_id && left.role === right.role && left.timestamp === right.timestamp;
  }

  fork(id: string, beforeIndex?: number): string {
    const info = this.info(id);
    const end = beforeIndex ?? info.message_count;
    if (!Number.isSafeInteger(end) || end < 0 || end > info.message_count) invalid('Fork position is outside the source history.');
    const target = this.create();
    this.db.prepare(`INSERT INTO history_spans(history_id,start_index,segment_id,segment_offset,count)
      SELECT ?,start_index,segment_id,segment_offset,min(count,?-start_index)
      FROM history_spans WHERE history_id=? AND start_index<?`).run(target, end, id, end);
    this.db.prepare('UPDATE histories SET message_count=? WHERE id=?').run(end, target);
    const indexedUntil = Math.min(end, info.search_position);
    if (indexedUntil) {
      this.db.prepare(`INSERT INTO history_search(history_id,position,message_id,text,normalized)
        SELECT ?,position,message_id,text,normalized FROM history_search WHERE history_id=? AND position<?`).run(target, id, indexedUntil);
    }
    this.db.prepare('UPDATE histories SET search_revision=?,search_position=? WHERE id=?')
      .run(indexedUntil === end ? 0 : -1, indexedUntil, target);
    return target;
  }

  /** 用量页不恢复附件；只有旧版部分输出估算需要读取文字和工具参数。 */
  usage(id: string): { revision: number; messages: PlatformMessage[] } {
    const info = this.info(id);
    const rows = this.db.prepare(`SELECT e.body_hash,e.message_id,e.role,e.timestamp
      FROM history_spans s JOIN segment_entries e ON e.segment_id=s.segment_id
      AND e.ordinal>=s.segment_offset AND e.ordinal<s.segment_offset+s.count
      WHERE s.history_id=? AND e.role='model' ORDER BY s.start_index,e.ordinal`).all(id) as EntryRow[];
    const fields = ['runId', 'modelVersion', 'usageMetadata', 'usageMetadataPartial', 'candidatesTokenCount', 'thoughtsTokenCount'];
    const messages = rows.map(row => {
      const body = this.objects.getValue<Record<string, unknown>>(row.body_hash, { fields, omitBinary: true });
      const parts = body.usageMetadataPartial
        ? this.objects.getValue<Pick<PlatformMessage, 'parts'>>(row.body_hash, { fields: ['parts'], omitBinary: true }).parts : [];
      return { ...body, parts: parts ?? [], role: row.role, ...(row.message_id ? { id: row.message_id } : {}),
        ...(row.timestamp !== null ? { timestamp: row.timestamp } : {}) } as PlatformMessage;
    });
    return { revision: info.revision, messages };
  }

  private truncate(id: string, length: number): void {
    this.db.prepare('DELETE FROM history_search WHERE history_id=? AND position>=?').run(id, length);
    this.db.prepare('UPDATE histories SET search_position=min(search_position,?) WHERE id=?').run(length, id);
    this.db.prepare('DELETE FROM history_spans WHERE history_id=? AND start_index>=?').run(id, length);
    this.db.prepare('UPDATE history_spans SET count=?-start_index WHERE history_id=? AND start_index+count>?').run(length, id, length);
    this.db.prepare('UPDATE histories SET message_count=? WHERE id=?').run(length, id);
  }

  private rows(id: string, start: number, end: number): EntryRow[] {
    return this.db.prepare(`SELECT e.body_hash,e.message_id,e.role,e.timestamp
      FROM history_spans s JOIN segment_entries e ON e.segment_id=s.segment_id
      AND e.ordinal>=s.segment_offset AND e.ordinal<s.segment_offset+s.count
      WHERE s.history_id=? AND s.start_index>=(
        SELECT start_index FROM history_spans WHERE history_id=? AND start_index<=? ORDER BY start_index DESC LIMIT 1
      ) AND s.start_index<?
      AND s.start_index+e.ordinal-s.segment_offset>=? AND s.start_index+e.ordinal-s.segment_offset<?
      ORDER BY s.start_index,e.ordinal`).all(id, id, start, end, start, end) as EntryRow[];
  }

  private encode(message: PlatformMessage): EntryRow {
    if (!message || typeof message !== 'object' || Array.isArray(message)) invalid('Every message must be an object.');
    if (typeof message.role !== 'string' || !message.role || !Array.isArray(message.parts)) invalid('A message requires a role and parts array.');
    if (message.id !== undefined) assertIdentifier(message.id, 'message id');
    const { role, id, ...body } = message;
    const timestamp = typeof body.timestamp === 'number' && Number.isFinite(body.timestamp) ? body.timestamp : null;
    if (timestamp !== null) delete body.timestamp;
    return { body_hash: this.objects.putValue(body), message_id: id ?? null, role, timestamp };
  }

  private decode(row: EntryRow): PlatformMessage {
    const body = this.objects.getValue<Record<string, unknown>>(row.body_hash);
    const message = { ...body, role: row.role } as PlatformMessage;
    if (row.message_id !== null) message.id = row.message_id;
    if (row.timestamp !== null) message.timestamp = row.timestamp;
    return message;
  }
}
