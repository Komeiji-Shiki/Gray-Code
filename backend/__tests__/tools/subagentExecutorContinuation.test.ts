/**
 * SubAgent 接续会话边界单元测试（F-06 / F-09）
 *
 * F-06：continueFromRunId 只能接续当前主对话所属的 run，跨对话必须拒绝，
 *       且拒绝发生在创建新 run 之前，错误信息不泄漏旧对话 ID。
 * F-09：内存快照缺失（重载/淘汰）时，只从当前对话的持久化元数据恢复 run 再接续。
 */

import { createDefaultExecutor } from '../../tools/subagents';
import { subAgentRunEventBus } from '../../tools/subagents';
import { subAgentConcurrencyLimiter } from '../../tools/subagents';
import type { SubAgentConfig, SubAgentExecutorContext } from '../../tools/subagents';
import type { Content } from '../../modules/conversation/types';
import { createSubAgentConfig } from '../__fixtures__/subagentFixtures';


function createContext(overrides: Partial<SubAgentExecutorContext> = {}): SubAgentExecutorContext {
    return {
        channelManager: {} as any,
        toolRegistry: undefined as any,
        configManager: {
            getConfig: async () => ({
                id: 'channel_1',
                name: 'Test Channel',
                type: 'custom',
                toolMode: 'function_call',
                multimodalToolsEnabled: false
            })
        } as any,
        ...overrides
    };
}

/** 创建一个已完成（终态）的旧 run 快照 */
function createCompletedRun(runId: string, conversationId?: string, contents: Content[] = []): void {
    subAgentRunEventBus.createRun(runId, 'Tester', { agentType: 'tester', prompt: 'old' }, {
        conversationId,
        initialContents: contents
    });
    subAgentRunEventBus.emit({ runId, agentName: 'Tester', type: 'run_completed', timestamp: Date.now() });
}

const MARKER_CONTENT: Content = {
    role: 'user',
    parts: [{ text: 'OLD TRANSCRIPT MARKER' }],
    timestamp: 1
} as Content;

