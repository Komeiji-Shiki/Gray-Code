import { PlatformStorage, PlatformStorageError, type PlatformMessage } from '@graycode/core';
import type { Content, ConversationHistory, ConversationMetadata, HistorySnapshot } from './types';
import type {
  IStorageAdapter, StorageReadResult, StorageHistoryPage, ConversationStorageIntegrity,
  HistoryIndexInfo, SubAgentTranscriptData,
} from './storageTypes';

function toPlatform(content: Content): PlatformMessage {
  return { ...content, parts: content.parts.map(part => ({ ...part })) };
}

/** Connects existing conversation semantics to the independent SQLite service. No VS Code API. */
export class SqliteStorageAdapter implements IStorageAdapter {
  constructor(readonly platform: PlatformStorage) {}

  async createConversation(metadata: ConversationMetadata): Promise<void> {
    await this.platform.createConversation({ ...metadata });
  }

  async saveMetadata(metadata: ConversationMetadata): Promise<void> {
    const current = await this.platform.getConversation(metadata.id);
    if (current) await this.platform.saveMetadata({ ...metadata });
    else await this.platform.createConversation({ ...metadata });
  }

  async loadMetadata(id: string): Promise<ConversationMetadata | null> {
    const info = await this.platform.getConversationInfo(id);
    if (!info) return null;
    const metadata = info.metadata as ConversationMetadata;
    return { ...metadata, custom: { ...metadata.custom, messageCount: info.messageCount } };
  }

  loadMetadataWithStatus(id: string): Promise<StorageReadResult<ConversationMetadata>> {
    return this.read(() => this.loadMetadata(id));
  }

  async saveHistory(id: string, history: ConversationHistory): Promise<void> {
    await this.platform.replaceHistory(id, history.map(toPlatform));
  }

  async appendHistory(id: string, contents: ConversationHistory): Promise<void> {
    await this.platform.appendHistory(id, contents.map(toPlatform));
  }

  /**
   * 平台运行时模式：会话当前活跃（未终结）任务的 ID 集合。
   * 读取路径的悬空调用补齐用它跳过"结果尚未落盘"的在途调用，避免给迟到的真实
   * 结果制造重复响应（duplicate_function_response_id）。
   */
  async listActiveRunIds(conversationId: string): Promise<Set<string> | undefined> {
      const runs = await this.platform.listRuns({ conversationId, activeOnly: true });
      return new Set(runs.map(run => run.id));
  }

  async mutateHistoryIfIdle(id: string, mutator: (history: ConversationHistory) => ConversationHistory): Promise<ConversationHistory> {
    const page = await this.platform.readFullHistory(id);
    const history = page.messages as ConversationHistory;
    const next = mutator(history);
    if (next === history) return history;
    try {
      // 运行器直接写 SQLite，不经过 ConversationManager 的写锁；只有存储事务能保护两者。
      await this.platform.commitConversation({ conversationId: id, expectedRevision: page.revision, messages: next.map(toPlatform) });
      return next;
    } catch (error) {
      if (!(error instanceof PlatformStorageError) || !['STORAGE_BUSY', 'REVISION_CONFLICT'].includes(error.code)) throw error;
      return (await this.platform.readFullHistory(id)).messages as ConversationHistory;
    }
  }

  async loadHistory(id: string): Promise<ConversationHistory | null> {
    try {
      return (await this.platform.readFullHistory(id)).messages as Content[];
    } catch (error) {
      if (error instanceof PlatformStorageError && error.code === 'NOT_FOUND') return null;
      throw error;
    }
  }

  loadHistoryWithStatus(id: string): Promise<StorageReadResult<ConversationHistory>> {
    return this.read(() => this.loadHistory(id));
  }

  async loadHistoryPage(id: string, options: { beforeIndex?: number; offset?: number; limit?: number } = {}): Promise<StorageReadResult<StorageHistoryPage>> {
    return this.read(async () => {
      // Retain the existing adapter's clamp and precedence at its compatibility boundary.
      const limit = Math.max(1, Math.min(Math.floor(options.limit ?? 120), 1000));
      const beforeIndex = Number.isFinite(options.beforeIndex) ? Math.max(0, Math.floor(options.beforeIndex!)) : undefined;
      const offset = beforeIndex === undefined && Number.isFinite(options.offset) ? Math.max(0, Math.floor(options.offset!)) : undefined;
      const page = await this.platform.readHistory(id, { limit, beforeIndex, offset });
      return { total: page.total, startIndex: page.startIndex, messages: page.messages as Content[], format: 'paged' };
    });
  }

