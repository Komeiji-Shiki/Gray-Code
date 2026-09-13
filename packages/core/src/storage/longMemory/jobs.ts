import type { LongMemoryJob, LongMemoryScope, LongMemoryWrite, LongMemoryWriteResult } from '@graycode/contracts';
import { assertIdentifier, invalid, PlatformStorageError } from '../../errors';
import { MemoryMutationStore } from './mutations';

/** 重启只恢复可确认尚未发送的任务，发送中断的收费请求需要显式重试。 */
export class MemoryJobs {
  constructor(private readonly store: MemoryMutationStore) {
    const rows = store.db.prepare("SELECT payload FROM long_memory_jobs WHERE status='running'").all() as Array<{ payload: string }>;
    for (const row of rows) {
      const job = JSON.parse(row.payload) as LongMemoryJob;
      job.status = 'interrupted'; job.updatedAt = Date.now(); job.error = '应用在请求期间退出，结果及用量可能不完整，请检查后重试。'; this.save(job);
    }
  }
  private save(job: LongMemoryJob): void {
    this.store.db.prepare('UPDATE long_memory_jobs SET status=?,payload=? WHERE scope_id=? AND id=?').run(job.status, JSON.stringify(job), job.scopeId, job.id);
  }
  get(scope: LongMemoryScope, id: string): LongMemoryJob | null {
    this.store.state(scope); assertIdentifier(id);
    const row = this.store.db.prepare('SELECT payload FROM long_memory_jobs WHERE scope_id=? AND id=?').get(scope.id,id) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as LongMemoryJob : null;
  }
  list(scopes: LongMemoryScope[], status?: LongMemoryJob['status']): LongMemoryJob[] {
    if (!scopes.length) return [];
    for (const scope of scopes) this.store.state(scope);
    return (this.store.db.prepare(`SELECT payload FROM long_memory_jobs WHERE scope_id IN(${scopes.map(()=>'?').join(',')})${status?' AND status=?':''} ORDER BY id DESC LIMIT 200`)
      .all(...scopes.map(scope=>scope.id), ...status?[status]:[]) as Array<{payload:string}>).map(row=>JSON.parse(row.payload) as LongMemoryJob);
  }
  enqueue(scope: LongMemoryScope, job: LongMemoryJob): LongMemoryJob {
    return this.store.db.transaction(()=>{
      this.store.state(scope,true); assertIdentifier(job.id); assertIdentifier(job.providerId);
      if (job.scopeId!==scope.id || job.status!=='pending' || job.attempts!==0 || !['extract','summarize','embed'].includes(job.kind)
        || !Number.isFinite(job.createdAt) || !Number.isFinite(job.updatedAt) || !Array.isArray(job.dependencies) || !job.dependencies.length || job.dependencies.length>256) invalid('后台记忆任务参数无效。');
      const existing=this.get(scope,job.id);
      if(existing) {
        if(JSON.stringify(existing.dependencies)!==JSON.stringify(job.dependencies)||existing.kind!==job.kind||existing.providerId!==job.providerId||existing.model!==job.model)
          throw new PlatformStorageError('REVISION_CONFLICT','相同任务编号不能覆盖另一项记忆整理。');
        return existing;
      }
      if(!job.dependencies.every(ref=>this.store.referenceAvailable(scope.id,ref))) throw new PlatformStorageError('SOURCE_CHANGED','记忆任务的来源已经改变。');
      this.store.db.prepare('INSERT INTO long_memory_jobs VALUES(?,?,?,?)').run(scope.id,job.id,job.status,JSON.stringify(job));
      for(const ref of job.dependencies)this.store.db.prepare('INSERT INTO long_memory_job_dependencies VALUES(?,?,?,?,?)').run(scope.id,job.id,ref.kind,ref.id,ref.version);
      return job;
    })();
  }
  transition(scope: LongMemoryScope, id: string, action: 'start'|'retry'|'cancel'|'fail', error?: string): LongMemoryJob | null {
    return this.store.db.transaction(()=>{
      const job=this.get(scope,id); if(!job)return null;
      if(action==='cancel') { if(job.status==='completed')return job; job.status='cancelled'; }
      else if(action==='fail') { if(job.status!=='running')return job; job.status='failed'; job.error=String(error??'记忆整理失败。').slice(0,2000); }
      else {
        if(action==='start'&&job.status!=='pending')return null;
        if(action==='retry'&&!['failed','interrupted'].includes(job.status))return null;
        if(!job.dependencies.every(ref=>this.store.referenceAvailable(scope.id,ref))) {job.status='cancelled';job.error='来源已经修订或删除。';}
        else {job.status=action==='start'?'running':'pending';if(action==='start')job.attempts++;delete job.error;}
      }
      job.updatedAt=Date.now();this.save(job);return job;
    })();
  }
  finish(scope: LongMemoryScope, id: string, write: LongMemoryWrite, usage?: LongMemoryJob['usage']): { applied: boolean; job: LongMemoryJob | null; result?: LongMemoryWriteResult } {
    return this.store.db.transaction(()=>{
      const job=this.get(scope,id);if(!job)return {applied:false,job:null};
      if(usage)job.usage=usage;
      if(job.status!=='running'||!job.dependencies.every(ref=>this.store.referenceAvailable(scope.id,ref))) {
        if(job.status==='running')job.status='cancelled';job.updatedAt=Date.now();this.save(job);return {applied:false,job};
      }
      if(write.scope.id!==scope.id||write.scope.actorId!==scope.actorId)invalid('后台任务不能修改其他记忆范围。');
      // 每条派生记录必须依赖本任务读取过的来源，不能写入无关记忆。
      for(const record of write.records??[])if(!job.dependencies.some(ref=>record.dependencies.some(parent=>JSON.stringify(parent)===JSON.stringify(ref))))invalid('后台记忆缺少任务来源。');
      if(write.sources?.length||write.remove?.length)invalid('自动整理只提交候选记忆，来源编辑与删除走显式操作。');
      const result=this.store.write(write);job.status='completed';job.updatedAt=Date.now();delete job.error;this.save(job);
      return {applied:true,job,result};
    })();
  }
}
