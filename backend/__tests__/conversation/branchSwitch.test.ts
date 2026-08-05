/**
 * TREE-04/06 候选切换全链测试（第六阶段：切换重建主历史）。
 *
 * 覆盖（TREE-14 切换部分）：
 * - handler 级 switchBranchCandidate 编排：切图（BranchService）→ 主历史重写
 *   （ConversationManager.rewriteHistoryFromBranchGraph）→ 检查点清理
 *   （CheckpointService.deleteCheckpointsFromIndex，会话锁之外）→ 响应
 *   { rewritten: true, activePathLength, historyLength, branchGraph }；
 * - 切换后主历史与图活跃路径一致（BR-05 校验通过）；切回旧候选恢复旧内容；
 * - functionResponse 依附正确（决策 8：FR 拆分回独立消息，id 链不含 FR）；
 * - 切换后继续对话 append 到新活跃尾（appendHistoryToGraph 已接线）；
 * - 检查点清理的分歧索引正确（新路径为旧路径前缀 / 分歧位 / 完全一致三种形态）；
 * - 主历史重写幂等（相同路径 rewritten=false 不落盘）；无图线性模式 no-op；
 *   损坏图拒绝重写（BRANCH_STORAGE_CORRUPT）；
 * - 重写失败回滚图状态（切回切换前活跃尾）并透出明确错误码。
 *
 * 存储组合：历史走 MemoryStorageAdapter，sidecar 走真实临时目录（注入 baseDir），
 * 风格与 branchReroll.test.ts / branchService.test.ts 一致。
 */

import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ConversationManager } from '../../modules/conversation/ConversationManager';
import { MemoryStorageAdapter } from '../../modules/conversation/storage';
import type { ConversationHistory, ConversationMetadata } from '../../modules/conversation/types';
import {
    BranchService,
    setGlobalBranchService,
} from '../../modules/conversation/branch/BranchService';
import { BranchGraphRepository } from '../../modules/conversation/branch/BranchGraphRepository';
import {
    activePath,
    isFunctionResponseMessage,
    validate,
} from '../../modules/conversation/branch/BranchGraph';
import { switchBranchCandidate } from '../../../webview/handlers/BranchHandlers';
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

/** 轮询等待分支图活跃尾收敛（appendHistoryToGraph 为锁外异步接线） */
async function waitForGraphTail(
    service: BranchService,
    conversationId: string,
    expectedTail: string,
    timeoutMs = 3000
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const graph = (await service.getBranchGraph(conversationId)).graph;
        if (graph && graph.activeTailNodeId === expectedTail) {
            return;
        }
        if (Date.now() > deadline) {
            throw new Error(`waitForGraphTail timed out: tail != ${expectedTail}`);
        }
        await new Promise(resolve => setTimeout(resolve, 10));
    }
}

/** R8a-M1：可注入 metadata 写失败的存储适配器（模拟 invalidateContextManagementState 抛错） */
class FailingMetadataStorage extends MemoryStorageAdapter {
    public failMetadata = false;

    override async saveMetadata(metadata: ConversationMetadata): Promise<void> {
        if (this.failMetadata) {
            throw new Error('simulated metadata write failure');
        }
        return super.saveMetadata(metadata);
    }
}

