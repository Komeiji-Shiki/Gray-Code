/**
 * 决策 6：主历史删除（deleteToMessage / deleteMessage）后同步软删分支图子树。
 *
 * 背景：此前删除路径只删主历史、不同步删图节点（integrityCheck ③），硬删除后
 * BranchGraph 中该点之后的子树成为「主历史已删但图仍活跃」的悬空状态。
 * 本测试覆盖：
 * - BranchGraph.softDeleteSubtreeFrom 纯函数（TREE-09 软删语义 + 活跃指针修正 + 根锚定重置）；
 * - BranchService.syncGraphAfterHistoryDelete（无图 no-op / FR 锚点退化 / 损坏拒绝覆盖）；
 * - deleteToMessage 端到端（模拟 ChatFlowService 接线顺序：删前捕获锚点 → 截断 → 同步软删）；
 * - ConversationManager.deleteMessage 接线（删除单条消息后同步软删被删节点及其子树）；
 * - ChatFlowService.handleDeleteToMessage 接线（锚点捕获 + 同步调用 + 失败不阻断）；
 * - 无分支图 / 无全局 BranchService 时不影响原有行为。
 *
 * 存储组合：历史走 MemoryStorageAdapter，sidecar 走真实临时目录（注入 baseDir），
 * 风格与 branchReroll.test.ts / branchService.test.ts 一致。
 */

import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ConversationManager } from '../../modules/conversation';
import { MemoryStorageAdapter } from '../../modules/conversation';
import type { ConversationHistory, Content } from '../../modules/conversation';
import { BranchGraphRepository } from '../../modules/conversation/branch/BranchGraphRepository';
import {
    BranchService,
    setGlobalBranchService,
} from '../../modules/conversation/branch/BranchService';
import {
    softDeleteSubtreeFrom,
    validate,
} from '../../modules/conversation/branch/BranchGraph';
import { BranchError } from '../../modules/conversation/branch/types';
import type {
    ConversationBranchGraph,
    ConversationBranchNode,
} from '../../modules/conversation/branch/types';
import { createChatFlowHarness } from '../__fixtures__/harnessFixtures';

/** 线性历史：root(user) → model(a1) */
function linearHistory(): ConversationHistory {
    return [
        { role: 'user', parts: [{ text: 'q1' }], timestamp: 100 },
        { role: 'model', parts: [{ text: 'a1' }], timestamp: 200 },
    ];
}

/** 模拟工具循环输出：模型消息（含 functionCall）+ functionResponse + 续接模型消息 */
async function simulateToolLoopOutput(manager: ConversationManager, conversationId: string): Promise<string[]> {
    await manager.addContent(conversationId, {
        role: 'model',
        parts: [
            { text: 'new answer' },
            { functionCall: { id: 'call-1', name: 'read_file', args: {} } },
        ],
        modelVersion: 'gemini-x',
    } as any);
    await manager.addContent(conversationId, {
        role: 'user',
        parts: [{ functionResponse: { id: 'call-1', name: 'read_file', response: { success: true } } }],
        isFunctionResponse: true,
    } as any);
    await manager.addContent(conversationId, {
        role: 'model',
        parts: [{ text: 'after tool' }],
        modelVersion: 'gemini-x',
    } as any);
    return (await manager.getMessagesRaw(conversationId)).map(m => m.id!);
}

/** 构造一条线性节点链图（父 = 前一个节点；活跃尾 = 最后一个节点；根镜像同步） */
function makeChainGraph(
    chain: Array<{ id: string; role: 'user' | 'model'; activeChildId?: string | null }>
): ConversationBranchGraph {
    const nodes: Record<string, ConversationBranchNode> = {};
    chain.forEach((item, index) => {
        nodes[item.id] = {
            id: item.id,
            parentId: index === 0 ? null : chain[index - 1]!.id,
            role: item.role,
            parts: [],
            kind: 'imported',
            createdAt: index + 1,
            activeChildId: item.activeChildId ?? null,
        };
    });
    const rootNodeId = chain[0]?.id ?? null;
    return {
        version: 1,
        rootNodeId,
        activeTailNodeId: chain[chain.length - 1]?.id ?? null,
        nodes,
        activeChildId: rootNodeId ? (nodes[rootNodeId]!.activeChildId ?? null) : null,
        candidateSummaries: [],
    };
}

