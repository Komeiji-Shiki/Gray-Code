/**
 * 分页读取路径的工具调用配对完整性。
 *
 * getMessages（全量）一直会把未响应的 functionCall 标记为 rejected 并补 functionResponse，
 * 但 getMessagesPaged 的分段存储快路径直接返回窗口，跳过了这一步。于是在分段存储下，
 * 流式取消留下的悬空 tool_use 永远不会被补齐，下一次请求会被 provider 以 400 拒绝。
 */

import { ConversationManager } from '../../modules/conversation/ConversationManager';
import { MemoryStorageAdapter } from '../../modules/conversation/storage';
import type { StorageHistoryPage, StorageReadResult } from '../../modules/conversation/storage';
import type { ConversationHistory } from '../../modules/conversation/types';

/** 模拟分段存储：走 getMessagesPaged 的 format === 'paged' 快路径 */
class PagedMemoryStorageAdapter extends MemoryStorageAdapter {
    pageReads = 0;

    async loadHistoryPage(
        conversationId: string,
        options: { beforeIndex?: number; offset?: number; limit?: number } = {}
    ): Promise<StorageReadResult<StorageHistoryPage>> {
        this.pageReads++;
        const result = await super.loadHistoryPage(conversationId, options);
        if (result.value) {
            result.value.format = 'paged';
        }
        return result;
    }
}

/** 流式取消后的典型历史：model 消息里落下了完整的 functionCall，没有对应的 functionResponse */
function historyWithDanglingCall(): ConversationHistory {
    return [
        { role: 'user', parts: [{ text: '读一下这个文件' }], isUserInput: true, timestamp: 100 },
        {
            role: 'model',
            parts: [
                { text: '好的，我来读。' },
                { functionCall: { id: 'call_1', name: 'read_file', args: { path: 'a.ts' } } }
            ],
            timestamp: 200
        }
    ] as ConversationHistory;
}

describe('getMessagesPaged - 悬空工具调用补齐', () => {
    it('分段存储首次加载会补齐悬空 functionCall', async () => {
        const storage = new PagedMemoryStorageAdapter();
        const manager = new ConversationManager(storage);
        await storage.saveHistory('conv', historyWithDanglingCall());

        const page = await manager.getMessagesPaged('conv');

        expect(page.total).toBe(3);
        const inserted = page.messages[2];
        expect(inserted.role).toBe('user');
        expect(inserted.isFunctionResponse).toBe(true);
        expect(inserted.parts[0].functionResponse?.id).toBe('call_1');
        expect(inserted.parts[0].functionResponse?.response).toMatchObject({ success: false, rejected: true });

        // 补齐写回了存储：模型消息上的调用被标记为 rejected
        const persisted = await storage.loadHistory('conv');
        expect(persisted![1].parts[1].functionCall?.rejected).toBe(true);
    });

    it('补齐是幂等的：已配对的历史不会被再次插入', async () => {
        const storage = new PagedMemoryStorageAdapter();
        const manager = new ConversationManager(storage);
        await storage.saveHistory('conv', historyWithDanglingCall());

        const first = await manager.getMessagesPaged('conv');
        const second = await manager.getMessagesPaged('conv');

        expect(first.total).toBe(3);
        expect(second.total).toBe(3);
    });

    it('上拉加载更早消息不重复做全量补齐', async () => {
        const storage = new PagedMemoryStorageAdapter();
        const manager = new ConversationManager(storage);
        await storage.saveHistory('conv', historyWithDanglingCall());

        await manager.getMessagesPaged('conv');
        const earlier = await manager.getMessagesPaged('conv', { beforeIndex: 2, limit: 2 });

        // 窗口本身仍然正确，且不会因为再跑一次补齐而改变总数
        expect(earlier.total).toBe(3);
        expect(earlier.messages.map(m => m.index)).toEqual([0, 1]);
    });

    it('本来就配对的历史保持原样', async () => {
        const storage = new PagedMemoryStorageAdapter();
        const manager = new ConversationManager(storage);
        const paired = [
            ...historyWithDanglingCall(),
            {
                role: 'user',
                parts: [{ functionResponse: { id: 'call_1', name: 'read_file', response: { success: true } } }],
                isFunctionResponse: true,
                timestamp: 300
            }
        ] as ConversationHistory;
        await storage.saveHistory('conv', paired);

        const page = await manager.getMessagesPaged('conv');

        expect(page.total).toBe(3);
        expect(page.messages[1].parts[1].functionCall?.rejected).toBeUndefined();
    });
});
