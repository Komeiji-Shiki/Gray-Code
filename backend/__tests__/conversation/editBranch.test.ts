/**
 * 编辑候选、原地编辑与主历史同步的共享分支行为。
 * 夹具组合真实 BranchService 和 ConversationManager；旧 Webview 与 ChatFlow 专属入口不再参与。
 */

import { ConversationManager } from '../../modules/conversation';
import { MemoryStorageAdapter } from '../../modules/conversation';
import type { ConversationHistory } from '../../modules/conversation';
import {
    BranchService,
    MAX_CANDIDATES_PER_PARENT,
    setGlobalBranchService,
} from '../../modules/conversation/branch/BranchService';
import { MemoryBranchStorage } from '../__fixtures__/memoryBranchStorage';
import {
    activePath,
    childrenIndex,
    importLinearHistory,
    validate,
} from '../../modules/conversation/branch/BranchGraph';

/** 线性历史：root(user q1) → model(a1) → user(q2) → model(a2)（编辑目标 U2 非根节点） */
function branchedHistory(): ConversationHistory {
    return [
        { role: 'user', parts: [{ text: 'q1' }], timestamp: 100 },
        { role: 'model', parts: [{ text: 'a1' }], timestamp: 200 },
        { role: 'user', parts: [{ text: 'q2' }], timestamp: 300 },
        { role: 'model', parts: [{ text: 'a2' }], timestamp: 400 },
    ];
}

/**
 * 组合 BranchService 与 ConversationManager 的编辑操作（TREE-03 / TREE-03-R）：
 * 解析目标 → 非根节点：editCandidate（新 user 节点）→ createRerollCandidate（模型候选占位）→
 * 主历史截断到旧用户节点之前 → 追加编辑后用户消息（id 对齐新用户节点）；
 * 根节点（TREE-03-R）：原地改写根节点 + 截断其后 + 模型候选。
 * 返回 { newUserNodeId, modelCandidateNodeId, parentNodeId }。
 */
async function runEditBranchFlow(
    service: BranchService,
    manager: ConversationManager,
    conversationId: string,
    newText: string,
    userNodeId: string,
): Promise<{ newUserNodeId: string; modelCandidateNodeId: string; parentNodeId: string | null }> {
    await service.ensureMainHistoryRepresentedInGraph(conversationId);
    const graphResult = await service.getBranchGraph(conversationId);
    const history = await manager.getMessagesRaw(conversationId);
    // 夹具显式传入合法节点；这里只取共享图中的父链，不复制已移除的宿主目标校验。
    const targetNode = (graphResult.graph ?? importLinearHistory(history)).nodes[userNodeId];
    const target = { nodeId: targetNode.id, parentNodeId: targetNode.parentId };

    // TREE-03-R：根节点（parentNodeId === null）编辑重生成——改写根节点 + 截断其后 + 模型候选
    if (target.parentNodeId === null) {
        const targetIndex = history.findIndex(message => message.id === target.nodeId);
        if (targetIndex >= 0) {
            await manager.updateMessage(conversationId, targetIndex, {
                parts: [{ text: newText }],
                isUserInput: true,
                tokenCountByChannel: {},
            } as any);
            await service.updateActiveNodeParts(conversationId, userNodeId, [{ text: newText }]);
        }
        const modelCreated = await service.createRerollCandidate(conversationId, target.nodeId, {
            parts: [],
        });
        if (targetIndex >= 0 && targetIndex < history.length - 1) {
            await manager.deleteMessagesInRange(conversationId, targetIndex + 1, history.length - 1);
        }
        return {
            newUserNodeId: target.nodeId,
            modelCandidateNodeId: modelCreated.nodeId,
            parentNodeId: null,
        };
    }

    const created = await service.editCandidate(conversationId, target.parentNodeId, {
        role: 'user',
        parts: [{ text: newText }],
    });
    const modelCreated = await service.createRerollCandidate(conversationId, created.nodeId, {
        parts: [],
    });

    const historyAfterGraph = await manager.getMessagesRaw(conversationId);
    const parentIndex = historyAfterGraph.findIndex(message => message.id === target.parentNodeId);
    if (parentIndex >= 0 && parentIndex < historyAfterGraph.length - 1) {
        await manager.deleteMessagesInRange(conversationId, parentIndex + 1, historyAfterGraph.length - 1);
    }
    await manager.addContent(conversationId, {
        role: 'user',
        parts: [{ text: newText }],
        id: created.nodeId,
        isUserInput: true,
    } as any);

    return { newUserNodeId: created.nodeId, modelCandidateNodeId: modelCreated.nodeId, parentNodeId: target.parentNodeId };
}

