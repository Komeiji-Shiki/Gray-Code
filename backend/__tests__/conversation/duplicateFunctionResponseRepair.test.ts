/**
 * 重复 functionResponse 清理（duplicate_function_response_id）。
 *
 * 事故形态：读取路径的悬空调用补齐把"结果尚未落盘"的在途调用误写成"用户拒绝"占位，
 * 真实工具结果随后照常落盘 → 同一调用两条响应 → 下一次模型请求被历史完整性校验拒绝
 * （API_ERROR: Unpaired tool history）。
 *
 * 修复分三层：
 * - 纯函数 repairDuplicateFunctionResponses：同一 ID 只保留一条响应（优先真实结果），
 *   清除真实响应上残留的 rejected 标记，删除被清空的占位消息并修正 parentId 链；
 * - 读取路径 normalizeHistoryForDisplay / scanHistoryForInitialPage：检出响应异常并写回自愈；
 * - 补齐跳过活跃任务写下的在途调用（listActiveRunIds）。
 */

import { ConversationManager, MemoryStorageAdapter } from '../../modules/conversation';
import type { ConversationHistory, Content } from '../../modules/conversation';
import type { StorageHistoryPage, StorageReadResult } from '../../modules/conversation/storage';
import { repairDuplicateFunctionResponses, isPlaceholderToolResponse } from '../../modules/conversation/manager/historyRepair';
import { validateHistoryIntegrity } from '../../modules/channel/HistoryIntegrityValidator';

/** 模拟分段存储：走 getMessagesPaged 的 format === 'paged' 快路径 */
class PagedMemoryStorageAdapter extends MemoryStorageAdapter {
    async loadHistoryPage(
        conversationId: string,
        options: { beforeIndex?: number; offset?: number; limit?: number } = {}
    ): Promise<StorageReadResult<StorageHistoryPage>> {
        const result = await super.loadHistoryPage(conversationId, options);
        if (result.value) {
            result.value.format = 'paged';
        }
        return result;
    }
}

/** 可提供活跃任务集合的存储：平台运行时（SqliteStorageAdapter）的能力模拟 */
class ActiveRunStorageAdapter extends MemoryStorageAdapter {
    activeRunIds?: Set<string>;

    async listActiveRunIds(): Promise<Set<string> | undefined> {
        return this.activeRunIds;
    }
}

/**
 * 事故数据形态：占位先写入（无 runId、无时间戳），真实结果随后追加（属于活跃任务）。
 * parentId 链与真实存储一致（线性）。
 */
function historyWithDuplicateResponse(): ConversationHistory {
    return [
        { role: 'user', id: 'u1', parentId: null, parts: [{ text: '继续' }], isUserInput: true, timestamp: 100 },
        {
            role: 'model', id: 'm1', parentId: 'u1', timestamp: 200,
            parts: [
                { text: '开始执行' },
                { functionCall: { id: 'call_a', name: 'read_file', args: { path: 'a.ts' }, rejected: true } },
                { functionCall: { id: 'call_b', name: 'read_file', args: { path: 'b.ts' }, rejected: true } },
            ],
        },
        {
            role: 'user', id: 'fr-placeholder', parentId: 'm1', isFunctionResponse: true, timestamp: 250,
            parts: [
                { functionResponse: { id: 'call_a', name: 'read_file', response: { success: false, error: '用户拒绝执行此工具', rejected: true } } },
                { functionResponse: { id: 'call_b', name: 'read_file', response: { success: false, error: '用户拒绝执行此工具', rejected: true } } },
            ],
        },
        {
            role: 'user', id: 'fr-real-a', parentId: 'fr-placeholder', isFunctionResponse: true, runId: 'run_live', timestamp: 300,
            parts: [{ functionResponse: { id: 'call_a', name: 'read_file', response: { success: true, data: 'A' } } }],
        },
        {
            role: 'user', id: 'fr-real-b', parentId: 'fr-real-a', isFunctionResponse: true, runId: 'run_live', timestamp: 301,
            parts: [{ functionResponse: { id: 'call_b', name: 'read_file', response: { success: true, data: 'B' } } }],
        },
    ] as ConversationHistory;
}

