/** 管理器在存储报告元数据损坏时的降级、备份委托与后续写入行为。 */
import { ConversationManager } from '../../modules/conversation';
import { IndexedMemoryStorage } from '../__fixtures__/indexedMemoryStorage';
import { makeContent } from '../__fixtures__/conversationFixtures';

describe('getMetadata 损坏降级（parse_error → fallback + 备份，不抛 UNKNOWN_ERROR）', () => {
    test('元数据损坏：getMetadata 返回 fallback，并委托存储备份损坏内容', async () => {
        const adapter = Object.assign(new IndexedMemoryStorage(), {
            backupCorruptMetadata: jest.fn(async (_conversationId: string) => {}),
        });
        const manager = new ConversationManager(adapter);
        await manager.createConversation('conv-corrupt', 'Original Title');
        jest.spyOn(adapter, 'loadMetadataWithStatus').mockResolvedValue({ value: null, errorCode: 'parse_error' });

        const meta = await manager.getMetadata('conv-corrupt');

        expect(meta).not.toBeNull();
        expect(meta!.id).toBe('conv-corrupt');
        expect(meta!.integrityStatus).toBe('meta_corrupt');
        expect(typeof meta!.title).toBe('string');
        expect(meta!.title).not.toBe('Original Title');
        expect(meta!.custom ?? {}).toEqual({});
        expect(adapter.backupCorruptMetadata).toHaveBeenCalledWith('conv-corrupt');
    });

    test('降级后写路径恢复正常：updateSummary 基于重建元数据成功覆盖', async () => {
        const adapter = Object.assign(new IndexedMemoryStorage(), {
            backupCorruptMetadata: jest.fn(async (_conversationId: string) => {}),
        });
        const manager = new ConversationManager(adapter);
        await manager.createConversation('conv-recover', 'R');
        await manager.addBatch('conv-recover', [makeContent('user', 'a'), makeContent('model', 'b')]);
        const read = jest.spyOn(adapter, 'loadMetadataWithStatus')
            .mockResolvedValue({ value: null, errorCode: 'parse_error' });
        // 备份后存储报告缺失，管理器必须重建基础元数据才能继续保存摘要。
        adapter.backupCorruptMetadata.mockImplementation(async () => {
            read.mockResolvedValue({ value: null, errorCode: 'not_found' });
        });

        expect(await manager.getMetadata('conv-recover')).not.toBeNull();
        await manager.updateSummary('conv-recover', { messageCount: 1, preview: 'p' });

        const meta = await adapter.loadMetadata('conv-recover');
        expect(meta).not.toBeNull();
        expect(meta!.custom!.messageCount).toBe(2);
        expect(meta!.custom!.preview).toBe('p');
        expect(adapter.backupCorruptMetadata).toHaveBeenCalledWith('conv-recover');
    });

    test('元数据损坏：getCustomMetadata 不抛错返回 undefined', async () => {
        const adapter = new IndexedMemoryStorage();
        const manager = new ConversationManager(adapter);
        await manager.createConversation('conv-custom-corrupt', 'C');
        await manager.setCustomMetadata('conv-custom-corrupt', 'todoList', [{ id: 't1', text: 'a' }]);
        jest.spyOn(adapter, 'loadMetadataWithStatus').mockResolvedValue({ value: null, errorCode: 'parse_error' });

        await expect(manager.getCustomMetadata('conv-custom-corrupt', 'todoList')).resolves.toBeUndefined();
    });
});
