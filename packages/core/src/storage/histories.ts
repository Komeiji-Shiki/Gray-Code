import { randomUUID } from 'node:crypto';
import type { SqliteConnection } from './schema';
import type { PlatformMessage, PageOptions, RuntimeHistoryCursor } from '@graycode/contracts';
import { ObjectStore, type ValueProjection } from './objects';
import { assertIdentifier, invalid, PlatformStorageError } from '../errors';

const SEGMENT_ENTRIES = 128;
/** 已解码消息正文的缓存上限（估算字节）。切换和准备长会话时同一份历史会被多个请求完整读取。 */
const BODY_CACHE_BYTES = 96 * 1024 * 1024;
const BODY_CACHE_ENTRY_BYTES = 2 * 1024 * 1024;
/** 导航摘要按历史保留少量快照：切换标签时来回读取的几个会话都能增量复用。 */
const OUTLINE_SNAPSHOTS = 4;
const OUTLINE_FIELDS = ['parentId', 'runId', 'isFunctionResponse', 'parts'] as const;

function outlineProjection(includePreview: boolean): ValueProjection {
  return { fields: OUTLINE_FIELDS, omitBinary: true, properties: { parts: { items: {
    fields: includePreview ? ['text', 'functionCall', 'functionResponse'] : ['functionCall', 'functionResponse'],
    properties: {
      functionCall: { fields: ['id', 'name', 'rejected', 'async', 'args'], properties: { args: { fields: ['task_handle'] } } },
      functionResponse: { fields: ['id', 'response'], properties: { response: { fields: ['rejected', 'cancelled', 'code'] } } },
    },
  } } } };
}
const OUTLINE_PROJECTION = outlineProjection(false);
const USER_OUTLINE_PROJECTION = outlineProjection(true);

/**
 * 导航标记、楼层与读取修复扫描只需要的消息摘要。正文、工具载荷与附件留在存储线程，
 * 长会话刷新导航时不再复制完整消息。
 */
export interface HistoryOutlineEntry {
  role: string;
  id?: string;
  /** parentId 字段是否存在（null 也算存在），用于节点 ID 迁移判据。 */
  hasParentId: boolean;
  runId?: string;
  isFunctionResponse?: boolean;
  /** 带 ID 的工具调用，保持原始顺序；异步句柄用于等待旧任务，避免再读完整参数。 */
  calls?: { id: string; rejected?: true; taskHandle?: string }[];
  /** 带 ID 的工具响应，只保留判断占位响应所需的结构标记。 */
  responses?: { id: string; rejected?: true; cancelled?: true; code?: string }[];
  /** 用户输入（非工具响应）的文字预览，口径与导航标记一致。 */
  preview?: string;
}

export interface HistorySelection {
  runIds?: string[];
  indices?: number[];
  projection?: ValueProjection;
  expectedRevision?: number;
}

function outlineEntry(row: EntryRow, body: Record<string, unknown>): HistoryOutlineEntry {
  const entry: HistoryOutlineEntry = { role: row.role, hasParentId: body.parentId !== undefined };
  if (row.message_id !== null) entry.id = row.message_id;
  if (typeof body.runId === 'string' && body.runId) entry.runId = body.runId;
  if (body.isFunctionResponse) entry.isFunctionResponse = true;
  const parts = Array.isArray(body.parts) ? body.parts as Array<Record<string, any> | null> : [];
  for (const part of parts) {
    const call = part?.functionCall;
    if (call && typeof call.id === 'string' && call.id) (entry.calls ??= []).push({ id: call.id,
      ...(call.rejected ? { rejected: true as const } : {}),
      ...(call.async === true && typeof call.args?.task_handle === 'string' ? { taskHandle: call.args.task_handle } : {}) });
    const response = part?.functionResponse;
    if (response && typeof response.id === 'string' && response.id) {
      const value = response.response && typeof response.response === 'object' && !Array.isArray(response.response) ? response.response : {};
      (entry.responses ??= []).push({ id: response.id,
        ...(value.rejected === true ? { rejected: true as const } : {}),
        ...(value.cancelled === true ? { cancelled: true as const } : {}),
        ...(typeof value.code === 'string' && value.code.length <= 64 ? { code: value.code } : {}) });
    }
  }
  if (row.role === 'user' && !entry.isFunctionResponse) {
    const preview = parts.map(part => typeof part?.text === 'string' ? part.text : '').join(' ').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (preview) entry.preview = preview;
  }
  return entry;
}

