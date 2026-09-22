import * as fs from 'node:fs';
import path from 'node:path';
import type { PlatformConversation, ConversationSummary, PlatformMessage, StorageStatistics, SnapshotMetadata, RecordMutation, ConversationCommit, ConversationCommitResult } from '@graycode/contracts';
import { assertIdentifier, invalid, PlatformStorageError } from '../errors';
import { openDatabase, SCHEMA_VERSION, type SqliteConnection } from './schema';
import { ObjectStore } from './objects';
import { HistoryStore } from './histories';
import { MemoryRepository } from './memories';
import { LongMemoryRepository } from './longMemory/repository';
import { VectorRanker } from './longMemory/vectorWorker';
import type { LongMemoryQuery, LongMemoryRecall } from '@graycode/contracts';
import { captureStorageSnapshot } from './backup';
import { backupInventory } from './backupInventory';
import { mergeBackupUnits } from './backupMerge';
import { RunRepository } from './runs';
import type { ConversationListOptions, ConversationList, StorageOperations, StorageMethod, MigrationState } from './protocol';

interface ConversationRow {
  id: string; title: string | null; created_at: number; updated_at: number;
  workspace_uri: string | null; metadata_hash: Buffer; history_id: string;
}
interface MigrationRow {
  source_key: string; fingerprint: string; conversation_id: string; metadata_hash: Buffer;
  history_id: string | null; imported_count: number; status: 'importing' | 'complete';
}

/** Synchronous implementation is deliberately private to one worker thread. */
export class PlatformDatabase {
  private readonly db: SqliteConnection;
  private readonly objects: ObjectStore;
  private readonly histories: HistoryStore;
  private readonly runs: RunRepository;
  private readonly memories: MemoryRepository;
  private readonly longMemories: LongMemoryRepository;
  private readonly databasePath: string;
  private readonly objectPath: string;
  private vectorRanker?: VectorRanker;
  private vectorIndexKey?: string;

  constructor(directory: string) {
    if (!path.isAbsolute(directory)) invalid('Storage directory must be absolute.');
    fs.mkdirSync(directory, { recursive: true });
    const root = fs.realpathSync(directory);
    this.databasePath = path.join(root, 'platform.sqlite');
    this.objectPath = path.join(root, 'objects');
    this.db = openDatabase(this.databasePath);
    this.objects = new ObjectStore(this.db, this.objectPath);
    this.histories = new HistoryStore(this.db, this.objects);
    this.runs = new RunRepository(this.db, this.objects);
    this.memories = new MemoryRepository(this.db, this.objects);
    this.longMemories = new LongMemoryRepository(this.db);
  }

  async recallMemory(query: LongMemoryQuery): Promise<LongMemoryRecall> {
    const prepared = this.longMemories.query.prepareVectors(query, this.vectorIndexKey);
    if (!prepared.rowIds.length) return this.longMemories.query.recall(query, { available: false, matches: [] });
    const ranker = this.vectorRanker ??= new VectorRanker();
    const matches = await ranker.rank(prepared.input);
    this.vectorIndexKey = prepared.key;
    return this.longMemories.query.recall(query, { available: prepared.rowIds.length > 0,
      matches: matches.map(item => ({ rowId: prepared.rowIds[item.index], score: item.score })) });
  }
  async closeVectorWorker(): Promise<void> { await this.vectorRanker?.close(); }

