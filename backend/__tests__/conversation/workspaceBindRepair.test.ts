/**
 * 对话绑定工作区 — 元数据保留与归一化测试。
 *
 * 覆盖（1.7.3 绑定工作区修复批次）：
 * - H4 自动建会话：历史缺失但元数据已存在时保留原标题/绑定工作区/自定义字段，
 *   仅补建空历史与用量索引；原元数据无绑定时按 H4 语义补绑调用方 hint；
 *   已绑定时不被 hint 覆盖（绑定即终身）。
 * - setWorkspaceUri / createConversation 的 workspaceUri 归一化：
 *   null / 空白 → undefined（解绑），脏 URI 去除首尾空白，避免字面 null 持久化。
 */

import { ConversationManager } from '../../modules/conversation/ConversationManager';
import { MemoryStorageAdapter } from '../../modules/conversation/storage';
import { createAdapter } from './helpers/fakeVscodeFs';

const WS_A = 'file:///c%3A/Users/foo/ProjectA';
const WS_B = 'file:///c%3A/Users/foo/ProjectB';

/** 模拟历史文件被清理（删除会话目录下全部文件，保留 {id}.meta.json） */
function deleteHistoryKeepMeta(fake: { files: Map<string, string> }, conversationId: string): void {
    // 历史文件位于 conversations/{id}/ 目录内，meta.json 位于目录外（{id}.meta.json）
    const marker = `conversations/${conversationId}/`;
    for (const key of Array.from(fake.files.keys())) {
        if (key.includes(marker)) {
            fake.files.delete(key);
        }
    }
}

describe('H4 自动建会话：元数据存在时保留原绑定（修复重建丢失）', () => {
    test('历史缺失 + 元数据已绑定：保留绑定/标题/自定义字段，hint 不覆盖（绑定即终身）', async () => {
        const { adapter, fake } = createAdapter();
        const manager1 = new ConversationManager(adapter);
        await manager1.createConversation('conv-h4-a', '原标题');
        await manager1.setWorkspaceUri('conv-h4-a', WS_B);
        await manager1.setCustomMetadata('conv-h4-a', 'inputModelConfig', { model: 'test-model' });

        deleteHistoryKeepMeta(fake, 'conv-h4-a');

        // 新实例（缓存清空）走 H4 路径，且 hint 指向另一工作区
        const manager2 = new ConversationManager(adapter);
        const messages = await manager2.getMessages('conv-h4-a', WS_A);
        expect(messages).toEqual([]);

        const meta = await manager2.getMetadata('conv-h4-a');
        expect(meta?.workspaceUri).toBe(WS_B);
        expect(meta?.title).toBe('原标题');
        expect((meta?.custom as Record<string, unknown>)?.inputModelConfig).toEqual({ model: 'test-model' });

        // 再次读取仍稳定（补建的历史已落盘）
        expect(await manager2.getHistory('conv-h4-a')).toEqual([]);
    });

    test('历史缺失 + 元数据存在但未绑定：按 H4 语义补绑 hint 工作区', async () => {
        const { adapter, fake } = createAdapter();
        const manager1 = new ConversationManager(adapter);
        await manager1.createConversation('conv-h4-b', '未绑定对话');

        deleteHistoryKeepMeta(fake, 'conv-h4-b');

        const manager2 = new ConversationManager(adapter);
        await manager2.getMessages('conv-h4-b', WS_A);

        const meta = await manager2.getMetadata('conv-h4-b');
        expect(meta?.workspaceUri).toBe(WS_A);
        expect(meta?.title).toBe('未绑定对话');
    });

    test('历史缺失 + 元数据不存在：走原创建路径并绑定 hint', async () => {
        const { adapter } = createAdapter();
        const manager = new ConversationManager(adapter);

        const messages = await manager.getMessages('conv-h4-c', WS_A);
        expect(messages).toEqual([]);
        const meta = await manager.getMetadata('conv-h4-c');
        expect(meta?.workspaceUri).toBe(WS_A);
    });
});

describe('workspaceUri 归一化（防字面 null / 脏 URI 持久化）', () => {
    test('setWorkspaceUri(null) → undefined（解绑，不写字面 null）', async () => {
        const storage = new MemoryStorageAdapter();
        const manager = new ConversationManager(storage);
        await manager.createConversation('conv-n1');
        await manager.setWorkspaceUri('conv-n1', WS_A);
        await manager.setWorkspaceUri('conv-n1', null as unknown as undefined);

        const meta = await manager.getMetadata('conv-n1');
        expect(meta?.workspaceUri).toBeUndefined();
        expect(JSON.stringify(meta)).not.toContain('"workspaceUri":null');
    });

    test('setWorkspaceUri(空白串) → undefined', async () => {
        const storage = new MemoryStorageAdapter();
        const manager = new ConversationManager(storage);
        await manager.createConversation('conv-n2');
        await manager.setWorkspaceUri('conv-n2', '   ');

        expect((await manager.getMetadata('conv-n2'))?.workspaceUri).toBeUndefined();
    });

    test('setWorkspaceUri 去除首尾空白（脏 URI 不落盘）', async () => {
        const storage = new MemoryStorageAdapter();
        const manager = new ConversationManager(storage);
        await manager.createConversation('conv-n3');
        await manager.setWorkspaceUri('conv-n3', `  ${WS_A}  `);

        expect((await manager.getMetadata('conv-n3'))?.workspaceUri).toBe(WS_A);
    });

    test('createConversation(null/空白 workspaceUri) → 未绑定', async () => {
        const storage = new MemoryStorageAdapter();
        const manager = new ConversationManager(storage);
        await manager.createConversation('conv-n4', 'T', null as unknown as undefined);

        expect((await manager.getMetadata('conv-n4'))?.workspaceUri).toBeUndefined();
    });
});
