/**
 * 分支竞态测试骨架（第六阶段 TREE-13/TREE-14）。
 *
 * 覆盖：
 * - TREE-13 互斥矩阵（服务层 + 守卫层）：
 *   · isConversationStreaming 守卫：真实 StreamAbortManager create → true /
 *     delete → false（模拟流式开始 / 结束），会话粒度隔离；
 *   · 流式期间变更类分支操作（reroll / switch / delete）集成被拒 BRANCH_BUSY，
 *     图状态不被改动；只读操作不受影响；
 *   · BranchService 写锁互斥（BR-07 runExclusive）：并发 reroll + 删除非活跃候选、
 *     并发 switch 两个候选——全部串行化、图 validate 通过、无丢失更新。
 * - TREE-14 迟到 chunk 隔离（R6 基础用例）：reroll 后旧流迟到的 chunk 追加主历史，
 *   分支图不变（节点集合 / 尾指针 / 候选摘要均保持），候选保留，后续分支操作可用。
 *
 * 存储组合：历史走 MemoryStorageAdapter，sidecar 走真实临时目录（注入 baseDir）。
 * 注：handler 层的 BRANCH_BUSY 矩阵单测在 backend/__tests__/webview/branchHandlers.test.ts；
 * 本文件补充服务层并发与「流式期间 + 迟到 chunk」的集成骨架。
 */

import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
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
import { BranchGraphRepository } from '../../modules/conversation/branch/BranchGraphRepository';
import {
    activePath,
    childrenIndex,
    validate,
} from '../../modules/conversation/branch/BranchGraph';
import {
    BRANCH_BUSY_STREAMING_MESSAGE,
    createRerollCandidate,
    deleteBranchCandidate,
    getBranchGraph,
    getBranchGraphMeta,
    isConversationStreaming,
    switchBranchCandidate,
} from '../../../webview/handlers/BranchHandlers';
import { StreamAbortManager } from '../../../webview/stream/StreamAbortManager';
import type { HandlerContext } from '../../../webview/types';

/** 线性历史：root(user) → model(a1) */
function linearHistory(): ConversationHistory {
    return [
        { role: 'user', parts: [{ text: 'q1' }], timestamp: 100 },
        { role: 'model', parts: [{ text: 'a1' }], timestamp: 200 },
    ];
}