describe('TREE-04/06 候选切换全链（handler 编排）', () => {
    let tempDir: string;
    let repo: BranchGraphRepository;
    let manager: ConversationManager;
    let service: BranchService;
    let responses: Array<{ requestId: string; data: unknown }>;
    let errors: Array<{ requestId: string; code: string; message: string }>;
    let checkpointDeleteSpy: jest.Mock;

    function makeCtx(overrides: Record<string, unknown> = {}): HandlerContext {
        return {
            conversationManager: manager,
            storagePathManager: {
                getEffectiveDataPath: () => tempDir,
            } as unknown as HandlerContext['storagePathManager'],
            streamAbortControllers: new StreamAbortManager() as unknown as Map<string, AbortController>,
            sendResponse: (requestId, data) => { responses.push({ requestId, data }); },
            sendError: (requestId, code, message) => { errors.push({ requestId, code, message }); },
            checkpointManager: {
                deleteCheckpointsFromIndex: checkpointDeleteSpy,
            } as unknown as HandlerContext['checkpointManager'],
            ...overrides,
        } as unknown as HandlerContext;
    }

    beforeEach(async () => {
        tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'branch-switch-'));
        repo = new BranchGraphRepository(tempDir);
        manager = new ConversationManager(new MemoryStorageAdapter());
        service = new BranchService(manager, repo);
        setGlobalBranchService(service);
        responses = [];
        errors = [];
        checkpointDeleteSpy = jest.fn(async () => 0);
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

    /** 调用 handler 级 switchBranchCandidate，返回本次响应数据（同一测试内可多次切换） */
    async function doSwitch(
        conversationId: string,
        nodeId: string,
        ctx: HandlerContext = makeCtx()
    ): Promise<Record<string, unknown>> {
        await switchBranchCandidate({ conversationId, nodeId }, 'req-switch', ctx);
        expect(errors).toHaveLength(0);
        expect(responses.length).toBeGreaterThan(0);
        return responses[responses.length - 1]!.data as Record<string, unknown>;
    }

    test('切图 + 主历史重写 + 响应（rewritten/activePathLength/branchGraph）+ 检查点清理（分歧索引=新历史长度）', async () => {
        const [userNodeId, modelNodeId] = await seedConversation('c1');
        const r1 = await service.createRerollCandidate('c1', modelNodeId, { parts: [{ text: 'a2' }] });
        await service.createRerollCandidate('c1', modelNodeId, { parts: [{ text: 'a3' }] });
        // 当前活跃 = r2，主历史 = [U, M]（createRerollCandidate 不截断主历史）

        const data = await doSwitch('c1', r1.nodeId);

        // 响应契约：rewritten / activePathLength / historyLength / branchGraph
        expect(data).toMatchObject({
            success: true,
            nodeId: r1.nodeId,
            rewritten: true,
            activePathLength: 3,
            historyLength: 3,
        });
        expect((data.branchGraph as { graph: { activeTailNodeId: string | null } }).graph.activeTailNodeId)
            .toBe(r1.nodeId);
        expect(data.activePathIds).toEqual([userNodeId, modelNodeId, r1.nodeId]);

        // 主历史已重写 = 新活跃路径（候选内容来自 sidecar，主历史里原本没有）
        const history = await manager.getMessagesRaw('c1');
        expect(history.map(m => m.id)).toEqual([userNodeId, modelNodeId, r1.nodeId]);
        expect(history[2]!.parts).toEqual([{ text: 'a2' }]);

        // BR-05：主历史 id 链 == 图活跃路径
        const consistency = await service.validateActivePathMatchesHistory('c1');
        expect(consistency.valid).toBe(true);
        expect(consistency.historyIds).toEqual([userNodeId, modelNodeId, r1.nodeId]);
        expect(validate((await service.getBranchGraph('c1')).graph!).valid).toBe(true);

        // 检查点清理：旧历史 [U, M] 是新的 [U, M, r1] 的前缀 → 分歧索引 = min(旧,新) = 2（R8a-L2）
        expect(checkpointDeleteSpy).toHaveBeenCalledWith('c1', 2, undefined);
    });

    test('检查点清理分歧索引：从分歧位（非前缀）清理', async () => {
        const [userNodeId, modelNodeId] = await seedConversation('c1');
        const r1 = await service.createRerollCandidate('c1', modelNodeId, { parts: [{ text: 'a2' }] });
        const r2 = await service.createRerollCandidate('c1', modelNodeId, { parts: [{ text: 'a3' }] });

        // 先切到 r1（历史 = [U, M, r1]）
        await doSwitch('c1', r1.nodeId);
        checkpointDeleteSpy.mockClear();

        // 再切到 r2：旧 [U, M, r1] vs 新 [U, M, r2] → 分歧在索引 2
        const data = await doSwitch('c1', r2.nodeId);
        expect(data.rewritten).toBe(true);
        const history = await manager.getMessagesRaw('c1');
        expect(history.map(m => m.id)).toEqual([userNodeId, modelNodeId, r2.nodeId]);
        expect(checkpointDeleteSpy).toHaveBeenCalledWith('c1', 2, undefined);
        expect(await service.validateActivePathMatchesHistory('c1')).toMatchObject({ valid: true });
    });

    test('检查点清理索引回退边界：切回祖先（旧分支更长）→ 分歧索引=新历史长度，清理尾部检查点（BCP-08）', async () => {
        const [userNodeId, modelNodeId] = await seedConversation('c1');
        // reroll 产生含 functionCall + FR + 续接节点的新候选（主历史 = [U, newA, FR, B]）
        const started = await service.startReroll('c1', modelNodeId);
        await simulateToolLoopOutput(manager, 'c1');
        await service.finishReroll('c1', started.candidateNodeId);
        expect((await manager.getMessagesRaw('c1'))).toHaveLength(4); // [U, newA, FR, B]

        // 切回祖先 M：新历史 [U, M] 是旧历史 [U, newA, FR, B] 的严格前缀 →
        // 分歧索引 = 新历史长度 1（U==U，索引 1 起分歧）→ 从索引 1 清理（newA 分支期间的检查点全部错位）
        const data = await doSwitch('c1', modelNodeId);
        expect(data.rewritten).toBe(true);
        const history = await manager.getMessagesRaw('c1');
        expect(history.map(m => m.id)).toEqual([userNodeId, modelNodeId]);
        expect(history[1]!.parts).toEqual([{ text: 'a1' }]); // 旧回答内容恢复
        expect(checkpointDeleteSpy).toHaveBeenCalledWith('c1', 1, undefined);
        expect(await service.validateActivePathMatchesHistory('c1')).toMatchObject({ valid: true });

        // 同一路径再次切换（幂等）：完全一致 → 不再清理
        checkpointDeleteSpy.mockClear();
        await doSwitch('c1', modelNodeId);
        expect(checkpointDeleteSpy).not.toHaveBeenCalled();
    });

    test('切回旧候选恢复旧内容；切回新候选 functionResponse 依附正确（决策 8）', async () => {
        const [userNodeId, modelNodeId] = await seedConversation('c1');
        // reroll 产生新候选（含 functionCall + FR + 续接节点）
        const started = await service.startReroll('c1', modelNodeId);
        const historyIds = await simulateToolLoopOutput(manager, 'c1');
        const finished = await service.finishReroll('c1', started.candidateNodeId);
        const newAId = finished.candidateNodeId;
        const continuationId = finished.activeTailNodeId!;
        expect(historyIds).toHaveLength(4); // [U, newA, FR, B]

        // 切回旧候选 M：主历史 = [U, M]，旧回答内容恢复
        await doSwitch('c1', modelNodeId);
        let history = await manager.getMessagesRaw('c1');
        expect(history.map(m => m.id)).toEqual([userNodeId, modelNodeId]);
        expect(history[1]!.parts).toEqual([{ text: 'a1' }]);
        expect(await service.validateActivePathMatchesHistory('c1')).toMatchObject({ valid: true });

        // 切回新候选：主历史 = [U, newA, FR, B]，FR 拆分回独立消息且依附正确
        await doSwitch('c1', newAId);
        history = await manager.getMessagesRaw('c1');
        const nonFrIds = history.filter(m => !isFunctionResponseMessage(m)).map(m => m.id!);
        expect(nonFrIds).toEqual([userNodeId, newAId, continuationId]);
        expect(nonFrIds).toEqual(activePath((await service.getBranchGraph('c1')).graph!));

        // FR 消息：role=user + isFunctionResponse + 内容来自 sidecar 节点合并的 parts
        const frMessages = history.filter(m => isFunctionResponseMessage(m));
        expect(frMessages).toHaveLength(1);
        expect(frMessages[0]!.parts).toEqual([
            { functionResponse: { id: 'call-1', name: 'read_file', response: { success: true } } },
        ]);
        // FR 依附：紧跟所属 model 节点消息之后，parentId = 前一条消息（newA）
        const frIndex = history.findIndex(m => isFunctionResponseMessage(m));
        expect(history[frIndex - 1]!.id).toBe(newAId);
        expect(frMessages[0]!.parentId).toBe(newAId);

        // 内容完整恢复（候选文本 + 续接文本）
        const texts = history.filter(m => !isFunctionResponseMessage(m)).map(m =>
            (m.parts ?? []).map(p => (p as { text?: string }).text ?? '').join('')
        );
        expect(texts).toEqual(['q1', 'new answer', 'after tool']);
        expect(await service.validateActivePathMatchesHistory('c1')).toMatchObject({ valid: true });
    });

    test('切换到空候选（失败候选）：从 sidecar 物化空消息，主历史 = 活跃路径', async () => {
        const [userNodeId, modelNodeId] = await seedConversation('c1');
        // reroll 开始但流式未产生内容（失败候选，决策 10）——候选节点 parts 为空
        const started = await service.startReroll('c1', modelNodeId);
        const candidateNodeId = started.candidateNodeId;
        await service.finishReroll('c1', candidateNodeId);
        // 主历史当前 = [U]（startReroll 截断到父节点）

        // 先切回旧候选 M
        await doSwitch('c1', modelNodeId);
        expect((await manager.getMessagesRaw('c1')).map(m => m.id)).toEqual([userNodeId, modelNodeId]);

        // 再切到空候选：主历史物化空消息（内容来自 sidecar）
        await doSwitch('c1', candidateNodeId);
        const history = await manager.getMessagesRaw('c1');
        expect(history.map(m => m.id)).toEqual([userNodeId, candidateNodeId]);
        expect(history[1]!.parts).toEqual([]);
        expect(await service.validateActivePathMatchesHistory('c1')).toMatchObject({ valid: true });
    });

    test('切换后继续对话 append 到新活跃尾（appendHistoryToGraph 已接线）', async () => {
        const [userNodeId, modelNodeId] = await seedConversation('c1');
        const r1 = await service.createRerollCandidate('c1', modelNodeId, { parts: [{ text: 'a2' }] });
        await service.createRerollCandidate('c1', modelNodeId, { parts: [{ text: 'a3' }] });

        // 切到 r1（历史 = [U, M, r1]）
        await doSwitch('c1', r1.nodeId);

        // 继续对话：追加用户消息（模拟前端发送新消息）
        await manager.addBatch('c1', [{ role: 'user', parts: [{ text: 'q2' }], timestamp: 300 }]);

        // appendHistoryToGraph 接线（appendContents 之后异步并入图）：图活跃尾收敛到新消息
        const history = await manager.getMessagesRaw('c1');
        const u2Id = history[history.length - 1]!.id!;
        await waitForGraphTail(service, 'c1', u2Id);

        const graph = (await service.getBranchGraph('c1')).graph!;
        expect(validate(graph).valid).toBe(true);
        expect(graph.nodes[u2Id]!.parentId).toBe(r1.nodeId);
        expect(activePath(graph)).toEqual([userNodeId, modelNodeId, r1.nodeId, u2Id]);

        // 主历史 = 新活跃路径（切到旧候选后继续对话不破坏图）
        const consistency = await service.validateActivePathMatchesHistory('c1');
        expect(consistency.valid).toBe(true);
        expect(consistency.historyIds).toEqual([userNodeId, modelNodeId, r1.nodeId, u2Id]);
    });

    test('线性模式首次切换（无图）：建基线图后主历史不变（幂等 rewritten=false）', async () => {
        const [userNodeId, modelNodeId] = await seedConversation('c1');
        expect(await repo.exists('c1')).toBe(false);

        // 切到已有模型节点 M：无图 → 先建线性基线 [U, M] → 切换目标即原活跃路径
        const data = await doSwitch('c1', modelNodeId);

        // 主历史与活跃路径一致 → 无变更（rewritten=true 表示编排完成，historyRewrite 未落盘）
        expect(data.rewritten).toBe(true);
        expect(data.activePathLength).toBe(2);
        expect((await manager.getMessagesRaw('c1')).map(m => m.id)).toEqual([userNodeId, modelNodeId]);
        // 图已建立且一致
        expect(await repo.exists('c1')).toBe(true);
        expect(await service.validateActivePathMatchesHistory('c1')).toMatchObject({ valid: true });
        // 完全一致 → 检查点无需清理
        expect(checkpointDeleteSpy).not.toHaveBeenCalled();
    });
    test('含 FR 的活跃路径重复切换：FR id 复用 → 第二次 rewritten=false、检查点不误删（R8a-H1/L1）', async () => {
        const [userNodeId, modelNodeId] = await seedConversation('c1');
        // reroll 产生含 functionCall + FR + 续接节点的新候选
        const started = await service.startReroll('c1', modelNodeId);
        await simulateToolLoopOutput(manager, 'c1');
        const finished = await service.finishReroll('c1', started.candidateNodeId);
        const newAId = finished.candidateNodeId;

        // 切回旧候选（清掉工具循环历史）→ 再切回新候选（FR 从图重建，无旧 FR 可复用 → 新 id）
        await doSwitch('c1', modelNodeId);
        checkpointDeleteSpy.mockClear();
        await doSwitch('c1', newAId);

        let history = await manager.getMessagesRaw('c1');
        const frMessages = history.filter(m => isFunctionResponseMessage(m));
        expect(frMessages).toHaveLength(1);
        const frId = frMessages[0]!.id!;
        expect(frId).toBeTruthy();
        // R8a-L1：FR 拆分消息携带所属节点 timestamp（node.timestamp ?? createdAt），不再丢失
        const node = (await service.getBranchGraph('c1')).graph!.nodes[newAId]!;
        expect(frMessages[0]!.timestamp).toBe(node.timestamp ?? node.createdAt);

        // 同一路径再次切换（幂等重试）：FR id 复用 → 主历史与活跃路径完全一致
        checkpointDeleteSpy.mockClear();
        await doSwitch('c1', newAId);
        history = await manager.getMessagesRaw('c1');
        expect(history.map(m => m.id)).toEqual([userNodeId, newAId, frId, finished.activeTailNodeId!]);
        expect(history.filter(m => isFunctionResponseMessage(m))[0]!.id).toBe(frId); // FR id 未重新生成
        // 完全一致 → divergenceIndex=null → 不清理检查点（内容未变、索引仍有效的检查点不被误删）
        expect(checkpointDeleteSpy).not.toHaveBeenCalled();
        expect(await service.validateActivePathMatchesHistory('c1')).toMatchObject({ valid: true });
    });

    test('幂等（含 FR）：同一活跃路径二次直调重写 rewritten=false，FR id 复用（R8a-H1）', async () => {
        const [userNodeId, modelNodeId] = await seedConversation('c1');
        const started = await service.startReroll('c1', modelNodeId);
        await simulateToolLoopOutput(manager, 'c1');
        const finished = await service.finishReroll('c1', started.candidateNodeId);
        const newAId = finished.candidateNodeId;

        await doSwitch('c1', modelNodeId);
        await doSwitch('c1', newAId);
        const frId = (await manager.getMessagesRaw('c1')).filter(m => isFunctionResponseMessage(m))[0]!.id!;

        const second = await manager.rewriteHistoryFromBranchGraph('c1');
        expect(second.rewritten).toBe(false); // 不重复落盘
        expect(second.divergenceIndex).toBeNull();
        const history = await manager.getMessagesRaw('c1');
        expect(history.map(m => m.id)).toEqual([userNodeId, newAId, frId, finished.activeTailNodeId!]);
        expect(await service.validateActivePathMatchesHistory('c1')).toMatchObject({ valid: true });
    });

    test('尾部未入图消息（同步完成前切换）：拒绝 BRANCH_OPERATION_CONFLICT、消息不丢，同步后重试成功（R8a-M2）', async () => {
        const [userNodeId, modelNodeId] = await seedConversation('c1');
        const r1 = await service.createRerollCandidate('c1', modelNodeId, { parts: [{ text: 'a2' }] });
        const r2 = await service.createRerollCandidate('c1', modelNodeId, { parts: [{ text: 'a3' }] });
        // 当前活跃 = r2

        // 模拟「主历史已追加但图同步未完成/失败」：分支服务未注册期间追加 → appendContents 的
        // appendHistoryToGraph 锁外同步被跳过，消息只存在于主历史（不在图中）。
        setGlobalBranchService(undefined);
        await manager.addBatch('c1', [{ role: 'user', parts: [{ text: 'q2' }], timestamp: 300 }]);
        setGlobalBranchService(service);
        const q2Id = (await manager.getMessagesRaw('c1'))[2]!.id!;
        expect((await service.getBranchGraph('c1')).graph!.nodes[q2Id]).toBeUndefined();

        // 切换被拒绝：明确错误码，主历史保持原样（未入图消息不丢），图回滚到切换前活跃尾 r2
        await switchBranchCandidate({ conversationId: 'c1', nodeId: r1.nodeId }, 'req-m2', makeCtx());
        expect(responses).toHaveLength(0);
        expect(errors).toHaveLength(1);
        expect(errors[0]).toMatchObject({ requestId: 'req-m2', code: 'BRANCH_OPERATION_CONFLICT' });
        expect(errors[0].message).toContain('not yet synced');
        expect((await manager.getMessagesRaw('c1')).map(m => m.id)).toEqual([userNodeId, modelNodeId, q2Id]);
        const graphAfterReject = (await service.getBranchGraph('c1')).graph!;
        expect(graphAfterReject.activeTailNodeId).toBe(r2.nodeId);

        // 同步收敛（模拟 appendHistoryToGraph 完成）后重试切换成功：消息保留为图分支，未被替换丢弃
        await service.appendHistoryToGraph('c1', (await manager.getMessagesRaw('c1')).slice(2));
        errors.length = 0;
        const data = await doSwitch('c1', r1.nodeId);
        expect(data.rewritten).toBe(true);
        expect((await manager.getMessagesRaw('c1')).map(m => m.id)).toEqual([userNodeId, modelNodeId, r1.nodeId]);
        const graph = (await service.getBranchGraph('c1')).graph!;
        expect(graph.nodes[q2Id]).toBeDefined();
        expect(graph.nodes[q2Id]!.parentId).toBe(r2.nodeId); // q2 保留在 r2 分支下
        expect(await service.validateActivePathMatchesHistory('c1')).toMatchObject({ valid: true });
    });

    test('owner 节点已入图但 FR 内容未同步：拒绝切换、主历史不变；补齐 FR 后重试成功、重写幂等（R8a-M2 FR 校验）', async () => {
        const [userNodeId, modelNodeId] = await seedConversation('c1');
        const r1 = await service.createRerollCandidate('c1', modelNodeId, { parts: [{ text: 'a2' }] });
        const r2 = await service.createRerollCandidate('c1', modelNodeId, { parts: [{ text: 'a3' }] });
        // 当前活跃 = r2，主历史 = [U, M]

        // 模拟「图同步只完成了非 FR 批次」：分支服务未注册期间追加非 FR 模型消息（appendContents
        // 的 appendHistoryToGraph 锁外同步被跳过），随后显式 appendHistoryToGraph 只同步该非 FR
        // 批次——owner 节点入图（含 functionCall），FR 内容尚未并入。
        setGlobalBranchService(undefined);
        await manager.addContent('c1', {
            role: 'model',
            parts: [
                { text: 'tool answer' },
                { functionCall: { id: 'call-1', name: 'read_file', args: {} } },
            ],
            modelVersion: 'gemini-x',
            timestamp: 300,
        } as any);
        setGlobalBranchService(service);
        const newAMessage = (await manager.getMessagesRaw('c1'))[2]!;
        const newAId = newAMessage.id!;
        await service.appendHistoryToGraph('c1', [newAMessage]);

        // 追加仅 FR 消息：addBatch 契约显式拒绝 functionResponse（L4，无去重安全网），FR 必须走
        // addContent——其 mutateContents 路径不触发 appendHistoryToGraph 图同步 → FR 内容留在
        // 主历史、图未更新（这正是「FR 同步缺口」的生产复现路径）。
        await manager.addContent('c1', {
            role: 'user',
            parts: [{ functionResponse: { id: 'call-1', name: 'read_file', response: { success: true } } }],
            isFunctionResponse: true,
            timestamp: 400,
        } as any);
        const frId = (await manager.getMessagesRaw('c1'))[3]!.id!;
        expect((await manager.getMessagesRaw('c1')).map(m => m.id)).toEqual([userNodeId, modelNodeId, newAId, frId]);

        // owner 节点已入图但 FR parts 未并入（只同步了非 FR 批次）
        let graph = (await service.getBranchGraph('c1')).graph!;
        expect(graph.nodes[newAId]).toBeDefined();
        expect(graph.nodes[newAId]!.parts.some(p => p.functionCall?.id === 'call-1')).toBe(true);
        expect(graph.nodes[newAId]!.parts.some(p => !!p.functionResponse)).toBe(false);
        expect(graph.activeTailNodeId).toBe(newAId);

        // 切换被拒绝：R8a-M2 FR 校验报出未同步 FR（明确错误码 + not yet synced + FR 数量），
        // 主历史保持原样（FR 内容不丢），图回滚到切换前活跃尾 newA
        await switchBranchCandidate({ conversationId: 'c1', nodeId: r1.nodeId }, 'req-m2-fr', makeCtx());
        expect(responses).toHaveLength(0);
        expect(errors).toHaveLength(1);
        expect(errors[0]).toMatchObject({ requestId: 'req-m2-fr', code: 'BRANCH_OPERATION_CONFLICT' });
        expect(errors[0].message).toContain('not yet synced');
        expect(errors[0].message).toContain('functionResponse');
        expect((await manager.getMessagesRaw('c1')).map(m => m.id)).toEqual([userNodeId, modelNodeId, newAId, frId]);
        graph = (await service.getBranchGraph('c1')).graph!;
        expect(graph.activeTailNodeId).toBe(newAId);
        expect(graph.nodes[newAId]!.parts.some(p => !!p.functionResponse)).toBe(false);

        // 补齐 FR（模拟 appendHistoryToGraph 完成 FR 合并）后重试切换成功：FR 内容并入 owner 节点
        await service.appendHistoryToGraph('c1', [(await manager.getMessagesRaw('c1'))[3]!]);
        graph = (await service.getBranchGraph('c1')).graph!;
        expect(graph.nodes[newAId]!.parts.some(p => p.functionResponse?.id === 'call-1')).toBe(true);

        errors.length = 0;
        const data = await doSwitch('c1', r1.nodeId);
        expect(data.rewritten).toBe(true);
        expect((await manager.getMessagesRaw('c1')).map(m => m.id)).toEqual([userNodeId, modelNodeId, r1.nodeId]);
        // FR 内容保留在 r2 分支下（未因切换静默丢弃）
        graph = (await service.getBranchGraph('c1')).graph!;
        expect(graph.nodes[newAId]!.parts.some(p => p.functionResponse?.id === 'call-1')).toBe(true);
        expect(await service.validateActivePathMatchesHistory('c1')).toMatchObject({ valid: true });

        // 补齐后再次重写：主历史 = 活跃路径 → 幂等 rewritten=false
        const second = await manager.rewriteHistoryFromBranchGraph('c1');
        expect(second.rewritten).toBe(false);
        expect(second.divergenceIndex).toBeNull();
    });

    test('metadata 写失败：重写前失效 trim 状态 → saveHistory 未执行、图回滚，图/历史一致（R8a-M1）', async () => {
        const failingStorage = new FailingMetadataStorage();
        const mgr = new ConversationManager(failingStorage);
        const customService = new BranchService(mgr, repo);
        setGlobalBranchService(customService);

        await mgr.createConversation('c1', 'T');
        await mgr.addBatch('c1', linearHistory());
        const [userNodeId, modelNodeId] = (await mgr.getMessagesRaw('c1')).map(m => m.id!);
        const r1 = await customService.createRerollCandidate('c1', modelNodeId, { parts: [{ text: 'a2' }] });
        const r2 = await customService.createRerollCandidate('c1', modelNodeId, { parts: [{ text: 'a3' }] });
        // 当前活跃 = r2

        // 注入 metadata 写失败：重写流程中 invalidateContextManagementState → saveMetadata 抛错
        failingStorage.failMetadata = true;
        const ctx = makeCtx({ conversationManager: mgr });
        await switchBranchCandidate({ conversationId: 'c1', nodeId: r1.nodeId }, 'req-m1', ctx);

        // 明确错误透出（非 BranchError → INTERNAL_ERROR）
        expect(responses).toHaveLength(0);
        expect(errors).toHaveLength(1);
        expect(errors[0]).toMatchObject({ requestId: 'req-m1', code: 'INTERNAL_ERROR' });
        expect(errors[0].message).toContain('simulated metadata write failure');

        // 主历史未被重写（saveHistory 未执行）：仍为切换前状态 [U, M]
        expect((await mgr.getMessagesRaw('c1')).map(m => m.id)).toEqual([userNodeId, modelNodeId]);
        // 图回滚到切换前活跃尾 r2：图/历史一致（无「图=新路径、历史=旧路径」的永久分裂）
        const graph = (await customService.getBranchGraph('c1')).graph!;
        expect(validate(graph).valid).toBe(true);
        expect(graph.activeTailNodeId).toBe(r2.nodeId);
        expect(graph.nodes[modelNodeId]!.activeChildId).toBe(r2.nodeId);

        // 自愈：metadata 恢复后重试切换成功
        failingStorage.failMetadata = false;
        errors.length = 0;
        const data = await doSwitch('c1', r1.nodeId, ctx);
        expect(data.rewritten).toBe(true);
        expect((await mgr.getMessagesRaw('c1')).map(m => m.id)).toEqual([userNodeId, modelNodeId, r1.nodeId]);
        expect(await customService.validateActivePathMatchesHistory('c1')).toMatchObject({ valid: true });
    });
});