/** 粗略估算已解码值占用的内存；只用于缓存淘汰，不参与存储语义。 */
function estimatedBytes(value: unknown, limit: number): number {
  let total = 0;
  // 按需遍历子项，避免大数组展开为函数参数，或在达到预算前先复制整个容器。
  function* values(record: Record<string, unknown>): Generator<unknown> {
    for (const key in record) if (Object.hasOwn(record, key)) {
      total += key.length * 2 + 16;
      yield record[key];
    }
  }
  const stack: Iterator<unknown>[] = [[value].values()];
  while (stack.length && total <= limit) {
    const next = stack[stack.length - 1].next();
    if (next.done) { stack.pop(); continue; }
    const item = next.value;
    if (typeof item === 'string') total += item.length * 2;
    else if (item instanceof Uint8Array) total += item.byteLength;
    else if (Array.isArray(item)) { total += 16; stack.push(item.values()); }
    else if (item && typeof item === 'object') stack.push(values(item as Record<string, unknown>));
    else total += 8;
  }
  return total;
}
interface HistoryRow { id: string; message_count: number; revision: number; search_revision: number; search_position: number }
interface SpanRow { start_index: number; segment_id: number; segment_offset: number; count: number }
interface EntryRow { body_hash: Buffer; message_id: string | null; role: string; timestamp: number | null }

/** 段内条目不可变；段身份、偏移和长度即可确定共享前缀，无需解压旧消息。 */
function sharedSpanPrefix(previous: readonly SpanRow[], current: readonly SpanRow[]): number {
  let length = 0;
  for (let index = 0; index < Math.min(previous.length, current.length); index++) {
    const before = previous[index], after = current[index];
    if (before.segment_id !== after.segment_id || before.segment_offset !== after.segment_offset || before.start_index !== after.start_index) break;
    length += Math.min(before.count, after.count);
    if (before.count !== after.count) break;
  }
  return length;
}

function searchableText(message: Pick<PlatformMessage, 'parts'>): string {
  return Array.isArray(message.parts) ? message.parts.flatMap(part => typeof part?.text === 'string' && part.thought !== true ? [part.text] : []).join('\n') : '';
}

/** Sequence spans are small indexes. Forks share spans; message content is immutable. */
export class HistoryStore {
  private readonly cursorSnapshots = new Map<string, { historyId: string; revision: number; spans: SpanRow[] }>();
  // 仅保留最近一次楼层窗口，避免随着浏览过的会话数量积累派生元数据。
  private floorSnapshot?: { historyId: string; revision: number; spans: SpanRow[]; floorIndices: number[] };
  /** 按最近使用顺序保存的导航摘要快照；段内条目不可变，新版本只解码共享前缀之后的消息。 */
  private readonly outlineSnapshots = new Map<string, { revision: number; spans: SpanRow[]; entries: HistoryOutlineEntry[] }>();
  /**
   * 正文按内容哈希寻址且不可变，已解码的正文可以跨请求、跨分叉共享。读取结果经线程消息复制后才交给调用方，
   * 存储线程内不修改解码后的消息，因此缓存不需要随版本失效。按最近使用顺序淘汰。
   */
  private readonly bodies = new Map<string, { body: Record<string, unknown>; bytes: number }>();
  private bodyBytes = 0;
  /** 用量前缀令牌的有效期；回收或备份合并后段号可能复用，随 clearSnapshots 换新，旧令牌回退全量读取。 */
  private usageEpoch = randomUUID();
  constructor(private readonly db: SqliteConnection, private readonly objects: ObjectStore) {}