describe('分支竞态（流式互斥 + 迟到 chunk 隔离）', () => {
    let tempDir: string;
    let repo: BranchGraphRepository;
    let manager: ConversationManager;
    let service: BranchService;

    /** 建会话并写入线性历史，返回 [userNodeId, modelNodeId] */
    async function seedConversation(conversationId: string): Promise<string[]> {
        await manager.createConversation(conversationId, 'T');
        await manager.addBatch(conversationId, linearHistory());
        return (await manager.getMessagesRaw(conversationId)).map(m => m.id!);
    }

    /** 构造 handler 级 ctx（streamAbortControllers 注入真实 StreamAbortManager，与生产一致） */
    function makeCtx(abortManager: StreamAbortManager, sendResponse?: (requestId: string, data: unknown) => void) {
        return {
            conversationManager: manager,
            storagePathManager: {
                getEffectiveDataPath: () => tempDir,
            } as unknown as HandlerContext['storagePathManager'],
            streamAbortControllers: abortManager,
            sendResponse: sendResponse || (() => undefined),
            sendError: (requestId: string, code: string, message: string) => {
                throw new Error(`[${requestId}] ${code}: ${message}`);
            },
        } as unknown as HandlerContext;
    }

    beforeEach(async () => {
        tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'branch-race-'));
        repo = new BranchGraphRepository(tempDir);
        manager = new ConversationManager(new MemoryStorageAdapter());
        service = new BranchService(manager, repo);
        setGlobalBranchService(service);
    });

    afterEach(async () => {
        setGlobalBranchService(undefined);
        await fsp.rm(tempDir, { recursive: true, force: true });
    });

    describe('守卫层：isConversationStreaming（真实 StreamAbortManager）', () => {
        let abortManager: StreamAbortManager;

        beforeEach(() => {
            abortManager = new StreamAbortManager();
        });

        test('create 后 true，delete 后 false（模拟流式开始 / 结束）；会话粒度隔离', () => {
            const ctx = makeCtx(abortManager);
            expect(isConversationStreaming(ctx, 'c1')).toBe(false);

            abortManager.create('c1'); // 流式开始
            expect(isConversationStreaming(ctx, 'c1')).toBe(true);
            expect(isConversationStreaming(ctx, 'other')).toBe(false); // 其他会话不受影响

            abortManager.delete('c1'); // 流式结束（正常结束 / 取消都会清 controller）
            expect(isConversationStreaming(ctx, 'c1')).toBe(false);
        });

    });

    describe('流式期间互斥矩阵（集成：真实 BranchService + BranchHandlers）', () => {
        let abortManager: StreamAbortManager;
        let ctx: HandlerContext;

        beforeEach(async () => {
            abortManager = new StreamAbortManager();
            ctx = makeCtx(abortManager);
        });

        test('流式中 reroll / switch / delete 全部被拒 BRANCH_BUSY，图状态不被改动', async () => {
            const ids = await seedConversation('c1');
            const r1 = await service.createRerollCandidate('c1', ids[1], { parts: [{ text: 'a1' }] });
            const r2 = await service.createRerollCandidate('c1', ids[1], { parts: [{ text: 'a2' }] });
            const before = JSON.stringify((await service.getBranchGraph('c1')).graph);

            abortManager.create('c1'); // 流式进行中

            // 收集错误而非抛错：注入带收集能力的 sendError
            const errors: Array<{ requestId: string; code: string; message: string }> = [];
            ctx.sendError = (requestId: string, code: string, message: string) => {
                errors.push({ requestId, code, message });
            };

            await createRerollCandidate(
                { conversationId: 'c1', parentNodeId: ids[1], parts: [{ text: 'a3' }] },
                'req-r1', ctx
            );
            await switchBranchCandidate({ conversationId: 'c1', nodeId: r1.nodeId }, 'req-s1', ctx);
            await deleteBranchCandidate({ conversationId: 'c1', nodeId: r2.nodeId }, 'req-d1', ctx);

            expect(errors.map(e => e.code)).toEqual(['BRANCH_BUSY', 'BRANCH_BUSY', 'BRANCH_BUSY']);
            expect(errors.every(e => e.message === BRANCH_BUSY_STREAMING_MESSAGE)).toBe(true);

            // 图未被部分写入污染：与流式前完全一致（reroll 未建、switch 未切、delete 未删）
            const after = JSON.stringify((await service.getBranchGraph('c1')).graph);
            expect(after).toBe(before);
            expect(validate((await service.getBranchGraph('c1')).graph!).valid).toBe(true);
        });

        test('流式中只读操作（getBranchGraph / getBranchGraphMeta）放行', async () => {
            await seedConversation('c1');
            abortManager.create('c1');

            const responses: Array<{ requestId: string; data: unknown }> = [];
            ctx.sendResponse = (requestId: string, data: unknown) => { responses.push({ requestId, data }); };

            await getBranchGraph({ conversationId: 'c1' }, 'req-g1', ctx);
            await getBranchGraphMeta({ conversationId: 'c1' }, 'req-g2', ctx);

            expect(responses.map(r => r.requestId)).toEqual(['req-g1', 'req-g2']);
        });

        test('流式结束后放行：delete 后 reroll / switch / delete 全部成功', async () => {
            const ids = await seedConversation('c1');
            const r1 = await service.createRerollCandidate('c1', ids[1], { parts: [{ text: 'a1' }] });
            const r2 = await service.createRerollCandidate('c1', ids[1], { parts: [{ text: 'a2' }] });

            abortManager.create('c1'); // 流式开始
            abortManager.delete('c1'); // 流式结束

            const responses: Array<{ requestId: string; data: unknown }> = [];
            ctx.sendResponse = (requestId: string, data: unknown) => { responses.push({ requestId, data }); };

            await createRerollCandidate(
                { conversationId: 'c1', parentNodeId: ids[1], parts: [{ text: 'a3' }] },
                'req-r2', ctx
            );
            await switchBranchCandidate({ conversationId: 'c1', nodeId: r1.nodeId }, 'req-s2', ctx);
            await deleteBranchCandidate({ conversationId: 'c1', nodeId: r2.nodeId }, 'req-d2', ctx);

            expect(responses).toHaveLength(3);
            expect(responses.every(r => (r.data as { success?: boolean }).success === true)).toBe(true);
            const graph = (await service.getBranchGraph('c1')).graph!;
            expect(validate(graph).valid).toBe(true);
            expect(graph.activeTailNodeId).toBe(r1.nodeId); // switch 生效
            expect(graph.nodes[r2.nodeId]!.deleted).toBe(true); // delete 生效
        });
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

    describe('迟到 chunk 不污染新分支（R6 基础用例）', () => {
        test('reroll 后旧流迟到的 chunk 追加主历史：分支图不变、候选保留、后续操作可用', async () => {
            const ids = await seedConversation('c1');
            const reroll = await service.createRerollCandidate('c1', ids[1], { parts: [{ text: 'new-candidate' }] });

            const before = (await service.getBranchGraph('c1')).graph!;
            const beforeNodes = JSON.stringify(before.nodes);
            const beforeSummaries = JSON.stringify(before.candidateSummaries);

            // 模拟旧流迟到的 chunk：直接往主历史追加一条 model 消息
            // （等价于流式 append 路径——迟到 chunk 落在主历史，不经过 BranchService）
            await manager.addBatch('c1', [{ role: 'model', parts: [{ text: 'late-chunk' }], timestamp: 300 }]);

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

            // ④ 迟到 chunk 后分支操作仍可用（图未被破坏）
            const r2 = await service.createRerollCandidate('c1', reroll.nodeId, { parts: [{ text: 'after-late' }] });
            const g2 = (await service.getBranchGraph('c1')).graph!;
            expect(g2.nodes[r2.nodeId]).toBeTruthy();
            expect(validate(g2).valid).toBe(true);
        });

        test('流式结束后 reroll 生效期间迟到 chunk 到达：图一致性与新候选不受影响', async () => {
            const ids = await seedConversation('c1');
            const abortManager = new StreamAbortManager();

            // 旧流结束 → reroll 放行并建新候选
            abortManager.create('c1');
            abortManager.delete('c1');
            const reroll = await service.createRerollCandidate('c1', ids[1], { parts: [{ text: 'a2' }] });

            // 迟到的旧流 chunk 到达（流式结束但网络层仍可能有残留 chunk）
            await manager.addBatch('c1', [{ role: 'model', parts: [{ text: 'stale' }], timestamp: 301 }]);

            const graph = (await service.getBranchGraph('c1')).graph!;
            expect(validate(graph).valid).toBe(true);
            expect(graph.activeTailNodeId).toBe(reroll.nodeId);
            // 新候选仍可通过 handler 正常操作（无 BRANCH_BUSY、无图损坏）
            const responses: Array<{ requestId: string; data: unknown }> = [];
            const ctx = makeCtx(abortManager, (requestId, data) => { responses.push({ requestId, data }); });
            await switchBranchCandidate({ conversationId: 'c1', nodeId: reroll.nodeId }, 'req-late1', ctx);
            expect(responses).toHaveLength(1);
            expect((responses[0].data as { success?: boolean }).success).toBe(true);
        });
    });
});
