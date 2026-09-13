import type { LongMemoryArchive, LongMemoryScope, LongMemoryRecord, LongMemorySource, LongMemoryTombstone } from '@graycode/contracts';
import { invalid } from '../../errors';
import { MemoryMutationStore } from './mutations';

/** 交换归档保存正文与依赖，不携带供应方凭据、运行句柄或可重建向量。 */
export class MemoryArchive {
  constructor(private readonly store: MemoryMutationStore) {}
  export(scopes: LongMemoryScope[]): LongMemoryArchive {
    if(!scopes.length||scopes.some(scope=>scope.actorId!==scopes[0].actorId))invalid('只能导出同一账号的记忆。');
    const states=scopes.map(scope=>this.store.state(scope));
    const placeholders=scopes.map(()=>'?').join(','),ids=scopes.map(scope=>scope.id);
    const sources=(this.store.db.prepare(`SELECT s.payload FROM long_memory_sources s WHERE s.scope_id IN(${placeholders}) AND EXISTS(
      SELECT 1 FROM long_memory_dependencies d WHERE d.scope_id=s.scope_id AND d.parent_kind='source' AND d.parent_id=s.id AND d.parent_version=s.version)
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
        if(existing){if(JSON.stringify(JSON.parse(existing.payload))!==JSON.stringify(source))invalid('归档来源与现有相同修订内容冲突。');result.skipped++;continue;}
        this.store.write({scope,sources:[{...source,expectedVersion:source.version-1}]},true);result.sources++;
      }
      let pending=[...archive.records].sort((a,b)=>a.version-b.version),progress=true;
      while(pending.length&&progress){
        progress=false;const next:LongMemoryRecord[]=[];
        for(const record of pending){
          const scope=scopeFor(record.scopeId);
          if(this.store.tombstoned(scope.id,'record',record.id)||record.dependencies.some(ref=>this.store.tombstoned(scope.id,ref.kind,ref.id))){result.skipped++;progress=true;continue;}
          const existing=this.store.record(scope.id,record.id,record.version);
          if(existing){if(JSON.stringify(JSON.parse(existing.payload))!==JSON.stringify(record))invalid('归档记忆与现有相同修订内容冲突。');result.skipped++;progress=true;continue;}
          if(record.dependencies.some(ref=>!this.store.referenceAvailable(scope.id,ref,false))||record.supersedes.some(id=>!this.store.record(scope.id,id))
            ||(this.store.record(scope.id,record.id)?.version??0)!==record.version-1){next.push(record);continue;}
          this.store.write({scope,records:[{...record,expectedVersion:record.version-1}]},true);result.records++;progress=true;
        }
        pending=next;
      }
      if(pending.length)invalid('归档存在缺失来源、修订或循环依赖，未执行部分恢复。');
      return result;
    })();
  }
}
