/**
 * FIX-G1 HIGH-1 / MED-2 / MED-3 / R5b-1.3 端到端回归测试
 *
 * 覆盖：
 * - HIGH-1：injectInboxMessages 注入的 agentInbox 随工具结果 addContent 落盘后，
 *   getHistoryForAPIFrom 在后续请求中保持原样；一次性消费由 mailbox 保证，历史不改写以
 *   维持 provider 前缀缓存。
 * - MED-3：新的真实 user 消息（新回合边界）清空主会话信箱未消费消息（防跨轮过期投递）；
 *   回合内 functionResponse / 总结消息不清空。
 * - MED-2：deleteConversation 清理 A-COMM 信箱（clearConversation 接线），
 *   删除失败时信箱保留。
 * - R5b-1.3：usage remove 在会话写锁内 enqueue——删除后新发起的 append 被短路，
 *   不会复活 usage.json。
 */

import { ConversationManager } from '../../modules/conversation/ConversationManager';
import { MemoryStorageAdapter } from '../../modules/conversation/storage';
import { agentMailbox, MAIN_SESSION_RUN_ID } from '../../tools/subagents/agentMailbox';
import type { Content } from '../../modules/conversation/types';
import { makeContent } from '../__fixtures__/conversationFixtures';

/** 模拟 injectInboxMessages 注入后的工具结果（顶层 + data 双写，与实现一致） */
function makeInjectedFunctionResponse(callId: string, inboxText: string): Content {
    return {
        role: 'user',
        isFunctionResponse: true,
        timestamp: Date.now(),
        parts: [{
            functionResponse: {
                id: callId,
                name: 'stub_tool',
                response: {
                    success: true,
                    agentInbox: [{ fromRunId: 'run_a', text: inboxText, threadId: 't1', hopDepth: 1, createdAt: 1 }],
                    data: {
                        applied: true,
                        agentInbox: [{ fromRunId: 'run_a', text: inboxText, threadId: 't1', hopDepth: 1, createdAt: 1 }]
                    }
                }
            }
        }]
    } as Content;
}

