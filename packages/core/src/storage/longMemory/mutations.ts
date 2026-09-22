import type {
  LongMemoryScope, LongMemoryScopeState, LongMemorySource, LongMemoryRecord, LongMemoryReference,
  LongMemorySourceInput, LongMemoryRecordInput, LongMemoryWrite, LongMemoryWriteResult, LongMemoryVector, LongMemoryJob,
} from '@graycode/contracts';
import { assertIdentifier, invalid, PlatformStorageError } from '../../errors';
import type { SqliteConnection } from '../schema';
import { memoryDigest, memoryTerms, memoryTopicKey } from './text';

interface ScopeRow { id: string; actor_id: string; kind: LongMemoryScope['kind']; scope_key: string | null; realm: string; revision: number; invalidation: number; has_records:number }
export interface RecordRow { row_id: number; scope_id: string; id: string; version: number; recorded_at: number; digest: string; payload: string }
interface SourceRow { scope_id: string; id: string; version: number; recorded_at: number; digest: string; payload: string }
const kinds = new Set(['fact', 'preference', 'experience', 'project', 'procedure', 'event', 'summary']);
const origins = new Set(['user', 'model', 'tool', 'fiction', 'import']);
const confidence = new Set(['confirmed', 'inferred', 'disputed']);

function timestamp(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 8.64e15) invalid(`${label} 时间无效。`);
}
function content(value: unknown, label: string, max = 32000): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) invalid(`${label} 不能为空或超过 ${max} 字符。`);
}
export function validateMemoryVector(vector: LongMemoryVector): void {
  assertIdentifier(vector.model, 'embedding model');
  if (!Number.isInteger(vector.dimensions) || vector.dimensions < 1 || vector.dimensions > 16384
    || !Array.isArray(vector.values) || vector.values.length !== vector.dimensions || vector.values.some(value => !Number.isFinite(value))) invalid('嵌入模型维度与向量不匹配。');
}
export function validateMemoryTopic(topic: string[]): void {
  if (!Array.isArray(topic) || topic.length > 8) invalid('记忆主题最多包含八层。');
  for (const part of topic) content(part, '主题名称', 120);
}

/** 修订、依赖和索引在一个事务内提交，生成模型不在存储线程中运行。 */
export class MemoryMutationStore {
  constructor(readonly db: SqliteConnection) {}

  state(scope: LongMemoryScope, create = false): LongMemoryScopeState {
    assertIdentifier(scope.id); assertIdentifier(scope.actorId); assertIdentifier(scope.realm);
    if (!['personal', 'workspace', 'group', 'library'].includes(scope.kind)) invalid('记忆范围类型无效。');
    if (scope.kind === 'personal' ? scope.key !== undefined : !scope.key) invalid('记忆范围标识无效。');
    if (scope.key !== undefined) assertIdentifier(scope.key);
    const row = this.db.prepare('SELECT *,EXISTS(SELECT 1 FROM long_memory_records WHERE scope_id=long_memory_scopes.id) AS has_records FROM long_memory_scopes WHERE id=?').get(scope.id) as ScopeRow | undefined;
    if (row) {
      if (row.actor_id !== scope.actorId || row.kind !== scope.kind || row.scope_key !== (scope.key ?? null) || row.realm !== scope.realm)
        invalid('记忆范围的账号、工作区或剧情域不匹配。');
      return { ...scope, revision: row.revision, invalidation: row.invalidation,hasRecords:!!row.has_records };
    }
    if (create) this.db.prepare('INSERT INTO long_memory_scopes(id,actor_id,kind,scope_key,realm) VALUES(?,?,?,?,?)')
      .run(scope.id, scope.actorId, scope.kind, scope.key ?? null, scope.realm);
    return { ...scope, revision: 0, invalidation: 0,hasRecords:false };
  }

  scopes(actorId: string): LongMemoryScopeState[] {
    assertIdentifier(actorId);
    return (this.db.prepare('SELECT *,EXISTS(SELECT 1 FROM long_memory_records WHERE scope_id=long_memory_scopes.id) AS has_records FROM long_memory_scopes WHERE actor_id=? ORDER BY kind,scope_key,realm,id').all(actorId) as ScopeRow[])
      .map(row => ({ id: row.id, actorId: row.actor_id, kind: row.kind, ...(row.scope_key ? { key: row.scope_key } : {}),
        realm: row.realm, revision: row.revision, invalidation: row.invalidation,hasRecords:!!row.has_records }));
  }

