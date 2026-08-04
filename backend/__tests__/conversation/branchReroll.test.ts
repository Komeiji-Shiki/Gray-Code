/**
 * TREE-01/02 reroll 底座单测（第六阶段：树状 reroll 与多候选）。
 *
 * 覆盖：
 * - TREE-01 startReroll：验证目标在活跃路径 → 旧助手节点及子树保留进 sidecar（线性模式
 *   首次建图不丢旧回答）→ 新候选激活 → 主历史截断到父节点之后（切换到新候选路径）；
 * - TREE-01 入参校验：节点缺失 / 不在活跃路径 / 非 model / 父非 user → 明确错误码；
 * - TREE-02 多候选：多次 reroll 形成兄弟候选；每父节点上限 10（决策 4）超限拒绝；
 * - TREE-01 finishReroll：流式结果写入新节点（重命名对齐主历史消息 id + 内容 + 摘要 +
 *   续接节点 + functionResponse 合并，决策 8）；失败保留旧候选（决策 10）；
 * - 与 retryStream 并存：reroll 后旧破坏性 retry 路径（deleteMessage）仍可用，图侧不受影响；
 * - BR-05：finish 后主历史消息 id 链（不含 functionResponse）== 图活跃路径。
 *
 * 存储组合：历史走 MemoryStorageAdapter，sidecar 走真实临时目录（注入 baseDir），
 * 风格与 branchService.test.ts 一致。
 */

import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ConversationManager } from '../../modules/conversation/ConversationManager';
import { MemoryStorageAdapter } from '../../modules/conversation/storage';
import type { ConversationHistory } from '../../modules/conversation/types';
import {
    BranchService,
    MAX_CANDIDATES_PER_PARENT,
    setGlobalBranchService,
} from '../../modules/conversation/branch/BranchService';
import { BranchGraphRepository } from '../../modules/conversation/branch/BranchGraphRepository';
import {
    activePath,
    childrenIndex,
    createEmptyBranchGraph,
    renameNode,
    updateNodeContent,
    validate,
} from '../../modules/conversation/branch/BranchGraph';
import { BranchError } from '../../modules/conversation/branch/types';
import { rerollStream } from '../../../webview/handlers/ChatHandlers';
import { StreamAbortManager } from '../../../webview/stream/StreamAbortManager';
import type { HandlerContext } from '../../../webview/types';

/** 线性历史：root(user) → model(a1) */
function linearHistory(): ConversationHistory {
    return [
        { role: 'user', parts: [{ text: 'q1' }], timestamp: 100 },
        { role: 'model', parts: [{ text: 'a1' }], timestamp: 200 },
    ];
}