describe('决策 6：主历史删除同步软删分支图子树', () => {
    let tempDir: string;
    let repo: BranchGraphRepository;
    let manager: ConversationManager;
    let service: BranchService;

    beforeEach(async () => {
        tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'branch-delete-sync-'));
        repo = new BranchGraphRepository(tempDir);
        manager = new ConversationManager(new MemoryStorageAdapter());
        service = new BranchService(manager, repo);
        setGlobalBranchService(service);
    });

    afterEach(async () => {
        setGlobalBranchService(undefined);
        await fsp.rm(tempDir, { recursive: true, force: true });
    });

    /** 建会话并写入线性历史，返回消息 id 数组 */
    async function seedConversation(conversationId: string, history: ConversationHistory = linearHistory()): Promise<string[]> {
        await manager.createConversation(conversationId, 'T');
        await manager.addBatch(conversationId, history);
        return (await manager.getMessagesRaw(conversationId)).map(m => m.id!);
    }

    describe('BranchGraph.softDeleteSubtreeFrom（纯函数）', () => {
        test('活跃路径锚点（截断场景）：锚点及子树软删，活跃尾回退到保留锚点', () => {
            // u1 → m1 → u2 → m2（活跃尾 = m2）；删除到 u2（含 u2）
            const graph = makeChainGraph([
                { id: 'u1', role: 'user', activeChildId: 'm1' },
                { id: 'm1', role: 'model', activeChildId: 'u2' },
                { id: 'u2', role: 'user', activeChildId: 'm2' },
                { id: 'm2', role: 'model' },
            ]);
            const outcome = softDeleteSubtreeFrom(graph, 'u2', { deletedAt: 1000 });

            expect(outcome.resetToEmpty).toBe(false);
            expect(outcome.activeTailAdjusted).toBe(true);
            expect(outcome.deletedNodeIds.sort()).toEqual(['m2', 'u2']);
            expect(outcome.graph.nodes['u2']).toMatchObject({ deleted: true, deletedAt: 1000 });
            expect(outcome.graph.nodes['m2']).toMatchObject({ deleted: true, deletedAt: 1000 });
            // 保留节点不受影响
            expect(outcome.graph.nodes['u1']!.deleted).toBeUndefined();
            expect(outcome.graph.nodes['m1']!.deleted).toBeUndefined();
            // 活跃指针修正：m1.activeChildId 清空，活跃尾回退到 m1
            expect(outcome.graph.nodes['m1']!.activeChildId).toBeNull();
            expect(outcome.graph.activeTailNodeId).toBe('m1');
            // 根镜像一致
            expect(outcome.graph.activeChildId).toBe(outcome.graph.nodes['u1']!.activeChildId ?? null);
            expect(validate(outcome.graph).valid).toBe(true);
        });

        test('级联覆盖该点之后的所有后代（含非活跃候选子树）', () => {
            // u1 → m1 → u2 → m2（活跃路径）；u2 下另挂非活跃候选 c2 → d2
            const graph = makeChainGraph([
                { id: 'u1', role: 'user', activeChildId: 'm1' },
                { id: 'm1', role: 'model', activeChildId: 'u2' },
                { id: 'u2', role: 'user', activeChildId: 'm2' },
                { id: 'm2', role: 'model' },
            ]);
            graph.nodes['c2'] = { id: 'c2', parentId: 'u2', role: 'model', parts: [], kind: 'reroll', createdAt: 5, activeChildId: 'd2' };
            graph.nodes['d2'] = { id: 'd2', parentId: 'c2', role: 'model', parts: [], kind: 'continue', createdAt: 6, activeChildId: null };

            const outcome = softDeleteSubtreeFrom(graph, 'u2', { deletedAt: 2000 });

            expect(outcome.deletedNodeIds.sort()).toEqual(['c2', 'd2', 'm2', 'u2']);
            for (const id of ['u2', 'm2', 'c2', 'd2']) {
                expect(outcome.graph.nodes[id]!.deleted).toBe(true);
            }
            expect(outcome.graph.nodes['m1']!.activeChildId).toBeNull();
            expect(outcome.graph.activeTailNodeId).toBe('m1');
            expect(validate(outcome.graph).valid).toBe(true);
        });

        test('非活跃锚点：活跃路径不受影响（活跃尾不变）', () => {
            // u1 → m1（活跃）；u1 下另挂非活跃候选 c1
            const graph = makeChainGraph([
                { id: 'u1', role: 'user', activeChildId: 'm1' },
                { id: 'm1', role: 'model' },
            ]);
            graph.nodes['c1'] = { id: 'c1', parentId: 'u1', role: 'model', parts: [], kind: 'reroll', createdAt: 3, activeChildId: null };

            const outcome = softDeleteSubtreeFrom(graph, 'c1', { deletedAt: 3000 });

            expect(outcome.activeTailAdjusted).toBe(false);
            expect(outcome.graph.nodes['c1']!.deleted).toBe(true);
            expect(outcome.graph.nodes['u1']!.activeChildId).toBe('m1');
            expect(outcome.graph.activeTailNodeId).toBe('m1');
            expect(validate(outcome.graph).valid).toBe(true);
        });

        test('excludeNode：只软删目标节点的后代，目标节点保留', () => {
            const graph = makeChainGraph([
                { id: 'u1', role: 'user', activeChildId: 'm1' },
                { id: 'm1', role: 'model', activeChildId: 'u2' },
                { id: 'u2', role: 'user', activeChildId: 'm2' },
                { id: 'm2', role: 'model' },
            ]);
            const outcome = softDeleteSubtreeFrom(graph, 'm1', { excludeNode: true, deletedAt: 4000 });

            expect(outcome.activeTailAdjusted).toBe(true);
            expect(outcome.deletedNodeIds.sort()).toEqual(['m2', 'u2']);
            expect(outcome.graph.nodes['m1']!.deleted).toBeUndefined(); // 保留点不清除
            expect(outcome.graph.nodes['m1']!.activeChildId).toBeNull();
            expect(outcome.graph.activeTailNodeId).toBe('m1'); // 活跃尾回退到保留点自身
            expect(validate(outcome.graph).valid).toBe(true);
        });

        test('excludeNode 且无后代：图未变化（原引用）', () => {
            const graph = makeChainGraph([
                { id: 'u1', role: 'user', activeChildId: 'm1' },
                { id: 'm1', role: 'model' },
            ]);
            const outcome = softDeleteSubtreeFrom(graph, 'm1', { excludeNode: true });
            expect(outcome.graph).toBe(graph);
            expect(outcome.deletedNodeIds).toEqual([]);
        });

        test('锚定根节点（删除到对话开头）：整体重置为空图', () => {
            const graph = makeChainGraph([
                { id: 'u1', role: 'user', activeChildId: 'm1' },
                { id: 'm1', role: 'model' },
            ]);
            const outcome = softDeleteSubtreeFrom(graph, 'u1', { deletedAt: 5000 });

            expect(outcome.resetToEmpty).toBe(true);
            expect(outcome.deletedNodeIds.sort()).toEqual(['m1', 'u1']);
            expect(outcome.graph.rootNodeId).toBeNull();
            expect(outcome.graph.activeTailNodeId).toBeNull();
            expect(Object.keys(outcome.graph.nodes)).toHaveLength(0);
            expect(validate(outcome.graph).valid).toBe(true);
        });

        test('锚点缺失 / 已软删：幂等返回原图引用', () => {
            const graph = makeChainGraph([
                { id: 'u1', role: 'user', activeChildId: 'm1' },
                { id: 'm1', role: 'model' },
            ]);
            expect(softDeleteSubtreeFrom(graph, 'missing').graph).toBe(graph);
            expect(softDeleteSubtreeFrom(graph, 'missing').deletedNodeIds).toEqual([]);

            graph.nodes['m1'] = { ...graph.nodes['m1']!, deleted: true, deletedAt: 111 };
            const idempotent = softDeleteSubtreeFrom(graph, 'm1', { deletedAt: 222 });
            expect(idempotent.graph).toBe(graph);
            expect(idempotent.deletedNodeIds).toEqual([]);
        });

        test('已软删子孙保留首次 deletedAt（幂等）', () => {
            const graph = makeChainGraph([
                { id: 'u1', role: 'user', activeChildId: 'm1' },
                { id: 'm1', role: 'model', activeChildId: 'u2' },
                { id: 'u2', role: 'user', activeChildId: 'm2' },
                { id: 'm2', role: 'model' },
            ]);
            graph.nodes['m2'] = { ...graph.nodes['m2']!, deleted: true, deletedAt: 111 };
            const outcome = softDeleteSubtreeFrom(graph, 'u2', { deletedAt: 222 });

            expect(outcome.graph.nodes['u2']!.deletedAt).toBe(222);
            expect(outcome.graph.nodes['m2']!.deletedAt).toBe(111); // 保持首次删除时间
        });

        test('候选摘要同步软删（deleted + deletedAt）', () => {
            const graph = makeChainGraph([
                { id: 'u1', role: 'user', activeChildId: 'm1' },
                { id: 'm1', role: 'model', activeChildId: 'u2' },
                { id: 'u2', role: 'user', activeChildId: 'm2' },
                { id: 'm2', role: 'model' },
            ]);
            graph.candidateSummaries = [
                { nodeId: 'u2', parentId: 'm1', kind: 'edit', createdAt: 1, preview: 'edited' },
                { nodeId: 'm1', parentId: 'u1', kind: 'reroll', createdAt: 1, preview: 'kept' },
            ];
            const outcome = softDeleteSubtreeFrom(graph, 'u2', { deletedAt: 999 });

            expect(outcome.graph.candidateSummaries!.find(s => s.nodeId === 'u2')).toMatchObject({
                deleted: true,
                deletedAt: 999,
            });
            // 保留节点摘要不受影响
            expect(outcome.graph.candidateSummaries!.find(s => s.nodeId === 'm1')!.deleted).toBeUndefined();
        });
    });

    describe('BranchService.syncGraphAfterHistoryDelete', () => {
        test('无分支图（线性对话未建图）：graphUpdated=false，不强制建图', async () => {
            await seedConversation('c1');
            const [u1, m1] = (await manager.getMessagesRaw('c1')).map(m => m.id!);

            const result = await service.syncGraphAfterHistoryDelete('c1', m1, { lastKeptMessageId: u1 });

            expect(result).toEqual({ graphUpdated: false, deletedNodeIds: [], resetToEmpty: false, activeTailAdjusted: false });
            // 未创建 sidecar
            expect((await service.getBranchGraph('c1')).graph).toBeNull();
        });

        test('锚点消息不在图中（functionResponse 等）：退化软删最后保留消息之后的所有后代', async () => {
            const ids = await seedConversation('c1', [
                { role: 'user', parts: [{ text: 'q1' }], timestamp: 100 },
                { role: 'model', parts: [{ text: 'a1' }], timestamp: 200 },
                { role: 'user', parts: [{ text: 'q2' }], timestamp: 300 },
                { role: 'model', parts: [{ text: 'a2' }], timestamp: 400 },
            ] as ConversationHistory);
            // 直接写入线性图 u1 → m1 → u2 → m2（活跃尾 m2）
            const graph = makeChainGraph([
                { id: ids[0], role: 'user', activeChildId: ids[1] },
                { id: ids[1], role: 'model', activeChildId: ids[2] },
                { id: ids[2], role: 'user', activeChildId: ids[3] },
                { id: ids[3], role: 'model' },
            ]);
            await repo.save('c1', graph);

            // 锚点 = 不在图中的 FR 消息 id；最后保留 = m1
            const result = await service.syncGraphAfterHistoryDelete('c1', 'fr-not-in-graph', {
                lastKeptMessageId: ids[1],
                deletedAt: 1234,
            });

            expect(result).toMatchObject({ graphUpdated: true, activeTailAdjusted: true, resetToEmpty: false });
            expect(result.deletedNodeIds.sort()).toEqual([ids[2], ids[3]].sort());
            const after = (await service.getBranchGraph('c1')).graph!;
            expect(after.nodes[ids[1]]!.deleted).toBeUndefined(); // 保留点自身不清除
            expect(after.nodes[ids[2]]!).toMatchObject({ deleted: true, deletedAt: 1234 });
            expect(after.nodes[ids[3]]!).toMatchObject({ deleted: true, deletedAt: 1234 });
            expect(after.activeTailNodeId).toBe(ids[1]);
            expect(validate(after).valid).toBe(true);
        });

        test('锚点与最后保留消息都不在图中：幂等 no-op，不落盘', async () => {
            const ids = await seedConversation('c1');
            const graph = makeChainGraph([
                { id: ids[0], role: 'user', activeChildId: ids[1] },
                { id: ids[1], role: 'model' },
            ]);
            await repo.save('c1', graph);

            const result = await service.syncGraphAfterHistoryDelete('c1', 'fr-not-in-graph', {
                lastKeptMessageId: 'also-not-in-graph',
            });

            expect(result.graphUpdated).toBe(false);
            const after = (await service.getBranchGraph('c1')).graph!;
            expect(after.nodes[ids[1]]!.deleted).toBeUndefined();
        });

        test('删除到对话开头（锚定根节点）：整图重置为空图', async () => {
            const ids = await seedConversation('c1');
            const graph = makeChainGraph([
                { id: ids[0], role: 'user', activeChildId: ids[1] },
                { id: ids[1], role: 'model' },
            ]);
            await repo.save('c1', graph);

            const result = await service.syncGraphAfterHistoryDelete('c1', ids[0], { deletedAt: 777 });

            expect(result).toMatchObject({ graphUpdated: true, resetToEmpty: true, activeTailAdjusted: true });
            const after = (await service.getBranchGraph('c1')).graph!;
            expect(after.rootNodeId).toBeNull();
            expect(Object.keys(after.nodes)).toHaveLength(0);
            expect(validate(after).valid).toBe(true);
        });

        test('sidecar 损坏：抛 BRANCH_STORAGE_CORRUPT，不覆盖', async () => {
            await seedConversation('c1');
            const filePath = repo.getBranchesFilePath('c1');
            await fsp.mkdir(path.dirname(filePath), { recursive: true });
            await fsp.writeFile(filePath, '{ broken json', 'utf8');

            await expect(
                service.syncGraphAfterHistoryDelete('c1', 'any-id')
            ).rejects.toMatchObject({ code: 'BRANCH_STORAGE_CORRUPT' });
        });

        test('无锚点（null）：防御 no-op', async () => {
            await seedConversation('c1');
            const result = await service.syncGraphAfterHistoryDelete('c1', null);
            expect(result.graphUpdated).toBe(false);
        });

        test('forceResetToEmpty：整体清空无条件重置为空图（不依赖锚点）；图已空时再次调用幂等', async () => {
            const ids = await seedConversation('c1');
            const graph = makeChainGraph([
                { id: ids[0], role: 'user', activeChildId: ids[1] },
                { id: ids[1], role: 'model' },
            ]);
            await repo.save('c1', graph);

            // 首次：非空图整体清空；锚点传 null 亦可（forceResetToEmpty 不依赖锚点）
            const first = await service.syncGraphAfterHistoryDelete('c1', null, { forceResetToEmpty: true });
            expect(first).toMatchObject({ graphUpdated: true, resetToEmpty: true, activeTailAdjusted: true });
            expect(first.deletedNodeIds.sort()).toEqual([ids[0], ids[1]].sort());
            const afterFirst = (await service.getBranchGraph('c1')).graph!;
            expect(afterFirst.rootNodeId).toBeNull();
            expect(Object.keys(afterFirst.nodes)).toHaveLength(0);
            expect(validate(afterFirst).valid).toBe(true);

            // 再次调用（图已空）：幂等短路——重置为空图是无操作，不写盘、返回空结果
            // （与软删路径 outcome.graph === graph 短路同语义；deletedNodeIds 为空、图保持空、不抛错）
            const second = await service.syncGraphAfterHistoryDelete('c1', null, { forceResetToEmpty: true });
            expect(second).toEqual({
                graphUpdated: false,
                deletedNodeIds: [],
                resetToEmpty: false,
                activeTailAdjusted: false,
            });
            const afterSecond = (await service.getBranchGraph('c1')).graph!;
            expect(afterSecond.rootNodeId).toBeNull();
            expect(Object.keys(afterSecond.nodes)).toHaveLength(0);
            expect(validate(afterSecond).valid).toBe(true);

            // 无分支图（线性会话未建图）：forceResetToEmpty no-op，不建图不落盘
            await seedConversation('c2');
            expect(await repo.exists('c2')).toBe(false);
            const noGraph = await service.syncGraphAfterHistoryDelete('c2', null, { forceResetToEmpty: true });
            expect(noGraph).toEqual({
                graphUpdated: false,
                deletedNodeIds: [],
                resetToEmpty: false,
                activeTailAdjusted: false,
            });
            expect(await repo.exists('c2')).toBe(false);
        });
    });

    describe('deleteToMessage 端到端（模拟 ChatFlowService 接线顺序）', () => {
        test('deleteToMessage 后：该点之后的子树整体软删，活跃尾回退，可整体恢复', async () => {
            const [u1, m1] = await seedConversation('c1');
            const started = await service.startReroll('c1', m1);
            await simulateToolLoopOutput(manager, 'c1');
            await service.finishReroll('c1', started.candidateNodeId);

            // 主历史当前 = [U, A, FR, B]；删除到索引 1（含 A），保留 U
            const historyBefore = await manager.getMessagesRaw('c1');
            expect(historyBefore.length).toBe(4);
            const anchorId = historyBefore[1]!.id!; // 第一个被删消息（A，图节点）
            const lastKeptId = historyBefore[0]!.id!; // 最后保留消息（U）
            const deletedCount = await manager.deleteToMessage('c1', 1);
            expect(deletedCount).toBe(3);

            // 决策 6：删除成功后同步软删分支图（ChatFlowService 接线点）
            const result = await service.syncGraphAfterHistoryDelete('c1', anchorId, { lastKeptMessageId: lastKeptId });

            expect(result).toMatchObject({ graphUpdated: true, activeTailAdjusted: true, resetToEmpty: false });
            expect(result.deletedNodeIds).toContain(anchorId);
            const graph = (await service.getBranchGraph('c1')).graph!;
            // 该点之后的子树（A、续接 B）整体软删；保留点 U 不受影响
            expect(graph.nodes[anchorId]).toMatchObject({ deleted: true });
            expect(graph.nodes[historyBefore[3]!.id!]).toMatchObject({ deleted: true });
            expect(graph.nodes[lastKeptId]!.deleted).toBeUndefined();
            // 活跃尾回退到保留锚点，父节点 activeChildId 清空
            expect(graph.activeTailNodeId).toBe(lastKeptId);
            expect(graph.nodes[lastKeptId]!.activeChildId).toBeNull();
            expect(validate(graph).valid).toBe(true);

            // TREE-09 软删语义：不物理移除 sidecar，可整体恢复
            const restored = await service.restoreBranchCandidate('c1', anchorId);
            expect(restored.restored).toBe(true);
            const afterRestore = (await service.getBranchGraph('c1')).graph!;
            expect(afterRestore.nodes[anchorId]!.deleted).toBeUndefined();
            expect(afterRestore.nodes[historyBefore[3]!.id!]!.deleted).toBeUndefined();
            expect(validate(afterRestore).valid).toBe(true);
        });
    });

    describe('ConversationManager.deleteMessage 接线', () => {
        test('删除单条消息（非活跃路径节点）后：被删节点及其子树软删，活跃路径不受影响', async () => {
            const ids = await seedConversation('c1');
            // 建图：u1 下创建 reroll 候选 cand（激活），m1 退为非活跃候选
            await service.createRerollCandidate('c1', ids[0], { parts: [{ text: 'cand' }] });
            let graph = (await service.getBranchGraph('c1')).graph!;
            const candId = graph.activeTailNodeId!;
            expect(graph.nodes[ids[1]]!.deleted).toBeUndefined();

            // 删除主历史中的 m1（非活跃路径消息）
            await manager.deleteMessage('c1', 1);

            // deleteMessage 内部已接线同步（await）：被删节点软删
            graph = (await service.getBranchGraph('c1')).graph!;
            expect(graph.nodes[ids[1]]).toMatchObject({ deleted: true });
            expect(graph.nodes[ids[1]]!.deletedAt).toEqual(expect.any(Number));
            // 活跃路径不受影响
            expect(graph.nodes[ids[0]]!.activeChildId).toBe(candId);
            expect(graph.activeTailNodeId).toBe(candId);
            expect(validate(graph).valid).toBe(true);
            // 主历史删除语义不变
            const history = await manager.getMessagesRaw('c1');
            expect(history.map(m => m.id)).toEqual([ids[0]]);
        });

        test('删除活跃尾消息：活跃尾回退到父节点', async () => {
            const ids = await seedConversation('c1', [
                { role: 'user', parts: [{ text: 'q1' }], timestamp: 100 },
                { role: 'model', parts: [{ text: 'a1' }], timestamp: 200 },
                { role: 'user', parts: [{ text: 'q2' }], timestamp: 300 },
                { role: 'model', parts: [{ text: 'a2' }], timestamp: 400 },
            ] as ConversationHistory);
            // 直接写入线性图 u1 → m1 → u2 → m2（活跃尾 m2）
            await repo.save('c1', makeChainGraph([
                { id: ids[0], role: 'user', activeChildId: ids[1] },
                { id: ids[1], role: 'model', activeChildId: ids[2] },
                { id: ids[2], role: 'user', activeChildId: ids[3] },
                { id: ids[3], role: 'model' },
            ]));

            await manager.deleteMessage('c1', 3); // 删除活跃尾 m2

            const graph = (await service.getBranchGraph('c1')).graph!;
            expect(graph.nodes[ids[3]]).toMatchObject({ deleted: true });
            expect(graph.nodes[ids[2]]!.activeChildId).toBeNull();
            expect(graph.activeTailNodeId).toBe(ids[2]);
            expect(validate(graph).valid).toBe(true);
        });

        test('无分支图时不影响原有删除行为（不建图、不抛错）', async () => {
            const ids = await seedConversation('c1');
            await manager.deleteMessage('c1', 1);
            const history = await manager.getMessagesRaw('c1');
            expect(history.map(m => m.id)).toEqual([ids[0]]);
            expect((await service.getBranchGraph('c1')).graph).toBeNull();
        });

        test('全局 BranchService 未注册时不影响原有删除行为', async () => {
            const ids = await seedConversation('c1');
            setGlobalBranchService(undefined);
            await manager.deleteMessage('c1', 1);
            const history = await manager.getMessagesRaw('c1');
            expect(history.map(m => m.id)).toEqual([ids[0]]);
        });
    });

    describe('ChatFlowService.handleDeleteToMessage 接线', () => {

        const fourMessageHistory = [
            { id: 'u1', role: 'user', parts: [{ text: 'q1' }] },
            { id: 'm1', role: 'model', parts: [{ text: 'a1' }] },
            { id: 'u2', role: 'user', parts: [{ text: 'q2' }] },
            { id: 'm2', role: 'model', parts: [{ text: 'a2' }] },
        ] as Content[];

        test('删除成功后同步软删分支图：锚点 = 第一个被删消息 id，保留点 = 前一条消息 id', async () => {
            const { flowService, conversationManager, branchService } = createChatFlowHarness({
                branchService: {
                    syncGraphAfterHistoryDelete: jest.fn().mockResolvedValue({
                        graphUpdated: true,
                        deletedNodeIds: [],
                        resetToEmpty: false,
                        activeTailAdjusted: false,
                    }),
                },
            });
            conversationManager.getMessagesRaw.mockResolvedValue(fourMessageHistory);
            conversationManager.deleteToMessage.mockResolvedValue(2);
            conversationManager.getHistoryRef.mockResolvedValue(fourMessageHistory.slice(0, 2));

            const result = await flowService.handleDeleteToMessage({ conversationId: 'c1', targetIndex: 2 });

            expect(result).toEqual({ success: true, deletedCount: 2 });
            expect(conversationManager.deleteToMessage).toHaveBeenCalledWith('c1', 2);
            expect(branchService.syncGraphAfterHistoryDelete).toHaveBeenCalledWith('c1', 'u2', {
                lastKeptMessageId: 'm1',
            });
        });

        test('图同步失败仅告警，不阻断硬删除', async () => {
            const { flowService, conversationManager, branchService } = createChatFlowHarness({
                branchService: {
                    syncGraphAfterHistoryDelete: jest.fn().mockResolvedValue({
                        graphUpdated: true,
                        deletedNodeIds: [],
                        resetToEmpty: false,
                        activeTailAdjusted: false,
                    }),
                },
            });
            conversationManager.getMessagesRaw.mockResolvedValue(fourMessageHistory);
            conversationManager.deleteToMessage.mockResolvedValue(2);
            conversationManager.getHistoryRef.mockResolvedValue(fourMessageHistory.slice(0, 2));
            branchService.syncGraphAfterHistoryDelete.mockRejectedValue(new Error('simulated graph failure'));

            const result = await flowService.handleDeleteToMessage({ conversationId: 'c1', targetIndex: 2 });
            expect(result).toEqual({ success: true, deletedCount: 2 });
        });

        test('无全局 BranchService 时不影响原有删除行为', async () => {
            const { flowService, conversationManager } = createChatFlowHarness();
            setGlobalBranchService(undefined);
            conversationManager.getMessagesRaw.mockResolvedValue(fourMessageHistory);
            conversationManager.deleteToMessage.mockResolvedValue(2);
            conversationManager.getHistoryRef.mockResolvedValue(fourMessageHistory.slice(0, 2));

            const result = await flowService.handleDeleteToMessage({ conversationId: 'c1', targetIndex: 2 });
            expect(result).toEqual({ success: true, deletedCount: 2 });
        });

        test('删除到对话开头（targetIndex=0）：锚点 = 根消息 id，保留点 = null', async () => {
            const { flowService, conversationManager, branchService } = createChatFlowHarness({
                branchService: {
                    syncGraphAfterHistoryDelete: jest.fn().mockResolvedValue({
                        graphUpdated: true,
                        deletedNodeIds: [],
                        resetToEmpty: false,
                        activeTailAdjusted: false,
                    }),
                },
            });
            conversationManager.getMessagesRaw.mockResolvedValue(fourMessageHistory);
            conversationManager.deleteToMessage.mockResolvedValue(4);
            conversationManager.getHistoryRef.mockResolvedValue([]);

            const result = await flowService.handleDeleteToMessage({ conversationId: 'c1', targetIndex: 0 });

            expect(result).toEqual({ success: true, deletedCount: 4 });
            expect(branchService.syncGraphAfterHistoryDelete).toHaveBeenCalledWith('c1', 'u1', {
                lastKeptMessageId: null,
            });
        });
    });

    describe('损坏 / 异常路径的既有行为保持', () => {
        test('syncGraphAfterHistoryDelete 对 BranchError 错误码透出（供调用方告警）', async () => {
            await seedConversation('c1');
            const filePath = repo.getBranchesFilePath('c1');
            await fsp.mkdir(path.dirname(filePath), { recursive: true });
            await fsp.writeFile(filePath, '{ broken json', 'utf8');

            await expect(
                service.syncGraphAfterHistoryDelete('c1', 'any-id')
            ).rejects.toBeInstanceOf(BranchError);
        });
    });
});
