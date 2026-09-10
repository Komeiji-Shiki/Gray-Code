import type { RunRecord, RunEvent, RunListOptions, RunStatus } from '@graycode/contracts';
import { assertIdentifier, invalid, PlatformStorageError } from '../errors';
import type { SqliteConnection } from './schema';
import type { ObjectStore } from './objects';

interface RunRow { value_hash: Buffer }
const ACTIVE: RunStatus[] = ['queued', 'running', 'awaiting_approval', 'awaiting_input'];
const TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
  queued: ['running', 'cancelled', 'interrupted', 'failed'],
  running: ['awaiting_approval', 'awaiting_input', 'completed', 'failed', 'cancelled', 'interrupted'],
  awaiting_approval: ['running', 'cancelled', 'interrupted', 'failed'],
  awaiting_input: ['running', 'cancelled', 'interrupted', 'failed'],
  completed: [], failed: [], cancelled: [], interrupted: [],
};

export interface RunEventWrite {
  runId: string;
  type: RunEvent['type'];
  payload: Record<string, unknown>;
  update?: { status?: RunStatus; iteration?: number; error?: string };
}

export class RunRepository {
  constructor(private readonly db: SqliteConnection, private readonly objects: ObjectStore) {}

  get(id: string): RunRecord | null {
    assertIdentifier(id, 'run id');
    const row = this.db.prepare('SELECT value_hash FROM runs WHERE id=?').get(id) as RunRow | undefined;
    return row ? this.objects.getValue<RunRecord>(row.value_hash) : null;
  }
  byRequestKey(requestKey: string): RunRecord | null {
    assertIdentifier(requestKey, 'request key');
    const row = this.db.prepare('SELECT value_hash FROM runs WHERE request_key=?').get(requestKey) as RunRow | undefined;
    return row ? this.objects.getValue<RunRecord>(row.value_hash) : null;
  }

  create(value: RunRecord): { run: RunRecord; created: boolean } {
    for (const id of [value.id, value.requestKey, value.actorId, value.agentId, value.conversationId]) assertIdentifier(id);
    if (value.status !== 'queued' || value.iteration !== 0 || !Number.isFinite(value.createdAt) || !Number.isFinite(value.updatedAt)) invalid('Invalid initial run state.');
    const run = this.byRequestKey(value.requestKey);
    if (run) {
      if (run.actorId !== value.actorId || run.conversationId !== value.conversationId) throw new PlatformStorageError('REVISION_CONFLICT', 'Request identity was already used.');
      return { run, created: false };
    }
    const active = this.db.prepare("SELECT id FROM runs WHERE conversation_id=? AND status IN ('queued','running','awaiting_approval','awaiting_input') LIMIT 1").get(value.conversationId);
    if (active) throw new PlatformStorageError('STORAGE_BUSY', 'This conversation already has an active run.');
    this.db.prepare(`INSERT INTO runs(id,request_key,conversation_id,actor_id,agent_id,workspace_id,status,created_at,updated_at,value_hash)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(value.id, value.requestKey, value.conversationId, value.actorId, value.agentId,
      value.workspaceId ?? null, value.status, value.createdAt, value.updatedAt, this.objects.putValue(value));
    this.append({ runId: value.id, type: 'run.created', payload: {} });
    return { run: value, created: true };
  }

  append(input: RunEventWrite): RunEvent {
    return this.db.transaction(() => {
      const run = this.get(input.runId);
      if (!run) throw new PlatformStorageError('NOT_FOUND', 'Run not found.');
      if (input.update?.status && input.update.status !== run.status && !TRANSITIONS[run.status].includes(input.update.status)) {
        throw new PlatformStorageError('REVISION_CONFLICT', `Invalid run transition: ${run.status} -> ${input.update.status}`);
      }
      if (input.update?.iteration !== undefined && (!Number.isSafeInteger(input.update.iteration) || input.update.iteration < run.iteration)) invalid('Run iteration cannot move backwards.');
      const timestamp = Date.now();
      if (input.update) {
        const next = { ...run, ...input.update, updatedAt: timestamp };
        this.db.prepare('UPDATE runs SET status=?,updated_at=?,value_hash=? WHERE id=?')
          .run(next.status, timestamp, this.objects.putValue(next), next.id);
      }
      const { sequence } = this.db.prepare('SELECT coalesce(max(sequence),0)+1 AS sequence FROM run_events WHERE run_id=?').get(run.id) as { sequence: number };
      this.db.prepare('INSERT INTO run_events(run_id,sequence,timestamp,type,payload_hash) VALUES(?,?,?,?,?)')
        .run(run.id, sequence, timestamp, input.type, this.objects.putValue(input.payload));
      return { runId: run.id, sequence, timestamp, type: input.type, payload: input.payload };
    })();
  }

  list(options: RunListOptions = {}): RunRecord[] {
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) invalid('Run list limit must be between 1 and 1000.');
    const clauses: string[] = [];
    const args: (string | number)[] = [];
    if (options.actorId) { clauses.push('actor_id=?'); args.push(options.actorId); }
    if (options.conversationId) { clauses.push('conversation_id=?'); args.push(options.conversationId); }
    if (options.activeOnly) { clauses.push(`status IN (${ACTIVE.map(() => '?').join(',')})`); args.push(...ACTIVE); }
    if (options.beforeCreatedAt !== undefined) { clauses.push('created_at<?'); args.push(options.beforeCreatedAt); }
    const rows = this.db.prepare(`SELECT value_hash FROM runs ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY created_at DESC,id LIMIT ?`).all(...args, limit) as RunRow[];
    return rows.map(row => this.objects.getValue<RunRecord>(row.value_hash));
  }

  events(runId: string, after = 0, limit = 500): RunEvent[] {
    assertIdentifier(runId);
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) invalid('Invalid event cursor or limit.');
    const rows = this.db.prepare('SELECT sequence,timestamp,type,payload_hash FROM run_events WHERE run_id=? AND sequence>? ORDER BY sequence LIMIT ?')
      .all(runId, after, limit) as { sequence: number; timestamp: number; type: RunEvent['type']; payload_hash: Buffer }[];
    return rows.map(row => ({ runId, sequence: row.sequence, timestamp: row.timestamp, type: row.type, payload: this.objects.getValue(row.payload_hash) }));
  }
}
