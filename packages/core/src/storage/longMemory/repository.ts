import type { SqliteConnection } from '../schema';
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
}