  execute<M extends StorageMethod>(method: M, input: StorageOperations[M]['input']): StorageOperations[M]['output'] {
    // The dispatch table is explicit: RPC never indexes arbitrary database methods.
    const operations: { [K in StorageMethod]: (value: StorageOperations[K]['input']) => StorageOperations[K]['output'] } = {
      longMemoryScopes: ({ actorId }) => this.longMemories.scopes(actorId),
      longMemoryState: scope => this.longMemories.state(scope),
      longMemoryWrite: input => this.longMemories.write(input),
      longMemoryRecall: input => this.longMemories.query.recall(input),
      longMemoryTopics: input => this.longMemories.query.topics(input),
      longMemoryRead: input => this.longMemories.query.read(input),
      longMemoryGraph: input => this.longMemories.query.graph(input),
      longMemoryRevisions: ({ scope, id }) => this.longMemories.query.revisions(scope, id),
      longMemoryInspect: ({scope,id})=>this.longMemories.query.inspect(scope,id),
      longMemorySources: ({scope,references})=>this.longMemories.query.sources(scope,references),
      longMemoryRecordVersions: ({scope,references})=>this.longMemories.query.recordVersions(scope,references),
      longMemoryImpact: ({ scope, kind, id, action }) => this.longMemories.impact(scope, kind, id, action),
      longMemoryDeletedSources: ({scopes})=>this.longMemories.deletedSources(scopes),
      longMemoryDeletionState: ()=>this.longMemories.deletionState(),
      longMemoryVector: ({ scope, id, version, vector }) => this.longMemories.putVector(scope, id, version, vector),
      longMemoryExport: ({ scopes }) => this.longMemories.archive.export(scopes),
      longMemoryRestore: ({ actorId, archive }) => this.longMemories.archive.restore(actorId, archive),
      longMemoryJobs: ({ scopes, status }) => this.longMemories.jobs.list(scopes, status),
      longMemoryJob: ({scope,id})=>this.longMemories.jobs.get(scope,id),
      longMemoryEnqueue: ({ scope, job }) => this.longMemories.jobs.enqueue(scope, job),
      longMemoryJobTransition: ({ scope, id, action, error,usage }) => this.longMemories.jobs.transition(scope, id, action, error,usage),
      longMemoryJobFinish: ({ scope, id, write, usage,vectors }) => this.longMemories.jobs.finish(scope, id, write, usage,vectors),
      memoryImportBatch: input => this.memories.importBatch(input),
      memoryImportPublish: input => this.memories.publishImport(input),
      memoryScopes: ({ actorId }) => this.memories.scopes(actorId),
      memoryState: scope => this.memories.state(scope),
      memoryEntries: ({ scope, offset, limit, expectedRevision }) => this.memories.entries(scope, offset, limit, expectedRevision),
      memorySummaries: ({ scope, lo, hi, expectedRevision }) => this.memories.summaries(scope, lo, hi, expectedRevision),
      memoryRevisions: ({ scope, before }) => this.memories.revisions(scope, before),
      memoryWrite: input => this.memories.write(input),
      readConversationState: ({ id, records = [], cursor }) => {
        const row = this.conversation(id);
        if (records.length > 256) invalid('Too many conversation state records.');
        return { metadata: this.objects.getValue<PlatformConversation>(row.metadata_hash), metadataToken: row.metadata_hash.toString('hex'),
          history: cursor ? { conversationId: id, ...this.histories.readIncremental(row.history_id, cursor) } : this.execute('readFullHistory', { id }),
          records: records.map(ref => ({ ...ref, record: this.execute('getVersionedRecord', ref) })) };
      },
      commitConversation: value => this.commitConversation(value),
      createRun: value => this.db.transaction(() => {
        this.assertWorkspaceOperation(value.run.conversationId);
        const result = this.runs.create(value.run);
        if (result.created) this.writeHistory(value.run.conversationId, [value.message], false, value.expectedRevision);
        return result;
      })(),
      getRun: ({ id }) => this.runs.get(id),
      getRunByRequestKey: ({ requestKey }) => this.runs.byRequestKey(requestKey),
      listRuns: options => this.runs.list(options),
      appendRunEvent: value => {
        const event = this.runs.append(value);
        if (value.update?.status && ['completed', 'failed', 'cancelled', 'interrupted'].includes(value.update.status)) this.histories.releaseCursor(value.runId);
        return event;
      },
      readRunEvents: ({ runId, after, limit }) => this.runs.events(runId, after, limit),
      createConversation: metadata => this.createConversation(metadata),
      initializeConversation: value => this.db.transaction(() => {
        this.createConversation(value.metadata);
        if (value.messages.length) this.writeHistory(value.metadata.id, value.messages, false);
        this.commitRecords(value.records);
        return this.summary(this.conversation(value.metadata.id));
      })(),
      getConversation: ({ id }) => this.getConversation(id),
      saveMetadata: metadata => this.saveMetadata(metadata),
      listConversations: options => this.listConversations(options),
      readHistory: ({ id, options }) => ({ conversationId: id, ...this.histories.page(this.conversation(id).history_id, options) }),
      historyInfo: ({ id }) => {
        const info = this.histories.info(this.conversation(id).history_id);
        return { total: info.message_count, revision: info.revision };
      },
      readUsageState: ({ id, records = [] }) => ({ ...this.histories.usage(this.conversation(id).history_id),
        records: records.map(record => ({ namespace: record.namespace, id: record.id, record: this.execute('getVersionedRecord', record) })) }),
      recordRevisions: ({ records }) => records.map(({ namespace, id }) => {
        assertIdentifier(namespace); assertIdentifier(id);
        return (this.db.prepare('SELECT revision FROM records WHERE namespace=? AND id=?').get(namespace, id) as { revision: number } | undefined)?.revision ?? null;
      }),
      readFullHistory: ({ id }) => {
        const historyId = this.conversation(id).history_id;
        const info = this.histories.info(historyId);
        const messages: PlatformMessage[] = [];
        for (let offset = 0; offset < info.message_count; offset += 1000) messages.push(...this.histories.page(historyId, { offset, limit: 1000 }).messages);
        return { conversationId: id, total: info.message_count, revision: info.revision, startIndex: 0, messages };
      },
      appendHistory: ({ id, messages, options }) => this.writeHistory(id, messages, false, options?.expectedRevision),
      replaceHistory: ({ id, messages, options }) => this.writeHistory(id, messages, true, options?.expectedRevision),
      forkConversation: value => this.db.transaction(() => {
        const source = this.conversation(value.sourceId);
        this.histories.checkRevision(source.history_id, value.expectedRevision);
        const target = this.insertConversation(value.metadata, this.histories.fork(source.history_id, value.beforeIndex));
        if (value.records?.length) this.commitRecords(value.records);
        return target;
      })(),
      deleteConversation: ({ id }) => this.db.transaction(() => {
        this.assertWorkspaceOperation(id);
        const row = this.findConversation(id);
        if (!row) return false;
        this.db.prepare('DELETE FROM records WHERE owner_id=?').run(id);
        this.db.prepare('DELETE FROM migrations WHERE conversation_id=?').run(id);
        this.db.prepare('DELETE FROM conversations WHERE id=?').run(id);
        this.db.prepare('DELETE FROM histories WHERE id=?').run(row.history_id);
        return true;
      })(),
      saveSnapshot: ({ metadata, messages }) => this.db.transaction(() => {
        assertIdentifier(metadata.id, 'snapshot id');
        if (!Number.isFinite(metadata.timestamp)) invalid('Snapshot timestamp must be finite.');
        const conversation = this.conversation(metadata.conversationId);
        if (this.db.prepare('SELECT 1 FROM snapshots WHERE id=?').get(metadata.id)) {
          throw new PlatformStorageError('REVISION_CONFLICT', 'Snapshot ID already exists.');
        }
        const historyId = this.histories.fork(conversation.history_id);
        if (messages !== undefined) this.histories.replace(historyId, messages);
        this.db.prepare('INSERT INTO snapshots(id,conversation_id,history_id,metadata_hash) VALUES(?,?,?,?)')
          .run(metadata.id, metadata.conversationId, historyId, this.objects.putValue(metadata));
      })(),
      getSnapshot: ({ id }) => {
        assertIdentifier(id);
        const row = this.db.prepare('SELECT history_id,metadata_hash FROM snapshots WHERE id=?').get(id) as { history_id: string; metadata_hash: Buffer } | undefined;
        if (!row) return null;
        const history: PlatformMessage[] = [];
        const total = this.histories.info(row.history_id).message_count;
        for (let offset = 0; offset < total; offset += 1000) history.push(...this.histories.page(row.history_id, { offset, limit: 1000 }).messages);
        return { ...this.objects.getValue<SnapshotMetadata>(row.metadata_hash), history };
      },
      listSnapshots: ({ conversationId }) => {
        assertIdentifier(conversationId);
        return (this.db.prepare('SELECT id FROM snapshots WHERE conversation_id=? ORDER BY id').all(conversationId) as { id: string }[]).map(row => row.id);
      },
      deleteSnapshot: ({ id }) => this.db.transaction(() => {
        assertIdentifier(id);
        const row = this.db.prepare('SELECT history_id FROM snapshots WHERE id=?').get(id) as { history_id: string } | undefined;
        if (!row) return false;
        this.db.prepare('DELETE FROM snapshots WHERE id=?').run(id);
        this.db.prepare('DELETE FROM histories WHERE id=?').run(row.history_id);
        return true;
      })(),
      putRecord: record => { this.commitRecords([record]); },
      commitRecords: mutations => this.commitRecords(mutations),
      getVersionedRecord: ({ namespace, id, projection }) => {
        assertIdentifier(namespace); assertIdentifier(id);
        const row = this.db.prepare('SELECT value_hash,revision FROM records WHERE namespace=? AND id=?').get(namespace, id) as { value_hash: Buffer; revision: number } | undefined;
        return { value: row ? this.objects.getValue(row.value_hash, projection) : null, revision: row?.revision ?? null };
      },
      getRecord: ({ namespace, id }) => {
        assertIdentifier(namespace); assertIdentifier(id);
        const row = this.db.prepare('SELECT value_hash FROM records WHERE namespace=? AND id=?').get(namespace, id) as { value_hash: Buffer } | undefined;
        return row ? this.objects.getValue(row.value_hash) : null;
      },
      listRecords: ({ namespace, ownerId }) => {
        assertIdentifier(namespace);
        const rows = ownerId === undefined
          ? this.db.prepare('SELECT id FROM records WHERE namespace=? ORDER BY id').all(namespace)
          : this.db.prepare('SELECT id FROM records WHERE namespace=? AND owner_id=? ORDER BY id').all(namespace, ownerId);
        return (rows as { id: string }[]).map(row => row.id);
      },
      readRecordPage: ({ namespace, ownerId, afterId, limit }) => {
        assertIdentifier(namespace); assertIdentifier(ownerId);
        if (afterId !== undefined) assertIdentifier(afterId);
        if (!Number.isInteger(limit) || limit < 1 || limit > 200) invalid('A record page must contain between 1 and 200 entries.');
        // 复用 namespace、owner_id、id 的索引，从游标继续读取，避免每次遍历整个事件档案。
        const rows = this.db.prepare('SELECT id,value_hash FROM records WHERE namespace=? AND owner_id=? AND id>? ORDER BY id LIMIT ?')
          .all(namespace, ownerId, afterId ?? '', limit) as { id: string; value_hash: Buffer }[];
        return rows.map(row => ({ namespace, id: row.id, ownerId, value: this.objects.getValue(row.value_hash) }));
      },
      deleteRecord: ({ namespace, id }) => {
        assertIdentifier(namespace); assertIdentifier(id);
        return this.db.prepare('DELETE FROM records WHERE namespace=? AND id=?').run(namespace, id).changes > 0;
      },
      migrationBegin: value => this.beginMigration(value),
      migrationAppend: value => this.db.transaction(() => {
        const migration = this.migration(value.sourceKey);
        if (migration.status !== 'importing' || migration.imported_count !== value.offset) {
          throw new PlatformStorageError('REVISION_CONFLICT', 'Migration offset no longer matches.');
        }
        this.histories.append(migration.history_id!, value.messages);
        const count = value.offset + value.messages.length;
        this.db.prepare('UPDATE migrations SET imported_count=? WHERE source_key=?').run(count, value.sourceKey);
        return { nextIndex: count, complete: false };
      })(),
      migrationFinish: value => this.db.transaction(() => {
        const migration = this.migration(value.sourceKey);
        if (migration.status === 'complete') return;
        if (migration.fingerprint !== value.fingerprint) throw new PlatformStorageError('SOURCE_CHANGED', 'Source changed during migration.');
        if (migration.imported_count !== value.total) throw new PlatformStorageError('CORRUPT_DATA', 'Imported message count does not match source.');
        const metadata = this.objects.getValue<PlatformConversation>(migration.metadata_hash);
        this.insertConversation(metadata, migration.history_id!);
        this.db.prepare("UPDATE migrations SET status='complete',history_id=NULL WHERE source_key=?").run(value.sourceKey);
      })(),
      statistics: () => this.statistics(),
      collectGarbage: () => this.collectGarbage(),
      verify: () => this.verify(),
      checkpoint: () => { this.db.pragma('wal_checkpoint(TRUNCATE)'); },
      backupSnapshot: () => ({ ...captureStorageSnapshot(this.db, this.databasePath, this.objectPath), statistics: this.statistics() }),
      backupInventory: () => backupInventory(this.db, this.objects),
      mergeBackupUnits: input => { this.histories.clearCursors(); return mergeBackupUnits(this.db, this.objects, this.objectPath, input); },
      close: () => { this.db.close(); },
    };
    if (!Object.hasOwn(operations, method)) invalid('Unknown storage operation.');
    const result = operations[method](input);
    // 只失效记忆数据的计算缓存，普通聊天写入不会迫使下一次搜索重传向量。
    if (['longMemoryWrite', 'longMemoryVector', 'longMemoryRestore', 'longMemoryJobFinish', 'mergeBackupUnits'].includes(method)) this.vectorIndexKey = undefined;
    return result;
  }