describe('TREE-06 ConversationManager.rewriteHistoryFromBranchGraph（直调）', () => {
    let tempDir: string;
    let repo: BranchGraphRepository;
    let manager: ConversationManager;
    let service: BranchService;

    beforeEach(async () => {
        tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'branch-rewrite-'));
        repo = new BranchGraphRepository(tempDir);
        manager = new ConversationManager(new MemoryStorageAdapter());
        service = new BranchService(manager, repo);
        setGlobalBranchService(service);
    });

    afterEach(async () => {
        setGlobalBranchService(undefined);
        await fsp.rm(tempDir, { recursive: true, force: true });
    });

    async function seedConversation(conversationId: string): Promise<string[]> {
        await manager.createConversation(conversationId, 'T');
        await manager.addBatch(conversationId, linearHistory());
        return (await manager.getMessagesRaw(conversationId)).map(m => m.id!);
    }

    test('无图（线性模式）：rewritten=false，主历史不变', async () => {
        const ids = await seedConversation('c1');
        const result = await manager.rewriteHistoryFromBranchGraph('c1');
        expect(result).toMatchObject({ rewritten: false, historyLength: 2, activePathLength: 0, divergenceIndex: null });
        expect(result.historyIds).toEqual(ids);
        expect((await manager.getMessagesRaw('c1')).map(m => m.id)).toEqual(ids);
    });

    test('幂等：切换重写后再次调用同一路径 rewritten=false（不重复落盘）', async () => {
        const [userNodeId, modelNodeId] = await seedConversation('c1');
        const r1 = await service.createRerollCandidate('c1', modelNodeId, { parts: [{ text: 'a2' }] });
        await service.createRerollCandidate('c1', modelNodeId, { parts: [{ text: 'a3' }] });

        await service.switchBranchCandidate('c1', r1.nodeId);
        const first = await manager.rewriteHistoryFromBranchGraph('c1');
        expect(first.rewritten).toBe(true);
        expect(first.divergenceIndex).toBe(2); // 旧 [U, M] 是 [U, M, r1] 的前缀（R8a-L2：min(旧,新)）

        // 同一路径再次重写 → 完全一致，不落盘
        const second = await manager.rewriteHistoryFromBranchGraph('c1');
        expect(second.rewritten).toBe(false);
        expect(second.divergenceIndex).toBeNull();
        expect(second.historyIds).toEqual([userNodeId, modelNodeId, r1.nodeId]);
    });

    test('sidecar 损坏时拒绝重写（BRANCH_STORAGE_CORRUPT），主历史保持原样', async () => {
        await seedConversation('c1');
        const filePath = repo.getBranchesFilePath('c1');
        await fsp.mkdir(path.dirname(filePath), { recursive: true });
        await fsp.writeFile(filePath, '{ broken json', 'utf8');

        await expect(manager.rewriteHistoryFromBranchGraph('c1'))
            .rejects.toMatchObject({ code: 'BRANCH_STORAGE_CORRUPT' });
        // 主历史未被破坏
        expect((await manager.getMessagesRaw('c1')).length).toBe(2);
    });

    test('语义损坏图（可解析但无效）同样拒绝重写', async () => {
        const ids = await seedConversation('c1');
        const filePath = repo.getBranchesFilePath('c1');
        await fsp.mkdir(path.dirname(filePath), { recursive: true });
        // parentId 链成环：可解析但语义损坏
        const invalidGraph = {
            version: 1,
            rootNodeId: 'root',
            activeTailNodeId: 'root',
            nodes: {
                root: { id: 'root', parentId: null, role: 'user', parts: [{ text: 'q' }], kind: 'normal', createdAt: 1 },
                a: { id: 'a', parentId: 'b', role: 'user', parts: [], kind: 'normal', createdAt: 2 },
                b: { id: 'b', parentId: 'a', role: 'user', parts: [], kind: 'normal', createdAt: 3 },
            },
            activeChildId: null,
            candidateSummaries: [],
        };
        await fsp.writeFile(filePath, JSON.stringify(invalidGraph), 'utf8');

        await expect(manager.rewriteHistoryFromBranchGraph('c1'))
            .rejects.toMatchObject({ code: 'BRANCH_STORAGE_CORRUPT' });
        expect((await manager.getMessagesRaw('c1')).length).toBe(2);
        expect(ids).toHaveLength(2);
    });

    test('未注册全局分支服务时拒绝（BRANCH_OPERATION_CONFLICT）', async () => {
        await seedConversation('c1');
        setGlobalBranchService(undefined);
        await expect(manager.rewriteHistoryFromBranchGraph('c1'))
            .rejects.toMatchObject({ code: 'BRANCH_OPERATION_CONFLICT' });
    });
});

