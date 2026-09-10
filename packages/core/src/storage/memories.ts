import type { SqliteConnection } from './schema';
import { createHash } from 'node:crypto';
import type { ObjectStore } from './objects';
import type { MemoryScopeDefinition, MemoryScopeState, MemoryEntry, MemorySummary, MemoryWrite, MemoryWriteResult, MemoryRevision, MemoryImportPublish, MemoryImportBatch } from './memoryTypes';
import { PlatformStorageError, assertIdentifier } from '../errors';

interface ScopeRow { id: string; actor_id: string; workspace_key: string | null; entry_count: number; revision: number }
interface EntryRow { position: number; body_hash: Buffer }
interface SummaryRow { lo: number; hi: number; body_hash: Buffer }
function invalid(message: string): never { throw new PlatformStorageError('INVALID_INPUT', message); }
function integer(value: number) { if (!Number.isSafeInteger(value) || value < 0) invalid('Invalid memory position.'); }
function line(value: string) { if (typeof value !== 'string' || !value.trim() || /[\r\n]/.test(value)) invalid('A memory is one line of text.'); }

/** 原始记忆、摘要失效与撤销记录在同一个 SQLite 事务中提交。 */
export class MemoryRepository {
  constructor(private readonly db: SqliteConnection, private readonly objects: ObjectStore) {}
  scopes(actorId: string): MemoryScopeState[] {
    assertIdentifier(actorId, 'memory owner');
    return (this.db.prepare('SELECT * FROM memory_scopes WHERE actor_id=? ORDER BY workspace_key,id').all(actorId) as ScopeRow[])
      .map(row => ({ id: row.id, actorId: row.actor_id, ...(row.workspace_key ? { workspaceKey: row.workspace_key } : {}), length: row.entry_count, revision: row.revision }));
  }
  state(definition: MemoryScopeDefinition): MemoryScopeState {
    assertIdentifier(definition.id, 'memory scope'); assertIdentifier(definition.actorId, 'memory owner');
    const row = this.db.prepare('SELECT * FROM memory_scopes WHERE id=?').get(definition.id) as ScopeRow | undefined;
    if (row && (row.actor_id !== definition.actorId || row.workspace_key !== (definition.workspaceKey ?? null)))
      invalid('Memory scope identity does not match.');
    return { ...definition, length: row?.entry_count ?? 0, revision: row?.revision ?? 0 };
  }
  entries(scope: MemoryScopeDefinition, offset: number, limit: number, expectedRevision?: number): MemoryEntry[] {
    this.readRevision(scope, expectedRevision); integer(offset); integer(limit);
    if (limit > 4096) invalid('Read memory entries in pages of at most 4096.');
    return (this.db.prepare('SELECT position,body_hash FROM memory_entries WHERE scope_id=? AND position>=? ORDER BY position LIMIT ?')
      .all(scope.id, offset, limit) as EntryRow[]).map(row => ({ ...this.objects.getValue<Omit<MemoryEntry, 'id'>>(row.body_hash), id: row.position }));
  }
  summaries(scope: MemoryScopeDefinition, lo?: number, hi?: number, expectedRevision?: number): MemorySummary[] {
    this.readRevision(scope, expectedRevision);
    const rows = lo !== undefined && hi !== undefined
      ? this.db.prepare('SELECT lo,hi,body_hash FROM memory_summaries WHERE scope_id=? AND lo=? AND hi=?').all(scope.id, lo, hi)
      : this.db.prepare('SELECT lo,hi,body_hash FROM memory_summaries WHERE scope_id=? ORDER BY hi-lo,lo').all(scope.id);
    return (rows as SummaryRow[]).map(row => ({ lo: row.lo, hi: row.hi, text: this.objects.getValue<string>(row.body_hash) }));
  }
  private readRevision(scope: MemoryScopeDefinition, expected?: number) {
    const state = this.state(scope);
    if (expected !== undefined && state.revision !== expected) throw new PlatformStorageError('REVISION_CONFLICT', 'Memory changed during reading. Read the current revision again.');
  }
  revisions(scope: MemoryScopeDefinition, before?: number): MemoryRevision[] {
    this.state(scope);
    const rows = this.db.prepare('SELECT revision,kind,created_at,source_hash FROM memory_revisions WHERE scope_id=? AND revision<? ORDER BY revision DESC LIMIT 100')
      .all(scope.id, before ?? Number.MAX_SAFE_INTEGER) as Array<{ revision: number; kind: MemoryRevision['kind']; created_at: number; source_hash: Buffer }>;
    return rows.map(row => ({ revision: row.revision, kind: row.kind, timestamp: row.created_at, source: this.objects.getValue(row.source_hash) }));
  }
  publishImport(input: MemoryImportPublish): { skipped: boolean; configImported: boolean } {
    return this.db.transaction(() => {
      assertIdentifier(input.sourceKey); assertIdentifier(input.fingerprint); integer(input.entries);
      const hash = (value: string) => createHash('sha256').update(value).digest('hex');
      if (input.staging.actorId !== `memory-import-${input.target.actorId}` || input.staging.id !== hash(`${input.sourceKey}:${input.fingerprint}`) ||
        input.staging.workspaceKey !== input.target.workspaceKey) invalid('Memory staging identity is invalid.');
      if (input.config && input.config.id !== hash(JSON.stringify([input.target.actorId, null]))) invalid('Memory configuration owner does not match.');
      if (input.staging.id === input.target.id) invalid('Import staging must be separate from the target.');
      const staging = this.state(input.staging); const target = this.state(input.target);
      const previous = this.db.prepare("SELECT value_hash FROM records WHERE namespace='legacy-memory-imports' AND id=?").get(input.sourceKey) as { value_hash: Buffer } | undefined;
      if (previous) {
        const marker = this.objects.getValue<{ fingerprint: string; targetId: string; configImported: boolean }>(previous.value_hash);
        if (marker.fingerprint !== input.fingerprint || marker.targetId !== input.target.id) throw new PlatformStorageError('REVISION_CONFLICT', 'The previously imported memory source changed. Merge it explicitly instead of overwriting memory.');
        this.db.prepare('DELETE FROM memory_scopes WHERE id=?').run(input.staging.id);
        return { skipped: true, configImported: marker.configImported };
      }
      if (target.revision || target.length) throw new PlatformStorageError('REVISION_CONFLICT', 'The target already contains memory changes. Import will not overwrite it.');
      const actual = this.db.prepare('SELECT count(*) AS n FROM memory_entries WHERE scope_id=?').get(staging.id) as { n: number };
      if (staging.length !== input.entries || actual.n !== input.entries) invalid('Memory staging is incomplete.');
      this.db.prepare('INSERT INTO memory_scopes(id,actor_id,workspace_key,entry_count,revision) VALUES(?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET entry_count=excluded.entry_count,revision=1')
        .run(target.id, target.actorId, target.workspaceKey ?? null, staging.length);
      this.db.prepare('INSERT INTO memory_entries(scope_id,position,body_hash) SELECT ?,position,body_hash FROM memory_entries WHERE scope_id=?').run(target.id, staging.id);
      this.db.prepare('INSERT INTO memory_summaries(scope_id,lo,hi,body_hash) SELECT ?,lo,hi,body_hash FROM memory_summaries WHERE scope_id=?').run(target.id, staging.id);
      this.db.prepare('INSERT INTO memory_revisions(scope_id,revision,kind,created_at,before_length,source_hash) VALUES(?,1,?,?,0,?)')
        .run(target.id, 'import', Date.now(), this.objects.putValue({ origin: 'legacy_import', sourceKey: input.sourceKey, fingerprint: input.fingerprint }));
      this.db.prepare('INSERT INTO memory_revision_entries(scope_id,revision,position,body_hash) SELECT ?,1,position,NULL FROM memory_entries WHERE scope_id=?').run(target.id, target.id);
      this.db.prepare('INSERT INTO memory_revision_summaries(scope_id,revision,lo,hi,body_hash) SELECT ?,1,lo,hi,NULL FROM memory_summaries WHERE scope_id=?').run(target.id, target.id);
      let configImported = false;
      if (input.config) {
        assertIdentifier(input.config.id);
        configImported = this.db.prepare("INSERT OR IGNORE INTO records(namespace,id,value_hash,revision) VALUES('memory-config',?,?,1)")
          .run(input.config.id, this.objects.putValue(input.config.value)).changes > 0;
      }
      const marker = { fingerprint: input.fingerprint, targetId: target.id, entries: staging.length, configImported };
      this.db.prepare("INSERT INTO records(namespace,id,value_hash,revision) VALUES('legacy-memory-imports',?,?,1)").run(input.sourceKey, this.objects.putValue(marker));
      this.db.prepare('DELETE FROM memory_scopes WHERE id=?').run(staging.id);
      return { skipped: false, configImported };
    })();
  }
  /** 暂存批次只保存续传位置，撤销历史在正式发布时统一建立。 */
  importBatch(input: MemoryImportBatch): MemoryScopeState {
    return this.db.transaction(() => {
      const expectedId = createHash('sha256').update(`${input.sourceKey}:${input.fingerprint}`).digest('hex');
      if (!input.staging.actorId.startsWith('memory-import-') || input.staging.id !== expectedId) invalid('Invalid memory import staging.');
      const state = this.state(input.staging);
      if (state.revision !== input.expectedRevision) throw new PlatformStorageError('REVISION_CONFLICT', 'Memory staging changed.');
      const entries = input.entries ?? []; const summaries = input.summaries ?? [];
      if (entries.length + summaries.length > 256) invalid('Memory import batches contain at most 256 items.');
      this.db.prepare('INSERT OR IGNORE INTO memory_scopes(id,actor_id,workspace_key,entry_count,revision) VALUES(?,?,?,?,?)')
        .run(state.id, state.actorId, state.workspaceKey ?? null, state.length, state.revision);
      let length = state.length;
      for (const value of entries) {
        line(value.text);
        this.db.prepare('INSERT INTO memory_entries(scope_id,position,body_hash) VALUES(?,?,?)').run(state.id, length++, this.objects.putValue(value));
      }
      for (const value of summaries) {
        line(value.text); integer(value.lo); integer(value.hi);
        const width = value.hi - value.lo;
        if (width < 2 || !Number.isInteger(Math.log2(width)) || value.lo % width || value.hi > length) invalid('Invalid imported summary range.');
        this.db.prepare('INSERT INTO memory_summaries(scope_id,lo,hi,body_hash) VALUES(?,?,?,?) ON CONFLICT(scope_id,lo,hi) DO UPDATE SET body_hash=excluded.body_hash')
          .run(state.id, value.lo, value.hi, this.objects.putValue(value.text));
      }
      this.db.prepare('UPDATE memory_scopes SET entry_count=?,revision=? WHERE id=?').run(length, state.revision + 1, state.id);
      return { ...state, length, revision: state.revision + 1 };
    })();
  }
  write(input: MemoryWrite): MemoryWriteResult {
    return this.db.transaction(() => {
      const state = this.state(input.scope);
      if (input.expectedRevision !== state.revision) throw new PlatformStorageError('REVISION_CONFLICT', 'Memory changed. Reload before applying this operation.');
      const id = state.id; const next = state.revision + 1;
      this.db.prepare('INSERT OR IGNORE INTO memory_scopes(id,actor_id,workspace_key,entry_count,revision) VALUES(?,?,?,?,?)')
        .run(id, state.actorId, state.workspaceKey ?? null, state.length, state.revision);
      this.db.prepare('INSERT INTO memory_revisions(scope_id,revision,kind,created_at,before_length,source_hash) VALUES(?,?,?,?,?,?)')
        .run(id, next, input.mutation.type, Date.now(), state.length, this.objects.putValue(input.source ?? {}));
      let length = state.length; let changed = false; let removed = 0; let appendedAt: number | undefined;
      const dropped: Array<[number, number]> = [];
      const entry = (position: number, hash: Buffer | null) => {
        const old = this.db.prepare('SELECT body_hash FROM memory_entries WHERE scope_id=? AND position=?').get(id, position) as { body_hash: Buffer } | undefined;
        if ((!old && !hash) || old && hash && old.body_hash.equals(hash)) return;
        this.db.prepare('INSERT OR IGNORE INTO memory_revision_entries(scope_id,revision,position,body_hash) VALUES(?,?,?,?)')
          .run(id, next, position, old?.body_hash ?? null);
        if (hash) this.db.prepare('INSERT INTO memory_entries(scope_id,position,body_hash) VALUES(?,?,?) ON CONFLICT(scope_id,position) DO UPDATE SET body_hash=excluded.body_hash').run(id, position, hash);
        else this.db.prepare('DELETE FROM memory_entries WHERE scope_id=? AND position=?').run(id, position);
        changed = true;
      };
      const summary = (lo: number, hi: number, hash: Buffer | null) => {
        const old = this.db.prepare('SELECT body_hash FROM memory_summaries WHERE scope_id=? AND lo=? AND hi=?').get(id, lo, hi) as { body_hash: Buffer } | undefined;
        if ((!old && !hash) || old && hash && old.body_hash.equals(hash)) return;
        this.db.prepare('INSERT OR IGNORE INTO memory_revision_summaries(scope_id,revision,lo,hi,body_hash) VALUES(?,?,?,?,?)')
          .run(id, next, lo, hi, old?.body_hash ?? null);
        if (hash) this.db.prepare('INSERT INTO memory_summaries(scope_id,lo,hi,body_hash) VALUES(?,?,?,?) ON CONFLICT(scope_id,lo,hi) DO UPDATE SET body_hash=excluded.body_hash').run(id, lo, hi, hash);
        else { this.db.prepare('DELETE FROM memory_summaries WHERE scope_id=? AND lo=? AND hi=?').run(id, lo, hi); dropped.push([lo, hi]); }
        changed = true;
      };
      const dropWhere = (predicate: (row: SummaryRow) => boolean) => {
        for (const row of this.db.prepare('SELECT lo,hi,body_hash FROM memory_summaries WHERE scope_id=? ORDER BY hi-lo,lo').all(id) as SummaryRow[])
          if (predicate(row)) summary(row.lo, row.hi, null);
      };
      const mutation = input.mutation;
      switch (mutation.type) {
        case 'append': {
          if (!Array.isArray(mutation.entries) || mutation.entries.length > 4096) invalid('Append memory entries in batches of at most 4096.');
          appendedAt = length;
          for (const value of mutation.entries) {
            line(value.text);
            if (typeof value.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.date)) invalid('Invalid memory date.');
            entry(length++, this.objects.putValue({ date: value.date, text: value.text, ...(value.source ? { source: value.source } : {}) }));
          }
          break;
        }
        case 'update': {
          integer(mutation.id); line(mutation.text);
          if (mutation.id >= length) invalid('Memory entry does not exist.');
          const current = this.entries(state, mutation.id, 1)[0];
          entry(mutation.id, this.objects.putValue({ date: current.date, text: mutation.text, ...(current.source ? { source: current.source } : {}) }));
          dropWhere(row => row.lo <= mutation.id && row.hi > mutation.id);
          break;
        }
        case 'delete': {
          if (!Array.isArray(mutation.ids)) invalid('Memory IDs must be an array.');
          mutation.ids.forEach(integer);
          if (mutation.ids.some(position => position >= length)) invalid('Memory entry does not exist.');
          const ids = new Set(mutation.ids);
          if (!ids.size) break;
          // 位置编号保持旧语义，正文对象不随位置移动而重新编码或复制。
          let first = length; for (const position of ids) first = Math.min(first, position);
          let target = first;
          const rows = this.db.prepare('SELECT position,body_hash FROM memory_entries WHERE scope_id=? AND position>=? ORDER BY position').all(id, first) as EntryRow[];
          for (const row of rows) if (!ids.has(row.position)) entry(target++, row.body_hash);
          for (let position = target; position < length; position++) entry(position, null);
          removed = ids.size; length = target;
          const suffix = first === length;
          dropWhere(row => !suffix || row.hi > length);
          break;
        }
        case 'truncate':
          integer(mutation.keep);
          if (mutation.keep >= length) break;
          removed = length - mutation.keep;
          for (let position = mutation.keep; position < length; position++) entry(position, null);
          length = mutation.keep; dropWhere(row => row.hi > length);
          break;
        case 'summary.put': {
          integer(mutation.lo); integer(mutation.hi); line(mutation.text);
          const width = mutation.hi - mutation.lo;
          if (width < 2 || !Number.isInteger(Math.log2(width)) || mutation.lo % width || mutation.hi > length) invalid('Invalid memory summary range.');
          if (!this.summaries(state, mutation.lo, mutation.hi).length) summary(mutation.lo, mutation.hi, this.objects.putValue(mutation.text));
          break;
        }
        case 'summary.drop': {
          integer(mutation.lo); integer(mutation.hi);
          const width = mutation.hi - mutation.lo;
          if (width < 2 || !Number.isInteger(Math.log2(width)) || mutation.lo % width) invalid('Invalid memory summary range.');
          dropWhere(row => row.hi - row.lo >= width && row.lo < mutation.hi && row.hi > mutation.lo);
          break;
        }
        case 'undo': {
          if (mutation.revision !== state.revision) invalid('Only the latest memory change can be undone.');
          const revision = this.db.prepare('SELECT before_length FROM memory_revisions WHERE scope_id=? AND revision=?').get(id, mutation.revision) as { before_length: number } | undefined;
          if (!revision) invalid('Memory revision does not exist.');
          for (const row of this.db.prepare('SELECT position,body_hash FROM memory_revision_entries WHERE scope_id=? AND revision=?').all(id, mutation.revision) as Array<{ position: number; body_hash: Buffer | null }>) entry(row.position, row.body_hash);
          for (const row of this.db.prepare('SELECT lo,hi,body_hash FROM memory_revision_summaries WHERE scope_id=? AND revision=?').all(id, mutation.revision) as Array<{ lo: number; hi: number; body_hash: Buffer | null }>) summary(row.lo, row.hi, row.body_hash);
          length = revision.before_length;
          break;
        }
      }
      if (changed) this.db.prepare('UPDATE memory_scopes SET entry_count=?,revision=? WHERE id=?').run(length, next, id);
      else this.db.prepare('DELETE FROM memory_revisions WHERE scope_id=? AND revision=?').run(id, next);
      return { state: { ...state, length, revision: changed ? next : state.revision }, changed, removed, dropped, appendedAt };
    })();
  }
}