  private commitConversation(value: ConversationCommit): ConversationCommitResult {
    return this.db.transaction(() => {
      this.assertWorkspaceOperation(value.conversationId, value.workspaceOperationId);
      const row = this.conversation(value.conversationId);
      let started: ConversationCommitResult['run'];
      if (value.startRun) {
        if (value.startRun.run.conversationId !== value.conversationId || value.activeRunId) invalid('Run does not belong to this conversation transaction.');
        // create() deduplicates before checking active work. Everything below rolls back on failure.
        started = this.runs.create(value.startRun.run);
        if (!started.created) {
          const info = this.histories.info(row.history_id);
          return { revision: info.revision, total: info.message_count, metadataToken: row.metadata_hash.toString('hex'), records: [], run: started };
        }
      } else {
        const active = this.runs.list({ conversationId: value.conversationId, activeOnly: true, limit: 1 });
        if (value.activeRunId ? active[0]?.id !== value.activeRunId : active.length > 0)
          throw new PlatformStorageError('STORAGE_BUSY', 'Conversation has active work; cancel and wait before changing its history.');
      }
      if (!Number.isSafeInteger(value.expectedRevision)) invalid('A conversation transaction requires its history revision.');
      this.histories.checkRevision(row.history_id, value.expectedRevision);
      if (value.metadata && value.expectedMetadataToken === undefined) invalid('Metadata changes require a metadata token.');
      if (value.expectedMetadataToken !== undefined && value.expectedMetadataToken !== row.metadata_hash.toString('hex'))
        throw new PlatformStorageError('REVISION_CONFLICT', 'Conversation metadata changed. Reload before applying the operation.');
      if (value.snapshot) {
        if (value.snapshot.conversationId !== value.conversationId) invalid('Snapshot belongs to another conversation.');
        this.execute('saveSnapshot', { metadata: value.snapshot });
      }
      if (value.messages && value.messageUpdates) invalid('不能同时替换历史和提交局部更新。');
      if (value.messages) this.writeHistory(value.conversationId, value.messages, true, value.expectedRevision);
      if (value.messageUpdates) {
        this.histories.patch(row.history_id, value.messageUpdates);
        if (!value.metadata && this.histories.info(row.history_id).revision !== value.expectedRevision)
          this.saveMetadata({ ...this.objects.getValue<PlatformConversation>(row.metadata_hash), updatedAt: Date.now() });
      }
      if (value.startRun?.message) this.writeHistory(value.conversationId, [value.startRun.message], false);
      if (value.metadata) {
        if (value.metadata.id !== value.conversationId) invalid('Metadata belongs to another conversation.');
        this.saveMetadata({ ...value.metadata, updatedAt: Date.now() });
      }
      const records = this.commitRecords(value.records ?? []);
      const current = this.conversation(value.conversationId);
      const info = this.histories.info(current.history_id);
      return { revision: info.revision, total: info.message_count, metadataToken: current.metadata_hash.toString('hex'), records, run: started };
    })();
  }