describe('TREE-04/06 切换失败语义（handler 回滚）', () => {
    let tempDir: string;
    let repo: BranchGraphRepository;
    let manager: ConversationManager;
    let service: BranchService;
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
        tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'branch-switch-fail-'));
        repo = new BranchGraphRepository(tempDir);
        manager = new ConversationManager(new MemoryStorageAdapter());
        service = new BranchService(manager, repo);
        setGlobalBranchService(service);
        responses = [];
        errors = [];
    });

    afterEach(async () => {
        setGlobalBranchService(undefined);
        await fsp.rm(tempDir, { recursive: true, force: true });
    });

    test('主历史重写失败：图状态回滚到切换前活跃尾，透出明确错误码', async () => {
        const [userNodeId, modelNodeId] = await seedConversationFor(manager, 'c1');
        const r1 = await service.createRerollCandidate('c1', modelNodeId, { parts: [{ text: 'a2' }] });
        const r2 = await service.createRerollCandidate('c1', modelNodeId, { parts: [{ text: 'a3' }] });
        // 当前活跃 = r2

        // 注入重写失败（模拟服务端缺陷/IO 异常）
        (manager as unknown as { rewriteHistoryFromBranchGraph: unknown }).rewriteHistoryFromBranchGraph =
            async () => { throw new Error('simulated rewrite failure'); };

        await switchBranchCandidate({ conversationId: 'c1', nodeId: r1.nodeId }, 'req-fail', makeCtx());

        // 明确错误码：非 BranchError → INTERNAL_ERROR，透出原始信息（L-6 语义）
        expect(responses).toHaveLength(0);
        expect(errors).toHaveLength(1);
        expect(errors[0]).toMatchObject({ requestId: 'req-fail', code: 'INTERNAL_ERROR' });
        expect(errors[0].message).toContain('simulated rewrite failure');

        // 图状态回滚到切换前活跃尾 r2（图/历史不长期不一致）
        const graph = (await service.getBranchGraph('c1')).graph!;
        expect(validate(graph).valid).toBe(true);
        expect(graph.activeTailNodeId).toBe(r2.nodeId);
        expect(graph.nodes[modelNodeId]!.activeChildId).toBe(r2.nodeId);
        // 主历史保持切换前状态
        const history = await manager.getMessagesRaw('c1');
        expect(history.map(m => m.id)).toEqual([userNodeId, modelNodeId]);
    });

    test('线性模式（无图）重写失败：回滚锚点取旧历史尾，图回到线性路径', async () => {
        const [userNodeId, modelNodeId] = await seedConversationFor(manager, 'c1');
        expect(await repo.exists('c1')).toBe(false);

        (manager as unknown as { rewriteHistoryFromBranchGraph: unknown }).rewriteHistoryFromBranchGraph =
            async () => { throw new Error('boom'); };

        await switchBranchCandidate({ conversationId: 'c1', nodeId: modelNodeId }, 'req-fail2', makeCtx());

        expect(errors).toHaveLength(1);
        expect(errors[0].code).toBe('INTERNAL_ERROR');
        // 图回到旧历史尾（线性路径 M）
        const graph = (await service.getBranchGraph('c1')).graph!;
        expect(validate(graph).valid).toBe(true);
        expect(activePath(graph)).toEqual([userNodeId, modelNodeId]);
        expect((await manager.getMessagesRaw('c1')).map(m => m.id)).toEqual([userNodeId, modelNodeId]);
    });

    /** 与顶层 describe 同名辅助（避免闭包依赖）：建会话并写入线性历史 */
    async function seedConversationFor(mgr: ConversationManager, conversationId: string): Promise<string[]> {
        await mgr.createConversation(conversationId, 'T');
        await mgr.addBatch(conversationId, linearHistory());
        return (await mgr.getMessagesRaw(conversationId)).map(m => m.id!);
    }
});
