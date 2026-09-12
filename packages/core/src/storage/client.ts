import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type {
  PlatformConversation, PlatformMessage, PageOptions, HistoryWriteOptions, StoredRecord, StorageErrorCode, SnapshotMetadata,
  RunRecord, RunListOptions,
  RecordMutation,
  ConversationCommit,
} from '@graycode/contracts';
import { PlatformStorageError } from '../errors';
import type { StorageOperations, StorageMethod, StorageReply, ConversationListOptions } from './protocol';
import type { MemoryScopeDefinition, MemoryWrite, MemoryImportPublish, MemoryImportBatch } from './memoryTypes';
import type { RunEventWrite } from './runs';

interface PendingCall { resolve(value: unknown): void; reject(error: Error): void }

/** Public asynchronous storage facade; SQLite and compression never run on its caller's thread. */
export class PlatformStorage {
  private readonly worker: Worker;
  private readonly pending = new Map<number, PendingCall>();
  private sequence = 0;
  private closing?: Promise<void>;
  private unavailable?: Error;
  private constructor(public readonly directory: string) {
    this.worker = new Worker(path.join(__dirname, 'storage.worker.cjs'), { workerData: { directory } });
  }

  static async open(directory: string): Promise<PlatformStorage> {
    const store = new PlatformStorage(path.resolve(directory));
    await new Promise<void>((resolve, reject) => {
      let ready = false;
      store.worker.on('message', (message: StorageReply) => {
        if (message.type === 'ready') { ready = true; resolve(); return; }
        if (message.type === 'error' && message.id === undefined) {
          const error = new PlatformStorageError(message.error.code as StorageErrorCode, message.error.message);
          store.fail(error); reject(error); return;
        }
        if (message.type === 'reply' || message.type === 'error') {
          const call = store.pending.get(message.id!);
          store.pending.delete(message.id!);
          if (message.type === 'reply') call?.resolve(message.value);
          else call?.reject(new PlatformStorageError(message.error.code as StorageErrorCode, message.error.message));
        }
      });
      store.worker.on('error', error => { store.fail(error); if (!ready) reject(error); });
      store.worker.on('exit', code => {
        const error = new PlatformStorageError('STORAGE_CLOSED', `Storage worker exited (${code}).`);
        store.fail(error);
        if (!ready) reject(error);
      });
    });
    return store;
  }

