import type { SqliteConnection } from '../schema';
import type { LongMemoryScope,LongMemoryTombstone } from '@graycode/contracts';
import { MemoryMutationStore } from './mutations';
import { MemoryQueries } from './queries';
import { MemoryJobs } from './jobs';
import { MemoryArchive } from './archive';

export class LongMemoryRepository extends MemoryMutationStore {
  readonly query: MemoryQueries;
  readonly jobs: MemoryJobs;
  readonly archive: MemoryArchive;
  constructor(db: SqliteConnection) {
    super(db); this.query=new MemoryQueries(this);this.jobs=new MemoryJobs(this);this.archive=new MemoryArchive(this);
  }
  deletedSources(scopes:LongMemoryScope[]):LongMemoryTombstone[]{
    if(!scopes.length)return [];
    for(const scope of scopes)this.state(scope);
    return (this.db.prepare(`SELECT scope_id AS scopeId,id,kind,action,created_at AS at,reference FROM long_memory_tombstones
      WHERE scope_id IN(${scopes.map(()=>'?').join(',')})`).all(...scopes.map(scope=>scope.id)) as Array<Omit<LongMemoryTombstone,'reference'>&{reference:string|null}>)
      .map(({reference,...row})=>({...row,...reference?{reference:JSON.parse(reference)}:{}}));
  }
  deletionState(){
    const owners=this.db.prepare('SELECT DISTINCT actor_id FROM long_memory_scopes s WHERE EXISTS(SELECT 1 FROM long_memory_tombstones t WHERE t.scope_id=s.id)').all() as Array<{actor_id:string}>;
    const scopes=owners.flatMap(owner=>this.scopes(owner.actor_id)).filter(scope=>!!this.db.prepare('SELECT 1 FROM long_memory_tombstones WHERE scope_id=? LIMIT 1').get(scope.id));
    return {scopes,tombstones:scopes.flatMap(scope=>this.deletedSources([scope]))};
  }
}
