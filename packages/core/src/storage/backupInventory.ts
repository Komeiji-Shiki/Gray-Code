import { createHash } from 'node:crypto';
import type { BackupUnit, BackupUnitReference } from '@graycode/contracts';
import type { SqliteConnection } from './schema';
import type { ObjectStore } from './objects';

export const memoryTables = ['memory_entries', 'memory_summaries', 'memory_revisions', 'memory_revision_entries', 'memory_revision_summaries'];
export const longMemoryTables = ['long_memory_sources', 'long_memory_records', 'long_memory_tombstones', 'long_memory_jobs', 'long_memory_job_dependencies'];
export const longMemoryRecordTables = ['long_memory_dependencies', 'long_memory_supersedes', 'long_memory_vectors'];
export const backupUnitKey = (unit: BackupUnitReference) => JSON.stringify([unit.kind, unit.namespace ?? '', unit.id]);
export const sqlName = (value: string) => `"${value.replaceAll('"', '""')}"`;

/** 只返回内容指纹和归属，备份预览不把附件或密钥载入界面。 */
export function backupInventory(db: SqliteConnection, objects: ObjectStore): BackupUnit[] {
  const result: BackupUnit[] = [];
  const digest = (queries: Array<[string, string[]]>) => {
    const hash = createHash('sha256');
    for (const [sql, args] of queries) for (const row of db.prepare(sql).iterate(...args)) hash.update(JSON.stringify(row)).update('\n');
    return hash.digest('hex');
  };
  for (const row of db.prepare('SELECT id,title,metadata_hash FROM conversations ORDER BY id').iterate() as Iterable<{ id: string; title: string; metadata_hash: Buffer }>) {
    const histories = `SELECT history_id FROM conversations WHERE id=? UNION SELECT history_id FROM snapshots WHERE conversation_id=? UNION SELECT history_id FROM migrations WHERE conversation_id=? AND history_id IS NOT NULL`;
    const historyArgs = [row.id, row.id, row.id];
    const unit: BackupUnitReference = { kind: 'conversation', id: row.id };
    const fingerprint = digest([
      ['SELECT * FROM conversations WHERE id=?', [row.id]], ['SELECT * FROM snapshots WHERE conversation_id=? ORDER BY id', [row.id]],
      ['SELECT * FROM records WHERE owner_id=? ORDER BY namespace,id', [row.id]], ['SELECT * FROM migrations WHERE conversation_id=? ORDER BY source_key', [row.id]],
      ['SELECT * FROM runs WHERE conversation_id=? ORDER BY id', [row.id]], ['SELECT * FROM run_events WHERE run_id IN (SELECT id FROM runs WHERE conversation_id=?) ORDER BY run_id,sequence', [row.id]],
      [`SELECT * FROM histories WHERE id IN (${histories}) ORDER BY id`, historyArgs],
      [`SELECT * FROM history_spans WHERE history_id IN (${histories}) ORDER BY history_id,start_index`, historyArgs],
      [`SELECT * FROM segment_entries WHERE segment_id IN (SELECT segment_id FROM history_spans WHERE history_id IN (${histories})) ORDER BY segment_id,ordinal`, historyArgs],
    ]);
    const records = (db.prepare('SELECT count(*) n FROM records WHERE owner_id=?').get(row.id) as { n: number }).n;
    const metadata = objects.getValue<{ actorId?: string; workspaceId?: string }>(row.metadata_hash);
    result.push({ ...unit, key: backupUnitKey(unit), label: row.title || row.id, fingerprint, records, actorId: metadata.actorId, workspaceId: metadata.workspaceId });
  }
  for (const row of db.prepare('SELECT namespace,id,owner_id,value_hash,revision FROM records WHERE owner_id IS NULL OR owner_id NOT IN (SELECT id FROM conversations) ORDER BY namespace,id').iterate() as Iterable<{ namespace: string; id: string; value_hash: Buffer }>) {
    const unit: BackupUnitReference = { kind: 'record', namespace: row.namespace, id: row.id };
    result.push({ ...unit, key: backupUnitKey(unit), label: row.id, fingerprint: createHash('sha256').update(JSON.stringify(row)).digest('hex') });
  }
  for (const kind of ['memory', 'long-memory'] as const) {
    const scopeTable = kind === 'memory' ? 'memory_scopes' : 'long_memory_scopes';
    for (const scope of db.prepare(`SELECT * FROM ${scopeTable} ORDER BY id`).iterate() as Iterable<{ id: string; actor_id: string; workspace_key?: string; kind?: string; scope_key?: string; realm?: string }>) {
      const unit: BackupUnitReference = { kind, id: scope.id };
      const tables = kind === 'memory' ? memoryTables : longMemoryTables;
      const queries: Array<[string, string[]]> = [[`SELECT * FROM ${scopeTable} WHERE id=?`, [scope.id]]];
      for (const table of tables) {
        const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; pk: number }>;
        const order = columns.filter(column => column.pk).sort((a, b) => a.pk - b.pk).map(column => sqlName(column.name)).join(',');
        queries.push([`SELECT * FROM ${table} WHERE scope_id=? ORDER BY ${order}`, [scope.id]]);
      }
      if (kind === 'long-memory') for (const table of longMemoryRecordTables)
        queries.push([`SELECT * FROM ${table} WHERE record_row IN (SELECT row_id FROM long_memory_records WHERE scope_id=?) ORDER BY record_row`, [scope.id]]);
      result.push({ ...unit, key: backupUnitKey(unit), label: scope.id, actorId: scope.actor_id, workspaceId: scope.workspace_key,
        scopeKind: scope.kind, scopeKey: scope.scope_key ?? scope.workspace_key, realm: scope.realm, fingerprint: digest(queries) });
    }
  }
  return result;
}
