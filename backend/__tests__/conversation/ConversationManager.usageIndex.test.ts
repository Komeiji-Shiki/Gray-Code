/**
 * ConversationManager 用量索引挂接测试
 *
 * 覆盖：
 * - 消息落盘（getTranscriptRepository.saveContents 路径）后用量索引被维护
 * - 创建对话的空历史落盘不写索引
 * - 删除对话时索引被清理
 * - 索引写失败静默降级，不影响对话保存主流程
 */

import { ConversationManager } from '../../modules/conversation';
import { MemoryStorageAdapter } from '../../modules/conversation';
import type { UsageIndex, UsageIndexMessage, UsageIndexStore } from '../../modules/conversation/usageStats';
import type { Content } from '../../modules/conversation';

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

    test('appendUsageIndexMessages 优先走 appendUsageMessages 增量追加', async () => {
        const storage = new MemoryStorageAdapter();
        const appends: Array<{ id: string; messages: UsageIndexMessage[] }> = [];
        const store: UsageIndexStore = {
            async read() { return null; },
            async write() {},
            async remove() {},
            async getFreshness() { return 'missing'; },
            async appendUsageMessages(conversationId, messages) {
                appends.push({ id: conversationId, messages });
                return true;
            }
        };
        const manager = new ConversationManager(storage, store);

        const entries: UsageIndexMessage[] = [{
            timestamp: 1000,
            modelVersion: 'model-x',
            prompt: 100,
            candidates: 50,
            thoughts: 10,
            cacheCreation: 20,
            cacheRead: 30,
            source: 'subagent'
        }];
        await manager.appendUsageIndexMessages('conv-sub', entries);

        expect(appends).toHaveLength(1);
        expect(appends[0].id).toBe('conv-sub');
        expect(appends[0].messages).toEqual(entries);
    });

    test('appendUsageIndexMessages 在无 appendUsageMessages 时回退读改写，保留既有条目', async () => {
        const storage = new MemoryStorageAdapter();
        const writes: Array<{ id: string; index: UsageIndex }> = [];
        let current: UsageIndex | null = {
            version: 1,
            conversationId: 'conv-sub',
            updatedAt: 100,
            messages: [{
                timestamp: 900,
                modelVersion: 'model-main',
                prompt: 10,
                candidates: 5,
                thoughts: 0,
                cacheCreation: 0,
                cacheRead: 0
            }]
        };
        const store: UsageIndexStore = {
            async read() { return current; },
            async write(conversationId, index) {
                current = index;
                writes.push({ id: conversationId, index });
            },
            async remove() {},
            async getFreshness() { return 'fresh'; }
        };
        const manager = new ConversationManager(storage, store);

        await manager.appendUsageIndexMessages('conv-sub', [{
            timestamp: 1000,
            modelVersion: 'model-x',
            prompt: 100,
            candidates: 50,
            thoughts: 10,
            cacheCreation: 0,
            cacheRead: 0,
            source: 'subagent'
        }]);

        expect(writes).toHaveLength(1);
        // 既有主会话条目保留，subagent 条目追加
        expect(writes[0].index.messages).toHaveLength(2);
        expect(writes[0].index.messages[0].modelVersion).toBe('model-main');
        expect(writes[0].index.messages[1].source).toBe('subagent');
        expect(writes[0].index.messages[1].prompt).toBe(100);
    });

    test('updateUsageIndex 全量重建时保留已有 subagent 条目', async () => {
        const storage = new MemoryStorageAdapter();
        const writes: Array<{ id: string; index: UsageIndex }> = [];
        let current: UsageIndex | null = {
            version: 1,
            conversationId: 'conv-sub',
            updatedAt: 100,
            messages: [{
                timestamp: 1000,
                modelVersion: 'model-x',
                prompt: 100,
                candidates: 50,
                thoughts: 10,
                cacheCreation: 0,
                cacheRead: 0,
                source: 'subagent'
            }]
        };
        const store: UsageIndexStore = {
            async read() { return current; },
            async write(conversationId, index) {
                current = index;
                writes.push({ id: conversationId, index });
            },
            async remove() {},
            async getFreshness() { return 'fresh'; }
        };
        const manager = new ConversationManager(storage, store);

        // 主会话追加一条带用量的 model 消息（走 saveContents → updateUsageIndex 全量重建）
        await manager.addContent('conv-sub', {
            role: 'model',
            parts: [{ text: 'reply' }],
            timestamp: 2000,
            usageMetadata: {
                promptTokenCount: 300,
                candidatesTokenCount: 100
            } as Content['usageMetadata']
        });

        const lastWrite = writes[writes.length - 1];
        // 重建后的索引 = 主会话新消息 + 保留的 subagent 条目
        expect(lastWrite.index.messages).toHaveLength(2);
        expect(lastWrite.index.messages.some(m => m.prompt === 300 && m.source === undefined)).toBe(true);
        expect(lastWrite.index.messages.some(m => m.source === 'subagent' && m.prompt === 100)).toBe(true);
    });
});