describe('HIGH-1：agentInbox 历史保持字节稳定（端到端）', () => {
    let storage: MemoryStorageAdapter;
    let manager: ConversationManager;
    const convId = 'conv-g1-high1';

    beforeEach(() => {
        storage = new MemoryStorageAdapter();
        manager = new ConversationManager(storage);
    });

    test('注入 → addContent 落盘 → getHistoryForAPI：当前与后续真实回合内容一致', async () => {
        await manager.createConversation(convId, 'G1');
        // 回合 1：真实 user 消息 → 模型 functionCall → 工具结果（含注入的 agentInbox）
        await manager.addMessage(convId, 'user', [{ text: 'do it' }], { isUserInput: true });
        await manager.addContent(convId, makeContent('model', '', {
            parts: [{ functionCall: { id: 'call_1', name: 'stub_tool', args: {} } }]
        }));
        await manager.addContent(convId, makeInjectedFunctionResponse('call_1', 'agent says hello'));

        // 当轮（最后一个真实 user 消息之后）：agentInbox 保留 → 主模型可见
        const current = await manager.getHistoryForAPI(convId);
        const frPart = current
            .find(m => m.role === 'user' && m.parts?.some(p => !!p.functionResponse))
            ?.parts?.[0] as any;
        expect(frPart?.functionResponse?.response?.agentInbox).toHaveLength(1);
        expect(frPart?.functionResponse?.response?.agentInbox?.[0]?.text).toBe('agent says hello');
        // data 子对象同样保留（覆盖 formatter 的 JSON/文本两条序列化路径）
        expect(frPart?.functionResponse?.response?.data?.agentInbox).toHaveLength(1);

        // 回合 2：只在历史末尾追加真实 user 消息，上一回合工具结果保持原样以命中缓存。
        await manager.addMessage(convId, 'user', [{ text: 'next round' }], { isUserInput: true });
        const nextRound = await manager.getHistoryForAPI(convId);
        const frPart2 = nextRound
            .find(m => m.role === 'user' && m.parts?.some(p => !!p.functionResponse))
            ?.parts?.[0] as any;
        expect(frPart2?.functionResponse?.response?.agentInbox?.[0]?.text).toBe('agent says hello');
        expect(frPart2?.functionResponse?.response?.data?.agentInbox?.[0]?.text).toBe('agent says hello');
        // 非信箱字段保留（不破坏既有清理逻辑）
        expect(frPart2?.functionResponse?.response?.success).toBe(true);
        expect(frPart2?.functionResponse?.response?.data?.applied).toBe(true);
    });

    test('回合内多轮工具循环：所有已发送 agentInbox 保持不变', async () => {
        await manager.createConversation(convId, 'G1b');
        await manager.addMessage(convId, 'user', [{ text: 'start' }], { isUserInput: true });
        await manager.addContent(convId, makeContent('model', '', {
            parts: [{ functionCall: { id: 'call_1', name: 'stub_tool', args: {} } }]
        }));
        await manager.addContent(convId, makeInjectedFunctionResponse('call_1', 'msg-1'));

        // 迭代 2：模型继续调用工具（无新真实 user 消息）→ 仍是当轮 → agentInbox 可见
        await manager.addContent(convId, makeContent('model', '', {
            parts: [{ functionCall: { id: 'call_2', name: 'stub_tool', args: {} } }]
        }));
        await manager.addContent(convId, makeInjectedFunctionResponse('call_2', 'msg-2'));

        const history = await manager.getHistoryForAPI(convId);
        const frParts = history
            .filter(m => m.role === 'user' && m.parts?.some(p => !!p.functionResponse))
            .map(m => (m.parts?.[0] as any)?.functionResponse?.response);
        expect(frParts).toHaveLength(2);
        expect(frParts[0]?.agentInbox?.[0]?.text).toBe('msg-1');
        expect(frParts[1]?.agentInbox?.[0]?.text).toBe('msg-2');
    });

    test('H1-1：总结消息插在历史中间/末尾不构成新回合——总结前的当轮 functionResponse 保留 agentInbox', async () => {
        await manager.createConversation(convId, 'G1h11');
        // 回合 1：真实 user 消息 → 模型 functionCall → 工具结果（含注入的 agentInbox）
        await manager.addMessage(convId, 'user', [{ text: 'do it' }], { isUserInput: true });
        await manager.addContent(convId, makeContent('model', '', {
            parts: [{ functionCall: { id: 'call_1', name: 'stub_tool', args: {} } }]
        }));
        await manager.addContent(convId, makeInjectedFunctionResponse('call_1', 'in-round msg'));

        // SummarizeService 语义：总结消息以 insertIndex 插在历史中间（此处插到末尾，
        // 成为最后一个 user 消息）——旧谓词会把总结当成“最后一个非 functionResponse user 消息”，
        // 总结之前的同回合 functionResponse 被判为历史而剥离 agentInbox（信箱又未清空，行为分叉）。
        const historyBefore = await manager.getHistory(convId);
        await manager.insertContent(convId, historyBefore.length, makeContent('user', 'summary', {
            isSummary: true, isAutoSummary: true
        }));

        // 修复后：总结消息不是回合边界 → 总结之前的 functionResponse 仍属当轮 → agentInbox 保留
        const current = await manager.getHistoryForAPI(convId);
        const frPart = current
            .find(m => m.role === 'user' && m.parts?.some(p => !!p.functionResponse))
            ?.parts?.[0] as any;
        expect(frPart?.functionResponse?.response?.agentInbox?.[0]?.text).toBe('in-round msg');
        expect(frPart?.functionResponse?.response?.data?.agentInbox?.[0]?.text).toBe('in-round msg');

        // 新真实 user 消息只追加尾部，旧 functionResponse 不被重写。
        await manager.addMessage(convId, 'user', [{ text: 'next round' }], { isUserInput: true });
        const nextRound = await manager.getHistoryForAPI(convId);
        const frPart2 = nextRound
            .find(m => m.role === 'user' && m.parts?.some(p => !!p.functionResponse))
            ?.parts?.[0] as any;
        expect(frPart2?.functionResponse?.response?.agentInbox?.[0]?.text).toBe('in-round msg');
        expect(frPart2?.functionResponse?.response?.data?.agentInbox?.[0]?.text).toBe('in-round msg');
    });
});

