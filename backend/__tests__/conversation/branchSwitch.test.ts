/**
 * BranchService 切图与 ConversationManager 重写主历史的组合测试。
 * 保留内容、父链、工具响应、幂等、同步缺口及写入失败断言；分歧索引直接取真实重写结果。
 */

import { ConversationManager } from '../../modules/conversation';
import { MemoryStorageAdapter } from '../../modules/conversation';
import type { ConversationHistory, ConversationMetadata } from '../../modules/conversation';
import {
    BranchService,
    setGlobalBranchService,
} from '../../modules/conversation/branch/BranchService';
import { MemoryBranchStorage } from '../__fixtures__/memoryBranchStorage';
import type { ConversationBranchGraph } from '../../modules/conversation/branch/types';
import {
    activePath,
    isFunctionResponseMessage,
    validate,
} from '../../modules/conversation/branch/BranchGraph';

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

describe('候选切换与主历史重写（共享服务组合）', () => {
    let repo: MemoryBranchStorage;
    let manager: ConversationManager;
    let service: BranchService;

    beforeEach(async () => {
        repo = new MemoryBranchStorage();
        manager = new ConversationManager(new MemoryStorageAdapter());
        service = new BranchService(manager, repo);
        setGlobalBranchService(service);
    });

    afterEach(async () => {
        setGlobalBranchService(undefined);
    });

    /** 建会话并写入线性历史，返回 [userNodeId, modelNodeId] */
    async function seedConversation(conversationId: string): Promise<string[]> {
        await manager.createConversation(conversationId, 'T');
        await manager.addBatch(conversationId, linearHistory());
        return (await manager.getMessagesRaw(conversationId)).map(m => m.id!);
    }

    /** 只组合两个真实服务调用，返回重写结果；不模拟旧 IPC 响应、回滚或检查点清理。 */
    async function doSwitch(conversationId: string, nodeId: string) {
        await service.switchBranchCandidate(conversationId, nodeId);
        return manager.rewriteHistoryFromBranchGraph(conversationId);
    }

    test('切图与主历史重写保持活跃路径一致，并返回准确分歧索引', async () => {
        const [userNodeId, modelNodeId] = await seedConversation('c1');
        const r1 = await service.createRerollCandidate('c1', modelNodeId, { parts: [{ text: 'a2' }] });
        await service.createRerollCandidate('c1', modelNodeId, { parts: [{ text: 'a3' }] });
        // 当前活跃 = r2，主历史 = [U, M]（createRerollCandidate 不截断主历史）

        const data = await doSwitch('c1', r1.nodeId);

        // 直接检查共享服务返回的历史重写结果。
        expect(data).toMatchObject({
            rewritten: true,
            activePathLength: 3,
            historyLength: 3,
        });
        const switchedGraph = (await service.getBranchGraph('c1')).graph!;
        expect(switchedGraph.activeTailNodeId).toBe(r1.nodeId);
        expect(activePath(switchedGraph)).toEqual([userNodeId, modelNodeId, r1.nodeId]);

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
        expect(data.divergenceIndex).toBe(2);
    });

    test('重写分歧索引：非前缀路径从第一个不同节点开始', async () => {
        const [userNodeId, modelNodeId] = await seedConversation('c1');
        const r1 = await service.createRerollCandidate('c1', modelNodeId, { parts: [{ text: 'a2' }] });
        const r2 = await service.createRerollCandidate('c1', modelNodeId, { parts: [{ text: 'a3' }] });

        // 先切到 r1（历史 = [U, M, r1]）
        await doSwitch('c1', r1.nodeId);

        // 再切到 r2：旧 [U, M, r1] vs 新 [U, M, r2] → 分歧在索引 2
        const data = await doSwitch('c1', r2.nodeId);
        expect(data.rewritten).toBe(true);
        const history = await manager.getMessagesRaw('c1');
        expect(history.map(m => m.id)).toEqual([userNodeId, modelNodeId, r2.nodeId]);
        expect(data.divergenceIndex).toBe(2);
        expect(await service.validateActivePathMatchesHistory('c1')).toMatchObject({ valid: true });
    });

    test('重写分歧索引边界：切回祖先与重复切换（BCP-08）', async () => {
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
        expect(data.divergenceIndex).toBe(1);
        expect(await service.validateActivePathMatchesHistory('c1')).toMatchObject({ valid: true });

        // 同一路径再次切换（幂等）：完全一致 → 不再清理
        const unchanged = await doSwitch('c1', modelNodeId);
        expect(unchanged.divergenceIndex).toBeNull();
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

    test('无输出的空候选会被丢弃，旧候选仍可切回，空节点不可再切换', async () => {
        const [userNodeId, modelNodeId] = await seedConversation('c1');
        // reroll 开始但流式未产生内容：finish 会移除没有任何可恢复内容的瞬时占位。
        const started = await service.startReroll('c1', modelNodeId);
        const candidateNodeId = started.candidateNodeId;
        const finished = await service.finishReroll('c1', candidateNodeId);
        expect(finished.discardedEmptyCandidate).toBe(true);
        // 主历史当前 = [U]（startReroll 截断到父节点）

        // 先切回旧候选 M
        await doSwitch('c1', modelNodeId);
        expect((await manager.getMessagesRaw('c1')).map(m => m.id)).toEqual([userNodeId, modelNodeId]);

        // 空占位已经物理移除，继续引用旧 ID 必须明确 NODE_NOT_FOUND，且不改主历史。
        await expect(service.switchBranchCandidate('c1', candidateNodeId)).rejects.toMatchObject({ code: 'NODE_NOT_FOUND' });
        expect((await manager.getMessagesRaw('c1')).map(m => m.id)).toEqual([userNodeId, modelNodeId]);
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

        // 直接调用重写服务：未写入历史时 rewritten 为 false。
        expect(data.rewritten).toBe(false);
        expect(data.activePathLength).toBe(2);
        expect((await manager.getMessagesRaw('c1')).map(m => m.id)).toEqual([userNodeId, modelNodeId]);
        // 图已建立且一致
        expect(await repo.exists('c1')).toBe(true);
        expect(await service.validateActivePathMatchesHistory('c1')).toMatchObject({ valid: true });
        // 完全一致 → 检查点无需清理
        expect(data.divergenceIndex).toBeNull();
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
        const unchanged = await doSwitch('c1', newAId);
        history = await manager.getMessagesRaw('c1');
        expect(history.map(m => m.id)).toEqual([userNodeId, newAId, frId, finished.activeTailNodeId!]);
        expect(history.filter(m => isFunctionResponseMessage(m))[0]!.id).toBe(frId); // FR id 未重新生成
        // 完全一致 → divergenceIndex=null → 不清理检查点（内容未变、索引仍有效的检查点不被误删）
        expect(unchanged.divergenceIndex).toBeNull();
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
        const refused = service.switchBranchCandidate('c1', r1.nodeId);
        await expect(refused).rejects.toMatchObject({ code: 'BRANCH_OPERATION_CONFLICT' });
        await expect(refused).rejects.toThrow('not yet synced');
        expect((await manager.getMessagesRaw('c1')).map(m => m.id)).toEqual([userNodeId, modelNodeId, q2Id]);
        const graphAfterReject = (await service.getBranchGraph('c1')).graph!;
        expect(graphAfterReject.activeTailNodeId).toBe(r2.nodeId);

        // 同步收敛（模拟 appendHistoryToGraph 完成）后重试切换成功：消息保留为图分支，未被替换丢弃
        await service.appendHistoryToGraph('c1', (await manager.getMessagesRaw('c1')).slice(2));
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
        const refusedFr = service.switchBranchCandidate('c1', r1.nodeId);
        await expect(refusedFr).rejects.toMatchObject({ code: 'BRANCH_OPERATION_CONFLICT' });
        await expect(refusedFr).rejects.toThrow('not yet synced');
        await expect(refusedFr).rejects.toThrow('functionResponse');
        expect((await manager.getMessagesRaw('c1')).map(m => m.id)).toEqual([userNodeId, modelNodeId, newAId, frId]);
        graph = (await service.getBranchGraph('c1')).graph!;
        expect(graph.activeTailNodeId).toBe(newAId);
        expect(graph.nodes[newAId]!.parts.some(p => !!p.functionResponse)).toBe(false);

        // 补齐 FR（模拟 appendHistoryToGraph 完成 FR 合并）后重试切换成功：FR 内容并入 owner 节点
        await service.appendHistoryToGraph('c1', [(await manager.getMessagesRaw('c1'))[3]!]);
        graph = (await service.getBranchGraph('c1')).graph!;
        expect(graph.nodes[newAId]!.parts.some(p => p.functionResponse?.id === 'call-1')).toBe(true);

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

    test('元数据写失败会在主历史保存前中断重写，恢复后可以重试（R8a-M1）', async () => {
        const failingStorage = new FailingMetadataStorage();
        const mgr = new ConversationManager(failingStorage);
        const customService = new BranchService(mgr, repo);
        setGlobalBranchService(customService);
        await mgr.createConversation('c1', 'T');
        await mgr.addBatch('c1', linearHistory());
        const [userNodeId, modelNodeId] = (await mgr.getMessagesRaw('c1')).map(m => m.id!);
        const r1 = await customService.createRerollCandidate('c1', modelNodeId, { parts: [{ text: 'a2' }] });
        await customService.createRerollCandidate('c1', modelNodeId, { parts: [{ text: 'a3' }] });

        failingStorage.failMetadata = true;
        await customService.switchBranchCandidate('c1', r1.nodeId);
        await expect(mgr.rewriteHistoryFromBranchGraph('c1')).rejects.toThrow('simulated metadata write failure');
        expect((await mgr.getMessagesRaw('c1')).map(m => m.id)).toEqual([userNodeId, modelNodeId]);
        expect(validate((await customService.getBranchGraph('c1')).graph!).valid).toBe(true);

        failingStorage.failMetadata = false;
        await customService.switchBranchCandidate('c1', r1.nodeId);
        const data = await mgr.rewriteHistoryFromBranchGraph('c1');
        expect(data.rewritten).toBe(true);
        expect((await mgr.getMessagesRaw('c1')).map(m => m.id)).toEqual([userNodeId, modelNodeId, r1.nodeId]);
        expect(await customService.validateActivePathMatchesHistory('c1')).toMatchObject({ valid: true });
    });
});

describe('ConversationManager.rewriteHistoryFromBranchGraph（直调）', () => {
    let repo: MemoryBranchStorage;
    let manager: ConversationManager;
    let service: BranchService;

    beforeEach(async () => {
        repo = new MemoryBranchStorage();
        manager = new ConversationManager(new MemoryStorageAdapter());
        service = new BranchService(manager, repo);
        setGlobalBranchService(service);
    });

    afterEach(async () => {
        setGlobalBranchService(undefined);
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
        repo.setReadResult('c1', { graph: null, errorCode: 'BRANCH_STORAGE_CORRUPT' });

        await expect(manager.rewriteHistoryFromBranchGraph('c1'))
            .rejects.toMatchObject({ code: 'BRANCH_STORAGE_CORRUPT' });
        // 主历史未被破坏
        expect((await manager.getMessagesRaw('c1')).length).toBe(2);
    });

    test('语义损坏图（可解析但无效）同样拒绝重写', async () => {
        const ids = await seedConversation('c1');
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
        repo.setReadResult('c1', { graph: invalidGraph as ConversationBranchGraph });

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