  releaseCursor(runId: string): void { this.cursorSnapshots.delete(runId); }
  clearSnapshots(): void {
    this.cursorSnapshots.clear(); this.floorSnapshot = undefined; this.outlineSnapshots.clear(); this.bodies.clear(); this.bodyBytes = 0;
    this.usageEpoch = randomUUID();
  }

  readIncremental(id: string, cursor: RuntimeHistoryCursor) {
    const info = this.info(id);
    const spans = this.db.prepare('SELECT * FROM history_spans WHERE history_id=? ORDER BY start_index').all(id) as SpanRow[];
    const previous = this.cursorSnapshots.get(cursor.runId);
    const startIndex = previous?.historyId === id && previous.revision === cursor.revision ? sharedSpanPrefix(previous.spans, spans) : 0;
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

  /** 中断结算只需本轮未配对的调用身份；旧消息仅投影 runId，不读取正文或附件。 */
  pendingToolCalls(id: string, runId: string): Array<{ id: string; name: string }> {
    return this.db.transaction(() => {
      const info = this.info(id);
      const rows = this.rows(id, 0, info.message_count);
      if (rows.length !== info.message_count) throw new PlatformStorageError('CORRUPT_DATA', 'History sequence contains missing entries.');
      const pending = new Map<string, { id: string; name: string }>();
      for (const row of rows) {
        const cached = this.bodies.get(row.body_hash.toString('hex'))?.body;
        const owner = cached ?? this.objects.getValue<Record<string, unknown>>(row.body_hash, { fields: ['runId'], omitBinary: true });
        if (owner.runId !== runId) continue;
        const body = cached ?? this.objects.getValue<Record<string, unknown>>(row.body_hash, { ...OUTLINE_PROJECTION, fields: ['parts'] });
        for (const part of body.parts as PlatformMessage['parts']) {
          const call = part.functionCall as { id: string; name: string } | undefined;
          const response = part.functionResponse as { id: string } | undefined;
          if (call && row.role === 'model') pending.set(call.id, { id: call.id, name: call.name });
          if (response) pending.delete(response.id);
        }
      }
      return [...pending.values()];
    })();
  }

  /** 按运行、位置或字段读取同一版本的历史，未选中的大型正文和附件留在存储线程。 */
  select(id: string, options: HistorySelection) {
    if (options.runIds?.some(runId => typeof runId !== 'string' || !runId)) invalid('Run IDs must be nonempty strings.');
    if (options.indices?.some(index => !Number.isSafeInteger(index) || index < 0)) invalid('Message indices must be nonnegative integers.');
    const runs = options.runIds ? new Set(options.runIds) : undefined;
    const indices = options.indices ? [...new Set(options.indices)].sort((left, right) => left - right) : undefined;
    return this.db.transaction(() => {
      const info = this.checkRevision(id, options.expectedRevision);
      const result = { total: info.message_count, revision: info.revision, messages: [] as PlatformMessage[] };
      if (runs?.size === 0 || indices?.length === 0) return result;
      const ranges: Array<{ start: number; end: number }> = [];
      if (indices) {
        // 选定位置按原历史顺序返回；相邻位置共用范围查询，不读取未选中的整段索引。
        for (const index of indices) {
          if (index >= info.message_count) break;
          const previous = ranges.at(-1);
          if (previous?.end === index) previous.end++;
          else ranges.push({ start: index, end: index + 1 });
        }
      } else ranges.push({ start: 0, end: info.message_count });
      // 同一次同步查询的投影不变，缓存键的后缀只序列化一次，不随每条消息重复计算。
      const projectionKey = options.projection ? JSON.stringify(options.projection) : '';
      for (const range of ranges) {
        const rows = this.rows(id, range.start, range.end);
        if (rows.length !== range.end - range.start) throw new PlatformStorageError('CORRUPT_DATA', 'History sequence contains missing entries.');
        for (const row of rows) {
          if (runs) {
            const cached = this.bodies.get(row.body_hash.toString('hex'))?.body;
            const owner = cached ?? this.objects.getValue<Record<string, unknown>>(row.body_hash, { fields: ['runId'], omitBinary: true });
            if (typeof owner.runId !== 'string' || !runs.has(owner.runId)) continue;
          }
          result.messages.push(this.decode(row, options.projection, projectionKey));
        }
      }
      return result;
    })();
  }

  /** A bounded page and its global floor metadata share one snapshot. No options means metadata only. */
  pageWithFloors(id: string, options?: PageOptions) {
    return this.db.transaction(() => {
      const info = this.info(id);
      const page = options ? this.page(id, options)
        : { total: info.message_count, startIndex: 0, revision: info.revision, messages: [] as PlatformMessage[] };
      const previous = this.floorSnapshot;
      if (previous?.historyId === id && previous.revision === info.revision) return { ...page, floorIndices: [...previous.floorIndices] };
      const spans = this.db.prepare('SELECT * FROM history_spans WHERE history_id=? ORDER BY start_index').all(id) as SpanRow[];
      const startIndex = previous ? sharedSpanPrefix(previous.spans, spans) : 0;
      const floorIndices = previous?.floorIndices.filter(index => index < startIndex) ?? [];
      const rows = this.rows(id, startIndex, info.message_count);
      if (rows.length !== info.message_count - startIndex) throw new PlatformStorageError('CORRUPT_DATA', 'History sequence contains missing entries.');
      rows.forEach((row, offset) => {
        if (row.role !== 'user' && row.role !== 'model') return;
        // 楼层只依赖工具结果标记，历史正文、工具载荷和附件继续留在请求页之外。
        const body = this.objects.getValue<Pick<PlatformMessage, 'isFunctionResponse'>>(row.body_hash, { fields: ['isFunctionResponse'] });
        if (!body.isFunctionResponse) floorIndices.push(startIndex + offset);
      });
      this.floorSnapshot = { historyId: id, revision: info.revision, spans, floorIndices };
      return { ...page, floorIndices: [...floorIndices] };
    })();
  }

  /**
   * 整段历史的导航摘要（同一快照）。同一历史优先与自身上次快照比较；首次读取分叉时借用最近
   * 一份快照，分叉共享的段前缀同样不必重新解码。
   */
  outline(id: string): { total: number; revision: number; entries: HistoryOutlineEntry[] } {
    return this.db.transaction(() => {
      const info = this.info(id);
      const own = this.outlineSnapshots.get(id);
      if (own) { this.outlineSnapshots.delete(id); this.outlineSnapshots.set(id, own); }
      if (own?.revision === info.revision) return { total: info.message_count, revision: info.revision, entries: [...own.entries] };
      const spans = this.db.prepare('SELECT * FROM history_spans WHERE history_id=? ORDER BY start_index').all(id) as SpanRow[];
      const previous = own ?? [...this.outlineSnapshots.values()].at(-1);
      const startIndex = previous ? sharedSpanPrefix(previous.spans, spans) : 0;
      const entries = previous ? previous.entries.slice(0, startIndex) : [];
      const rows = this.rows(id, startIndex, info.message_count);
      if (rows.length !== info.message_count - startIndex) throw new PlatformStorageError('CORRUPT_DATA', 'History sequence contains missing entries.');
      for (const row of rows) {
        // 已缓存的完整正文直接复用；否则只投影摘要字段，附件不解码，也不挤占正文缓存。
        const body = this.bodies.get(row.body_hash.toString('hex'))?.body
          ?? this.objects.getValue<Record<string, unknown>>(row.body_hash, row.role === 'user' ? USER_OUTLINE_PROJECTION : OUTLINE_PROJECTION);
        entries.push(outlineEntry(row, body));
      }
      this.outlineSnapshots.set(id, { revision: info.revision, spans, entries });
      while (this.outlineSnapshots.size > OUTLINE_SNAPSHOTS) this.outlineSnapshots.delete(this.outlineSnapshots.keys().next().value!);
      return { total: info.message_count, revision: info.revision, entries: [...entries] };
    })();
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
    for (const { index, message } of updates) {
      if (!Number.isSafeInteger(index) || index < 0 || index >= info.message_count) invalid('历史更新位置超出范围。');
      changes.set(index, message);
    }
    const ordered = [...changes].sort(([left], [right]) => left - right);
    const spans = this.db.prepare(`SELECT * FROM history_spans WHERE history_id=? AND start_index<=? AND start_index+count>?
      ORDER BY start_index`).all(id, ordered[ordered.length - 1][0], ordered[0][0]) as SpanRow[];
    const insertEntry = this.db.prepare('INSERT INTO segment_entries(segment_id,ordinal,body_hash,message_id,role,timestamp) VALUES(?,?,?,?,?,?)');
    const insertSpan = this.db.prepare('INSERT INTO history_spans(history_id,start_index,segment_id,segment_offset,count) VALUES(?,?,?,?,?)');
    const removeSearch = this.db.prepare('DELETE FROM history_search WHERE history_id=? AND position=?');
    const insertSearch = this.db.prepare('INSERT INTO history_search(history_id,position,message_id,text,normalized) VALUES(?,?,?,?,?)');
    let next = 0, changed = false;
    for (const span of spans) {
      const end = span.start_index + span.count;
      if (next >= ordered.length || ordered[next][0] >= end) continue;
      const rows = this.rows(id, span.start_index, end);
      if (ordered[next][0] < span.start_index || rows.length !== span.count) throw new PlatformStorageError('CORRUPT_DATA', 'History sequence contains missing entries.');
      const replacements: Array<{ index: number; message: PlatformMessage; entry: EntryRow }> = [];
      while (next < ordered.length && ordered[next][0] < end) {
        const [index, message] = ordered[next++], entry = this.encode(message);
        if (!this.sameEntry(entry, rows[index - span.start_index])) replacements.push({ index, message, entry });
      }
      if (!replacements.length) continue;
      changed = true;
      const start = replacements[0].index, prefix = start - span.start_index;
      const entries = rows.slice(prefix);
      for (const replacement of replacements) entries[replacement.index - start] = replacement.entry;
      // 仅复制受影响段的不可变条目引用；保留最早改动之前的原段身份，增量游标仍从真实修改位置开始。
      const segmentId = Number(this.db.prepare('INSERT INTO segments DEFAULT VALUES').run().lastInsertRowid);
      entries.forEach((entry, ordinal) => insertEntry.run(segmentId, ordinal, entry.body_hash, entry.message_id, entry.role, entry.timestamp));
      this.db.prepare('DELETE FROM history_spans WHERE history_id=? AND start_index=?').run(id, span.start_index);
      if (prefix) insertSpan.run(id, span.start_index, span.segment_id, span.segment_offset, prefix);
      insertSpan.run(id, start, segmentId, 0, entries.length);
      for (const { index, message } of replacements) {
        removeSearch.run(id, index);
        // 已完成的索引前缀原位更新；尚未索引的部分继续从原进度构建，不重扫无关后缀。
        if (index < info.search_position) {
          const text = searchableText(message);
          if (text) insertSearch.run(id, index, message.id ?? null, text, text.toLowerCase());
        }
      }
    }
    if (next !== ordered.length) throw new PlatformStorageError('CORRUPT_DATA', 'History sequence contains missing entries.');
    if (!changed) return;
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

  /**
   * 用量页不恢复附件；只有旧版部分输出估算需要读取文字和工具参数。
   * since 是上次返回的前缀令牌：段内条目不可变，段身份一致的前缀里 model 消息不会变化，只解码共享前缀之后的消息；
   * keep 是共享前缀中的 model 条数，调用方据此截断缓存。删除、重生成、分支切换会改写段序列，共享前缀随之缩短。
   */
  usage(id: string, since?: string): { revision: number; messages: PlatformMessage[]; token: string; keep: number } {
    const info = this.info(id);
    const spans = this.db.prepare('SELECT * FROM history_spans WHERE history_id=? ORDER BY start_index').all(id) as SpanRow[];
    const previous = this.usageSpans(since);
    const shared = previous ? sharedSpanPrefix(previous, spans) : 0;
    const source = `FROM history_spans s JOIN segment_entries e ON e.segment_id=s.segment_id
      AND e.ordinal>=s.segment_offset AND e.ordinal<s.segment_offset+s.count
      WHERE s.history_id=? AND e.role='model'`;
    const position = 's.start_index+e.ordinal-s.segment_offset';
    // 共享前缀只计数，不读取正文。
    const keep = shared ? (this.db.prepare(`SELECT count(*) AS n ${source} AND ${position}<?`).get(id, shared) as { n: number }).n : 0;
    const rows = this.db.prepare(`SELECT e.body_hash,e.message_id,e.role,e.timestamp ${source} AND ${position}>=?
      ORDER BY s.start_index,e.ordinal`).all(id, shared) as EntryRow[];
    const fields = ['runId', 'modelVersion', 'usageMetadata', 'usageMetadataPartial', 'candidatesTokenCount', 'thoughtsTokenCount'];
    const messages = rows.map(row => {
      const body = this.objects.getValue<Record<string, unknown>>(row.body_hash, { fields, omitBinary: true });
      const parts = body.usageMetadataPartial
        ? this.objects.getValue<Pick<PlatformMessage, 'parts'>>(row.body_hash, { fields: ['parts'], omitBinary: true }).parts : [];
      return { ...body, parts: parts ?? [], role: row.role, ...(row.message_id ? { id: row.message_id } : {}),
        ...(row.timestamp !== null ? { timestamp: row.timestamp } : {}) } as PlatformMessage;
    });
    const token = JSON.stringify([this.usageEpoch, spans.map(span => [span.start_index, span.segment_id, span.segment_offset, span.count])]);
    return { revision: info.revision, messages, token, keep };
  }

  /** 令牌来自调用方缓存，格式不符或已过期时按无前缀处理。 */
  private usageSpans(token?: string): SpanRow[] | undefined {
    if (typeof token !== 'string') return undefined;
    try {
      const [epoch, spans] = JSON.parse(token) as [unknown, unknown];
      if (epoch !== this.usageEpoch || !Array.isArray(spans)) return undefined;
      return spans.map(item => {
        if (!Array.isArray(item) || item.length !== 4 || !item.every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error('invalid span');
        return { start_index: item[0], segment_id: item[1], segment_offset: item[2], count: item[3] };
      });
    } catch { return undefined; }
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

  private body(hash: Buffer, projection?: ValueProjection, projectionKey = projection ? JSON.stringify(projection) : ''): Record<string, unknown> {
    // 投影与完整正文共用原有容量和淘汰规则；内容及投影相同才复用，避免每次检查点重新解码旧消息。
    const key = hash.toString('hex') + (projection ? `:${projectionKey}` : '');
    const cached = this.bodies.get(key);
    if (cached) { this.bodies.delete(key); this.bodies.set(key, cached); return cached.body; }
    const body = this.objects.getValue<Record<string, unknown>>(hash, projection);
    const bytes = estimatedBytes(body, BODY_CACHE_ENTRY_BYTES) + key.length * 2;
    if (bytes <= BODY_CACHE_ENTRY_BYTES) {
      this.bodies.set(key, { body, bytes }); this.bodyBytes += bytes;
      for (const [oldest, entry] of this.bodies) {
        if (this.bodyBytes <= BODY_CACHE_BYTES) break;
        this.bodies.delete(oldest); this.bodyBytes -= entry.bytes;
      }
    }
    return body;
  }

  private decode(row: EntryRow, projection?: ValueProjection, projectionKey?: string): PlatformMessage {
    const body = this.body(row.body_hash, projection, projectionKey);
    const message = { ...body, role: row.role } as PlatformMessage;
    if (row.message_id !== null) message.id = row.message_id;
    if (row.timestamp !== null) message.timestamp = row.timestamp;
    return message;
  }
}
