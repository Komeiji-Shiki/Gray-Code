/** 分支服务写锁与历史/图异步同步的共享行为。旧宿主流式守卫单独从本夹具移除。 */

import {
    ConversationManager,
} from '../../modules/conversation';
import {
    MemoryStorageAdapter,
} from '../../modules/conversation';
import type { ConversationHistory } from '../../modules/conversation';
import {
    BranchService,
    setGlobalBranchService,
} from '../../modules/conversation/branch/BranchService';
import { MemoryBranchStorage } from '../__fixtures__/memoryBranchStorage';
import {
    activePath,
    childrenIndex,
    validate,
} from '../../modules/conversation/branch/BranchGraph';

/** 线性历史：root(user) → model(a1) */
function linearHistory(): ConversationHistory {
    return [
        { role: 'user', parts: [{ text: 'q1' }], timestamp: 100 },
        { role: 'model', parts: [{ text: 'a1' }], timestamp: 200 },
    ];
}

describe('分支竞态（服务写锁 + 迟到历史隔离）', () => {
    let repo: MemoryBranchStorage;
    let manager: ConversationManager;
    let service: BranchService;

    /** 明确控制派生图同步时机，历史写入仍经过真实的仓储与会话锁。 */
    async function appendBeforeGraphSync(conversationId: string, history: ConversationHistory): Promise<void> {
        setGlobalBranchService(undefined);
        try { await manager.addBatch(conversationId, history); }
        finally { setGlobalBranchService(service); }
    }

    /** 建会话并写入线性历史，返回 [userNodeId, modelNodeId] */
    async function seedConversation(conversationId: string): Promise<string[]> {
        await manager.createConversation(conversationId, 'T');
        await appendBeforeGraphSync(conversationId, linearHistory());
        return (await manager.getMessagesRaw(conversationId)).map(m => m.id!);
    }

    beforeEach(async () => {
        repo = new MemoryBranchStorage();
        manager = new ConversationManager(new MemoryStorageAdapter());
        service = new BranchService(manager, repo);
        setGlobalBranchService(service);
    });

    afterEach(async () => {
        setGlobalBranchService(undefined);
    });

    describe('服务层写锁互斥矩阵（BR-07 runExclusive 串行化）', () => {
        test('并发 reroll + 删除非活跃候选：全部成功、图有效、无丢失更新', async () => {
            const ids = await seedConversation('c1');
            const r1 = await service.createRerollCandidate('c1', ids[1], { parts: [{ text: 'a1' }] });
            const r2 = await service.createRerollCandidate('c1', ids[1], { parts: [{ text: 'a2' }] }); // active = r2

            const [r3, r4, del] = await Promise.all([
                service.createRerollCandidate('c1', ids[1], { parts: [{ text: 'a3' }] }),
                service.createRerollCandidate('c1', ids[1], { parts: [{ text: 'a4' }] }),
                service.deleteBranchCandidate('c1', r1.nodeId), // r1 全程非活跃，删除无顺序依赖
            ]);

            expect(del.deleted).toBe(true);
            const graph = (await service.getBranchGraph('c1')).graph!;
            expect(validate(graph).valid).toBe(true);
            expect(graph.nodes[r3.nodeId]).toBeTruthy();
            expect(graph.nodes[r4.nodeId]).toBeTruthy();
            expect(graph.nodes[r1.nodeId]!.deleted).toBe(true);
            // 尾指针收敛到最后一次写（r3 或 r4 之一），兄弟候选全部保留
            expect([r3.nodeId, r4.nodeId]).toContain(graph.activeTailNodeId);
            expect(childrenIndex(graph).get(ids[1])).toHaveLength(4);
        });

        test('并发 switch 到两个候选：尾指针收敛到其一，活跃路径与指针一致且图有效', async () => {
            const ids = await seedConversation('c1');
            const r1 = await service.createRerollCandidate('c1', ids[1], { parts: [{ text: 'a1' }] });
            const r2 = await service.createRerollCandidate('c1', ids[1], { parts: [{ text: 'a2' }] });

            const [s1, s2] = await Promise.all([
                service.switchBranchCandidate('c1', r1.nodeId),
                service.switchBranchCandidate('c1', r2.nodeId),
            ]);

            expect(s1.mainHistoryRewrite).toBe(false);
            expect(s2.mainHistoryRewrite).toBe(false);
            const graph = (await service.getBranchGraph('c1')).graph!;
            expect(validate(graph).valid).toBe(true);
            // 写锁串行化：尾指针必须是两者之一，且与根 activeChildId / 活跃路径一致（无中间态）
            expect([r1.nodeId, r2.nodeId]).toContain(graph.activeTailNodeId);
            const tail = graph.activeTailNodeId!;
            expect(graph.nodes[ids[1]]!.activeChildId).toBe(tail);
            const path = activePath(graph);
            expect(path[path.length - 1]).toBe(tail);
        });
    });

    describe('迟到消息与异步图同步（R6 基础用例）', () => {
        test('历史追加尚未同步时保留新候选，同步完成后可以继续分支操作', async () => {
            const ids = await seedConversation('c1');
            const reroll = await service.createRerollCandidate('c1', ids[1], { parts: [{ text: 'new-candidate' }] });

            const before = (await service.getBranchGraph('c1')).graph!;
            const beforeNodes = JSON.stringify(before.nodes);
            const beforeSummaries = JSON.stringify(before.candidateSummaries);

            // 暂不派发后台图同步，稳定检查历史已写入但图尚未更新的中间状态。
            await appendBeforeGraphSync('c1', [{ role: 'model', parts: [{ text: 'late-chunk' }], timestamp: 300 }]);

            // ① 分支图不被污染：节点集合 / 尾指针 / 候选摘要全部保持不变
            const after = (await service.getBranchGraph('c1')).graph!;
            expect(validate(after).valid).toBe(true);
            expect(after.activeTailNodeId).toBe(reroll.nodeId);
            expect(JSON.stringify(after.nodes)).toBe(beforeNodes);
            expect(JSON.stringify(after.candidateSummaries)).toBe(beforeSummaries);

            // ② 迟到 chunk 只落在主历史（新节点 id），不进分支图
            const history = await manager.getMessagesRaw('c1');
            expect(history).toHaveLength(3);
            expect(history[2].id).not.toBe(reroll.nodeId);
            expect(history[2].parts).toEqual([{ text: 'late-chunk' }]);
            expect(after.nodes[history[2].id!]).toBeUndefined();

            // ③ reroll 候选内容完整保留（未被迟到 chunk 覆盖 / 截断）
            expect(after.nodes[reroll.nodeId]!.parts).toEqual([{ text: 'new-candidate' }]);

            // ④ 执行真实的增量同步后再继续操作，不依赖后台任务恰好先执行。
            await service.appendHistoryToGraph('c1', [history[2]]);
            const r2 = await service.createRerollCandidate('c1', reroll.nodeId, { parts: [{ text: 'after-late' }] });
            const g2 = (await service.getBranchGraph('c1')).graph!;
            expect(g2.nodes[r2.nodeId]).toBeTruthy();
            expect(validate(g2).valid).toBe(true);
        });

        test('未同步的迟到消息阻止切换，同步后可以继续选择新候选', async () => {
            const ids = await seedConversation('c1');
            const reroll = await service.createRerollCandidate('c1', ids[1], { parts: [{ text: 'a2' }] });
            await appendBeforeGraphSync('c1', [{ role: 'model', parts: [{ text: 'stale' }], timestamp: 301 }]);

            const graph = (await service.getBranchGraph('c1')).graph!;
            expect(validate(graph).valid).toBe(true);
            expect(graph.activeTailNodeId).toBe(reroll.nodeId);
            const history = await manager.getMessagesRaw('c1');
            const beforeGraph = JSON.stringify(graph);
            await expect(service.switchBranchCandidate('c1', reroll.nodeId))
                .rejects.toMatchObject({ code: 'BRANCH_OPERATION_CONFLICT' });
            expect(await manager.getMessagesRaw('c1')).toEqual(history);
            expect(JSON.stringify((await service.getBranchGraph('c1')).graph)).toBe(beforeGraph);

            await service.appendHistoryToGraph('c1', [history[2]]);
            const switched = await service.switchBranchCandidate('c1', reroll.nodeId);
            expect(switched.nodeId).toBe(reroll.nodeId);
            const synced = (await service.getBranchGraph('c1')).graph!;
            expect(synced.nodes[reroll.nodeId].parts).toEqual([{ text: 'a2' }]);
            expect(synced.nodes[history[2].id!].parts).toEqual([{ text: 'stale' }]);
        });
    });
});
