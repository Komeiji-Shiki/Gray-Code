/**
 * 内存存储适配器（拆分自 storage.ts，用于测试或临时存储）。
 *
 * storage.ts 通过 `export { MemoryStorageAdapter } from './memoryStorageAdapter'` 再导出，
 * 保持既有公共 API 不变。
 */

import type { ConversationHistory, ConversationMetadata, HistorySnapshot } from './types';
import type {
    ConversationStorageIntegrity,
    HistoryIndexInfo,
    IStorageAdapter,
    StorageHistoryPage,
    StorageReadResult,
    SubAgentTranscriptData,
} from './storageTypes';

export class MemoryStorageAdapter implements IStorageAdapter {
    private histories: Map<string, ConversationHistory> = new Map();
    private metadata: Map<string, ConversationMetadata> = new Map();
    private snapshots: Map<string, HistorySnapshot> = new Map();
    private subAgentTranscripts: Map<string, SubAgentTranscriptData> = new Map();

    async saveHistory(conversationId: string, history: ConversationHistory): Promise<void> {
        // 深拷贝以避免引用问题
        this.histories.set(conversationId, JSON.parse(JSON.stringify(history)));
    }

    async loadHistory(conversationId: string): Promise<ConversationHistory | null> {
        const history = this.histories.get(conversationId);
        return history ? JSON.parse(JSON.stringify(history)) : null;
    }

    async loadHistoryWithStatus(conversationId: string): Promise<StorageReadResult<ConversationHistory>> {
        const value = await this.loadHistory(conversationId);
        if (!value) {
            return { value: null, errorCode: 'not_found' };
        }
        return { value };
    }

    async loadHistoryPage(
        conversationId: string,
        options: { beforeIndex?: number; offset?: number; limit?: number } = {}
    ): Promise<StorageReadResult<StorageHistoryPage>> {
        const historyResult = await this.loadHistoryWithStatus(conversationId);
        if (!historyResult.value) {
            return { value: null, errorCode: historyResult.errorCode, errorMessage: historyResult.errorMessage };
        }

        const history = historyResult.value;
        const total = history.length;
        const limit = Math.max(1, Math.min(options.limit ?? 120, 1000));
        let startIndex = 0;
        let endExclusive = total;
        if (typeof options.beforeIndex === 'number' && Number.isFinite(options.beforeIndex)) {
            endExclusive = Math.max(0, Math.min(total, Math.floor(options.beforeIndex)));
            startIndex = Math.max(0, endExclusive - limit);
        } else if (typeof options.offset === 'number' && Number.isFinite(options.offset)) {
            startIndex = Math.max(0, Math.min(total, Math.floor(options.offset)));
            endExclusive = Math.max(startIndex, Math.min(total, startIndex + limit));
        } else { startIndex = Math.max(0, total - limit); }
        return { value: { total, startIndex, messages: JSON.parse(JSON.stringify(history.slice(startIndex, endExclusive))), format: 'legacy' } };
    }

    /** 追加历史（append-only，HIS-01）：内存实现直接 push 后单次深拷贝保存 */
    async appendHistory(conversationId: string, contents: ConversationHistory): Promise<void> {
        const existing = this.histories.get(conversationId) ?? [];
        existing.push(...contents);
        // 单次 structuredClone：避免 concat 新数组 + JSON 往返的双份全量拷贝（O(n²) 追加路径）
        this.histories.set(conversationId, structuredClone(existing));
    }

    /** 索引结构信息（HIS-11）：内存实现只查存在性，不解析消息 */
    async getHistoryIndexInfo(conversationId: string): Promise<HistoryIndexInfo> {
        const exists = this.histories.has(conversationId);
        return { exists, readable: exists };
    }

    async deleteHistory(conversationId: string): Promise<void> {
        this.histories.delete(conversationId);
        this.metadata.delete(conversationId);
        for (const key of this.subAgentTranscripts.keys()) {
            if (key.startsWith(`${conversationId}:`)) this.subAgentTranscripts.delete(key);
        }
    }

    async listConversations(): Promise<string[]> {
        return Array.from(this.histories.keys());
    }

    async saveSubAgentTranscript(conversationId: string, runId: string, data: SubAgentTranscriptData): Promise<string> {
        this.subAgentTranscripts.set(`${conversationId}:${runId}`, JSON.parse(JSON.stringify(data)));
        return `subagents/${encodeURIComponent(runId)}.json`;
    }

    async loadSubAgentTranscript(conversationId: string, runId: string): Promise<SubAgentTranscriptData | null> {
        const data = this.subAgentTranscripts.get(`${conversationId}:${runId}`);
        return data ? JSON.parse(JSON.stringify(data)) : null;
    }

    async deleteSubAgentTranscript(conversationId: string, runId: string): Promise<void> {
        this.subAgentTranscripts.delete(`${conversationId}:${runId}`);
    }

    async saveMetadata(metadata: ConversationMetadata): Promise<void> {
        this.metadata.set(metadata.id, JSON.parse(JSON.stringify(metadata)));
    }

    async loadMetadata(conversationId: string): Promise<ConversationMetadata | null> {
        const meta = this.metadata.get(conversationId);
        return meta ? JSON.parse(JSON.stringify(meta)) : null;
    }

    async loadMetadataWithStatus(conversationId: string): Promise<StorageReadResult<ConversationMetadata>> {
        const value = await this.loadMetadata(conversationId);
        if (!value) {
            return { value: null, errorCode: 'not_found' };
        }
        return { value };
    }

    async getConversationIntegrity(conversationId: string): Promise<ConversationStorageIntegrity> {
        const historyExists = this.histories.has(conversationId);
        const metadataExists = this.metadata.has(conversationId);
        return {
            historyExists,
            metadataExists,
            historyReadable: historyExists,
            metadataReadable: metadataExists,
            historyErrorCode: historyExists ? undefined : 'not_found',
            metadataErrorCode: metadataExists ? undefined : 'not_found',
        };
    }

    async saveSnapshot(snapshot: HistorySnapshot): Promise<void> {
        this.snapshots.set(snapshot.id, JSON.parse(JSON.stringify(snapshot)));
    }

    async loadSnapshot(snapshotId: string): Promise<HistorySnapshot | null> {
        const snapshot = this.snapshots.get(snapshotId);
        return snapshot ? JSON.parse(JSON.stringify(snapshot)) : null;
    }

    async deleteSnapshot(snapshotId: string): Promise<void> {
        this.snapshots.delete(snapshotId);
    }

    async listSnapshots(conversationId: string): Promise<string[]> {
        const snapshots = Array.from(this.snapshots.values());
        return snapshots
            .filter(s => s.conversationId === conversationId)
            .map(s => s.id);
    }

    /**
     * 清空所有数据
     */
    clear(): void {
        this.histories.clear();
        this.metadata.clear();
        this.snapshots.clear();
        this.subAgentTranscripts.clear();
    }
}
