import { MemoryStorageAdapter } from '../../modules/conversation/memoryStorageAdapter';
import type { ConversationHistory } from '../../modules/conversation/types';

/** 为管理器业务用例提供轻量计数端口，保留现有内存适配器的读写行为。 */
export class IndexedMemoryStorage extends MemoryStorageAdapter {
    private readonly totals = new Map<string, number>();

    async saveHistory(conversationId: string, history: ConversationHistory): Promise<void> {
        await super.saveHistory(conversationId, history);
        this.totals.set(conversationId, history.length);
    }

    async appendHistory(conversationId: string, contents: ConversationHistory): Promise<void> {
        await super.appendHistory(conversationId, contents);
        this.totals.set(conversationId, (this.totals.get(conversationId) ?? 0) + contents.length);
    }

    async deleteHistory(conversationId: string): Promise<void> {
        await super.deleteHistory(conversationId);
        this.totals.delete(conversationId);
    }

    async getHistoryTotalMessages(conversationId: string): Promise<number | null> {
        return this.totals.get(conversationId) ?? null;
    }
}