  async deleteHistory(id: string): Promise<void> { await this.platform.deleteConversation(id); }

  async listConversations(): Promise<string[]> {
    const ids: string[] = [];
    let cursor: { updatedAt: number; id: string } | undefined;
    do {
      const page = await this.platform.listConversations({ limit: 1000, cursor });
      ids.push(...page.items.map(item => item.id)); cursor = page.nextCursor;
    } while (cursor);
    return ids;
  }

  async getHistoryTotalMessages(id: string): Promise<number | null> {
    try { return (await this.platform.historyInfo(id)).total; }
    catch (error) {
      if (error instanceof PlatformStorageError && error.code === 'NOT_FOUND') return null;
      throw error;
    }
  }

  async getHistoryIndexInfo(id: string): Promise<HistoryIndexInfo> {
    try {
      const total = await this.getHistoryTotalMessages(id);
      return total === null ? { exists: false, readable: false } : { exists: true, readable: true, totalMessages: total };
    } catch (error) {
      return { exists: true, readable: false, errorCode: this.readError(error), errorMessage: (error as Error).message };
    }
  }

  async getConversationIntegrity(id: string): Promise<ConversationStorageIntegrity> {
    const metadata = await this.loadMetadataWithStatus(id);
    const history = await this.getHistoryIndexInfo(id);
    return { historyExists: history.exists, metadataExists: metadata.value !== null || metadata.errorCode !== 'not_found',
      historyReadable: history.readable, metadataReadable: metadata.value !== null,
      historyErrorCode: history.errorCode, historyErrorMessage: history.errorMessage,
      metadataErrorCode: metadata.errorCode, metadataErrorMessage: metadata.errorMessage };
  }

  async saveSnapshot(snapshot: HistorySnapshot): Promise<void> {
    const { history, ...metadata } = snapshot;
    await this.platform.saveSnapshot(metadata, history.map(toPlatform));
  }
  async loadSnapshot(id: string): Promise<HistorySnapshot | null> { return await this.platform.getSnapshot(id) as HistorySnapshot | null; }
  async deleteSnapshot(id: string): Promise<void> { await this.platform.deleteSnapshot(id); }
  listSnapshots(conversationId: string): Promise<string[]> { return this.platform.listSnapshots(conversationId); }

  async saveSubAgentTranscript(conversationId: string, runId: string, data: SubAgentTranscriptData): Promise<string> {
    const id = this.transcriptId(conversationId, runId);
    await this.platform.putRecord({ namespace: 'subagent-transcript', id, ownerId: conversationId, value: data });
    return `platform:subagent-transcript:${encodeURIComponent(conversationId)}:${encodeURIComponent(runId)}`;
  }
  async loadSubAgentTranscript(conversationId: string, runId: string): Promise<SubAgentTranscriptData | null> {
    return await this.platform.getRecord('subagent-transcript', this.transcriptId(conversationId, runId)) as SubAgentTranscriptData | null;
  }
  async deleteSubAgentTranscript(conversationId: string, runId: string): Promise<void> {
    await this.platform.deleteRecord('subagent-transcript', this.transcriptId(conversationId, runId));
  }

  private transcriptId(conversationId: string, runId: string): string { return JSON.stringify([conversationId, runId]); }
  private readError(error: unknown): 'not_found' | 'parse_error' | 'io_error' {
    return error instanceof PlatformStorageError && error.code === 'NOT_FOUND' ? 'not_found'
      : error instanceof PlatformStorageError && error.code === 'CORRUPT_DATA' ? 'parse_error' : 'io_error';
  }
  private async read<T>(load: () => Promise<T | null>): Promise<StorageReadResult<T>> {
    try {
      const value = await load();
      return value === null ? { value: null, errorCode: 'not_found' } : { value };
    } catch (error) { return { value: null, errorCode: this.readError(error), errorMessage: (error as Error).message }; }
  }
}
