import type {
  LongMemoryArchive, LongMemoryScope, LongMemoryRecord, LongMemorySource, LongMemoryTombstone, LongMemoryReference,
} from '@graycode/contracts';
import { invalid } from '../../errors';
import { MemoryMutationStore } from './mutations';
import { memoryContentEqual } from './text';

/** 交换归档保存正文与依赖，不携带供应方凭据、运行句柄或可重建向量。 */
export class MemoryArchive {
  constructor(private readonly store: MemoryMutationStore) {}
  private unavailableRecords(records: LongMemoryRecord[], scopeFor: (id: string) => LongMemoryScope): Set<LongMemoryRecord> {
    const checked = new Set<string>();
    const unavailable = new Set<string>();
    const pending: string[] = [];
    const dependents = new Map<string, Set<string>>();
    const identities = new Map<LongMemoryRecord, string>();
    const identity = (scopeId: string, kind: LongMemoryReference['kind'], id: string): string => {
      const key = JSON.stringify([scopeId, kind, id]);
      if (!checked.has(key)) {
        checked.add(key);
        if (this.store.tombstoned(scopeId, kind, id)) { unavailable.add(key); pending.push(key); }
      }
      return key;
    };
    for (const record of records) {
      const scope = scopeFor(record.scopeId);
      const key = identity(scope.id, 'record', record.id);
      identities.set(record, key);
      for (const ref of record.dependencies) {
        const parent = identity(scope.id, ref.kind, ref.id);
        let children = dependents.get(parent);
        if (!children) { children = new Set(); dependents.set(parent, children); }
        children.add(key);
      }
    }
    // 删除按身份影响全部修订；先传播再写入，不能先恢复旧版再跳过无效的新版本。
    // 替代关系不属于来源依赖，删除旧事实不能反向删除来源独立的新事实。
    for (let index = 0; index < pending.length; index++) {
      for (const child of dependents.get(pending[index]) ?? []) {
        if (unavailable.has(child)) continue;
        unavailable.add(child);
        pending.push(child);
      }
    }
    const result = new Set<LongMemoryRecord>();
    for (const [record, key] of identities) if (unavailable.has(key)) result.add(record);
    return result;
  }
  private restoreRecords(records: LongMemoryRecord[], scopeFor: (id: string) => LongMemoryScope): { records: number; skipped: number } {
    const candidates = records.map((record, index) => ({ record, scope: scopeFor(record.scopeId), index, round: 0, remaining: 0, scheduled: false }));
    type Candidate = (typeof candidates)[number];
    const ready: Candidate[] = [];
    const waiting = new Map<string, Candidate[]>();
    const revisions = new Map<string, Candidate[]>();
    const available = new Map<string, boolean>();
    const currentVersions = new Map<string, number>();
    const revisionKey = (scopeId: string, kind: LongMemoryReference['kind'], id: string, version: number): string =>
      JSON.stringify([scopeId, kind, id, version]);
    const earlier = (a: Candidate, b: Candidate): boolean => a.round < b.round || a.round === b.round && a.index < b.index;
    // 保留旧算法逐轮从前向后的写入次序，避免失效计数随队列实现发生变化。
    const enqueue = (candidate: Candidate): void => {
      candidate.scheduled = true;
      let index = ready.length;
      ready.push(candidate);
      while (index > 0) {
        const parent = (index - 1) >>> 1;
        if (!earlier(candidate, ready[parent])) break;
        ready[index] = ready[parent];
        index = parent;
      }
      ready[index] = candidate;
    };
    const take = (): Candidate => {
      const first = ready[0], last = ready.pop()!;
      if (ready.length) {
        let index = 0;
        while (index * 2 + 1 < ready.length) {
          let child = index * 2 + 1;
          if (child + 1 < ready.length && earlier(ready[child + 1], ready[child])) child++;
          if (!earlier(ready[child], last)) break;
          ready[index] = ready[child];
          index = child;
        }
        ready[index] = last;
      }
      return first;
    };
    for (const candidate of candidates) {
      const { record, scope } = candidate;
      const key = revisionKey(scope.id, 'record', record.id, record.version);
      let duplicates = revisions.get(key);
      if (!duplicates) { duplicates = []; revisions.set(key, duplicates); }
      duplicates.push(candidate);
      const missing = new Set<string>();
      if (!this.store.record(scope.id, record.id, record.version)) {
        for (const ref of record.dependencies) {
          const key = revisionKey(scope.id, ref.kind, ref.id, ref.version);
          if (!available.has(key)) available.set(key, this.store.referenceAvailable(scope.id, ref, false));
          if (!available.get(key)) missing.add(key);
        }
        const identity = JSON.stringify([scope.id, record.id]);
        if (!currentVersions.has(identity)) currentVersions.set(identity, this.store.record(scope.id, record.id)?.version ?? 0);
        if (currentVersions.get(identity) !== record.version - 1) {
          missing.add(revisionKey(scope.id, 'record', record.id, record.version - 1));
        }
      }
      candidate.remaining = missing.size;
      if (!missing.size) enqueue(candidate);
      for (const key of missing) {
        let dependents = waiting.get(key);
        if (!dependents) { dependents = []; waiting.set(key, dependents); }
        dependents.push(candidate);
      }
    }
    const result = { records: 0, skipped: 0 };
    while (ready.length) {
      const candidate = take(), { record, scope } = candidate;
      const existing = this.store.record(scope.id, record.id, record.version);
      if (existing) {
        if (!memoryContentEqual(existing.payload, record)) invalid('归档记忆与现有相同修订内容冲突。');
        result.skipped++;
      } else {
        this.store.write({ scope, records: [{ ...record, expectedVersion: record.version - 1 }] }, true);
        result.records++;
      }
      const key = revisionKey(scope.id, 'record', record.id, record.version);
      // 精确修订已经存在时优先比较内容，不能让冲突重复项继续等待它自己的无效依赖。
      for (const duplicate of revisions.get(key) ?? []) {
        if (duplicate.scheduled) continue;
        duplicate.round = candidate.round + (duplicate.index < candidate.index ? 1 : 0);
        enqueue(duplicate);
      }
      revisions.delete(key);
      for (const dependent of waiting.get(key) ?? []) {
        if (dependent.scheduled) continue;
        dependent.round = Math.max(dependent.round, candidate.round + (dependent.index < candidate.index ? 1 : 0));
        if (--dependent.remaining === 0) enqueue(dependent);
      }
      // 同修订的重复项只解除一次依赖，仍各自验证内容并计入幂等跳过数。
      waiting.delete(key);
    }
    if (result.records + result.skipped !== candidates.length) invalid('归档存在缺失来源、修订或循环依赖，未执行部分恢复。');
    return result;
  }
  export(scopes: LongMemoryScope[]): LongMemoryArchive {
    if(!scopes.length||scopes.some(scope=>scope.actorId!==scopes[0].actorId))invalid('只能导出同一账号的记忆。');
    const states=scopes.map(scope=>this.store.state(scope));
    const placeholders=scopes.map(()=>'?').join(','),ids=scopes.map(scope=>scope.id);
    // 恢复依赖连续修订；未被直接引用的后续版本也决定旧记忆是否仍然有效。
    const sources=(this.store.db.prepare(`SELECT s.payload FROM long_memory_sources s WHERE s.scope_id IN(${placeholders}) AND EXISTS(
      SELECT 1 FROM long_memory_dependencies d WHERE d.scope_id=s.scope_id AND d.parent_kind='source' AND d.parent_id=s.id)
      ORDER BY s.scope_id,s.id,s.version`).all(...ids) as Array<{payload:string}>).map(row=>JSON.parse(row.payload) as LongMemorySource);
    const records=(this.store.db.prepare(`SELECT payload FROM long_memory_records WHERE scope_id IN(${placeholders}) ORDER BY recorded_at,version,id`).all(...ids) as Array<{payload:string}>).map(row=>JSON.parse(row.payload) as LongMemoryRecord);
    const tombstones=(this.store.db.prepare(`SELECT scope_id AS scopeId,kind,id,action,created_at AS at,reference FROM long_memory_tombstones WHERE scope_id IN(${placeholders}) ORDER BY scope_id,kind,id`).all(...ids) as Array<Omit<LongMemoryTombstone,'reference'>&{reference:string|null}>)
      .map(({reference,...row})=>({...row,...reference?{reference:JSON.parse(reference)}:{}}));
    return {format:'graycode-long-memory',version:1,createdAt:Date.now(),scopes:states,sources,records,tombstones};
  }
  restore(actorId: string, archive: LongMemoryArchive): { sources: number; records: number; skipped: number; tombstones: number } {
    if(archive.format!=='graycode-long-memory'||archive.version!==1||!Array.isArray(archive.scopes)||!Array.isArray(archive.sources)||!Array.isArray(archive.records)||!Array.isArray(archive.tombstones))invalid('记忆归档格式无效。');
    if(archive.scopes.some(scope=>scope.actorId!==actorId)||archive.scopes.length>256||archive.records.length>100000||archive.sources.length>100000)invalid('归档账号不匹配或超过单次恢复上限。');
    return this.store.db.transaction(()=>{
      const scopes=new Map(archive.scopes.map(scope=>[scope.id,scope]));
      if(scopes.size!==archive.scopes.length)invalid('归档记忆范围重复。');
      const scopeFor=(id:string)=>{const scope=scopes.get(id);if(!scope)invalid('归档记录引用了未声明的范围。');return scope;};
      for(const scope of scopes.values())this.store.state(scope,true);
      const result={sources:0,records:0,skipped:0,tombstones:0};
      // 删除先于正文合并；来自旧备份的删除状态也会使现有派生记录失效。
      for(const tomb of archive.tombstones){
        const scope=scopeFor(tomb.scopeId);
        if(!['source','record'].includes(tomb.kind)||!['delete','retract'].includes(tomb.action)||!Number.isFinite(tomb.at))invalid('归档删除标记无效。');
        const written=this.store.write({scope,remove:[{kind:tomb.kind,id:tomb.id,action:tomb.action}]});
        this.store.db.prepare('UPDATE long_memory_tombstones SET created_at=min(created_at,?) WHERE scope_id=? AND kind=? AND id=?').run(tomb.at,scope.id,tomb.kind,tomb.id);
        if(tomb.reference){
          for(const value of Object.values(tomb.reference))if(typeof value!=='string'||value.length>512)invalid('归档的删除来源定位无效。');
          this.store.db.prepare('UPDATE long_memory_tombstones SET reference=coalesce(reference,?) WHERE scope_id=? AND kind=? AND id=?')
            .run(JSON.stringify(tomb.reference),scope.id,tomb.kind,tomb.id);
        }
        if(written.state.invalidation)result.tombstones++;
      }
      for(const source of [...archive.sources].sort((a,b)=>a.version-b.version)){
        const scope=scopeFor(source.scopeId);
        if(this.store.tombstoned(scope.id,'source',source.id)){result.skipped++;continue;}
        const existing=this.store.source(scope.id,source.id,source.version);
        if (existing) {
          if (!memoryContentEqual(existing.payload, source)) invalid('归档来源与现有相同修订内容冲突。');
          result.skipped++; continue;
        }
        this.store.write({scope,sources:[{...source,expectedVersion:source.version-1}]},true);result.sources++;
      }
      const unavailable = this.unavailableRecords(archive.records, scopeFor);
      const pending = archive.records.filter(record => {
        if (!unavailable.has(record)) return true;
        result.skipped++;
        return false;
      }).sort((a, b) => a.version - b.version);
      const restored = this.restoreRecords(pending, scopeFor);
      result.records += restored.records;
      result.skipped += restored.skipped;
      return result;
    })();
  }
}