/** 模拟工具循环输出：模型消息 + functionResponse + 续接模型消息 */
async function simulateToolLoopOutput(manager: ConversationManager, conversationId: string): Promise<string[]> {
    await manager.addContent(conversationId, {
        role: 'model',
        parts: [{ text: 'edited answer' }],
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

describe('编辑用户消息分支（编排组合）', () => {
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

    /** 建会话并写入线性历史，返回 [U1, M1, U2, M2] */
    async function seedConversation(conversationId: string): Promise<string[]> {
        await manager.createConversation(conversationId, 'T');
        await manager.addBatch(conversationId, branchedHistory());
        return (await manager.getMessagesRaw(conversationId)).map(m => m.id!);
    }

    test('编辑保留原分支（决策 7 / TREE-03）：旧用户节点及子树进 sidecar，新 user 节点 kind=edit 激活', async () => {
        const [u1, m1, u2, m2] = await seedConversation('c1');

        const result = await runEditBranchFlow(service, manager, 'c1', 'edited q2', u2);

        const graph = (await service.getBranchGraph('c1')).graph!;
        expect(validate(graph).valid).toBe(true);
        // 旧分支完整保留：旧用户节点 U2 与其 model 子树 M2 仍在图中（kind='imported'），内容未变
        expect(graph.nodes[u2]).toBeTruthy();
        expect(graph.nodes[u2]!.parts).toEqual([{ text: 'q2' }]);
        expect(graph.nodes[m2]).toBeTruthy();
        expect(graph.nodes[m2]!.parts).toEqual([{ text: 'a2' }]);
        expect(graph.nodes[m2]!.parentId).toBe(u2);
        // 新编辑候选：kind='edit'，文本=编辑后内容，父节点 = 旧用户节点的父节点（M1）
        const newUser = graph.nodes[result.newUserNodeId]!;
        expect(newUser.kind).toBe('edit');
        expect(newUser.role).toBe('user');
        expect(newUser.parentId).toBe(m1);
        expect(newUser.parts).toEqual([{ text: 'edited q2' }]);
        // 父节点 M1 下两个候选：旧 U2（imported）与新编辑节点（edit），新节点激活
        expect(graph.nodes[m1]!.activeChildId).toBe(result.newUserNodeId);
        // 模型候选占位：kind='reroll'（createRerollCandidate 固定 kind，见设计说明），在新 user 节点下
        const modelCandidate = graph.nodes[result.modelCandidateNodeId]!;
        expect(modelCandidate.role).toBe('model');
        expect(modelCandidate.parentId).toBe(result.newUserNodeId);
        expect(graph.activeTailNodeId).toBe(result.modelCandidateNodeId);
        expect(activePath(graph)).toEqual([u1, m1, result.newUserNodeId, result.modelCandidateNodeId]);

        // 主历史已切换到编辑后路径：截断到旧用户节点之前（父节点 M1 保留）+ 追加编辑后用户消息
        const history = await manager.getMessagesRaw('c1');
        expect(history.map(m => m.id)).toEqual([u1, m1, result.newUserNodeId]);
        // BR-01 同源：主历史里的编辑后用户消息 id == 图中新 user 节点 id，文本一致
        expect(history[2].id).toBe(result.newUserNodeId);
        expect(history[2].parts).toEqual([{ text: 'edited q2' }]);
        expect(history[2].isUserInput).toBe(true);
    });

    test('TREE-03-R：根节点编辑重生成——改写根节点 + 截断其后 + 模型候选（旧回答保留可切换）', async () => {
        const [u1, m1, u2, m2] = await seedConversation('c1');

        // 编辑根节点 U1（branch 模式，TREE-03-R：不再降级 keep/拒绝）
        const result = await runEditBranchFlow(service, manager, 'c1', 'edited q1', u1);

        // 主历史截断到只剩根节点，且文本已改写（首条消息 = 新问题）
        const history = await manager.getMessagesRaw('c1');
        expect(history.map(m => m.id)).toEqual([u1]);
        expect(history[0].parts).toEqual([{ text: 'edited q1' }]);
        expect(history[0].isUserInput).toBe(true);

        const graph = (await service.getBranchGraph('c1')).graph!;
        expect(validate(graph).valid).toBe(true);
        // 根节点内容同步改写（BR-01 同源：节点 id == Content.id）
        expect(graph.nodes[u1]!.parts).toEqual([{ text: 'edited q1' }]);
        // 模型候选占位挂在根节点下并激活；旧回答 M1 保留为非活跃候选（可切回）
        const modelCandidate = graph.nodes[result.modelCandidateNodeId]!;
        expect(modelCandidate.role).toBe('model');
        expect(modelCandidate.parentId).toBe(u1);
        expect(graph.nodes[u1]!.activeChildId).toBe(result.modelCandidateNodeId);
        expect(graph.activeTailNodeId).toBe(result.modelCandidateNodeId);
        expect(activePath(graph)).toEqual([u1, result.modelCandidateNodeId]);
        // 旧回答及其子树仍完整保留在图中（决策 7 语义延续）
        expect(graph.nodes[m1]!.parts).toEqual([{ text: 'a1' }]);
        expect(graph.nodes[m1]!.parentId).toBe(u1);
        expect(graph.nodes[u2]).toBeTruthy();
        expect(graph.nodes[m2]).toBeTruthy();
        // 注：BR-05（主历史 == 图活跃路径）在流式回填前不成立——模型候选占位只存在于图侧，
        // 主历史要等工具循环输出 + finishReroll 重命名对齐后才一致（见下一个测试）。
    });

    test('TREE-03-R：根节点编辑后 finishReroll 回填新回答，旧回答可切回', async () => {
        const [u1, m1, u2, m2] = await seedConversation('c1');
        const result = await runEditBranchFlow(service, manager, 'c1', 'edited q1', u1);

        // 模拟工具循环输出后回填
        await manager.addContent('c1', { role: 'model', parts: [{ text: 'new answer' }] } as any);
        const finished = await service.finishReroll('c1', result.modelCandidateNodeId);
        expect(finished.syncedMessageCount).toBe(1);
        // 候选节点重命名对齐主历史消息 id（与 TREE-03 非根节点同语义）
        const newAnswerId = finished.candidateNodeId;

        const graph = (await service.getBranchGraph('c1')).graph!;
        expect(validate(graph).valid).toBe(true);
        expect(graph.nodes[newAnswerId]!.parts).toEqual([{ text: 'new answer' }]);

        // 主历史 = 根节点（新文本）+ 新回答
        const history = await manager.getMessagesRaw('c1');
        expect(history.map(m => m.id)).toEqual([u1, newAnswerId]);
        expect(history[0].parts).toEqual([{ text: 'edited q1' }]);
        expect(history[1].parts).toEqual([{ text: 'new answer' }]);

        // BR-05：回填后主历史非 functionResponse id 链 == 图活跃路径
        const consistency = await service.validateActivePathMatchesHistory('c1');
        expect(consistency.valid).toBe(true);
        expect(consistency.historyIds).toEqual([u1, newAnswerId]);

        // 旧回答 M1 仍在图中，可切回（switchBranchCandidate 接受旧 model 节点）
        const switched = await service.switchBranchCandidate('c1', m1);
        expect(switched.activePathIds).toContain(m1);
        expect(switched.activePathIds[0]).toBe(u1);
    });

    test('回归：遗留空占位冻结 sidecar 后，编辑新消息不再 NODE_NOT_FOUND，旧图有备份', async () => {
        const [u1] = await seedConversation('c1');
        // 模拟旧版本已经结束却仍保留的空 reroll 活跃尾；它会让随后追加跳过图同步。
        await service.createRerollCandidate('c1', u1, { parts: [] });
        await manager.addBatch('c1', [
            { role: 'user', parts: [{ text: 'q3' }], timestamp: 500 },
            { role: 'model', parts: [{ text: 'a3' }], timestamp: 600 },
        ]);
        const staleHistory = await manager.getMessagesRaw('c1');
        const q3Id = staleHistory[4]!.id!;
        const a3Id = staleHistory[5]!.id!;
        expect((await service.getBranchGraph('c1')).graph!.nodes[q3Id]).toBeUndefined();

        const result = await runEditBranchFlow(service, manager, 'c1', 'q3 edited', q3Id);
        const graph = (await service.getBranchGraph('c1')).graph!;
        expect(graph.nodes[q3Id]).toBeDefined();
        expect(graph.nodes[a3Id]).toBeDefined();
        expect(graph.nodes[result.newUserNodeId]!.parts).toEqual([{ text: 'q3 edited' }]);
        expect(validate(graph).valid).toBe(true);

        expect(repo.backups.some(item => item.conversationId === 'c1' && item.reason === 'history-diverged')).toBe(true);
    });

    test('编辑后生成新回答：finishReroll 等价回填写入模型候选（重命名对齐 + 摘要 + 续接节点 + BR-05）', async () => {
        const [u1, m1, u2] = await seedConversation('c1');
        const result = await runEditBranchFlow(service, manager, 'c1', 'edited q2', u2);

        // 模拟工具循环输出（模型消息 + functionResponse + 续接模型消息）
        const historyIds = await simulateToolLoopOutput(manager, 'c1');
        const [modelAId, modelBId] = [historyIds[3], historyIds[5]];

        const finished = await service.finishReroll('c1', result.modelCandidateNodeId);
        expect(finished.candidateNodeId).toBe(modelAId); // 候选节点重命名对齐主历史消息 id
        expect(finished.syncedMessageCount).toBe(2);
        expect(finished.activeTailNodeId).toBe(modelBId);

        const graph = (await service.getBranchGraph('c1')).graph!;
        expect(validate(graph).valid).toBe(true);

        // 模型候选内容 = 模型消息 + functionResponse 合并（决策 8）
        const candidate = graph.nodes[modelAId]!;
        expect(candidate.kind).toBe('reroll');
        expect(candidate.parentId).toBe(result.newUserNodeId);
        expect(candidate.modelVersion).toBe('gemini-x');
        expect(candidate.parts).toEqual([
            { text: 'edited answer' },
            { functionResponse: { id: 'call-1', name: 'read_file', response: { success: true } } },
        ]);
        // 摘要已更新
        expect(graph.candidateSummaries!.find(s => s.nodeId === modelAId)!.preview).toBe('edited answer');
        // 续接节点
        const continuation = graph.nodes[modelBId]!;
        expect(continuation.kind).toBe('continue');
        expect(continuation.parentId).toBe(modelAId);
        expect(continuation.parts).toEqual([{ text: 'after tool' }]);

        // 旧分支仍完整保留
        expect(graph.nodes[u2]!.parts).toEqual([{ text: 'q2' }]);

        // BR-05：主历史非 functionResponse id 链 == 图活跃路径
        const consistency = await service.validateActivePathMatchesHistory('c1');
        expect(consistency.valid).toBe(true);
        expect(consistency.historyIds).toEqual([u1, m1, result.newUserNodeId, modelAId, modelBId]);
        expect(consistency.activePathIds).toEqual([u1, m1, result.newUserNodeId, modelAId, modelBId]);
    });

    test('流式无输出时移除空模型占位、编辑后用户消息仍在、旧分支可切回', async () => {
        const [u1, m1, u2, m2] = await seedConversation('c1');
        const result = await runEditBranchFlow(service, manager, 'c1', 'edited q2', u2);

        // 流式失败：主历史没有任何新模型消息 → finishReroll 同步 0 条
        const finished = await service.finishReroll('c1', result.modelCandidateNodeId);
        expect(finished.syncedMessageCount).toBe(0);
        expect(finished.candidateNodeId).toBe(result.modelCandidateNodeId);
        expect(finished.discardedEmptyCandidate).toBe(true);
        expect(finished.activeTailNodeId).toBe(result.newUserNodeId);

        const graph = (await service.getBranchGraph('c1')).graph!;
        expect(validate(graph).valid).toBe(true);
        // 空模型占位无可恢复内容，必须移除；编辑后的用户消息成为当前路径尾。
        expect(graph.nodes[result.modelCandidateNodeId]).toBeUndefined();
        expect(graph.candidateSummaries!.find(s => s.nodeId === result.modelCandidateNodeId)).toBeUndefined();
        expect(activePath(graph)).toEqual([u1, m1, result.newUserNodeId]);
        // 旧分支完整保留且可切回
        expect(graph.nodes[u2]!.parts).toEqual([{ text: 'q2' }]);
        expect(graph.nodes[m2]!.parts).toEqual([{ text: 'a2' }]);
        const switched = await service.switchBranchCandidate('c1', u2);
        expect(switched.activePathIds).toEqual([u1, m1, u2, m2]);
    });

    test('与 reroll 并存：编辑分支后可再 reroll 编辑出的回答；reroll 分支后也可再编辑', async () => {
        const [u1, m1, u2, m2] = await seedConversation('c1');

        // 1) 先编辑 U2 → 新回答 A
        const editResult = await runEditBranchFlow(service, manager, 'c1', 'edited q2', u2);
        await manager.addContent('c1', { role: 'model', parts: [{ text: 'answer A' }] } as any);
        const editFinished = await service.finishReroll('c1', editResult.modelCandidateNodeId);
        const answerAId = editFinished.candidateNodeId;

        // 2) 再 reroll 编辑出的回答 A → 回答 B（旧 A 保留）
        const rerollStarted = await service.startReroll('c1', answerAId);
        await manager.addContent('c1', { role: 'model', parts: [{ text: 'answer B' }] } as any);
        const rerollFinished = await service.finishReroll('c1', rerollStarted.candidateNodeId);
        const answerBId = rerollFinished.candidateNodeId;

        const graph = (await service.getBranchGraph('c1')).graph!;
        expect(validate(graph).valid).toBe(true);
        // M1 下：旧 U2（imported）、编辑节点（edit）；编辑节点下：A（reroll）、B（reroll）
        expect(childrenIndex(graph).get(m1)).toEqual([u2, editResult.newUserNodeId]);
        expect(childrenIndex(graph).get(editResult.newUserNodeId)).toEqual([answerAId, answerBId]);
        // 旧编辑分支内容保留
        expect(graph.nodes[u2]!.parts).toEqual([{ text: 'q2' }]);
        expect(graph.nodes[m2]!.parts).toEqual([{ text: 'a2' }]);
        expect(graph.nodes[answerAId]!.parts).toEqual([{ text: 'answer A' }]);
        expect(graph.activeTailNodeId).toBe(answerBId);

        // 3) 主历史 == 活跃路径（BR-05）
        const consistency = await service.validateActivePathMatchesHistory('c1');
        expect(consistency.valid).toBe(true);
        expect(consistency.historyIds).toEqual([u1, m1, editResult.newUserNodeId, answerBId]);
    });

    test('TREE-05：有分支图时 append 增量并入图（切回候选后继续对话不破坏图）', async () => {
        const [, , , m2] = await seedConversation('c1');
        // 建图（活跃路径 = 全量历史 [U1, M1, U2, M2]）
        const history = await manager.getMessagesRaw('c1');
        await service.saveBranchGraph('c1', importLinearHistory(history));

        // 模拟用户在候选上继续对话：普通消息追加（走正常 append 路径）
        await manager.addContent('c1', { role: 'user', parts: [{ text: 'q3' }] } as any);

        const historyAfter = await manager.getMessagesRaw('c1');
        const q3Id = historyAfter[historyAfter.length - 1].id!;
        // 图同步是 fire-and-forget（异步排队，最终一致）：轮询等待 q3 进入图
        let graph = (await service.getBranchGraph('c1')).graph;
        const deadline = Date.now() + 3000;
        while ((!graph || !graph.nodes[q3Id]) && Date.now() < deadline) {
            await manager.runExclusive('c1', async () => {});
            await new Promise(resolve => setTimeout(resolve, 10));
            graph = (await service.getBranchGraph('c1')).graph;
        }
        expect(graph).toBeTruthy();
        expect(validate(graph!).valid).toBe(true);
        // 新消息成为活跃尾节点（kind='normal'，父 = 原活跃尾 M2）
        expect(graph!.nodes[q3Id]).toBeTruthy();
        expect(graph!.nodes[q3Id]!.role).toBe('user');
        expect(graph!.nodes[q3Id]!.parts).toEqual([{ text: 'q3' }]);
        expect(graph!.nodes[q3Id]!.parentId).toBe(m2);
        expect(graph!.activeTailNodeId).toBe(q3Id);
        // BR-05：主历史 id 链 == 图活跃路径（append 不破坏图）
        const consistency = await service.validateActivePathMatchesHistory('c1');
        expect(consistency.valid).toBe(true);
        expect(consistency.historyIds[consistency.historyIds.length - 1]).toBe(q3Id);
    });

    test('TREE-05：无分支图时 append 不建图（线性对话保持线性，不产生 sidecar）', async () => {
        await seedConversation('c1');
        expect(await repo.exists('c1')).toBe(false);

        await manager.addContent('c1', { role: 'user', parts: [{ text: 'q3' }] } as any);
        await manager.runExclusive('c1', async () => {});

        // 无分支图：appendHistoryToGraph 返回 false，不建 sidecar
        expect(await repo.exists('c1')).toBe(false);
        expect((await service.getBranchGraph('c1')).graph).toBeNull();
    });

    test('TREE-05：reroll 流式窗口期 append 不并入图（空占位候选跳过，由 finishReroll 回填）', async () => {
        const [u1, m1] = await seedConversation('c1');
        // startReroll：旧 M1 进 sidecar，新占位候选激活（空 parts）
        const started = await service.startReroll('c1', m1);

        // 工具循环追加模型消息（走正常 append 路径）
        await manager.addContent('c1', { role: 'model', parts: [{ text: 'streamed' }] } as any);
        await manager.runExclusive('c1', async () => {});

        // 流式窗口期：新消息未并入图（避免与 finishReroll 重命名冲突）
        const graphMid = (await service.getBranchGraph('c1')).graph!;
        const historyMid = await manager.getMessagesRaw('c1');
        const streamedId = historyMid[historyMid.length - 1].id!;
        expect(graphMid.nodes[streamedId]).toBeUndefined();
        expect(graphMid.activeTailNodeId).toBe(started.candidateNodeId);
        expect(validate(graphMid).valid).toBe(true);

        // finishReroll 正常回填（不抛重复节点 id），主历史 == 活跃路径
        const finished = await service.finishReroll('c1', started.candidateNodeId);
        expect(finished.candidateNodeId).toBe(streamedId);
        const consistency = await service.validateActivePathMatchesHistory('c1');
        expect(consistency.valid).toBe(true);
        expect(consistency.historyIds).toEqual([u1, streamedId]);
    });

    test('每父节点候选上限（决策 4）：编辑候选计入，第 11 个拒绝并提示清理，不自动删', async () => {
        const [u1, m1] = await seedConversation('c1');
        // children(M1) = [U2]（原始用户消息占 1 个槽位）
        // 通过编辑流程创建 MAX-1 个编辑候选（每个编辑候选 = 新 user 节点，挂在 M1 下）
        for (let i = 0; i < MAX_CANDIDATES_PER_PARENT - 1; i++) {
            const created = await service.editCandidate('c1', m1, {
                role: 'user',
                parts: [{ text: `edited ${i}` }],
            });
            // 同时补上模型候选，保持活跃路径合法（编辑流程组合的一部分）
            await service.createRerollCandidate('c1', created.nodeId, { parts: [] });
        }
        const graphBefore = (await service.getBranchGraph('c1')).graph!;
        expect(childrenIndex(graphBefore).get(m1)).toHaveLength(MAX_CANDIDATES_PER_PARENT);

        await expect(
            service.editCandidate('c1', m1, { role: 'user', parts: [{ text: 'overflow' }] })
        ).rejects.toMatchObject({ code: 'BRANCH_OPERATION_CONFLICT' });
        await expect(
            service.editCandidate('c1', m1, { role: 'user', parts: [{ text: 'overflow' }] })
        ).rejects.toThrow(/candidate limit/);

        // 不自动删除：图状态不变
        const graphAfter = (await service.getBranchGraph('c1')).graph!;
        expect(childrenIndex(graphAfter).get(m1)).toHaveLength(MAX_CANDIDATES_PER_PARENT);
        expect(validate(graphAfter).valid).toBe(true);
        expect(u1).toBeTruthy();
    });
});

describe('keep 模式：原地编辑（保持当前分支）', () => {
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
        await manager.addBatch(conversationId, branchedHistory());
        return (await manager.getMessagesRaw(conversationId)).map(m => m.id!);
    }

    /**
     * 组合真实消息更新与活跃图节点更新，验证原地保存：
     * 解析目标 → 更新主历史消息 → 同步图节点内容。不截断、不软删、不创建候选。
     * 返回目标消息索引。
     */
    async function runEditInPlaceFlow(
        conversationId: string,
        newText: string,
        userNodeId: string,
    ): Promise<{ targetIndex: number }> {
        await service.ensureMainHistoryRepresentedInGraph(conversationId);
        const history = await manager.getMessagesRaw(conversationId);
        const targetIndex = history.findIndex(message => message.id === userNodeId);
        if (targetIndex === -1) {
            throw new Error('target not found');
        }

        // 建图（图节点内容同步需要）
        await service.ensureBranchGraph(conversationId);

        await manager.updateMessage(conversationId, targetIndex, {
            parts: [{ text: newText }],
            isUserInput: true,
            tokenCountByChannel: {},
        });
        await service.updateActiveNodeParts(conversationId, userNodeId, [{ text: newText }]);
        return { targetIndex };
    }

    test('updateActiveNodeParts：改写活跃节点内容并同步候选摘要，其他节点不受影响', async () => {
        const [u1, m1, u2, m2] = await seedConversation('c1');
        const history = await manager.getMessagesRaw('c1');
        await service.saveBranchGraph('c1', importLinearHistory(history));

        await service.updateActiveNodeParts('c1', u2, [{ text: 'edited q2' }]);

        const graph = (await service.getBranchGraph('c1')).graph!;
        expect(validate(graph).valid).toBe(true);
        expect(graph.nodes[u2]!.parts).toEqual([{ text: 'edited q2' }]);
        expect(graph.candidateSummaries!.find(s => s.nodeId === u2)!.preview).toBe('edited q2');
        expect(graph.nodes[m1]!.parts).toEqual([{ text: 'a1' }]);
        expect(graph.nodes[m2]!.parts).toEqual([{ text: 'a2' }]);
        expect(graph.activeTailNodeId).toBe(m2);
    });

    test('updateActiveNodeParts：不存在节点 → NODE_NOT_FOUND；非活跃节点 → INVALID_BRANCH_RELATION', async () => {
        const [, , , m2] = await seedConversation('c1');
        const history = await manager.getMessagesRaw('c1');
        await service.saveBranchGraph('c1', importLinearHistory(history));

        await expect(
            service.updateActiveNodeParts('c1', 'no-such-node', [{ text: 'x' }])
        ).rejects.toMatchObject({ code: 'NODE_NOT_FOUND' });

        // reroll 后 M2 离开活跃路径（进入 sidecar 候选），原地改写被拒绝
        await service.startReroll('c1', m2);
        await expect(
            service.updateActiveNodeParts('c1', m2, [{ text: 'x' }])
        ).rejects.toMatchObject({ code: 'INVALID_BRANCH_RELATION' });
    });

    test('keep 模式编排：只改写目标消息，后续消息与分支图全部保留，BR-05 一致', async () => {
        const [u1, m1, u2, m2] = await seedConversation('c1');

        await runEditInPlaceFlow('c1', 'edited q2', u2);

        // 主历史：目标消息改写，后续消息（M2）原样保留，节点 id 不变（BR-01：原地编辑不产生新节点）
        const history = await manager.getMessagesRaw('c1');
        expect(history.map(m => m.id)).toEqual([u1, m1, u2, m2]);
        expect(history[2].parts).toEqual([{ text: 'edited q2' }]);
        expect(history[2].isUserInput).toBe(true);
        expect(history[3].parts).toEqual([{ text: 'a2' }]);

        // 分支图：U2 内容更新；M2 未软删（真·原地保存不触碰后续子树）；活跃尾仍是 M2
        const graph = (await service.getBranchGraph('c1')).graph!;
        expect(validate(graph).valid).toBe(true);
        expect(graph.nodes[u2]!.parts).toEqual([{ text: 'edited q2' }]);
        expect(graph.nodes[m2]!.deleted).toBeFalsy();
        expect(graph.nodes[u2]!.activeChildId).toBe(m2);
        expect(graph.activeTailNodeId).toBe(m2);

        // BR-05：主历史非 functionResponse id 链 == 图活跃路径（全量保留）
        const consistency = await service.validateActivePathMatchesHistory('c1');
        expect(consistency.valid).toBe(true);
        expect(consistency.historyIds).toEqual([u1, m1, u2, m2]);
        expect(consistency.activePathIds).toEqual([u1, m1, u2, m2]);
    });

    test('keep 模式不创建新候选：后续节点与内容原样保留（可继续正常分支）', async () => {
        const [u1, m1, u2, m2] = await seedConversation('c1');

        await runEditInPlaceFlow('c1', 'edited q2', u2);

        const graphBefore = (await service.getBranchGraph('c1')).graph!;
        // 没有新增节点：节点数保持不变（原地编辑，不产生 edit/reroll 候选）
        expect(Object.keys(graphBefore.nodes)).toHaveLength(4);
        // 后续节点保留：M2 内容仍在且未软删（真·原地保存不触碰后续子树）
        expect(graphBefore.nodes[m2]!.parts).toEqual([{ text: 'a2' }]);
        expect(graphBefore.nodes[m2]!.deleted).toBeFalsy();
    });
});
