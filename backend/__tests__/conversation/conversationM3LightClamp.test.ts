/**
 * updateSummary M3 钳制轻量化（HIS-11 只读 index，0 次逐段 stat）与
 * 元数据语义（updatedAt 不在此写 / 批量摘要截断标志）测试。
 *
 * 覆盖：
 * - 多段历史下钳制只读 index JSON，不 stat 任何 .ndjson 段文件（此前每次消息后 O(段数) stat）；
 * - 索引不可读 / legacy 时钳制跳过，按原值保存；
 * - updateSummary 不移动 meta.updatedAt（由历史提交路径统一维护，注释语义落地）；
 * - getConversationMetadataBatch 超过 200 条时返回 truncated 标志（数组主体不变，前端兼容）。
 */

import { ConversationManager } from '../../modules/conversation/ConversationManager';
import { MemoryStorageAdapter } from '../../modules/conversation/storage';
import type { ConversationHistory, Content } from '../../modules/conversation/types';
import { Uri } from 'vscode';
import { createAdapter, normPath } from './helpers/fakeVscodeFs';
import { makeContent, makeHistory } from '../__fixtures__/conversationFixtures';

describe('updateSummary M3 钳制轻量化（只读 index JSON，不逐段 stat）', () => {
    test('多段历史下钳制只读 index，不 stat 任何段文件', async () => {
        const { adapter, fake } = createAdapter();
        const manager = new ConversationManager(adapter);
        await manager.createConversation('conv-light', 'Light');
        await manager.addBatch('conv-light', makeHistory(210)); // 210 条 → 2 段

        fake.statCalls.length = 0;
        await manager.updateSummary('conv-light', { messageCount: 1000 });

        const meta = await adapter.loadMetadata('conv-light');
        expect(meta!.custom!.messageCount).toBe(210);
        // 钳制路径没有对任何 .ndjson 段文件做 stat（也没有读段文件）
        expect(fake.statCalls.filter(p => p.includes('.ndjson'))).toHaveLength(0);
        expect(fake.readCalls.filter(p => p.includes('.ndjson'))).toHaveLength(0);
    });

    test('legacy 历史（无 index）时钳制跳过，messageCount 按原值保存', async () => {
        const { adapter, fake } = createAdapter();
        const manager = new ConversationManager(adapter);
        fake.files.set(
            normPath(`${(Uri.parse('file:///c%3A/data/graycode') as any).fsPath}/conversations/conv-legacy.json`),
            JSON.stringify(makeHistory(2))
        );

        await manager.updateSummary('conv-legacy', { messageCount: 5 });

        const meta = await adapter.loadMetadata('conv-legacy');
        expect(meta).not.toBeNull();
        expect(meta!.custom!.messageCount).toBe(5); // 未钳制（legacy 无 totalMessages 可读）
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
