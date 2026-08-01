/**
 * ConversationManager 用量索引挂接测试
 *
 * 覆盖：
 * - 消息落盘（getTranscriptRepository.saveContents 路径）后用量索引被维护
 * - 创建对话的空历史落盘不写索引
 * - 删除对话时索引被清理
 * - 索引写失败静默降级，不影响对话保存主流程
 */

import { ConversationManager } from '../../modules/conversation/ConversationManager';
import { MemoryStorageAdapter } from '../../modules/conversation/storage';
import type { UsageIndex, UsageIndexStore } from '../../modules/conversation/usageStats';
import type { Content } from '../../modules/conversation/types';

describe('ConversationManager 用量索引挂接', () => {
    test('消息落盘时维护用量索引（含 token 提取），删除对话时清理索引', async () => {
        const storage = new MemoryStorageAdapter();
        const writes: Array<{ id: string; index: UsageIndex }> = [];
        const removes: string[] = [];
        const store: UsageIndexStore = {
            async read() { return null; },
            async write(conversationId, index) { writes.push({ id: conversationId, index }); },
            async remove(conversationId) { removes.push(conversationId); },
            async getFreshness() { return 'missing'; }
        };
        const manager = new ConversationManager(storage, store);
        const convId = 'conv-usage-index';

        // 创建对话落盘空历史：不写索引
        await manager.createConversation(convId, 'Usage Index');
        expect(writes).toHaveLength(0);

        // 追加带用量的 model 消息：索引被维护
        await manager.addContent(convId, {
            role: 'model',
            parts: [{ text: 'reply' }],
            timestamp: 1000,
            usageMetadata: {
                promptTokenCount: 120,
                candidatesTokenCount: 60
            } as Content['usageMetadata']
        });
        expect(writes.length).toBeGreaterThan(0);
        const lastWrite = writes[writes.length - 1];
        expect(lastWrite.id).toBe(convId);
        expect(lastWrite.index.messages).toHaveLength(1);
        expect(lastWrite.index.messages[0].prompt).toBe(120);
        expect(lastWrite.index.messages[0].candidates).toBe(60);
        expect(lastWrite.index.messages[0].timestamp).toBe(1000);

        // 删除对话：索引被清理
        await manager.deleteConversation(convId);
        expect(removes).toContain(convId);
    });

    test('索引写失败静默降级，不影响对话保存主流程', async () => {
        const storage = new MemoryStorageAdapter();
        const store: UsageIndexStore = {
            async read() { return null; },
            async write() { throw new Error('disk full'); },
            async remove() {},
            async getFreshness() { return 'missing'; }
        };
        const manager = new ConversationManager(storage, store);
        const convId = 'conv-fail';

        await manager.addContent(convId, {
            role: 'user',
            parts: [{ text: 'hi' }],
            timestamp: 1
        } as Content);

        // 消息仍成功落盘（索引写失败被静默吞掉）
        const history = await manager.getHistory(convId);
        expect(history).toHaveLength(1);
        expect(history[0].role).toBe('user');
    });
});