  source(scopeId: string, id: string, version?: number): SourceRow | undefined {
    return (version === undefined
      ? this.db.prepare('SELECT * FROM long_memory_sources WHERE scope_id=? AND id=? ORDER BY version DESC LIMIT 1').get(scopeId, id)
      : this.db.prepare('SELECT * FROM long_memory_sources WHERE scope_id=? AND id=? AND version=?').get(scopeId, id, version)) as SourceRow | undefined;
  }
  record(scopeId: string, id: string, version?: number): RecordRow | undefined {
    return (version === undefined
      ? this.db.prepare('SELECT * FROM long_memory_records WHERE scope_id=? AND id=? ORDER BY version DESC LIMIT 1').get(scopeId, id)
      : this.db.prepare('SELECT * FROM long_memory_records WHERE scope_id=? AND id=? AND version=?').get(scopeId, id, version)) as RecordRow | undefined;
  }
  tombstoned(scopeId: string, kind: LongMemoryReference['kind'], id: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM long_memory_tombstones WHERE scope_id=? AND kind=? AND id=?').get(scopeId, kind, id);
  }
  referenceAvailable(scopeId: string, ref: LongMemoryReference, current = true): boolean {
    const record = ref.kind === 'source' ? this.source(scopeId, ref.id, current ? undefined : ref.version) : this.record(scopeId, ref.id, current ? undefined : ref.version);
    return !!record && record.version === ref.version && !this.tombstoned(scopeId, ref.kind, ref.id);
  }
  private assertDependencies(scopeId: string, id: string, refs: LongMemoryReference[], historical: boolean): void {
    if (!Array.isArray(refs) || refs.length < 1 || refs.length > 256) invalid('记忆必须引用 1 至 256 个确切来源修订。');
    const unique = new Set<string>();
    for (const ref of refs) {
      assertIdentifier(ref.id);
      if (!['source', 'record'].includes(ref.kind) || !Number.isSafeInteger(ref.version) || ref.version < 1) invalid('来源修订无效。');
      const key = JSON.stringify(ref); if (unique.has(key)) invalid('记忆来源重复。'); unique.add(key);
      if (!this.referenceAvailable(scopeId, ref, !historical)) throw new PlatformStorageError('SOURCE_CHANGED', '来源已经修订或删除，请重新读取后再保存。');
      if (ref.kind === 'record') {
        if (ref.id === id) invalid('记忆不能依赖自身。');
        const circular = this.db.prepare(`WITH RECURSIVE parents(id) AS (
          SELECT ? UNION SELECT d.parent_id FROM long_memory_dependencies d
          JOIN long_memory_records r ON r.row_id=d.record_row JOIN parents p ON r.id=p.id
          WHERE r.scope_id=? AND d.parent_kind='record') SELECT 1 FROM parents WHERE id=? LIMIT 1`).get(ref.id, scopeId, id);
        if (circular) invalid('分层摘要不能形成循环依赖。');
      }
    }
  }
  private putSource(scope: LongMemoryScope, input: LongMemorySourceInput): { value: LongMemorySource; changed: boolean; invalidated: boolean } {
    assertIdentifier(input.id); content(input.text, '记忆来源'); timestamp(input.recordedAt, '记录');
    if (input.eventAt !== undefined) timestamp(input.eventAt, '事件');
    if (!origins.has(input.origin) || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) invalid('记忆来源类型或修订无效。');
    if (input.origin === 'fiction' && scope.realm === 'real') invalid('角色剧情来源必须使用独立剧情域。');
    if (this.tombstoned(scope.id, 'source', input.id)) throw new PlatformStorageError('SOURCE_CHANGED', '这个来源已被删除，不能通过重试或恢复重新写入。');
    if (input.reference) for (const value of Object.values(input.reference)) if (value !== undefined) assertIdentifier(value, 'source reference');
    if(input.upstream){assertIdentifier(input.upstream.id);if(!Number.isSafeInteger(input.upstream.version)||input.upstream.version<1)invalid('上游来源修订无效。');}
    const value: LongMemorySource = { id: input.id, scopeId: scope.id, version: input.expectedVersion + 1, origin: input.origin,
      text: input.text, recordedAt: input.recordedAt, ...(input.eventAt !== undefined ? { eventAt: input.eventAt } : {}),
      ...(input.reference ? { reference: input.reference } : {}),...(input.upstream?{upstream:input.upstream}:{}) };
    const digest = memoryDigest(value), previous = this.source(scope.id, input.id);
    if (previous?.version === value.version && previous.digest === digest) return { value, changed: false, invalidated: false };
    if ((previous?.version ?? 0) !== input.expectedVersion) throw new PlatformStorageError('REVISION_CONFLICT', '记忆来源已改变，请刷新后重试。');
    if (previous && input.recordedAt < previous.recorded_at) invalid('新修订的记录时间不能早于已有版本。');
    this.db.prepare('INSERT INTO long_memory_sources VALUES(?,?,?,?,?,?)').run(scope.id, value.id, value.version, value.recordedAt, digest, JSON.stringify(value));
    return { value, changed: true, invalidated: !!previous };
  }
  private putRecord(scope: LongMemoryScope, input: LongMemoryRecordInput, historical: boolean): { value: LongMemoryRecord; changed: boolean; invalidated: boolean } {
    assertIdentifier(input.id); content(input.text, '记忆正文'); content(input.subject, '记忆主体', 512);
    timestamp(input.recordedAt, '记录'); timestamp(input.validFrom, '有效起始');
    if (input.validTo !== undefined) { timestamp(input.validTo, '有效截止'); if (input.validTo <= input.validFrom) invalid('有效截止必须晚于起始时间。'); }
    if (input.eventAt !== undefined) timestamp(input.eventAt, '事件');
    if (!kinds.has(input.kind) || !origins.has(input.origin) || !confidence.has(input.confidence)) invalid('记忆类别、来源或确认状态无效。');
    if (input.origin === 'model' && input.confidence === 'confirmed') invalid('模型推断不能自动标记为用户已确认。');
    if (input.origin === 'fiction' && scope.realm === 'real') invalid('角色剧情必须使用独立剧情域。');
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) invalid('记忆修订无效。');
    validateMemoryTopic(input.topic);
    if (!Array.isArray(input.entities) || input.entities.length > 64) invalid('记忆实体数量无效。');
    for (const entity of input.entities) content(entity, '记忆实体', 256);
    if (input.attribute !== undefined) content(input.attribute, '记忆属性', 256);
    if (input.value !== undefined) content(input.value, '属性值', 4000);
    if (this.tombstoned(scope.id, 'record', input.id)) throw new PlatformStorageError('SOURCE_CHANGED', '这条记忆已被删除，不能重新写入。');
    if (!Array.isArray(input.supersedes) || input.supersedes.length > 128) invalid('替代关系数量无效。');
    for (const id of input.supersedes) {
      assertIdentifier(id);
      if (id === input.id || !this.record(scope.id, id)) invalid('被替代记忆必须存在于同一范围。');
    }
    const value: LongMemoryRecord = { id: input.id, version: input.expectedVersion + 1, scopeId: scope.id,
      kind: input.kind, origin: input.origin, confidence: input.confidence, subject: input.subject,
      ...(input.attribute !== undefined ? { attribute: input.attribute } : {}), ...(input.value !== undefined ? { value: input.value } : {}),
      text: input.text, topic: input.topic, entities: input.entities, recordedAt: input.recordedAt,
      validFrom: input.validFrom, ...(input.validTo !== undefined ? { validTo: input.validTo } : {}), ...(input.eventAt !== undefined ? { eventAt: input.eventAt } : {}),
      dependencies: input.dependencies, supersedes: input.supersedes };
    const digest = memoryDigest(value), previous = this.record(scope.id, input.id);
    if (previous?.version === value.version && previous.digest === digest) return { value, changed: false, invalidated: false };
    if ((previous?.version ?? 0) !== input.expectedVersion) throw new PlatformStorageError('REVISION_CONFLICT', '记忆已改变，请刷新后重试。');
    if (previous && input.recordedAt < previous.recorded_at) invalid('新修订的记录时间不能早于已有版本。');
    this.assertDependencies(scope.id, input.id, input.dependencies, historical);
    const insert = this.db.prepare(`INSERT INTO long_memory_records(scope_id,id,version,recorded_at,valid_from,valid_to,kind,confidence,subject,attribute,value,topic,digest,payload)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(scope.id, value.id, value.version, value.recordedAt, value.validFrom, value.validTo ?? null,
      value.kind, value.confidence, value.subject, value.attribute ?? null, value.value ?? null, memoryTopicKey(value.topic), digest, JSON.stringify(value));
    const rowId = Number(insert.lastInsertRowid);
    this.db.prepare('INSERT INTO long_memory_terms(rowid,tokens) VALUES(?,?)').run(rowId, memoryTerms([value.text, ...value.topic, ...value.entities].join(' ')).join(' '));
    for (const ref of value.dependencies) this.db.prepare('INSERT INTO long_memory_dependencies VALUES(?,?,?,?,?)').run(rowId, scope.id, ref.kind, ref.id, ref.version);
    for (const id of value.supersedes) this.db.prepare('INSERT INTO long_memory_supersedes VALUES(?,?,?)').run(rowId, scope.id, id);
    if (input.vector) this.putVector(scope, value.id, value.version, input.vector);
    const conflict = value.attribute && this.db.prepare(`SELECT 1 FROM long_memory_records WHERE scope_id=? AND id<>? AND subject=? AND attribute=? AND value IS NOT ? LIMIT 1`)
      .get(scope.id,value.id,value.subject,value.attribute,value.value??null);
    return { value, changed: true, invalidated: !!previous || value.supersedes.length > 0 || !!conflict };
  }

  putVector(scope: LongMemoryScope, id: string, version: number, vector: LongMemoryVector): boolean {
    this.state(scope); validateMemoryVector(vector);
    const row = this.record(scope.id, id,version);
    if (!row || this.tombstoned(scope.id, 'record', id)) return false;
    const values = new Float32Array(vector.values);
    this.db.prepare('INSERT OR REPLACE INTO long_memory_vectors VALUES(?,?,?,?)').run(row.row_id, vector.model, vector.dimensions, Buffer.from(values.buffer));
    return true;
  }

  impact(scope: LongMemoryScope, kind: LongMemoryReference['kind'], id: string, action: 'delete' | 'retract'): Array<{kind:LongMemoryReference['kind'];id:string}> {
    this.state(scope);assertIdentifier(id);
    // 删除事实同时删除其来源摘录，避免后台从同一摘录再次提取；摘要删除不向上删除事实。
    // 彻底忘记会包含被替代的旧事实，撤回错误修订则允许先前事实重新生效。
    return this.db.prepare(`WITH RECURSIVE edges(parent_kind,parent_id,child_kind,child_id) AS (
      SELECT d.parent_kind,d.parent_id,'record',r.id FROM long_memory_dependencies d JOIN long_memory_records r ON r.row_id=d.record_row WHERE r.scope_id=?
      UNION SELECT 'record',r.id,'source',d.parent_id FROM long_memory_dependencies d JOIN long_memory_records r ON r.row_id=d.record_row
        WHERE r.scope_id=? AND r.kind<>'summary' AND d.parent_kind='source'
      UNION SELECT 'record',r.id,'record',s.original_id FROM long_memory_supersedes s JOIN long_memory_records r ON r.row_id=s.record_row
        WHERE r.scope_id=? AND ?='delete'
      UNION SELECT 'source',s.id,'source',json_extract(s.payload,'$.upstream.id') FROM long_memory_sources s
        WHERE s.scope_id=? AND json_extract(s.payload,'$.upstream.id') IS NOT NULL
    ), affected(kind,id) AS(SELECT ?,? UNION SELECT e.child_kind,e.child_id FROM edges e JOIN affected a ON e.parent_kind=a.kind AND e.parent_id=a.id)
      SELECT DISTINCT kind,id FROM affected`).all(scope.id,scope.id,scope.id,action,scope.id,kind,id) as Array<{kind:LongMemoryReference['kind'];id:string}>;
  }

  purge(scope: LongMemoryScope, kind: LongMemoryReference['kind'], id: string, action: 'delete' | 'retract', at = Date.now()): number {
    const affected=this.impact(scope,kind,id,action);
    const references=new Map<string,LongMemorySource['reference']>();
    for(const item of affected)if(item.kind==='source'){
      const source=JSON.parse(this.source(scope.id,item.id)?.payload??'null') as LongMemorySource|null;
      if(source?.reference){references.set(source.id,source.reference);if(source.upstream)references.set(source.upstream.id,source.reference);}
    }
    let removed = 0;
    for (const target of affected) {
      const reference=target.kind==='source'?references.get(target.id):undefined;
      this.db.prepare('INSERT OR IGNORE INTO long_memory_tombstones VALUES(?,?,?,?,?,?)').run(scope.id, target.kind, target.id, action, at,reference?JSON.stringify(reference):null);
      const jobs = this.db.prepare(`SELECT j.payload FROM long_memory_jobs j JOIN long_memory_job_dependencies d
        ON j.scope_id=d.scope_id AND j.id=d.job_id WHERE d.scope_id=? AND d.parent_kind=? AND d.parent_id=?`).all(scope.id, target.kind, target.id) as Array<{ payload: string }>;
      for (const row of jobs) {
        const job = JSON.parse(row.payload) as LongMemoryJob;
        job.status = 'cancelled'; job.updatedAt = at; delete job.error;
        this.db.prepare('UPDATE long_memory_jobs SET status=?,payload=? WHERE scope_id=? AND id=?').run(job.status, JSON.stringify(job), scope.id, job.id);
      }
      if (target.kind === 'source') removed += this.db.prepare('DELETE FROM long_memory_sources WHERE scope_id=? AND id=?').run(scope.id, target.id).changes > 0 ? 1 : 0;
      else {
        this.db.prepare('DELETE FROM long_memory_terms WHERE rowid IN(SELECT row_id FROM long_memory_records WHERE scope_id=? AND id=?)').run(scope.id, target.id);
        removed += this.db.prepare('DELETE FROM long_memory_records WHERE scope_id=? AND id=?').run(scope.id, target.id).changes > 0 ? 1 : 0;
      }
    }
    return removed;
  }

  write(input: LongMemoryWrite, historical = false): LongMemoryWriteResult {
    return this.db.transaction(() => {
      const state = this.state(input.scope, true);
      if ((input.sources?.length ?? 0) + (input.records?.length ?? 0) + (input.remove?.length ?? 0) > 1000) invalid('单次记忆提交过大，请分批提交。');
      let changed = false, invalidated = false, removed = 0;
      const sources: LongMemorySource[] = [], records: LongMemoryRecord[] = [];
      for (const item of input.remove ?? []) {
        assertIdentifier(item.id);
        if (!['source', 'record'].includes(item.kind) || !['delete', 'retract'].includes(item.action)) invalid('删除对象或操作无效。');
        const previous = item.kind === 'source' ? this.source(input.scope.id, item.id) : this.record(input.scope.id, item.id);
        if (item.expectedVersion !== undefined && previous?.version !== item.expectedVersion) throw new PlatformStorageError('REVISION_CONFLICT', '要删除的记忆已改变。');
        if (this.tombstoned(input.scope.id, item.kind, item.id)) continue;
        removed += this.purge(input.scope, item.kind, item.id, item.action); changed = true; invalidated = true;
      }
      for (const item of input.sources ?? []) {
        const result = this.putSource(input.scope, item); sources.push(result.value);
        changed ||= result.changed; invalidated ||= result.invalidated;
      }
      for (const item of input.records ?? []) {
        const result = this.putRecord(input.scope, item, historical); records.push(result.value);
        changed ||= result.changed; invalidated ||= result.invalidated;
      }
      if (changed) this.db.prepare('UPDATE long_memory_scopes SET revision=revision+1,invalidation=invalidation+? WHERE id=?').run(invalidated ? 1 : 0, input.scope.id);
      return { state: changed ? this.state(input.scope) : state, sources, records, removed };
    })();
  }
}