  private assertWorkspaceOperation(conversationId: string, operationId?: string): void {
    const pending = this.execute('getRecord', { namespace: 'workspace-operations', id: conversationId }) as { id: string } | null;
    if (pending && pending.id !== operationId)
      throw new PlatformStorageError('STORAGE_BUSY', '工作区文件操作尚未完成，请先完成恢复。');
    if (operationId && pending?.id !== operationId)
      throw new PlatformStorageError('REVISION_CONFLICT', '工作区操作记录已变化。');
  }

  private commitRecords(mutations: RecordMutation[]): { namespace: string; id: string; revision: number | null }[] {
    if (!Array.isArray(mutations) || mutations.length > 256) invalid('A settings transaction may contain at most 256 records.');
    return this.db.transaction(() => {
      const seen = new Set<string>();
      return mutations.map(record => {
        assertIdentifier(record.namespace); assertIdentifier(record.id);
        const key = JSON.stringify([record.namespace, record.id]);
        if (seen.has(key)) invalid('A record may only appear once in a transaction.');
        seen.add(key);
        const current = this.db.prepare('SELECT revision FROM records WHERE namespace=? AND id=?').get(record.namespace, record.id) as { revision: number } | undefined;
        if (record.expectedRevision !== undefined && record.expectedRevision !== (current?.revision ?? null)) throw new PlatformStorageError('REVISION_CONFLICT', 'Settings changed in another client. Reload or merge before saving.');
        if ('delete' in record) {
          this.db.prepare('DELETE FROM records WHERE namespace=? AND id=?').run(record.namespace, record.id);
          return { namespace: record.namespace, id: record.id, revision: null };
        }
        if (record.ownerId !== undefined) assertIdentifier(record.ownerId);
        const revision = (current?.revision ?? 0) + 1;
        this.db.prepare(`INSERT INTO records(namespace,id,owner_id,value_hash,revision) VALUES(?,?,?,?,?)
          ON CONFLICT(namespace,id) DO UPDATE SET owner_id=excluded.owner_id,value_hash=excluded.value_hash,revision=excluded.revision`)
          .run(record.namespace, record.id, record.ownerId ?? null, this.objects.putValue(record.value, record.namespace === 'model-requests'), revision);
        return { namespace: record.namespace, id: record.id, revision };
      });
    })();
  }

