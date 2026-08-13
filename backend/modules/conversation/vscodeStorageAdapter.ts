/**
 * VS Code ExtensionContext 存储适配器（拆分自 storage.ts）。
 * 使用 VS Code 的 globalState 或 workspaceState。
 *
 * storage.ts 通过 `export { VSCodeStorageAdapter } from './vscodeStorageAdapter'` 再导出，
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
import { withMetadataWriteSerialized } from './storageWriteQueues';

export class VSCodeStorageAdapter implements IStorageAdapter {
    constructor(
        private context: any // vscode.ExtensionContext
    ) {}

    async saveHistory(conversationId: string, history: ConversationHistory): Promise<void> {
        const key = `limcode.history.${conversationId}`;
        await this.context.globalState.update(key, history);
        
        // 更新元数据的 updatedAt（必须与 ConversationManager 的元数据读改写共用同一条链，
        // 否则基于旧 meta 的整体写回会互相覆盖 custom 字段）
        await withMetadataWriteSerialized(conversationId, async () => {
            const metaKey = `limcode.meta.${conversationId}`;
            const meta = this.context.globalState.get(metaKey) as ConversationMetadata | undefined;
            if (meta) {
                meta.updatedAt = Date.now();
                await this.context.globalState.update(metaKey, meta);
            }
        });
    }

    async loadHistory(conversationId: string): Promise<ConversationHistory | null> {
        const key = `limcode.history.${conversationId}`;
        return (this.context.globalState.get(key) as ConversationHistory | undefined) || null;
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

    /** 追加历史（append-only，HIS-01）：globalState 直接追加后整体更新 */
    async appendHistory(conversationId: string, contents: ConversationHistory): Promise<void> {
        const key = `limcode.history.${conversationId}`;
        const existing = (this.context.globalState.get(key) as ConversationHistory | undefined) || [];
        await this.context.globalState.update(key, existing.concat(contents));

        // 与 saveHistory 同链更新 updatedAt（避免覆盖 custom 字段）
        await withMetadataWriteSerialized(conversationId, async () => {
            const metaKey = `limcode.meta.${conversationId}`;
            const meta = this.context.globalState.get(metaKey) as ConversationMetadata | undefined;
            if (meta) {
                meta.updatedAt = Date.now();
                await this.context.globalState.update(metaKey, meta);
            }
        });
    }

    /** 索引结构信息（HIS-11）：globalState 只查存在性 */
    async getHistoryIndexInfo(conversationId: string): Promise<HistoryIndexInfo> {
        const key = `limcode.history.${conversationId}`;
        return { exists: this.context.globalState.get(key) !== undefined, readable: true };
    }

    /** 索引消息总数（HIS-11 轻量路径）：globalState 直接取数组长度，无逐段 stat */
    async getHistoryTotalMessages(conversationId: string): Promise<number | null> {
        const key = `limcode.history.${conversationId}`;
        const history = this.context.globalState.get(key) as ConversationHistory | undefined;
        return history ? history.length : null;
    }

    async deleteHistory(conversationId: string): Promise<void> {
        const historyKey = `limcode.history.${conversationId}`;
        const metaKey = `limcode.meta.${conversationId}`;
        await withMetadataWriteSerialized(conversationId, async () => {
            await this.context.globalState.update(historyKey, undefined);
            await this.context.globalState.update(metaKey, undefined);
            const prefix = `limcode.subagent.${conversationId}.`;
            for (const key of this.context.globalState.keys()) {
                if (key.startsWith(prefix)) await this.context.globalState.update(key, undefined);
            }
        });
    }

    async listConversations(): Promise<string[]> {
        const keys = this.context.globalState.keys();
        return keys
            .filter((k: string) => k.startsWith('limcode.history.'))
            .map((k: string) => k.replace('limcode.history.', ''));
    }

    async saveSubAgentTranscript(conversationId: string, runId: string, data: SubAgentTranscriptData): Promise<string> {
        await this.context.globalState.update(`limcode.subagent.${conversationId}.${runId}`, data);
        return `globalState:${runId}`;
    }

    async loadSubAgentTranscript(conversationId: string, runId: string): Promise<SubAgentTranscriptData | null> {
        return (this.context.globalState.get(`limcode.subagent.${conversationId}.${runId}`) as SubAgentTranscriptData | undefined) ?? null;
    }

    async deleteSubAgentTranscript(conversationId: string, runId: string): Promise<void> {
        await this.context.globalState.update(`limcode.subagent.${conversationId}.${runId}`, undefined);
    }

    async saveMetadata(metadata: ConversationMetadata): Promise<void> {
        const key = `limcode.meta.${metadata.id}`;
        await this.context.globalState.update(key, metadata);
    }

    async loadMetadata(conversationId: string): Promise<ConversationMetadata | null> {
        const key = `limcode.meta.${conversationId}`;
        return (this.context.globalState.get(key) as ConversationMetadata | undefined) || null;
    }

    async loadMetadataWithStatus(conversationId: string): Promise<StorageReadResult<ConversationMetadata>> {
        const value = await this.loadMetadata(conversationId);
        if (!value) {
            return { value: null, errorCode: 'not_found' };
        }
        return { value };
    }

    async getConversationIntegrity(conversationId: string): Promise<ConversationStorageIntegrity> {
        const history = await this.loadHistoryWithStatus(conversationId);
        const metadata = await this.loadMetadataWithStatus(conversationId);
        const historyExists = history.value !== null || history.errorCode !== 'not_found';
        const metadataExists = metadata.value !== null || metadata.errorCode !== 'not_found';
        return {
            historyExists,
            metadataExists,
            historyReadable: history.value !== null,
            metadataReadable: metadata.value !== null,
            historyErrorCode: history.errorCode,
            metadataErrorCode: metadata.errorCode,
            historyErrorMessage: history.errorMessage,
            metadataErrorMessage: metadata.errorMessage,
        };
    }

    async saveSnapshot(snapshot: HistorySnapshot): Promise<void> {
        const key = `limcode.snapshot.${snapshot.id}`;
        await this.context.globalState.update(key, snapshot);
    }

    async loadSnapshot(snapshotId: string): Promise<HistorySnapshot | null> {
        const key = `limcode.snapshot.${snapshotId}`;
        return (this.context.globalState.get(key) as HistorySnapshot | undefined) || null;
    }

    async deleteSnapshot(snapshotId: string): Promise<void> {
        const key = `limcode.snapshot.${snapshotId}`;
        await this.context.globalState.update(key, undefined);
    }

    async listSnapshots(conversationId: string): Promise<string[]> {
        const keys = this.context.globalState.keys();
        const snapshotKeys = keys.filter((k: string) => k.startsWith('limcode.snapshot.'));
        
        const snapshots: string[] = [];
        for (const key of snapshotKeys) {
            const snapshot = this.context.globalState.get(key) as HistorySnapshot | undefined;
            if (snapshot && snapshot.conversationId === conversationId) {
                snapshots.push(snapshot.id);
            }
        }
        return snapshots;
    }
}
