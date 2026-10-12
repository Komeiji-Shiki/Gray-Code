/**
 * updateSummary M3 钳制轻量化（优先使用存储计数端口）与
 * 元数据语义（updatedAt 不在此写 / 批量摘要截断标志）测试。
 *
 * 覆盖：
 * - 钳制优先读取轻量消息总数，不加载完整历史；
 * - 存储未提供可读消息总数时跳过钳制，按原值保存；
 * - updateSummary 不移动 meta.updatedAt（由历史提交路径统一维护，注释语义落地）；
 * - getConversationMetadataBatch 超过 200 条时返回 truncated 标志（数组主体不变，前端兼容）。
 */

import { ConversationManager } from '../../modules/conversation';
import { MemoryStorageAdapter } from '../../modules/conversation';
import { IndexedMemoryStorage } from '../__fixtures__/indexedMemoryStorage';
import { makeHistory } from '../__fixtures__/conversationFixtures';

describe('updateSummary M3 钳制轻量化（优先读取消息总数）', () => {
    test('钳制只使用轻量计数端口，不加载完整历史', async () => {
        const adapter = new IndexedMemoryStorage();
        const manager = new ConversationManager(adapter);
        await manager.createConversation('conv-light', 'Light');
        await manager.addBatch('conv-light', makeHistory(210));
        const totalRead = jest.spyOn(adapter, 'getHistoryTotalMessages');
        const indexRead = jest.spyOn(adapter, 'getHistoryIndexInfo');
        const historyRead = jest.spyOn(adapter, 'loadHistory');

        await manager.updateSummary('conv-light', { messageCount: 1000 });

        const meta = await adapter.loadMetadata('conv-light');
        expect(meta!.custom!.messageCount).toBe(210);
        expect(totalRead).toHaveBeenCalledWith('conv-light');
        expect(indexRead).not.toHaveBeenCalled();
        expect(historyRead).not.toHaveBeenCalled();
    });

    test('迟到的较小摘要不会覆盖已提交的消息数，仍使用轻量计数', async () => {
        const adapter = new IndexedMemoryStorage();
        const manager = new ConversationManager(adapter);
        await manager.createConversation('conv-late-summary', 'Late summary');
        await manager.addBatch('conv-late-summary', makeHistory(210));
        const totalRead = jest.spyOn(adapter, 'getHistoryTotalMessages');
        const historyRead = jest.spyOn(adapter, 'loadHistory');

        await manager.updateSummary('conv-late-summary', { messageCount: 6, preview: '旧摘要' });

        const meta = await adapter.loadMetadata('conv-late-summary');
        expect(meta!.custom!.messageCount).toBe(210);
        expect(meta!.custom!.preview).toBe('旧摘要');
        expect(totalRead).toHaveBeenCalledWith('conv-late-summary');
        expect(historyRead).not.toHaveBeenCalled();
    });

    test('存储未提供消息总数时钳制跳过，messageCount 按原值保存', async () => {
        const adapter = new MemoryStorageAdapter();
        const manager = new ConversationManager(adapter);
        await adapter.saveHistory('conv-legacy', makeHistory(2));

        await manager.updateSummary('conv-legacy', { messageCount: 5 });

        const meta = await adapter.loadMetadata('conv-legacy');
        expect(meta).not.toBeNull();
        expect(meta!.custom!.messageCount).toBe(5);
    });
});

describe('updateSummary 注释语义：updatedAt 由历史提交统一维护，不在此写', () => {
    test('updateSummary 不移动 meta.updatedAt（避免 append 失败场景下列表排序抖动）', async () => {
        const storage = new MemoryStorageAdapter();
        const manager = new ConversationManager(storage);
        await manager.createConversation('conv-ua', 'UA');

        // 固定 updatedAt，模拟历史提交路径已维护的时间
        const meta = await storage.loadMetadata('conv-ua');
        meta!.updatedAt = 12345;
        await storage.saveMetadata(meta!);

        await manager.updateSummary('conv-ua', { messageCount: 3, preview: 'p' });

        const after = await storage.loadMetadata('conv-ua');
        expect(after!.updatedAt).toBe(12345); // 未被 updateSummary 前移
        expect(after!.custom!.messageCount).toBe(3);
        expect(after!.custom!.preview).toBe('p');
    });
});

describe('getConversationMetadataBatch 截断标志', () => {
    test('超过 200 个 ID 时返回 truncated 标志（数组主体仍是 200 条摘要）', async () => {
        const storage = new MemoryStorageAdapter();
        const manager = new ConversationManager(storage);
        const ids = Array.from({ length: 250 }, (_, i) => `conv-t-${i}`);

        const summaries = await manager.getConversationMetadataBatch(ids) as any;
        expect(summaries).toHaveLength(200);
        expect(summaries[0].id).toBe('conv-t-0');
        expect(summaries[199].id).toBe('conv-t-199');
        expect(summaries.truncated).toBe(true);
    });

    test('≤200 个 ID 时不带 truncated 标志', async () => {
        const storage = new MemoryStorageAdapter();
        const manager = new ConversationManager(storage);
        const ids = Array.from({ length: 200 }, (_, i) => `conv-t2-${i}`);

        const summaries = await manager.getConversationMetadataBatch(ids) as any;
        expect(summaries).toHaveLength(200);
        expect(summaries.truncated).toBeUndefined();
    });
});