  private findConversation(id: string): ConversationRow | undefined {
    assertIdentifier(id, 'conversation id');
    return this.db.prepare('SELECT * FROM conversations WHERE id=?').get(id) as ConversationRow | undefined;
  }

  private conversation(id: string): ConversationRow {
    const row = this.findConversation(id);
    if (!row) throw new PlatformStorageError('NOT_FOUND', `Conversation does not exist: ${id}`);
    return row;
  }

  private getConversation(id: string): PlatformConversation | null {
    const row = this.findConversation(id);
    return row ? this.objects.getValue<PlatformConversation>(row.metadata_hash) : null;
  }

  private validateMetadata(metadata: PlatformConversation): void {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) invalid('Conversation metadata must be an object.');
    assertIdentifier(metadata.id, 'conversation id');
    if (![metadata.createdAt, metadata.updatedAt].every(value => typeof value === 'number' && Number.isFinite(value))) invalid('Conversation timestamps must be finite numbers.');
    if (metadata.title !== undefined && typeof metadata.title !== 'string') invalid('Title must be a string.');
    if (metadata.workspaceUri !== undefined && typeof metadata.workspaceUri !== 'string') invalid('Workspace URI must be a string.');
  }

  private createConversation(metadata: PlatformConversation): ConversationSummary {
    return this.db.transaction(() => this.insertConversation(metadata, this.histories.create()))();
  }

  private insertConversation(metadata: PlatformConversation, historyId: string): ConversationSummary {
    this.validateMetadata(metadata);
    if (this.findConversation(metadata.id)) throw new PlatformStorageError('REVISION_CONFLICT', 'Conversation ID already exists.');
    this.db.prepare('INSERT INTO conversations(id,title,created_at,updated_at,workspace_uri,metadata_hash,history_id) VALUES(?,?,?,?,?,?,?)')
      .run(metadata.id, metadata.title ?? null, metadata.createdAt, metadata.updatedAt, metadata.workspaceUri ?? null, this.objects.putValue(metadata), historyId);
    return this.summary(this.conversation(metadata.id));
  }

  private saveMetadata(metadata: PlatformConversation): void {
    this.db.transaction(() => {
      this.validateMetadata(metadata);
      this.conversation(metadata.id);
      this.db.prepare('UPDATE conversations SET title=?,created_at=?,updated_at=?,workspace_uri=?,metadata_hash=? WHERE id=?')
        .run(metadata.title ?? null, metadata.createdAt, metadata.updatedAt, metadata.workspaceUri ?? null, this.objects.putValue(metadata), metadata.id);
    })();
  }

  private writeHistory(id: string, messages: PlatformMessage[], replace: boolean, expected?: number): { revision: number; total: number } {
    return this.db.transaction(() => {
      const row = this.conversation(id);
      const previous = this.histories.checkRevision(row.history_id, expected);
      if (replace) this.histories.replace(row.history_id, messages);
      else this.histories.append(row.history_id, messages);
      const result = this.histories.info(row.history_id);
      if (result.revision !== previous.revision) {
        const metadata = this.objects.getValue<PlatformConversation>(row.metadata_hash);
        metadata.updatedAt = Date.now();
        this.saveMetadata(metadata);
      }
      return { revision: result.revision, total: result.message_count };
    })();
  }

  private summary(row: ConversationRow): ConversationSummary {
    const history = this.histories.info(row.history_id);
    const { workspaceId, custom } = this.objects.getValue<{ workspaceId?: unknown; custom?: { botOrigin?: { platform?: unknown } } }>(row.metadata_hash, { fields: ['workspaceId', 'custom'] });
    const botPlatform = custom?.botOrigin?.platform;
    return { id: row.id, title: row.title ?? undefined, createdAt: row.created_at, updatedAt: row.updated_at,
      ...(typeof workspaceId === 'string' ? { workspaceId } : {}),
      ...(botPlatform === 'discord' || botPlatform === 'onebot' ? { botPlatform } : {}),
      workspaceUri: row.workspace_uri ?? undefined, messageCount: history.message_count, revision: history.revision };
  }

  private listConversations(options: ConversationListOptions): ConversationList {
    const limit = options.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) invalid('List limit must be between 1 and 1000.');
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (options.workspaceUri !== undefined) { where.push('workspace_uri=?'); args.push(options.workspaceUri); }
    if (options.query !== undefined) {
      if (typeof options.query !== 'string' || options.query.length > 512) invalid('Conversation title query is invalid.');
      if (options.query.trim()) { where.push("instr(lower(coalesce(title,'')),lower(?))>0"); args.push(options.query.trim()); }
    }
    if (options.cursor) {
      if (!Number.isFinite(options.cursor.updatedAt)) invalid('Invalid conversation cursor.');
      assertIdentifier(options.cursor.id);
      where.push('(updated_at<? OR (updated_at=? AND id>?))');
      args.push(options.cursor.updatedAt, options.cursor.updatedAt, options.cursor.id);
    }
    const rows = this.db.prepare(`SELECT * FROM conversations ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY updated_at DESC,id LIMIT ?`).all(...args, limit + 1) as ConversationRow[];
    const more = rows.length > limit;
    const items = rows.slice(0, limit).map(row => this.summary(row));
    const last = items.at(-1);
    return { items, ...(more && last ? { nextCursor: { updatedAt: last.updatedAt, id: last.id } } : {}) };
  }

  private migration(sourceKey: string): MigrationRow {
    assertIdentifier(sourceKey, 'migration source');
    const row = this.db.prepare('SELECT * FROM migrations WHERE source_key=?').get(sourceKey) as MigrationRow | undefined;
    if (!row) throw new PlatformStorageError('NOT_FOUND', 'Migration has not been started.');
    return row;
  }

  private beginMigration(value: StorageOperations['migrationBegin']['input']): MigrationState {
    return this.db.transaction(() => {
      assertIdentifier(value.sourceKey); assertIdentifier(value.fingerprint);
      this.validateMetadata(value.metadata);
      const existing = this.db.prepare('SELECT * FROM migrations WHERE source_key=?').get(value.sourceKey) as MigrationRow | undefined;
      if (existing) {
        if (existing.fingerprint !== value.fingerprint || existing.conversation_id !== value.metadata.id) {
          throw new PlatformStorageError('SOURCE_CHANGED', 'This source differs from the previous import. Use a new destination or resolve the existing migration.');
        }
        return { nextIndex: existing.imported_count, complete: existing.status === 'complete' };
      }
      if (this.findConversation(value.metadata.id)) throw new PlatformStorageError('REVISION_CONFLICT', 'Import would overwrite an existing conversation.');
      this.db.prepare(`INSERT INTO migrations(source_key,fingerprint,conversation_id,metadata_hash,history_id,status)
        VALUES(?,?,?,?,?,'importing')`).run(value.sourceKey, value.fingerprint, value.metadata.id, this.objects.putValue(value.metadata), this.histories.create());
      return { nextIndex: 0, complete: false };
    })();
  }

  private statistics(): StorageStatistics {
    const count = (table: string) => (this.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
    const sum = (table: string, column: string) => (this.db.prepare(`SELECT coalesce(sum(${column}),0) AS n FROM ${table}`).get() as { n: number }).n;
    const size = (file: string) => { try { return fs.statSync(file).size; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw error; } };
    return { schemaVersion: SCHEMA_VERSION, sqliteVersion: (this.db.prepare('SELECT sqlite_version() AS v').get() as { v: string }).v,
      conversations: count('conversations'), messages: sum('histories', 'message_count'), objects: count('objects'),
      rawBytes: sum('objects', 'raw_bytes'), storedBytes: sum('chunks', 'stored_bytes'), databaseBytes: size(this.databasePath), walBytes: size(`${this.databasePath}-wal`) };
  }

  private verify(): { ok: boolean; issues: string[]; objectsChecked: number } {
    const issues: string[] = [];
    const integrity = this.db.pragma('integrity_check') as { integrity_check: string }[];
    issues.push(...integrity.map(row => row.integrity_check).filter(value => value !== 'ok'));
    const foreign = this.db.pragma('foreign_key_check') as unknown[];
    if (foreign.length) issues.push(`${foreign.length} foreign key violations`);
    const invalidSequences = this.db.prepare(`SELECT h.id FROM histories h LEFT JOIN history_spans s ON s.history_id=h.id
      GROUP BY h.id HAVING coalesce(sum(s.count),0)<>h.message_count`).all();
    if (invalidSequences.length) issues.push(`${invalidSequences.length} histories have inconsistent message counts`);
    const gaps = this.db.prepare(`SELECT history_id FROM (
      SELECT history_id,start_index,lag(start_index+count,1,0) OVER(PARTITION BY history_id ORDER BY start_index) AS expected
      FROM history_spans) WHERE start_index<>expected`).all();
    if (gaps.length) issues.push(`${gaps.length} noncontiguous history spans`);
    const missingEntries = this.db.prepare(`SELECT s.history_id FROM history_spans s LEFT JOIN segment_entries e
      ON e.segment_id=s.segment_id AND e.ordinal>=s.segment_offset AND e.ordinal<s.segment_offset+s.count
      GROUP BY s.history_id,s.start_index HAVING count(e.ordinal)<>s.count`).all();
    if (missingEntries.length) issues.push(`${missingEntries.length} history spans have missing entries`);
    let objectsChecked = 0;
    for (const row of this.db.prepare('SELECT hash FROM objects').iterate() as Iterable<{ hash: Buffer }>) {
      try { this.objects.get(row.hash); } catch (error) { issues.push(error instanceof Error ? error.message : String(error)); }
      objectsChecked++;
    }
    return { ok: issues.length === 0, issues, objectsChecked };
  }

  private collectGarbage(): StorageOperations['collectGarbage']['output'] {
    // 回收会删除未引用的段，后续 SQLite 可能复用编号，已有运行下次重新取得完整快照。
    this.histories.clearCursors();
    const result = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM histories WHERE id NOT IN (
        SELECT history_id FROM conversations UNION SELECT history_id FROM snapshots
        UNION SELECT history_id FROM migrations WHERE history_id IS NOT NULL
      )`).run();
      this.db.prepare(`DELETE FROM segment_entries WHERE NOT EXISTS (
        SELECT 1 FROM history_spans s WHERE s.segment_id=segment_entries.segment_id
        AND segment_entries.ordinal>=s.segment_offset AND segment_entries.ordinal<s.segment_offset+s.count
      )`).run();
      this.db.prepare('DELETE FROM segments WHERE id NOT IN (SELECT segment_id FROM history_spans)').run();
      const objectsRemoved = this.db.prepare(`WITH RECURSIVE reachable(hash) AS (
        SELECT metadata_hash FROM conversations UNION SELECT body_hash FROM segment_entries
        UNION SELECT value_hash FROM records UNION SELECT metadata_hash FROM migrations UNION SELECT metadata_hash FROM snapshots
        UNION SELECT value_hash FROM runs UNION SELECT payload_hash FROM run_events
        UNION SELECT body_hash FROM memory_entries UNION SELECT body_hash FROM memory_summaries
        UNION SELECT source_hash FROM memory_revisions
        UNION SELECT body_hash FROM memory_revision_entries WHERE body_hash IS NOT NULL
        UNION SELECT body_hash FROM memory_revision_summaries WHERE body_hash IS NOT NULL
        UNION SELECT e.child_hash FROM object_edges e JOIN reachable r ON e.parent_hash=r.hash
      ) DELETE FROM objects WHERE hash NOT IN (SELECT hash FROM reachable)`).run().changes;
      const chunksRemoved = this.db.prepare('DELETE FROM chunks WHERE hash NOT IN (SELECT chunk_hash FROM object_chunks)').run().changes;
      return { objectsRemoved, chunksRemoved, externalFilesRemoved: 0 };
    })();
    const referenced = new Set((this.db.prepare('SELECT file_id FROM chunks WHERE file_id IS NOT NULL').all() as { file_id: string }[]).map(row => row.file_id));
    // Only owned content filenames are collected; arbitrary files in the data directory are untouched.
    for (const shard of fs.readdirSync(this.objectPath, { withFileTypes: true })) {
      if (!shard.isDirectory() || !/^[a-f0-9]{2}$/.test(shard.name)) continue;
      for (const file of fs.readdirSync(path.join(this.objectPath, shard.name), { withFileTypes: true })) {
        if (!file.isFile()) continue;
        const contentFile = /^[a-f0-9]{64}\.bin$/.test(file.name);
        const temporaryFile = /^[a-f0-9]{64}\.bin\.[a-f0-9-]{36}\.tmp$/.test(file.name);
        if ((!contentFile && !temporaryFile) || (contentFile && referenced.has(file.name.slice(0, -4)))) continue;
        fs.unlinkSync(path.join(this.objectPath, shard.name, file.name));
        result.externalFilesRemoved++;
      }
    }
    return result;
  }
}