/** 模拟工具循环输出：模型消息（含 functionCall）+ functionResponse + 续接模型消息 */
async function simulateToolLoopOutput(manager: ConversationManager, conversationId: string): Promise<string[]> {
    const modelA = { role: 'model' as const, parts: [
        { text: 'new answer' },
        { functionCall: { id: 'call-1', name: 'read_file', args: {} } },
    ], modelVersion: 'gemini-x' };
    await manager.addContent(conversationId, modelA as any);
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

describe('TREE-01/02 BranchService reroll', () => {
    let tempDir: string;
    let repo: BranchGraphRepository;
    let manager: ConversationManager;
    let service: BranchService;

    beforeEach(async () => {
        tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'branch-reroll-'));
        repo = new BranchGraphRepository(tempDir);
        manager = new ConversationManager(new MemoryStorageAdapter());
        service = new BranchService(manager, repo);
        setGlobalBranchService(service);
    });

    afterEach(async () => {
        setGlobalBranchService(undefined);
        await fsp.rm(tempDir, { recursive: true, force: true });
    });

    /** 建会话并写入线性历史，返回 [userNodeId, modelNodeId] */
    async function seedConversation(conversationId: string): Promise<string[]> {
        await manager.createConversation(conversationId, 'T');
        await manager.addBatch(conversationId, linearHistory());
        return (await manager.getMessagesRaw(conversationId)).map(m => m.id!);
    }

    describe('TREE-01 startReroll：旧候选保留 + 新候选激活 + 主历史切换', () => {
        test('旧候选保留进 sidecar、新候选激活、主历史截断到父节点之后', async () => {
            const [userNodeId, modelNodeId] = await seedConversation('c1');
            const result = await service.startReroll('c1', modelNodeId);

            expect(result.previousNodeId).toBe(modelNodeId);
            expect(result.parentNodeId).toBe(userNodeId);
            expect(result.historyLengthAfterTruncate).toBe(1);

            const graph = (await service.getBranchGraph('c1')).graph!;
            expect(validate(graph).valid).toBe(true);
            // 旧候选仍在图中（保留旧回答，不删除）
            expect(graph.nodes[modelNodeId]).toBeTruthy();
            expect(graph.nodes[modelNodeId]!.parts).toEqual([{ text: 'a1' }]);
            // 新候选激活
            expect(graph.nodes[result.candidateNodeId]!.kind).toBe('reroll');
            expect(graph.nodes[userNodeId]!.activeChildId).toBe(result.candidateNodeId);
            expect(graph.activeTailNodeId).toBe(result.candidateNodeId);
            expect(activePath(graph)).toEqual([userNodeId, result.candidateNodeId]);

            // 主历史已切换到新候选路径：旧助手消息被截断，只剩父用户节点
            const history = await manager.getMessagesRaw('c1');
            expect(history.map(m => m.id)).toEqual([userNodeId]);
        });

        test('线性模式首次建图不丢旧回答：先建图（含旧节点）后截断主历史', async () => {
            const [userNodeId, modelNodeId] = await seedConversation('c1');
            expect(await repo.exists('c1')).toBe(false); // 无 sidecar

            await service.startReroll('c1', modelNodeId);

            const graph = (await service.getBranchGraph('c1')).graph!;
            // 旧助手节点已进入 sidecar（kind='imported'），内容完整
            expect(graph.nodes[modelNodeId]!.kind).toBe('imported');
            expect(graph.nodes[modelNodeId]!.parts).toEqual([{ text: 'a1' }]);
            expect(validate(graph).valid).toBe(true);
            expect(userNodeId).toBeTruthy();
        });

        test('assistantNodeId 缺省：取活跃路径上最后一条助手消息', async () => {
            const [userNodeId, modelNodeId] = await seedConversation('c1');
            const result = await service.startReroll('c1');

            expect(result.previousNodeId).toBe(modelNodeId);
            expect(result.parentNodeId).toBe(userNodeId);
        });

        test('入参校验：节点缺失 → NODE_NOT_FOUND；不在活跃路径 → INVALID_BRANCH_RELATION', async () => {
            const [, modelNodeId] = await seedConversation('c1');
            await expect(service.startReroll('c1', 'no-such-node')).rejects.toMatchObject({
                code: 'NODE_NOT_FOUND'
            });

            // 第一次 reroll 后旧节点 M 不再在活跃路径上，再次 reroll 它被拒绝
            await service.startReroll('c1', modelNodeId);
            await expect(service.startReroll('c1', modelNodeId)).rejects.toMatchObject({
                code: 'INVALID_BRANCH_RELATION'
            });
        });

        test('入参校验：非 model 节点 / 父节点非 user 均拒绝', async () => {
            const [userNodeId, modelNodeId] = await seedConversation('c1');
            // reroll 用户节点本身 → 非 model
            await expect(service.startReroll('c1', userNodeId)).rejects.toMatchObject({
                code: 'INVALID_BRANCH_RELATION'
            });

            // 构造「model 父节点为 model」的场景：reroll 后工具循环产生续接节点（kind='continue'），
            // 续接节点父节点是模型节点 → reroll 它被拒绝
            const started = await service.startReroll('c1', modelNodeId);
            const historyIds = await simulateToolLoopOutput(manager, 'c1');
            const finished = await service.finishReroll('c1', started.candidateNodeId);
            const continuationId = historyIds[historyIds.length - 1];
            expect(finished.activePathIds).toContain(continuationId);
            const continuation = (await service.getBranchGraph('c1')).graph!.nodes[continuationId]!;
            expect(continuation.role).toBe('model');
            expect(continuation.parentId).toBe(finished.candidateNodeId);

            await expect(service.startReroll('c1', continuationId)).rejects.toMatchObject({
                code: 'INVALID_BRANCH_RELATION'
            });
        });

        test('sidecar 损坏时 reroll 拒绝覆盖（BRANCH_STORAGE_CORRUPT）', async () => {
            const [userNodeId] = await seedConversation('c1');
            const filePath = repo.getBranchesFilePath('c1');
            await fsp.mkdir(path.dirname(filePath), { recursive: true });
            await fsp.writeFile(filePath, '{ broken json', 'utf8');

            await expect(service.startReroll('c1')).rejects.toMatchObject({
                code: 'BRANCH_STORAGE_CORRUPT'
            });
            // 原文件未被覆盖
            expect(await fsp.readFile(filePath, 'utf8')).toBe('{ broken json');
            expect(userNodeId).toBeTruthy();
        });
    });

    describe('TREE-01 finishReroll：流式结果写入新节点 + 摘要', () => {
        test('内容回填：候选重命名对齐消息 id、functionResponse 合并、续接节点、摘要更新', async () => {
            const [userNodeId, modelNodeId] = await seedConversation('c1');
            const started = await service.startReroll('c1', modelNodeId);
            const historyIds = await simulateToolLoopOutput(manager, 'c1');
            // [user, modelA, fr, modelB] 的非 functionResponse id
            const [modelAId, modelBId] = [historyIds[1], historyIds[3]];

            const finished = await service.finishReroll('c1', started.candidateNodeId);
            expect(finished.candidateNodeId).toBe(modelAId); // 候选节点已重命名对齐主历史消息 id
            expect(finished.syncedMessageCount).toBe(2);
            expect(finished.activeTailNodeId).toBe(modelBId);

            const graph = (await service.getBranchGraph('c1')).graph!;
            expect(validate(graph).valid).toBe(true);

            // 候选节点：内容 = 模型消息 + functionResponse 合并（决策 8），kind='reroll'
            const candidate = graph.nodes[modelAId]!;
            expect(candidate.kind).toBe('reroll');
            expect(candidate.modelVersion).toBe('gemini-x');
            expect(candidate.parts).toEqual([
                { text: 'new answer' },
                { functionCall: { id: 'call-1', name: 'read_file', args: {} } },
                { functionResponse: { id: 'call-1', name: 'read_file', response: { success: true } } },
            ]);
            // 摘要 preview 已更新
            expect(graph.candidateSummaries!.find(s => s.nodeId === modelAId)!.preview).toBe('new answer');

            // 续接节点：kind='continue'，父节点为候选，内容为第二条模型消息
            const continuation = graph.nodes[modelBId]!;
            expect(continuation.kind).toBe('continue');
            expect(continuation.parentId).toBe(modelAId);
            expect(continuation.parts).toEqual([{ text: 'after tool' }]);
            expect(graph.nodes[modelAId]!.activeChildId).toBe(modelBId);

            // 旧候选仍在图中
            expect(graph.nodes[modelNodeId]!.parts).toEqual([{ text: 'a1' }]);

            // BR-05：主历史非 functionResponse id 链 == 图活跃路径
            const consistency = await service.validateActivePathMatchesHistory('c1');
            expect(consistency.valid).toBe(true);
            expect(consistency.historyIds).toEqual([userNodeId, modelAId, modelBId]);
            expect(consistency.activePathIds).toEqual([userNodeId, modelAId, modelBId]);
        });

        test('失败保留旧候选（决策 10）：流式未产生内容时新候选保留为空、旧候选可切回', async () => {
            const [userNodeId, modelNodeId] = await seedConversation('c1');
            const started = await service.startReroll('c1', modelNodeId);

            // 流式失败：主历史没有任何新消息（工具循环未写入）
            const finished = await service.finishReroll('c1', started.candidateNodeId);
            expect(finished.syncedMessageCount).toBe(0);
            expect(finished.candidateNodeId).toBe(started.candidateNodeId);

            const graph = (await service.getBranchGraph('c1')).graph!;
            expect(validate(graph).valid).toBe(true);
            // 新候选保留为空（失败候选，可切回查看）
            expect(graph.nodes[started.candidateNodeId]!.parts).toEqual([]);
            expect(graph.candidateSummaries!.find(s => s.nodeId === started.candidateNodeId)!.preview).toBe('');
            // 旧候选完整保留
            expect(graph.nodes[modelNodeId]!.parts).toEqual([{ text: 'a1' }]);

            // 旧候选可切回（switchBranchCandidate 图状态切换）
            const switched = await service.switchBranchCandidate('c1', modelNodeId);
            expect(switched.activePathIds).toEqual([userNodeId, modelNodeId]);
        });

        test('失败保留旧候选（决策 10）：半截消息也回填，可切回查看错误', async () => {
            const [, modelNodeId] = await seedConversation('c1');
            const started = await service.startReroll('c1', modelNodeId);

            // 流式中断：只写入了半截模型消息
            await manager.addContent('c1', { role: 'model', parts: [{ text: 'half answer' }] } as any);
            const history = await manager.getMessagesRaw('c1');
            const halfId = history[history.length - 1].id!;

            const finished = await service.finishReroll('c1', started.candidateNodeId);
            expect(finished.candidateNodeId).toBe(halfId);

            const graph = (await service.getBranchGraph('c1')).graph!;
            expect(graph.nodes[halfId]!.parts).toEqual([{ text: 'half answer' }]);
            expect(graph.candidateSummaries!.find(s => s.nodeId === halfId)!.preview).toBe('half answer');
            // 旧候选保留
            expect(graph.nodes[modelNodeId]).toBeTruthy();
            expect(validate(graph).valid).toBe(true);
        });
    });

    describe('TREE-02 多候选与上限', () => {
        test('多次 reroll 形成多个兄弟候选（含 reroll 新候选后再 reroll）', async () => {
            const [userNodeId, modelNodeId] = await seedConversation('c1');

            // 第一次 reroll → A
            const r1 = await service.startReroll('c1', modelNodeId);
            const history1 = await simulateToolLoopOutput(manager, 'c1');
            const f1 = await service.finishReroll('c1', r1.candidateNodeId);
            const aId = f1.candidateNodeId;

            // 第二次 reroll（reroll 新候选 A）→ B
            const r2 = await service.startReroll('c1', aId);
            await manager.addContent('c1', { role: 'model', parts: [{ text: 'second answer' }] } as any);
            const f2 = await service.finishReroll('c1', r2.candidateNodeId);
            const bId = f2.candidateNodeId;

            const graph = (await service.getBranchGraph('c1')).graph!;
            expect(validate(graph).valid).toBe(true);
            // 兄弟候选：M（imported）、A（reroll）、B（reroll），按 createdAt 升序
            expect(childrenIndex(graph).get(userNodeId)).toEqual([modelNodeId, aId, bId]);
            // 全部候选都在图中
            expect(graph.nodes[modelNodeId]).toBeTruthy();
            expect(graph.nodes[aId]).toBeTruthy();
            expect(graph.nodes[bId]).toBeTruthy();
            expect(graph.nodes[aId]!.kind).toBe('reroll');
            expect(graph.nodes[bId]!.kind).toBe('reroll');
            // 尾指针指向最后激活的候选
            expect(graph.activeTailNodeId).toBe(bId);
            expect(graph.nodes[userNodeId]!.activeChildId).toBe(bId);
            // 主历史 = 新候选路径（第二条回答）
            const history = await manager.getMessagesRaw('c1');
            expect(history.map(m => m.id)).toEqual([userNodeId, bId]);
            expect(history1).toHaveLength(4); // 第一条模拟输出仍可用（上一轮）
        });

        test('每父节点候选上限（决策 4）：第 11 个拒绝并提示清理，不自动删', async () => {
            const [userNodeId, modelNodeId] = await seedConversation('c1');
            // children(U) = [M]（原始回答占 1 个槽位），还能创建 MAX-1 个 reroll 候选
            for (let i = 0; i < MAX_CANDIDATES_PER_PARENT - 1; i++) {
                await service.createRerollCandidate('c1', userNodeId, { parts: [{ text: `a${i}` }] });
            }
            const graphBefore = (await service.getBranchGraph('c1')).graph!;
            expect(childrenIndex(graphBefore).get(userNodeId)).toHaveLength(MAX_CANDIDATES_PER_PARENT);

            await expect(
                service.createRerollCandidate('c1', userNodeId, { parts: [{ text: 'overflow' }] })
            ).rejects.toMatchObject({ code: 'BRANCH_OPERATION_CONFLICT' });
            await expect(
                service.createRerollCandidate('c1', userNodeId, { parts: [{ text: 'overflow' }] })
            ).rejects.toThrow(/candidate limit/);

            // 不自动删除：图状态不变
            const graphAfter = (await service.getBranchGraph('c1')).graph!;
            expect(childrenIndex(graphAfter).get(userNodeId)).toHaveLength(MAX_CANDIDATES_PER_PARENT);
            expect(validate(graphAfter).valid).toBe(true);
            expect(modelNodeId).toBeTruthy();
        });

        test('startReroll 同样受上限约束', async () => {
            const [userNodeId, modelNodeId] = await seedConversation('c1');
            // 创建 9 个候选（含原始回答共 10 个 children）
            let lastCandidateId = modelNodeId;
            for (let i = 0; i < MAX_CANDIDATES_PER_PARENT - 1; i++) {
                const created = await service.createRerollCandidate('c1', userNodeId, { parts: [{ text: `a${i}` }] });
                lastCandidateId = created.nodeId;
            }
            // 活跃路径 = U → 最后一个候选（model），reroll 它 → 父节点 U 已满
            await expect(service.startReroll('c1', lastCandidateId)).rejects.toMatchObject({
                code: 'BRANCH_OPERATION_CONFLICT'
            });
            const graph = (await service.getBranchGraph('c1')).graph!;
            expect(childrenIndex(graph).get(userNodeId)).toHaveLength(MAX_CANDIDATES_PER_PARENT);
            expect(validate(graph).valid).toBe(true);
        });

        test('候选摘要维护：每次 reroll upsert 对应摘要，finish 后更新 preview', async () => {
            const [userNodeId, modelNodeId] = await seedConversation('c1');
            const r1 = await service.startReroll('c1', modelNodeId);
            await manager.addContent('c1', { role: 'model', parts: [{ text: 'brand new' }] } as any);
            const f1 = await service.finishReroll('c1', r1.candidateNodeId);

            const graph = (await service.getBranchGraph('c1')).graph!;
            const summaries = graph.candidateSummaries ?? [];
            expect(summaries.filter(s => s.parentId === userNodeId)).toHaveLength(1);
            expect(summaries.find(s => s.nodeId === f1.candidateNodeId)).toMatchObject({
                parentId: userNodeId,
                kind: 'reroll',
                preview: 'brand new',
            });
        });
    });

    describe('与 retryStream 并存（决策 5：旧接口保留内部兼容）', () => {
        test('reroll 后旧破坏性 retry 路径（deleteMessage）仍可用，图侧候选不受影响', async () => {
            const [userNodeId, modelNodeId] = await seedConversation('c1');
            const started = await service.startReroll('c1', modelNodeId);
            await simulateToolLoopOutput(manager, 'c1');
            await service.finishReroll('c1', started.candidateNodeId);

            // 模拟旧 retryFromMessage：前端先 deleteMessage 截断主历史再 retryStream。
            // 主历史当前 = [U, A, FR, B]；删除助手消息（index 1 起）
            const historyBefore = await manager.getMessagesRaw('c1');
            expect(historyBefore.length).toBe(4);
            await manager.deleteToMessage('c1', 1);
            const historyAfter = await manager.getMessagesRaw('c1');
            expect(historyAfter.map(m => m.id)).toEqual([userNodeId]);

            // 图侧不受影响：旧候选 M 与 reroll 候选（finish 后重命名对齐消息 id）全部保留，图仍一致
            const graph = (await service.getBranchGraph('c1')).graph!;
            expect(validate(graph).valid).toBe(true);
            expect(graph.nodes[modelNodeId]).toBeTruthy();
            // finishReroll 会把候选节点重命名为主历史消息 id，占位 id 已不存在
            const history = await manager.getMessagesRaw('c1');
            expect(history.map(m => m.id)).toEqual([userNodeId]);
        });
    });

    describe('BranchGraph 纯函数扩展（TREE-01 内容写入 / 重命名）', () => {
        test('updateNodeContent：只替换显式字段，parts 深拷贝，缺失节点抛错', () => {
            const graph = createEmptyBranchGraph();
            const base = { id: 'n1', parentId: null, role: 'model' as const, parts: [{ text: 'a' }], kind: 'reroll' as const, createdAt: 1 };
            const withNode = { ...graph, nodes: { n1: base }, rootNodeId: 'n1', activeTailNodeId: 'n1' };

            const inputParts = [{ text: 'b' }];
            const updated = updateNodeContent(withNode, 'n1', { parts: inputParts, modelVersion: 'v2' });
            expect(updated.nodes.n1!.parts).toEqual([{ text: 'b' }]);
            expect(updated.nodes.n1!.modelVersion).toBe('v2');
            expect(updated.nodes.n1!.createdAt).toBe(1); // 未显式提供的字段保留
            // 深拷贝：调用方后续修改传入数组不污染图数据
            inputParts.push({ text: 'c' });
            expect(updated.nodes.n1!.parts).toEqual([{ text: 'b' }]);

            expect(() => updateNodeContent(withNode, 'missing', { parts: [] })).toThrow(BranchError);
            expect(() => updateNodeContent(withNode, 'missing', { parts: [] })).toThrow(/NODE_NOT_FOUND|node not found/);
        });

        test('renameNode：同步修正 nodes / 父 activeChildId / 尾指针 / 摘要；oldId===newId 为 no-op', () => {
            const graph = createEmptyBranchGraph();
            const parent = { id: 'u1', parentId: null, role: 'user' as const, parts: [], kind: 'normal' as const, createdAt: 1, activeChildId: 'n1' };
            const child = { id: 'n1', parentId: 'u1', role: 'model' as const, parts: [], kind: 'reroll' as const, createdAt: 2 };
            const withNodes: typeof graph = {
                ...graph,
                nodes: { u1: parent, n1: child },
                rootNodeId: 'u1',
                activeTailNodeId: 'n1',
                activeChildId: 'n1', // 根节点 activeChildId 镜像（validate 要求一致）
                candidateSummaries: [{ nodeId: 'n1', parentId: 'u1', kind: 'reroll', createdAt: 2, preview: 'x' }],
            };
            expect(validate(withNodes).valid).toBe(true);

            const renamed = renameNode(withNodes, 'n1', 'n1-real');
            expect(renamed.nodes['n1']).toBeUndefined();
            expect(renamed.nodes['n1-real']!.parentId).toBe('u1');
            expect(renamed.nodes['u1']!.activeChildId).toBe('n1-real');
            expect(renamed.activeTailNodeId).toBe('n1-real');
            expect(renamed.candidateSummaries![0].nodeId).toBe('n1-real');
            expect(validate(renamed).valid).toBe(true);

            // no-op
            expect(renameNode(withNodes, 'n1', 'n1')).toBe(withNodes);
            // 目标 id 已占用
            expect(() => renameNode(withNodes, 'n1', 'u1')).toThrow(BranchError);
        });
    });
});

