/**
 * rejectToolCalls 原子性测试（R2 4.1）
 *
 * 背景：旧实现「锁外 getContents + 锁内 replaceContents」——get 与 replace 之间
 * 并发写入会被基于旧快照的整体写回覆盖（真实执行成功的工具结果 / 已追加的新消息丢失）。
 * 修复：get→修改→replace 整体走 repository.mutateContents（仓储互斥执行器，
 * withConversationWriteLock），与 settleFunctionResponses / rejectAllPendingToolCalls
 * / 其它 mutate 串行；无变更返回原引用跳过写回。
 */

import { ConversationManager } from '../../modules/conversation/ConversationManager';
import { createAdapter } from './helpers/fakeVscodeFs';
import type { Content } from '../../modules/conversation/types';

function makeContent(role: 'user' | 'model', text: string, extra: Record<string, unknown> = {}): Content {
    return { role, parts: [{ text }], timestamp: Date.now(), ...extra } as Content;
}

/** 构造历史：user 消息 + 含 N 个 functionCall 的 model 消息 */
async function seedToolCallConversation(manager: ConversationManager, convId: string, toolIds: string[]): Promise<number> {
    await manager.createConversation(convId, 'Reject');
    await manager.addContent(convId, makeContent('user', 'run tools'));
    await manager.addContent(convId, {
        role: 'model',
        parts: toolIds.map(id => ({ functionCall: { id, name: `tool_${id}`, args: '{}' } })),
        timestamp: Date.now()
    } as unknown as Content);
    const history = await manager.getHistory(convId);
    return history.findIndex(m => m.role === 'model');
}

describe('ConversationManager.rejectToolCalls 原子性（R2 4.1）', () => {
    test('并发 rejectToolCalls 互不覆盖：所有拒绝与 functionResponse 均落盘', async () => {
        const { adapter } = createAdapter();
        const manager = new ConversationManager(adapter);
        const toolIds = ['call-1', 'call-2', 'call-3', 'call-4', 'call-5'];
        const modelIndex = await seedToolCallConversation(manager, 'conv-rej-par', toolIds);

        // 并发拒绝 5 个工具：旧实现锁外 get + 锁内 replace，基于同一旧快照的后写
        // 会覆盖先写（最终只剩 1 条拒绝）；修复后整体串行，全部保留。
        await Promise.all(toolIds.map(id => manager.rejectToolCalls('conv-rej-par', modelIndex, [id])));

        const after = await manager.getHistory('conv-rej-par');
        const rejectedCalls = after
            .flatMap(m => m.parts ?? [])
            .filter(p => p.functionCall?.rejected)
            .map(p => p.functionCall!.id)
            .sort();
        expect(rejectedCalls).toEqual([...toolIds].sort());

        const rejectedResponses = after
            .flatMap(m => m.parts ?? [])
            .filter(p => p.functionResponse?.response?.rejected);
        expect(rejectedResponses).toHaveLength(toolIds.length);
        // model 消息本身只有一条（未被重复插入）
        expect(after.filter(m => m.role === 'model')).toHaveLength(1);
    });

    test('rejectToolCalls 写回期间并发追加不被覆盖（会话写锁串行）', async () => {
        const { adapter } = createAdapter();
        const manager = new ConversationManager(adapter);
        const modelIndex = await seedToolCallConversation(manager, 'conv-rej-ser', ['call-1']);

        // 挂起 rejectToolCalls 的写回（storage.saveHistory），期间发起并发追加：
        // 修复后两者共用会话写锁，追加排在 reject 写回之后，不会被旧快照覆盖。
        let releaseSave: () => void = () => {};
        let saveStartedResolve: () => void = () => {};
        const saveStarted = new Promise<void>(r => { saveStartedResolve = r; });
        const originalSave = adapter.saveHistory.bind(adapter);
        (adapter as any).saveHistory = async (id: string, history: Content[]) => {
            saveStartedResolve();
            await new Promise<void>(r => { releaseSave = r; });
            await originalSave(id, history);
        };

        const rejectPromise = manager.rejectToolCalls('conv-rej-ser', modelIndex, ['call-1']);
        await saveStarted; // reject 已进入写回（持会话写锁）
        const appendPromise = manager.addContent('conv-rej-ser', makeContent('user', 'concurrent'));
        releaseSave();
        await Promise.all([rejectPromise, appendPromise]);

        const after = await manager.getHistory('conv-rej-ser');
        // 拒绝生效
        expect(after.some(m => m.parts?.some(p => p.functionCall?.rejected))).toBe(true);
        expect(after.some(m => m.parts?.some(p => p.functionResponse?.response?.rejected))).toBe(true);
        // 并发追加的消息未丢失
        expect(after.some(m => (m.parts ?? []).some(p => (p as any).text === 'concurrent'))).toBe(true);
    });

    test('messageIndex 越界在锁内抛出，不写回', async () => {
        const { adapter } = createAdapter();
        const manager = new ConversationManager(adapter);
        await seedToolCallConversation(manager, 'conv-rej-bad', ['call-1']);

        await expect(manager.rejectToolCalls('conv-rej-bad', 99, ['call-1']))
            .rejects.toThrow(/越界|index/);
        const history = await manager.getHistory('conv-rej-bad');
        // 无任何拒绝被写入
        expect(history.some(m => m.parts?.some(p => p.functionCall?.rejected))).toBe(false);
    });

    test('目标消息无 parts（历史中存在无 parts 消息）不抛 TypeError，无拒绝写入', async () => {
        const { adapter } = createAdapter();
        const manager = new ConversationManager(adapter);
        await manager.createConversation('conv-rej-noparts', 'NoParts');
        await manager.addContent('conv-rej-noparts', makeContent('user', 'run tools'));

        // 注入一条无 parts 的 model 消息（历史中可能出现无 parts 消息）
        const history = await manager.getHistory('conv-rej-noparts');
        const noParts = { role: 'model', timestamp: Date.now() } as unknown as Content;
        await adapter.saveHistory('conv-rej-noparts', [...history, noParts]);
        const noPartsIndex = (await manager.getHistory('conv-rej-noparts')).length - 1;

        await expect(manager.rejectToolCalls('conv-rej-noparts', noPartsIndex)).resolves.toBeUndefined();
        const after = await manager.getHistory('conv-rej-noparts');
        expect(after.some(m => m.parts?.some(p => p.functionCall?.rejected))).toBe(false);
    });
});