describe('repairDuplicateFunctionResponses 纯函数', () => {
    test('占位判定只认结构标记，不依赖界面文案', () => {
        expect(isPlaceholderToolResponse({ rejected: true })).toBe(true);
        expect(isPlaceholderToolResponse({ cancelled: true })).toBe(true);
        expect(isPlaceholderToolResponse({ success: false, code: 'CANCELLED' })).toBe(true);
        expect(isPlaceholderToolResponse({ success: false, code: 'INTERRUPTED' })).toBe(true);
        expect(isPlaceholderToolResponse({ success: true, data: 'x' })).toBe(false);
        expect(isPlaceholderToolResponse(null)).toBe(false);
    });

    test('同一调用的重复响应只保留真实结果，占位消息整条删除并修正 parentId 链', () => {
        const result = repairDuplicateFunctionResponses(historyWithDuplicateResponse());

        expect(result.changed).toBe(true);
        expect(result.history.map(message => message.id)).toEqual(['u1', 'm1', 'fr-real-a', 'fr-real-b']);
        // 真实响应保留、rejected 标记清除（占位配套的"无响应是有意"不再成立）
        expect(result.history[1].parts[1].functionCall?.rejected).toBe(false);
        expect(result.history[1].parts[2].functionCall?.rejected).toBe(false);
        // 被删占位消息（fr-placeholder）的下一条重新指向 m1；再之后保持原链
        expect(result.history[2].parentId).toBe('m1');
        expect(result.history[3].parentId).toBe('fr-real-a');

        // 幂等：修复后的历史不再有变更，且返回原引用
        const second = repairDuplicateFunctionResponses(result.history);
        expect(second.changed).toBe(false);
        expect(second.history).toBe(result.history);
    });

    test('同一调用只有占位响应时保留最后一条，拒绝语义不破坏', () => {
        const history = [
            { role: 'model', id: 'm0', parts: [{ functionCall: { id: 'call_x', name: 'read_file', args: {}, rejected: true } }] },
            { role: 'user', id: 'p1', isFunctionResponse: true, parts: [{ functionResponse: { id: 'call_x', name: 'read_file', response: { success: false, error: 'a', rejected: true } } }] },
            { role: 'user', id: 'p2', isFunctionResponse: true, parts: [{ functionResponse: { id: 'call_x', name: 'read_file', response: { success: false, error: 'b', cancelled: true } } }] },
        ] as ConversationHistory;
        const result = repairDuplicateFunctionResponses(history);

        expect(result.changed).toBe(true);
        expect(result.history.map(message => message.id)).toEqual(['m0', 'p2']);
        // 全是占位：调用保持 rejected（拒绝是设计语义）
        expect(result.history[0].parts[0].functionCall?.rejected).toBe(true);
    });

    test('真实响应上残留的 rejected 标记会被清除（无重复也自愈）', () => {
        const history = [
            { role: 'model', id: 'm1', parts: [{ functionCall: { id: 'call_x', name: 'read_file', args: {}, rejected: true } }] },
            { role: 'user', id: 'f1', isFunctionResponse: true, parts: [{ functionResponse: { id: 'call_x', name: 'read_file', response: { success: true } } }] },
        ] as ConversationHistory;
        const result = repairDuplicateFunctionResponses(history);

        expect(result.changed).toBe(true);
        expect(result.history[0].parts[0].functionCall?.rejected).toBe(false);
    });
});