describe('新真实 user 消息不再删除尚未投递的主会话信箱', () => {
    let storage: MemoryStorageAdapter;
    let manager: ConversationManager;
    const convId = 'conv-g1-med3';

    beforeEach(() => {
        storage = new MemoryStorageAdapter();
        manager = new ConversationManager(storage);
        agentMailbox.clearAll();
    });

    afterEach(() => {
        agentMailbox.clearAll();
    });

    test('addMessage 的 model / functionResponse / 真实 user 消息都不删除未读 inbox', async () => {
        await manager.createConversation(convId, 'G1m3');
        agentMailbox.registerRun(convId, 'run_a', 'Agent A');
        // 上一回合滞留的 agent→main 消息
        agentMailbox.sendMessage({
            conversationId: convId, fromRunId: 'run_a', targetRunId: MAIN_SESSION_RUN_ID, text: 'stale'
        });
        expect(agentMailbox.peekMessages(convId, MAIN_SESSION_RUN_ID)).toHaveLength(1);

        // 回合内 functionResponse 追加：不清空（当轮消息保留投递）
        await manager.addContent(convId, makeInjectedFunctionResponse('call_1', 'x'));
        expect(agentMailbox.peekMessages(convId, MAIN_SESSION_RUN_ID)).toHaveLength(1);

        // 回合内总结消息追加：不清空（自动总结发生在回合内）
        await manager.addContent(convId, makeContent('user', 'summary', { isSummary: true, isAutoSummary: true }));
        expect(agentMailbox.peekMessages(convId, MAIN_SESSION_RUN_ID)).toHaveLength(1);

        // 新回合真实 user 消息也是可投递边界，未读消息必须保留到实际消费。
        await manager.addMessage(convId, 'user', [{ text: 'new round' }], { isUserInput: true });
        expect(agentMailbox.peekMessages(convId, MAIN_SESSION_RUN_ID)).toHaveLength(1);

        // 子代理 inbox 不受影响（各自 run 生命周期管理）
        agentMailbox.sendMessage({
            conversationId: convId, fromRunId: 'run_a', targetRunId: 'run_a', text: 'sub self'
        });
        await manager.addMessage(convId, 'user', [{ text: 'another round' }], { isUserInput: true });
        expect(agentMailbox.peekMessages(convId, 'run_a')).toHaveLength(1);
        expect(agentMailbox.peekMessages(convId, MAIN_SESSION_RUN_ID)).toHaveLength(1);
    });

    test('addContent 追加真实 user 消息同样保留未读消息', async () => {
        await manager.createConversation(convId, 'G1m3b');
        agentMailbox.registerRun(convId, 'run_a', 'Agent A');
        agentMailbox.sendMessage({
            conversationId: convId, fromRunId: 'run_a', targetRunId: MAIN_SESSION_RUN_ID, text: 'stale-2'
        });

        await manager.addContent(convId, makeContent('user', 'round via addContent', { isUserInput: true }));
        expect(agentMailbox.peekMessages(convId, MAIN_SESSION_RUN_ID)).toHaveLength(1);
    });

    test('H1-2：addMessage 追加 isSummary 总结消息不清空主会话 inbox（与 addContent/addBatch 同谓词）', async () => {
        await manager.createConversation(convId, 'G1h12');
        agentMailbox.registerRun(convId, 'run_a', 'Agent A');
        // 回合内滞留的 agent→main 消息
        agentMailbox.sendMessage({
            conversationId: convId, fromRunId: 'run_a', targetRunId: MAIN_SESSION_RUN_ID, text: 'stale-3'
        });
        expect(agentMailbox.peekMessages(convId, MAIN_SESSION_RUN_ID)).toHaveLength(1);

        // 旧谓词只有 !isFunctionResponse：isSummary 总结消息会被误判为回合边界而清空
        await manager.addMessage(convId, 'user', [{ text: 'summary' }], { isSummary: true });
        expect(agentMailbox.peekMessages(convId, MAIN_SESSION_RUN_ID)).toHaveLength(1);

        // 真实 user 消息同样不删除未投递内容。
        await manager.addMessage(convId, 'user', [{ text: 'new round' }], { isUserInput: true });
        expect(agentMailbox.peekMessages(convId, MAIN_SESSION_RUN_ID)).toHaveLength(1);
    });
});