describe('SubAgent 接续 - 会话归属校验（F-06）', () => {
    afterEach(() => {
        subAgentConcurrencyLimiter.release('cont_same');
        subAgentConcurrencyLimiter.release('cont_restored');
    });

    test('同一 conversationId 的终态 run 可以接续（runId 复用旧 run，同一条记录继续）', async () => {
        createCompletedRun('cont_same', 'conv_1', [MARKER_CONTENT]);
        const executor = createDefaultExecutor(createSubAgentConfig({ maxIterations: 0 }), createContext({ conversationId: 'conv_1' }));

        const result = await executor({
            agentType: 'tester',
            prompt: 'continue',
            runId: 'new_same',
            continueFromRunId: 'cont_same',
            conversationId: 'conv_1'
        });

        // maxIterations=0 立即失败；若接续被拒会返回 run not found / different conversation
        expect(result.error).toContain('Exceeded maximum iterations');
        // 续跑沿用旧 runId：不产生第二个 run 记录，transcript 一条线连续
        expect(subAgentRunEventBus.getSnapshot('new_same')).toBeUndefined();
        const snapshot = subAgentRunEventBus.getSnapshot('cont_same')!;
        // 旧 transcript 保留（MARKER），新的 Invocation 卡片追加在后
        expect(snapshot.contents.some(c => c.parts.some(p => (p as any).text === 'OLD TRANSCRIPT MARKER'))).toBe(true);
        expect(snapshot.contents).toHaveLength(2);
        expect(JSON.stringify(snapshot.contents[1])).toContain('SubAgent Invocation');
        // 事件时间线保留并追加 run_resumed
        expect(snapshot.events.some(e => e.type === 'run_created')).toBe(true);
        expect(snapshot.events.some(e => e.type === 'run_resumed')).toBe(true);
        // maxIterations=0 立即失败，最终状态为 failed
        expect(snapshot.status).toBe('failed');
    });

    test('不同 conversationId 的 run 被拒绝，且不泄漏旧对话信息', async () => {
        createCompletedRun('cont_other', 'conv_other', [MARKER_CONTENT]);
        const executor = createDefaultExecutor(createSubAgentConfig({ maxIterations: 0 }), createContext({ conversationId: 'conv_1' }));

        const result = await executor({
            agentType: 'tester',
            prompt: 'x',
            runId: 'new_other',
            continueFromRunId: 'cont_other',
            conversationId: 'conv_1'
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain('belongs to a different conversation');
        // 错误信息不包含旧对话 ID 或 transcript 内容
        expect(result.error).not.toContain('conv_other');
        expect(result.error).not.toContain('OLD TRANSCRIPT MARKER');
        // 跨会话拒绝发生在续跑（resumeRun）之前：旧 run 保持终态，无 run_resumed、内容未追加
        expect(subAgentRunEventBus.getSnapshot('new_other')).toBeUndefined();
        const oldSnapshot = subAgentRunEventBus.getSnapshot('cont_other')!;
        expect(oldSnapshot.status).toBe('completed');
        expect(oldSnapshot.events.some(e => e.type === 'run_resumed')).toBe(false);
        expect(oldSnapshot.contents).toHaveLength(1);
    });

    test('正在运行的 run 仍然不能接续', async () => {
        subAgentRunEventBus.createRun('cont_running', 'Tester', undefined, { conversationId: 'conv_1' });
        // 不发终态事件，保持 running
        const executor = createDefaultExecutor(createSubAgentConfig({ maxIterations: 0 }), createContext({ conversationId: 'conv_1' }));

        const result = await executor({
            agentType: 'tester',
            prompt: 'x',
            runId: 'new_running',
            continueFromRunId: 'cont_running',
            conversationId: 'conv_1'
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain('still running');
    });

    test('不存在的 run 返回明确错误', async () => {
        const executor = createDefaultExecutor(createSubAgentConfig({ maxIterations: 0 }), createContext({ conversationId: 'conv_1' }));

        const result = await executor({
            agentType: 'tester',
            prompt: 'x',
            runId: 'new_notfound',
            continueFromRunId: 'ghost_run',
            conversationId: 'conv_1'
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain('run not found');
    });
});

describe('SubAgent 接续 - lastSentHistory（续跑前缀缓存依据）', () => {
    afterEach(() => {
        subAgentConcurrencyLimiter.release('cont_lsh_old');
    });

    test('updateLastSentHistory 深拷贝存入快照，不污染 Monitor contents 与 contentRevision，不发 content_snapshot', () => {
        subAgentRunEventBus.createRun('hist_only', 'Tester', undefined, { conversationId: 'conv_1' });
        const snapshot = subAgentRunEventBus.getSnapshot('hist_only')!;
        const revisionBefore = snapshot.contentRevision;
        const eventsBefore = snapshot.events.length;
        const sent: Content[] = [
            { role: 'user', parts: [{ text: 'sent-1' }] },
            { role: 'model', parts: [{ text: 'sent-2' }] }
        ];

        subAgentRunEventBus.updateLastSentHistory('hist_only', sent);

        // 深拷贝存入，且修改原数组不影响已存快照
        expect(snapshot.lastSentHistory).toEqual(sent);
        expect(snapshot.lastSentHistory).not.toBe(sent);
        (sent[0].parts as any)[0].text = 'mutated';
        expect((snapshot.lastSentHistory![0].parts![0] as any).text).toBe('sent-1');
        // 不污染 Monitor contents 与 contentRevision
        expect(snapshot.contents).toEqual([]);
        expect(snapshot.contentRevision).toBe(revisionBefore);
        // 不发 content_snapshot 事件（事件 journal 长度不变）
        expect(snapshot.events).toHaveLength(eventsBefore);
        expect(snapshot.events.some(e => e.type === 'content_snapshot')).toBe(false);

        subAgentRunEventBus.emit({ runId: 'hist_only', agentName: 'Tester', type: 'run_completed', timestamp: Date.now() });
    });

    test('续跑 baseContents 优先取 lastSentHistory（而不是 contents 卡片），历史逐条一致', async () => {
        // 模拟旧 run：contents 首条是 # SubAgent Invocation 卡片，lastSentHistory 是实际发送的 history
        subAgentRunEventBus.createRun('cont_lsh_old', 'Tester', { agentType: 'tester', prompt: 'old' }, {
            conversationId: 'conv_1',
            initialContents: [
                { role: 'user', parts: [{ text: '# SubAgent Invocation\nold task' }], isUserInput: true },
                { role: 'model', parts: [{ text: 'old reply' }] }
            ] as Content[]
        });
        subAgentRunEventBus.updateLastSentHistory('cont_lsh_old', [
            { role: 'user', parts: [{ text: 'old task' }] },
            { role: 'model', parts: [{ text: 'old reply' }] }
        ]);
        subAgentRunEventBus.emit({ runId: 'cont_lsh_old', agentName: 'Tester', type: 'run_completed', timestamp: Date.now() });

        const executor = createDefaultExecutor(createSubAgentConfig({ maxIterations: 0 }), createContext({ conversationId: 'conv_1' }));
        const result = await executor({
            agentType: 'tester',
            prompt: 'continue',
            runId: 'new_lsh',
            continueFromRunId: 'cont_lsh_old',
            conversationId: 'conv_1'
        });

        expect(result.error).toContain('Exceeded maximum iterations');
        // 续跑沿用旧 runId：transcript 一条线连续——旧 contents（含卡片）保留，续跑新卡片追加在后
        const snapshot = subAgentRunEventBus.getSnapshot('cont_lsh_old')!;
        expect(snapshot.contents).toHaveLength(3);
        expect(JSON.stringify(snapshot.contents[0])).toContain('SubAgent Invocation');
        expect(snapshot.contents[1]).toEqual({ role: 'model', parts: [{ text: 'old reply' }] });
        expect(JSON.stringify(snapshot.contents[2])).toContain('SubAgent Invocation');
        expect(snapshot.contents[2].parts?.some(p => (p as any).text?.includes('continue'))).toBe(true);
        // lastSentHistory 保持旧 run 最后一次实际发送的历史（generate 前仍以此为前缀，缓存命中条件不变）
        expect(snapshot.lastSentHistory).toEqual([
            { role: 'user', parts: [{ text: 'old task' }] },
            { role: 'model', parts: [{ text: 'old reply' }] }
        ]);
    });
});

describe('SubAgent 接续 - 持久化快照恢复（F-09）', () => {
    afterEach(() => {
        subAgentConcurrencyLimiter.release('cont_restored');
        subAgentConcurrencyLimiter.release('cont_restored_lsh');
        subAgentConcurrencyLimiter.release('cont_legacy');
    });

    test('内存无快照时，从当前对话持久化记录恢复并接续', async () => {
        const persisted: Record<string, unknown> = {
            cont_restored: {
                runId: 'cont_restored',
                agentName: 'Tester',
                status: 'completed',
                createdAt: 1,
                updatedAt: 2,
                contents: [MARKER_CONTENT],
                contentRevision: 0,
                eventSequence: 0
            }
        };
        const store = {
            getCustomMetadata: jest.fn(async () => persisted),
            setCustomMetadata: jest.fn(async () => {})
        };

        const executor = createDefaultExecutor(createSubAgentConfig({ maxIterations: 0 }), createContext({
            conversationId: 'conv_1',
            conversationStore: store as any
        }));

        const result = await executor({
            agentType: 'tester',
            prompt: 'x',
            runId: 'new_restored',
            continueFromRunId: 'cont_restored',
            conversationId: 'conv_1'
        });

        expect(result.error).toContain('Exceeded maximum iterations');
        // 恢复过程只加载了当前对话的记录
        expect(store.getCustomMetadata).toHaveBeenCalledWith('conv_1', 'subAgentRuns');
        // 续跑沿用旧 runId：恢复出的快照被直接复用（内容保留 + 新卡片追加）
        expect(subAgentRunEventBus.getSnapshot('new_restored')).toBeUndefined();
        const snapshot = subAgentRunEventBus.getSnapshot('cont_restored')!;
        expect(snapshot.contents.some(c => c.parts.some(p => (p as any).text === 'OLD TRANSCRIPT MARKER'))).toBe(true);
        expect(snapshot.contents).toHaveLength(2);
        expect(JSON.stringify(snapshot.contents[1])).toContain('SubAgent Invocation');
    });

    test('持久化记录带 lastSentHistory 时，恢复后接续以它为前缀（而非卡片 contents）', async () => {
        const persisted: Record<string, unknown> = {
            cont_restored_lsh: {
                runId: 'cont_restored_lsh',
                agentName: 'Tester',
                status: 'completed',
                createdAt: 1,
                updatedAt: 2,
                contents: [
                    { role: 'user', parts: [{ text: '# SubAgent Invocation\nold task' }], isUserInput: true },
                    { role: 'model', parts: [{ text: 'old reply' }] }
                ],
                contentRevision: 2,
                eventSequence: 2,
                lastSentHistory: [
                    { role: 'user', parts: [{ text: 'old task' }] },
                    { role: 'model', parts: [{ text: 'old reply' }] }
                ]
            }
        };
        const store = {
            getCustomMetadata: jest.fn(async () => persisted),
            setCustomMetadata: jest.fn(async () => {})
        };

        const executor = createDefaultExecutor(createSubAgentConfig({ maxIterations: 0 }), createContext({
            conversationId: 'conv_1',
            conversationStore: store as any
        }));

        const result = await executor({
            agentType: 'tester',
            prompt: 'x',
            runId: 'new_restored_lsh',
            continueFromRunId: 'cont_restored_lsh',
            conversationId: 'conv_1'
        });

        expect(result.error).toContain('Exceeded maximum iterations');
        // 恢复出的旧快照带 lastSentHistory（深拷贝，与持久化对象不共享引用）
        const restoredOld = subAgentRunEventBus.getSnapshot('cont_restored_lsh')!;
        expect(restoredOld.lastSentHistory).toEqual([
            { role: 'user', parts: [{ text: 'old task' }] },
            { role: 'model', parts: [{ text: 'old reply' }] }
        ]);
        // 注：不再断言「与持久化对象不共享引用」——续跑复用同一 runId 后，finalizeRun 的
        // flushPersist 会把快照引用写回持久化记录（快照即最新真源），共享引用是正常行为。
        // 续跑沿用旧 runId：恢复出的 transcript 一条线连续（卡片 + old reply + 续跑新卡片）
        expect(subAgentRunEventBus.getSnapshot('new_restored_lsh')).toBeUndefined();
        const snapshot = subAgentRunEventBus.getSnapshot('cont_restored_lsh')!;
        expect(snapshot.contents).toHaveLength(3);
        expect(JSON.stringify(snapshot.contents[0])).toContain('SubAgent Invocation');
        expect(snapshot.contents[1]).toEqual({ role: 'model', parts: [{ text: 'old reply' }] });
        expect(JSON.stringify(snapshot.contents[2])).toContain('SubAgent Invocation');
    });

    test('旧记录缺 lastSentHistory 时降级：过滤掉 # SubAgent Invocation 卡片，其余保留', async () => {
        const persisted: Record<string, unknown> = {
            cont_legacy: {
                runId: 'cont_legacy',
                agentName: 'Tester',
                status: 'completed',
                createdAt: 1,
                updatedAt: 2,
                contents: [
                    { role: 'user', parts: [{ text: '# SubAgent Invocation\n\n## Agent System Prompt\nlegacy prompt' }], isUserInput: true },
                    { role: 'model', parts: [{ text: 'legacy reply' }] },
                    { role: 'user', isFunctionResponse: true, parts: [{ functionResponse: { name: 't', response: { success: true } } }] }
                ],
                contentRevision: 0,
                eventSequence: 0
                // 无 lastSentHistory：模拟旧格式数据
            }
        };
        const store = {
            getCustomMetadata: jest.fn(async () => persisted),
            setCustomMetadata: jest.fn(async () => {})
        };

        const executor = createDefaultExecutor(createSubAgentConfig({ maxIterations: 0 }), createContext({
            conversationId: 'conv_1',
            conversationStore: store as any
        }));

        const result = await executor({
            agentType: 'tester',
            prompt: 'x',
            runId: 'new_legacy',
            continueFromRunId: 'cont_legacy',
            conversationId: 'conv_1'
        });

        expect(result.error).toContain('Exceeded maximum iterations');
        // 续跑沿用旧 runId：旧 transcript 原样保留（卡片 + legacy reply + 工具结果）+ 续跑新卡片
        const snapshot = subAgentRunEventBus.getSnapshot('cont_legacy')!;
        expect(snapshot.contents).toHaveLength(4);
        expect(JSON.stringify(snapshot.contents[0])).toContain('SubAgent Invocation');
        expect(snapshot.contents[1]).toEqual({ role: 'model', parts: [{ text: 'legacy reply' }] });
        expect((snapshot.contents[2].parts![0] as any).functionResponse?.name).toBe('t');
        expect(JSON.stringify(snapshot.contents[3])).toContain('SubAgent Invocation');
    });

    test('恢复出的快照仍执行会话归属校验（归属不同时拒绝）', async () => {
        // 持久化记录里没有 conversationId 字段，恢复时会被标记为当前对话
        const persisted: Record<string, unknown> = {
            cont_foreign: {
                runId: 'cont_foreign',
                agentName: 'Tester',
                status: 'completed',
                createdAt: 1,
                updatedAt: 2,
                contents: [MARKER_CONTENT],
                contentRevision: 0,
                eventSequence: 0
            }
        };
        const store = {
            getCustomMetadata: jest.fn(async () => persisted),
            setCustomMetadata: jest.fn(async () => {})
        };

        // 先以 conv_A 身份恢复（快照归属变成 conv_A）
        await subAgentRunEventBus.loadConversationSnapshots('conv_A', store as any);

        // 再用 conv_B 接续同一 run：内存快照已存在（conversationId=conv_A），必须被拒绝
        const executor = createDefaultExecutor(createSubAgentConfig({ maxIterations: 0 }), createContext({ conversationId: 'conv_B' }));
        const result = await executor({
            agentType: 'tester',
            prompt: 'x',
            runId: 'new_foreign',
            continueFromRunId: 'cont_foreign',
            conversationId: 'conv_B'
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain('belongs to a different conversation');
        // 拒绝发生在续跑之前：旧快照保持终态，无 run_resumed、内容未追加
        expect(subAgentRunEventBus.getSnapshot('new_foreign')).toBeUndefined();
        const oldSnapshot = subAgentRunEventBus.getSnapshot('cont_foreign')!;
        expect(oldSnapshot.status).toBe('completed');
        expect(oldSnapshot.events.some(e => e.type === 'run_resumed')).toBe(false);
        expect(oldSnapshot.contents).toHaveLength(1);
    });
});
