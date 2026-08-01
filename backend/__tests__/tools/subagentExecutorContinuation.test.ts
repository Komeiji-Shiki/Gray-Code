/**
 * SubAgent 接续会话边界单元测试（F-06 / F-09）
 *
 * F-06：continueFromRunId 只能接续当前主对话所属的 run，跨对话必须拒绝，
 *       且拒绝发生在创建新 run 之前，错误信息不泄漏旧对话 ID。
 * F-09：内存快照缺失（重载/淘汰）时，只从当前对话的持久化元数据恢复 run 再接续。
 */

import { createDefaultExecutor } from '../../tools/subagents/executor';
import { subAgentRunEventBus } from '../../tools/subagents/runEventBus';
import { subAgentConcurrencyLimiter } from '../../tools/subagents/concurrencyLimiter';
import type { SubAgentConfig, SubAgentExecutorContext } from '../../tools/subagents/types';
import type { Content } from '../../modules/conversation/types';

function createConfig(overrides: Partial<SubAgentConfig> = {}): SubAgentConfig {
    return {
        type: 'tester',
        name: 'Tester',
        description: 'test agent',
        systemPrompt: 'you are a test agent',
        channel: { channelId: 'channel_1' },
        tools: { mode: 'all' },
        maxIterations: 0, // 立即触发「超出最大迭代次数」早退，不触碰 channelManager
        maxRuntime: 300,
        ...overrides
    };
}

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
        subAgentConcurrencyLimiter.release('new_same');
        subAgentConcurrencyLimiter.release('new_restored');
    });

    it('同一 conversationId 的终态 run 可以接续', async () => {
        createCompletedRun('cont_same', 'conv_1', [MARKER_CONTENT]);
        const executor = createDefaultExecutor(createConfig(), createContext({ conversationId: 'conv_1' }));

        const result = await executor({
            agentType: 'tester',
            prompt: 'continue',
            runId: 'new_same',
            continueFromRunId: 'cont_same',
            conversationId: 'conv_1'
        });

        // maxIterations=0 立即失败；若接续被拒会返回 run not found / different conversation
        expect(result.error).toContain('Exceeded maximum iterations');
        // 新 run 继承了旧 run 的 transcript
        const snapshot = subAgentRunEventBus.getSnapshot('new_same')!;
        expect(snapshot.contents.some(c => c.parts.some(p => (p as any).text === 'OLD TRANSCRIPT MARKER'))).toBe(true);
    });

    it('不同 conversationId 的 run 被拒绝，且不泄漏旧对话信息', async () => {
        createCompletedRun('cont_other', 'conv_other', [MARKER_CONTENT]);
        const executor = createDefaultExecutor(createConfig(), createContext({ conversationId: 'conv_1' }));

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
        // 跨会话拒绝发生在新 run 创建和持久化之前
        expect(subAgentRunEventBus.getSnapshot('new_other')).toBeUndefined();
    });

    it('正在运行的 run 仍然不能接续', async () => {
        subAgentRunEventBus.createRun('cont_running', 'Tester', undefined, { conversationId: 'conv_1' });
        // 不发终态事件，保持 running
        const executor = createDefaultExecutor(createConfig(), createContext({ conversationId: 'conv_1' }));

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

    it('不存在的 run 返回明确错误', async () => {
        const executor = createDefaultExecutor(createConfig(), createContext({ conversationId: 'conv_1' }));

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

describe('SubAgent 接续 - 持久化快照恢复（F-09）', () => {
    afterEach(() => {
        subAgentConcurrencyLimiter.release('new_restored');
    });

    it('内存无快照时，从当前对话持久化记录恢复并接续', async () => {
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

        const executor = createDefaultExecutor(createConfig(), createContext({
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
        // 新 run 继承了恢复出的 transcript
        const snapshot = subAgentRunEventBus.getSnapshot('new_restored')!;
        expect(snapshot.contents.some(c => c.parts.some(p => (p as any).text === 'OLD TRANSCRIPT MARKER'))).toBe(true);
    });

    it('恢复出的快照仍执行会话归属校验（归属不同时拒绝）', async () => {
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
        const executor = createDefaultExecutor(createConfig(), createContext({ conversationId: 'conv_B' }));
        const result = await executor({
            agentType: 'tester',
            prompt: 'x',
            runId: 'new_foreign',
            continueFromRunId: 'cont_foreign',
            conversationId: 'conv_B'
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain('belongs to a different conversation');
        expect(subAgentRunEventBus.getSnapshot('new_foreign')).toBeUndefined();
    });
});