describe('MED-2：deleteConversation 清理 A-COMM 信箱', () => {
    let storage: MemoryStorageAdapter;
    let manager: ConversationManager;

    beforeEach(() => {
        storage = new MemoryStorageAdapter();
        manager = new ConversationManager(storage);
        agentMailbox.clearAll();
    });

    afterEach(() => {
        agentMailbox.clearAll();
    });

    test('删除对话清空该对话全部信箱状态（inbox / knownRuns / 频率限制），其它对话不受影响', async () => {
        await manager.createConversation('conv-del-a', 'A');
        await manager.createConversation('conv-del-b', 'B');
        agentMailbox.registerRun('conv-del-a', 'run_a', 'Agent A');
        agentMailbox.registerRun('conv-del-b', 'run_b', 'Agent B');
        agentMailbox.sendMessage({ conversationId: 'conv-del-a', fromRunId: 'run_a', targetRunId: MAIN_SESSION_RUN_ID, text: 'to main' });
        agentMailbox.sendMessage({ conversationId: 'conv-del-b', fromRunId: 'run_b', targetRunId: 'run_b', text: 'self' });
        expect(agentMailbox.getPendingMessageCount()).toBe(2);

        await manager.deleteConversation('conv-del-a');

        expect(agentMailbox.getPendingMessageCount()).toBe(1);
        expect(agentMailbox.isKnownRun('conv-del-a', 'run_a')).toBe(false);
        expect(agentMailbox.peekMessages('conv-del-a', MAIN_SESSION_RUN_ID)).toHaveLength(0);
        // 其它对话不受影响
        expect(agentMailbox.isKnownRun('conv-del-b', 'run_b')).toBe(true);
    });

    test('删除失败时信箱保留（与对话生命周期一致）', async () => {
        await manager.createConversation('conv-del-fail', 'F');
        agentMailbox.registerRun('conv-del-fail', 'run_a', 'Agent A');
        agentMailbox.sendMessage({ conversationId: 'conv-del-fail', fromRunId: 'run_a', targetRunId: MAIN_SESSION_RUN_ID, text: 'keep me' });

        const original = storage.deleteHistory.bind(storage);
        (storage as any).deleteHistory = async () => { throw new Error('simulated delete failure'); };
        await expect(manager.deleteConversation('conv-del-fail')).rejects.toThrow(/simulated delete failure/);
        (storage as any).deleteHistory = original;

        // 删除失败 → 信箱未被清理
        expect(agentMailbox.peekMessages('conv-del-fail', MAIN_SESSION_RUN_ID)).toHaveLength(1);
        expect(agentMailbox.isKnownRun('conv-del-fail', 'run_a')).toBe(true);
    });
});

describe('R5b-1.3：删除对话后 usage 写被短路（usage.json 不复活）', () => {
    test('deleteConversation 后新发起的 append 不产生 usage 写', async () => {
        const storage = new MemoryStorageAdapter();
        const writes: string[] = [];
        const removes: string[] = [];
        const store = {
            async read() { return null; },
            async write(conversationId: string) { writes.push(conversationId); },
            async remove(conversationId: string) { removes.push(conversationId); },
            async getFreshness() { return 'missing'; }
        } as any;
        const manager = new ConversationManager(storage, store);
        const convId = 'conv-g1-r513';

        await manager.addContent(convId, makeContent('model', 'reply'));
        expect(writes).toContain(convId);

        await manager.deleteConversation(convId);
        expect(removes).toContain(convId);

        // 删除后新发起的 append 被 assertNotDeleted 短路 → 不产生 usage 写（不复活 usage.json）
        const writesBeforeZombie = writes.length;
        await expect(manager.addContent(convId, makeContent('model', 'zombie'))).rejects.toThrow(/deleted/);
        expect(writes.length).toBe(writesBeforeZombie);
        // 增量路径同样被短路
        await expect(manager.addMessage(convId, 'model', [{ text: 'zombie2' }])).rejects.toThrow(/deleted/);
        expect(writes.length).toBe(writesBeforeZombie);
    });
});