describe('读取路径清理重复响应', () => {
    test('getMessages 清理重复响应并写回存储，修复后历史通过完整性校验', async () => {
        const storage = new MemoryStorageAdapter();
        const manager = new ConversationManager(storage);
        await storage.saveHistory('conv-dup', historyWithDuplicateResponse());

        const messages = await manager.getMessages('conv-dup');
        expect(messages.map(message => message.id)).toEqual(['u1', 'm1', 'fr-real-a', 'fr-real-b']);

        const persisted = await storage.loadHistory('conv-dup');
        expect(persisted!.map(message => message.id)).toEqual(['u1', 'm1', 'fr-real-a', 'fr-real-b']);

        const integrity = validateHistoryIntegrity(messages, { detectOrphanFunctionCall: true });
        expect(integrity.valid).toBe(true);

        // 幂等：再次读取不再变化
        const again = await manager.getMessages('conv-dup');
        expect(again.map(message => message.id)).toEqual(['u1', 'm1', 'fr-real-a', 'fr-real-b']);
    });

    test('分段存储首屏分页（getMessagesPaged）也会触发清理', async () => {
        const storage = new PagedMemoryStorageAdapter();
        const manager = new ConversationManager(storage);
        await storage.saveHistory('conv-dup-paged', historyWithDuplicateResponse());

        const page = await manager.getMessagesPaged('conv-dup-paged');

        expect(page.total).toBe(4);
        expect(page.messages.map(message => message.id)).toEqual(['u1', 'm1', 'fr-real-a', 'fr-real-b']);
        const persisted = await storage.loadHistory('conv-dup-paged');
        expect(persisted!.map(message => message.id)).toEqual(['u1', 'm1', 'fr-real-a', 'fr-real-b']);
    });

    test('无重复的无响应调用保留原补齐行为', async () => {
        const storage = new MemoryStorageAdapter();
        const manager = new ConversationManager(storage);
        await storage.saveHistory('conv-dangling', [
            { role: 'user', id: 'u1', parts: [{ text: '读一下' }], isUserInput: true },
            { role: 'model', id: 'm1', parts: [{ functionCall: { id: 'call_1', name: 'read_file', args: { path: 'a.ts' } } }] },
        ] as ConversationHistory);

        const messages = await manager.getMessages('conv-dangling');

        expect(messages).toHaveLength(3);
        expect(messages[2].parts[0].functionResponse?.id).toBe('call_1');
        expect(messages[1].parts[0].functionCall?.rejected).toBe(true);
    });
});

describe('活跃任务的在途调用', () => {
    test('活跃状态读取失败时保留历史，不误写拒绝响应', async () => {
        const storage = new ActiveRunStorageAdapter();
        const manager = new ConversationManager(storage);
        const history: Array<Content & { runId: string }> = [{ role: 'model', id: 'm1', runId: 'run-live', parts: [
            { functionCall: { id: 'call_live', name: 'execute_command', args: {} } },
        ] }];
        await storage.saveHistory('conv-read-error', history);
        jest.spyOn(storage, 'listActiveRunIds').mockRejectedValueOnce(new Error('storage temporarily unavailable'));
        const save = jest.spyOn(storage, 'saveHistory');
        await expect(manager.getMessages('conv-read-error')).rejects.toThrow('storage temporarily unavailable');
        expect(save).not.toHaveBeenCalled();
        expect(await storage.loadHistory('conv-read-error')).toEqual(history);
    });

    test('属于活跃任务的未响应调用不被补齐为拒绝占位；任务结束后恢复补齐', async () => {
        const storage = new ActiveRunStorageAdapter();
        const manager = new ConversationManager(storage);
        await storage.saveHistory('conv-active', [
            { role: 'user', id: 'u1', parts: [{ text: '跑一下' }], isUserInput: true },
            { role: 'model', id: 'm1', runId: 'run-live', parts: [{ functionCall: { id: 'call_live', name: 'execute_command', args: { command: 'sleep 99' } } }] },
        ] as ConversationHistory);

        // 任务活跃：不补占位、不打 rejected 标记（结果只是尚未落盘）
        storage.activeRunIds = new Set(['run-live']);
        const live = await manager.getMessages('conv-active');
        expect(live).toHaveLength(2);
        expect(live[1].parts[0].functionCall?.rejected).toBeUndefined();
        expect((await storage.loadHistory('conv-active'))).toHaveLength(2);

        // 任务结束（不再活跃）：遗留的悬空调用仍按旧行为补齐
        storage.activeRunIds = new Set();
        const settled = await manager.getMessages('conv-active');
        expect(settled).toHaveLength(3);
        expect(settled[2].parts[0].functionResponse?.id).toBe('call_live');
        expect(settled[1].parts[0].functionCall?.rejected).toBe(true);

        const integrity = validateHistoryIntegrity(settled, { detectOrphanFunctionCall: true });
        expect(integrity.valid).toBe(true);
    });
});
