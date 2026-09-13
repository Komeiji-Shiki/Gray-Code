import * as fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BackupMergeGroup, BackupMergeResult, BackupUnitReference } from '@graycode/contracts';
import { PlatformStorageError } from '../errors';
import { openDatabase, type SqliteConnection } from './schema';
import { ObjectStore } from './objects';
import { backupInventory, backupUnitKey, memoryTables, longMemoryTables, longMemoryRecordTables, sqlName } from './backupInventory';

type Row = Record<string, any>;

/** 仅在恢复用的数据库副本内执行；原库始终保留到最终目录切换。 */
export function mergeBackupUnits(target: SqliteConnection, objects: ObjectStore, objectPath: string, input: {
  sourceDirectory: string; groups: BackupMergeGroup[];
}): BackupMergeResult {
  const sourceDirectory = fs.realpathSync(input.sourceDirectory);
  if (sourceDirectory === path.dirname(objectPath)) throw new Error('恢复来源和目标不能是同一个目录。');
  const source = openDatabase(path.join(sourceDirectory, 'platform.sqlite'));
  try {
    const sourceObjects = new ObjectStore(source, path.join(sourceDirectory, 'objects'));
    const inventory = new Map(backupInventory(source, sourceObjects).map(unit => [unit.key, unit]));
    const current = new Map(backupInventory(target, objects).map(unit => [unit.key, unit]));
    const selected = new Set<string>();
    const groups = input.groups.map(group => {
      if (!group.units.length || !['keep', 'replace'].includes(group.conflict)) throw new Error('恢复选择无效。');
      for (const unit of group.units) {
        const key = backupUnitKey(unit);
        if (selected.has(key)) throw new Error('恢复选择包含重复对象。'); selected.add(key);
        if (!inventory.has(key) || inventory.get(key)!.fingerprint !== group.source[key]) throw new PlatformStorageError('REVISION_CONFLICT', '备份来源已变化，请重新校验并预览。');
        if (group.conflict === 'replace' && (current.get(key)?.fingerprint ?? null) !== group.expected[key])
          throw new PlatformStorageError('REVISION_CONFLICT', '所选对象在预览后发生了变化，请重新预览冲突。');
      }
      for (const unit of group.remove ?? []) {
        if (unit.kind !== 'record' || group.conflict !== 'replace') throw new Error('只能在明确替换类别时移除该类别的旧记录。');
        const key = backupUnitKey(unit);
        if ((current.get(key)?.fingerprint ?? null) !== group.expected[key]) throw new PlatformStorageError('REVISION_CONFLICT', '将被替换的类别在预览后发生了变化。');
      }
      return { group, keep: group.conflict === 'keep' && group.units.some(unit => current.has(backupUnitKey(unit))) };
    });
    const copier = new BackupUnitCopier(target, source, objectPath, path.join(sourceDirectory, 'objects'));
    return target.transaction(() => {
      const result: BackupMergeResult = { restored: [], kept: [] };
      for (const { group, keep } of groups) {
        if (!keep) for (const unit of group.remove ?? []) target.prepare('DELETE FROM records WHERE namespace=? AND id=?').run(unit.namespace!, unit.id);
        for (const unit of group.units) {
          if (keep) result.kept.push(backupUnitKey(unit));
          else { copier.copy(unit); result.restored.push(backupUnitKey(unit)); }
        }
      }
      if (target.prepare('PRAGMA foreign_key_check').all().length) throw new Error('恢复后的数据引用不完整，当前数据未替换。');
      return result;
    })();
  } finally { source.close(); }
}

class BackupUnitCopier {
  private readonly objects = new Set<string>();
  private readonly histories = new Map<string, string>();
  private readonly segments = new Map<number, number>();
  private readonly references = new Map<string, Set<string>>();
  constructor(private readonly target: SqliteConnection, private readonly source: SqliteConnection,
    private readonly targetObjects: string, private readonly sourceObjects: string) {}