  createConversation(metadata: PlatformConversation) { return this.request('createConversation', metadata); }
  initializeConversation(metadata: PlatformConversation, messages: PlatformMessage[] = [], records: RecordMutation[] = []) {
    return this.request('initializeConversation', { metadata, messages, records });
  }
  readConversationState(id: string, records?: { namespace: string; id: string }[]) { return this.request('readConversationState', { id, records }); }
  commitConversation(value: ConversationCommit) { return this.request('commitConversation', value); }
  createRun(run: RunRecord, message: PlatformMessage, expectedRevision?: number) { return this.request('createRun', { run, message, expectedRevision }); }
  getRun(id: string) { return this.request('getRun', { id }); }
  getRunByRequestKey(requestKey: string) { return this.request('getRunByRequestKey', { requestKey }); }
  listRuns(options: RunListOptions = {}) { return this.request('listRuns', options); }
  appendRunEvent(input: RunEventWrite) { return this.request('appendRunEvent', input); }
  readRunEvents(runId: string, after = 0, limit = 500) { return this.request('readRunEvents', { runId, after, limit }); }
  getConversation(id: string) { return this.request('getConversation', { id }); }
  memoryImportBatch(input: MemoryImportBatch) { return this.request('memoryImportBatch', input); }
  memoryImportPublish(input: MemoryImportPublish) { return this.request('memoryImportPublish', input); }
  memoryScopes(actorId: string) { return this.request('memoryScopes', { actorId }); }
  memoryState(scope: MemoryScopeDefinition) { return this.request('memoryState', scope); }
  memoryEntries(scope: MemoryScopeDefinition, offset: number, limit: number, expectedRevision?: number) { return this.request('memoryEntries', { scope, offset, limit, expectedRevision }); }
  memorySummaries(scope: MemoryScopeDefinition, lo?: number, hi?: number, expectedRevision?: number) { return this.request('memorySummaries', { scope, lo, hi, expectedRevision }); }
  memoryRevisions(scope: MemoryScopeDefinition, before?: number) { return this.request('memoryRevisions', { scope, before }); }
  memoryWrite(input: MemoryWrite) { return this.request('memoryWrite', input); }
  saveMetadata(metadata: PlatformConversation) { return this.request('saveMetadata', metadata); }
  listConversations(options: ConversationListOptions = {}) { return this.request('listConversations', options); }
  readHistory(id: string, options: PageOptions = {}) { return this.request('readHistory', { id, options }); }
  historyInfo(id: string) { return this.request('historyInfo', { id }); }
  /** Explicit full reads use one worker operation; UI callers should use readHistory pages. */
  readUsageState(id: string, records: StorageOperations['readUsageState']['input']['records'] = []) { return this.request('readUsageState', { id, records }); }
  recordRevisions(records: StorageOperations['recordRevisions']['input']['records']) { return this.request('recordRevisions', { records }); }
  readFullHistory(id: string) { return this.request('readFullHistory', { id }); }
  appendHistory(id: string, messages: PlatformMessage[], options?: HistoryWriteOptions) { return this.request('appendHistory', { id, messages, options }); }
  replaceHistory(id: string, messages: PlatformMessage[], options?: HistoryWriteOptions) { return this.request('replaceHistory', { id, messages, options }); }
  forkConversation(sourceId: string, metadata: PlatformConversation, options: Pick<StorageOperations['forkConversation']['input'], 'beforeIndex' | 'expectedRevision' | 'records'> = {}) {
    return this.request('forkConversation', { sourceId, metadata, ...options });
  }
  deleteConversation(id: string) { return this.request('deleteConversation', { id }); }
  saveSnapshot(metadata: SnapshotMetadata, messages?: PlatformMessage[]) { return this.request('saveSnapshot', { metadata, messages }); }
  getSnapshot(id: string) { return this.request('getSnapshot', { id }); }
  listSnapshots(conversationId: string) { return this.request('listSnapshots', { conversationId }); }
  deleteSnapshot(id: string) { return this.request('deleteSnapshot', { id }); }
  putRecord(record: StoredRecord) { return this.request('putRecord', record); }
  getVersionedRecord(namespace: string, id: string, projection?: StorageOperations['getVersionedRecord']['input']['projection']) { return this.request('getVersionedRecord', { namespace, id, projection }); }
  commitRecords(mutations: RecordMutation[]) { return this.request('commitRecords', mutations); }
  getRecord(namespace: string, id: string) { return this.request('getRecord', { namespace, id }); }
  listRecords(namespace: string, ownerId?: string) { return this.request('listRecords', { namespace, ownerId }); }
  readRecordPage(namespace: string, ownerId: string, options: { afterId?: string; limit: number }) { return this.request('readRecordPage', { namespace, ownerId, ...options }); }
  deleteRecord(namespace: string, id: string) { return this.request('deleteRecord', { namespace, id }); }
  statistics() { return this.request('statistics', undefined); }
  verify() { return this.request('verify', undefined); }
  collectGarbage() { return this.request('collectGarbage', undefined); }
  checkpoint() { return this.request('checkpoint', undefined); }
  backupSnapshot() { return this.request('backupSnapshot', undefined); }

  /** Migration operations are atomic per batch and hidden from normal conversation listings. */
  beginMigration(value: StorageOperations['migrationBegin']['input']) { return this.request('migrationBegin', value); }
  appendMigration(value: StorageOperations['migrationAppend']['input']) { return this.request('migrationAppend', value); }
  finishMigration(value: StorageOperations['migrationFinish']['input']) { return this.request('migrationFinish', value); }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    if (this.unavailable) return Promise.resolve();
    this.closing = (async () => {
      const exited = new Promise<void>(resolve => this.worker.once('exit', () => resolve()));
      await this.request('close', undefined);
      await exited;
    })();
    return this.closing;
  }

  private request<M extends StorageMethod>(method: M, input: StorageOperations[M]['input']): Promise<StorageOperations[M]['output']> {
    if (this.unavailable) return Promise.reject(this.unavailable);
    if (this.closing && method !== 'close') return Promise.reject(new PlatformStorageError('STORAGE_CLOSED', 'Storage is closing.'));
    // 备份暂时占用存储线程时，正常请求继续排队，不能按固定条数拒绝正在使用的会话。
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: value => resolve(value as StorageOperations[M]['output']), reject });
      try { this.worker.postMessage({ id, method, input }); }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }

  private fail(error: Error): void {
    this.unavailable = error;
    for (const call of this.pending.values()) call.reject(error);
    this.pending.clear();
  }
}