describe('TREE-01 webview handler：chat.rerollStream（R6a-FIX H1 取消接线）', () => {
    let tempDir: string;
    let manager: ConversationManager;
    let responses: Array<{ requestId: string; data: unknown }>;
    let errors: Array<{ requestId: string; code: string; message: string }>;

    function makeCtx(overrides: Record<string, unknown> = {}): HandlerContext {
        return {
            conversationManager: manager,
            storagePathManager: {
                getEffectiveDataPath: () => tempDir,
            } as unknown as HandlerContext['storagePathManager'],
            streamAbortControllers: new StreamAbortManager() as unknown as Map<string, AbortController>,
            sendResponse: (requestId, data) => { responses.push({ requestId, data }); },
            sendError: (requestId, code, message) => { errors.push({ requestId, code, message }); },
            ...overrides,
        } as unknown as HandlerContext;
    }

    beforeEach(async () => {
        tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'reroll-handler-'));
        manager = new ConversationManager(new MemoryStorageAdapter());
        responses = [];
        errors = [];
        setGlobalBranchService(undefined);
    });

    afterEach(async () => {
        setGlobalBranchService(undefined);
        await fsp.rm(tempDir, { recursive: true, force: true });
    });

    test('H1：rerollStream 注册 AbortController、透传 abortSignal、结束清理（isActive 生命周期）', async () => {
        const abortManager = new StreamAbortManager();
        let receivedAbortSignal: AbortSignal | undefined;
        let isActiveDuringStream = false;
        const fakeChatHandler = {
            handleRerollStream: async function* (request: any) {
                receivedAbortSignal = request.abortSignal;
                isActiveDuringStream = abortManager.isActive(request.conversationId);
                yield { conversationId: request.conversationId, chunk: { text: 'x' } } as any;
            },
        } as any;

        const ctx = makeCtx({
            chatHandler: fakeChatHandler,
            streamAbortControllers: abortManager as unknown as Map<string, AbortController>,
        });

        await rerollStream(
            { conversationId: 'c1', configId: 'cfg' },
            'req-h1',
            ctx
        );

        // 流期间已注册控制器并透传 signal（TREE-13 互斥因此能覆盖 reroll）
        expect(isActiveDuringStream).toBe(true);
        expect(receivedAbortSignal).toBeDefined();
        expect(receivedAbortSignal!.aborted).toBe(false);
        // 结束后 finally 清理：isActive 归 false，无残留控制器
        expect(abortManager.isActive('c1')).toBe(false);
        expect(abortManager.get('c1')).toBeUndefined();
        expect(responses).toEqual([{ requestId: 'req-h1', data: { started: true } }]);
        expect(errors).toHaveLength(0);
    });

    test('H1：停止按钮路径（abortManager.cancel）→ 取消时透出 cancelled 结尾、不报错、控制器已清理', async () => {
        const abortManager = new StreamAbortManager();
        let capturedSignal: AbortSignal | undefined;
        const fakeChatHandler = {
            handleRerollStream: async function* (request: any) {
                capturedSignal = request.abortSignal;
                // 模拟工具循环感知取消后抛 AbortError（与真实 runToolLoop 一致）
                await new Promise<void>((_resolve, reject) => {
                    request.abortSignal.addEventListener('abort', () => {
                        const err = new Error('The operation was aborted.');
                        err.name = 'AbortError';
                        reject(err);
                    });
                });
            },
        } as any;

        const ctx = makeCtx({
            chatHandler: fakeChatHandler,
            streamAbortControllers: abortManager as unknown as Map<string, AbortController>,
        });

        const pending = rerollStream({ conversationId: 'c1', configId: 'cfg' }, 'req-h2', ctx);
        // 生产「停止」按钮路径：cancel 会 abort controller 并从 map 移除
        abortManager.cancel('c1');
        await pending;

        expect(capturedSignal).toBeDefined();
        expect(capturedSignal!.aborted).toBe(true);
        // 取消路径：不产生 REROLL_ERROR，控制器已清理
        expect(errors).toHaveLength(0);
        expect(abortManager.isActive('c1')).toBe(false);
        expect(abortManager.get('c1')).toBeUndefined();
    });
});