  private object(hash: Buffer, depth = 0) {
    const key = hash.toString('hex');
    if (this.objects.has(key) || this.target.prepare('SELECT 1 FROM objects WHERE hash=?').get(hash)) return;
    if (depth > 128) throw new Error('备份附件引用深度无效。'); this.objects.add(key);
    const row = this.source.prepare('SELECT * FROM objects WHERE hash=?').get(hash) as Row | undefined;
    if (!row) throw new Error('备份缺少被引用的对象。');
    const edges = this.source.prepare('SELECT * FROM object_edges WHERE parent_hash=?').all(hash) as Row[];
    for (const edge of edges) this.object(edge.child_hash, depth + 1);
    this.insert('objects', row);
    for (const part of this.source.prepare('SELECT * FROM object_chunks WHERE object_hash=? ORDER BY ordinal').iterate(hash) as Iterable<Row>) {
      if (!this.target.prepare('SELECT 1 FROM chunks WHERE hash=?').get(part.chunk_hash)) {
        const chunk = this.source.prepare('SELECT * FROM chunks WHERE hash=?').get(part.chunk_hash) as Row | undefined;
        if (!chunk) throw new Error('备份缺少附件内容块。');
        if (chunk.file_id) {
          if (!/^[a-f0-9]{64}$/.test(chunk.file_id)) throw new Error('备份附件路径无效。');
          const relative = path.join(chunk.file_id.slice(0, 2), `${chunk.file_id}.bin`);
          const target = path.join(this.targetObjects, relative); fs.mkdirSync(path.dirname(target), { recursive: true });
          try { fs.linkSync(path.join(this.sourceObjects, relative), target); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') fs.copyFileSync(path.join(this.sourceObjects, relative), target, fs.constants.COPYFILE_EXCL);
          }
        }
        this.insert('chunks', chunk);
      }
      this.insert('object_chunks', part);
    }
    for (const edge of edges) this.insert('object_edges', edge);
  }
  private insert(table: string, row: Row, ignore = false) {
    let references = this.references.get(table);
    if (!references) {
      references = new Set((this.target.prepare(`PRAGMA foreign_key_list(${sqlName(table)})`).all() as Row[]).filter(key => key.table === 'objects').map(key => key.from));
      this.references.set(table, references);
    }
    for (const [key, value] of Object.entries(row)) if (references.has(key) && Buffer.isBuffer(value)) this.object(value);
    const columns = Object.keys(row);
    return this.target.prepare(`INSERT ${ignore ? 'OR IGNORE ' : ''}INTO ${sqlName(table)} (${columns.map(sqlName).join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...columns.map(key => row[key]));
  }
  private rows(table: string, column: string, id: string): Row[] {
    return this.source.prepare(`SELECT * FROM ${sqlName(table)} WHERE ${sqlName(column)}=?`).all(id) as Row[];
  }
  private record(row: Row) {
    const previous = this.target.prepare('SELECT revision FROM records WHERE namespace=? AND id=?').get(row.namespace, row.id) as Row | undefined;
    this.target.prepare('DELETE FROM records WHERE namespace=? AND id=?').run(row.namespace, row.id);
    this.insert('records', { ...row, revision: previous ? Math.max(previous.revision, row.revision) + 1 : row.revision });
  }
  private history(id: string) {
    const known = this.histories.get(id); if (known) return known;
    const row = this.source.prepare('SELECT * FROM histories WHERE id=?').get(id) as Row | undefined;
    if (!row) throw new Error('备份缺少会话历史。');
    const next = randomUUID(); this.histories.set(id, next); this.insert('histories', { ...row, id: next });
    for (const span of this.rows('history_spans', 'history_id', id)) {
      let segment = this.segments.get(span.segment_id);
      if (segment === undefined) {
        segment = Number(this.target.prepare('INSERT INTO segments DEFAULT VALUES').run().lastInsertRowid); this.segments.set(span.segment_id, segment);
        for (const entry of this.rows('segment_entries', 'segment_id', String(span.segment_id))) this.insert('segment_entries', { ...entry, segment_id: segment });
      }
      this.insert('history_spans', { ...span, history_id: next, segment_id: segment });
    }
    return next;
  }
  private conversation(id: string) {
    const row = this.source.prepare('SELECT * FROM conversations WHERE id=?').get(id) as Row;
    for (const table of ['snapshots', 'runs']) for (const item of this.rows(table, 'conversation_id', id)) {
      const conflict = this.target.prepare(`SELECT conversation_id FROM ${table} WHERE id=?`).get(item.id) as Row | undefined;
      if (conflict && conflict.conversation_id !== id) throw new Error('备份的任务或分支标识与其他会话冲突，请使用完整恢复或取消此会话的恢复。');
    }
    this.target.prepare('DELETE FROM records WHERE owner_id=?').run(id);
    this.target.prepare('DELETE FROM migrations WHERE conversation_id=?').run(id);
    this.target.prepare('DELETE FROM conversations WHERE id=?').run(id);
    this.insert('conversations', { ...row, history_id: this.history(row.history_id) });
    for (const item of this.rows('snapshots', 'conversation_id', id)) this.insert('snapshots', { ...item, history_id: this.history(item.history_id) });
    for (const item of this.rows('migrations', 'conversation_id', id)) this.insert('migrations', { ...item, history_id: item.history_id ? this.history(item.history_id) : null }, true);
    for (const run of this.rows('runs', 'conversation_id', id)) {
      this.insert('runs', run); for (const event of this.rows('run_events', 'run_id', run.id)) this.insert('run_events', event);
    }
    for (const item of this.rows('records', 'owner_id', id)) {
      const conflict = this.target.prepare('SELECT owner_id FROM records WHERE namespace=? AND id=?').get(item.namespace, item.id) as Row | undefined;
      if (conflict && conflict.owner_id !== id) throw new Error('备份中的会话记录与其他资源冲突。'); this.record(item);
    }
  }
  private memory(id: string) {
    for (const table of [...memoryTables].reverse()) this.target.prepare(`DELETE FROM ${table} WHERE scope_id=?`).run(id);
    this.target.prepare('DELETE FROM memory_scopes WHERE id=?').run(id);
    this.insert('memory_scopes', this.source.prepare('SELECT * FROM memory_scopes WHERE id=?').get(id) as Row);
    for (const table of memoryTables) for (const row of this.rows(table, 'scope_id', id)) this.insert(table, row);
  }
  private longMemory(id: string) {
    this.target.prepare('DELETE FROM long_memory_terms WHERE rowid IN (SELECT row_id FROM long_memory_records WHERE scope_id=?)').run(id);
    for (const table of longMemoryRecordTables) this.target.prepare(`DELETE FROM ${table} WHERE record_row IN (SELECT row_id FROM long_memory_records WHERE scope_id=?)`).run(id);
    for (const table of [...longMemoryTables].reverse()) this.target.prepare(`DELETE FROM ${table} WHERE scope_id=?`).run(id);
    this.target.prepare('DELETE FROM long_memory_scopes WHERE id=?').run(id);
    this.insert('long_memory_scopes', this.source.prepare('SELECT * FROM long_memory_scopes WHERE id=?').get(id) as Row);
    for (const row of this.rows('long_memory_sources', 'scope_id', id)) this.insert('long_memory_sources', row);
    for (const row of this.rows('long_memory_records', 'scope_id', id)) {
      const { row_id: previous, ...value } = row;
      const next = Number(this.insert('long_memory_records', value).lastInsertRowid);
      for (const table of longMemoryRecordTables) for (const item of this.rows(table, 'record_row', String(previous))) this.insert(table, { ...item, record_row: next });
      const terms = this.source.prepare('SELECT tokens FROM long_memory_terms WHERE rowid=?').get(previous) as Row | undefined;
      if (terms) this.target.prepare('INSERT INTO long_memory_terms(rowid,tokens) VALUES(?,?)').run(next, terms.tokens);
    }
    for (const table of ['long_memory_tombstones', 'long_memory_jobs', 'long_memory_job_dependencies'])
      for (const row of this.rows(table, 'scope_id', id)) this.insert(table, row);
  }
  copy(unit: BackupUnitReference) {
    if (unit.kind === 'conversation') return this.conversation(unit.id);
    if (unit.kind === 'memory') return this.memory(unit.id);
    if (unit.kind === 'long-memory') return this.longMemory(unit.id);
    const row = this.source.prepare('SELECT * FROM records WHERE namespace=? AND id=?').get(unit.namespace!, unit.id) as Row;
    this.record(row);
  }
}
