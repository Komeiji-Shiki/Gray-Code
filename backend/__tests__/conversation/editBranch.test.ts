/**
 * TREE-03 + TREE-05 编辑用户消息分支测试（第六阶段：树状 reroll 与候选切换）。
 *
 * 覆盖：
 * - 编辑保留原分支（决策 7 / TREE-03 语义）：旧用户节点及其 model 子树完整保留进 sidecar，
 *   新用户节点 kind='edit'（编辑后文本）激活，主历史截断到旧用户节点之前并追加编辑后消息
 *   （id 对齐新用户节点，BR-01 同源）；
 * - 编辑后生成新回答：finishReroll 等价回填——模型候选节点重命名对齐消息 id、内容 + 摘要更新、
 *   续接节点、BR-05 主历史 id 链 == 活跃路径；
 * - 编辑目标校验（resolveEditTargetNode 纯函数）：缺失 → NODE_NOT_FOUND；非 user / 不在活跃路径 /
 *   根节点 → INVALID_BRANCH_RELATION；缺省取活跃路径最后一条可编辑用户消息（含 functionResponse 跳过）；
 * - 失败保留（决策 10 精神）：流式无输出时模型候选保留为空、旧分支可切回；
 * - 与 reroll 并存：编辑分支后可再 reroll 编辑出的回答；reroll 分支后也可再编辑；
 * - 每父节点候选上限（决策 4）：编辑候选同样计入，超限拒绝不自动删；
 * - webview handler：chat.editBranchStream 注册 + 入参校验。
 *
 * 编排说明：BranchService 目前没有 startEditBranch 公共方法（修复批次边界外），
 * handleEditBranchStream 的编排（editCandidate → createRerollCandidate → 截断 → 追加 → finishReroll）
 * 在测试中复刻为 runEditBranchFlow 助手，验证其组合语义；目标校验使用导出的纯函数 resolveEditTargetNode。
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
    importLinearHistory,
    validate,
} from '../../modules/conversation/branch/BranchGraph';
import { resolveEditTargetNode } from '../../modules/api/chat/services/ChatFlowService';
import { BranchError } from '../../modules/conversation/branch/types';
import { ChannelError, ErrorType } from '../../modules/channel/types';
import { registerChatHandlers, editBranchStream } from '../../../webview/handlers/ChatHandlers';
import { StreamAbortManager } from '../../../webview/stream/StreamAbortManager';
import { createMessageHandlerRegistry } from '../../../webview/handlers';
import type { HandlerContext, MessageHandler } from '../../../webview/types';

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
 * 复刻 ChatFlowService.handleEditBranchStream 的编排（TREE-03 流程）：
 * 解析目标 → editCandidate（新 user 节点）→ createRerollCandidate（模型候选占位）→
 * 主历史截断到旧用户节点之前 → 追加编辑后用户消息（id 对齐新用户节点）。
 * 返回 { newUserNodeId, modelCandidateNodeId, parentNodeId }。
 */
async function runEditBranchFlow(
    service: BranchService,
    manager: ConversationManager,
    conversationId: string,
    newText: string,
    userNodeId?: string,
): Promise<{ newUserNodeId: string; modelCandidateNodeId: string; parentNodeId: string }> {
    const graphResult = await service.getBranchGraph(conversationId);
    const history = await manager.getMessagesRaw(conversationId);
    const target = resolveEditTargetNode(graphResult.graph, history, userNodeId);

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

/** 断言同步抛出的 BranchError 的错误码（BranchError.message 不含 code，需单独断言） */
function expectBranchError(fn: () => void, code: string, messagePattern?: RegExp): void {
    try {
        fn();
        throw new Error('expected to throw');
    } catch (error: any) {
        if (error instanceof Error && error.message === 'expected to throw') {
            throw error;
        }
        expect(error).toBeInstanceOf(BranchError);
        expect(error.code).toBe(code);
        if (messagePattern) {
            expect(error.message).toMatch(messagePattern);
        }
    }
}

describe('TREE-03 编辑用户消息分支（编排组合）', () => {
    let tempDir: string;
    let repo: BranchGraphRepository;
    let manager: ConversationManager;
    let service: BranchService;

    beforeEach(async () => {
        tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'branch-edit-'));
        repo = new BranchGraphRepository(tempDir);
        manager = new ConversationManager(new MemoryStorageAdapter());
        service = new BranchService(manager, repo);
        setGlobalBranchService(service);
    });

    afterEach(async () => {
        setGlobalBranchService(undefined);
        await fsp.rm(tempDir, { recursive: true, force: true });
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

    test('失败保留（决策 10 精神）：流式无输出时模型候选保留为空、编辑后用户消息仍在、旧分支可切回', async () => {
        const [u1, m1, u2, m2] = await seedConversation('c1');
        const result = await runEditBranchFlow(service, manager, 'c1', 'edited q2', u2);

        // 流式失败：主历史没有任何新模型消息 → finishReroll 同步 0 条
        const finished = await service.finishReroll('c1', result.modelCandidateNodeId);
        expect(finished.syncedMessageCount).toBe(0);
        expect(finished.candidateNodeId).toBe(result.modelCandidateNodeId);

        const graph = (await service.getBranchGraph('c1')).graph!;
        expect(validate(graph).valid).toBe(true);
        // 失败候选保留为空（可切回查看），编辑后的用户消息仍在新路径上
        expect(graph.nodes[result.modelCandidateNodeId]!.parts).toEqual([]);
        expect(graph.candidateSummaries!.find(s => s.nodeId === result.modelCandidateNodeId)!.preview).toBe('');
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

    test('编辑目标校验（resolveEditTargetNode 纯函数）：缺失 / 非 user / 不在活跃路径 / 根节点', async () => {
        const [u1, m1, u2, m2] = await seedConversation('c1');
        // 先建基线图（活跃路径 = 全量历史），进入图模式校验
        const history = await manager.getMessagesRaw('c1');
        await service.saveBranchGraph('c1', importLinearHistory(history));
        const graph = (await service.getBranchGraph('c1')).graph!;

        // 节点缺失 → NODE_NOT_FOUND
        expectBranchError(() => resolveEditTargetNode(graph, history, 'no-such-node'), 'NODE_NOT_FOUND');
        // 非 user（M2）→ INVALID_BRANCH_RELATION
        expectBranchError(() => resolveEditTargetNode(graph, history, m2), 'INVALID_BRANCH_RELATION', /not a user node/);
        // 根节点 U1（无父节点可挂编辑候选）→ INVALID_BRANCH_RELATION
        expectBranchError(() => resolveEditTargetNode(graph, history, u1), 'INVALID_BRANCH_RELATION', /root node/);

        // 缺省：活跃路径最后一条可编辑用户消息 = U2
        expect(resolveEditTargetNode(graph, history)).toEqual({ nodeId: u2, parentNodeId: m1 });

        // 编辑后 U2 不再在活跃路径上 → 再次显式编辑被拒绝
        const result = await runEditBranchFlow(service, manager, 'c1', 'edited q2', u2);
        const graphAfter = (await service.getBranchGraph('c1')).graph!;
        expectBranchError(() => resolveEditTargetNode(graphAfter, history, u2), 'INVALID_BRANCH_RELATION', /not on the active path/);
        // 缺省 → 新编辑节点
        expect(resolveEditTargetNode(graphAfter, history).nodeId).toBe(result.newUserNodeId);
    });

    test('线性模式（无分支图）目标校验：主历史为活跃路径，父节点跳过 functionResponse', async () => {
        const [, , u2] = await seedConversation('c1');
        const history = await manager.getMessagesRaw('c1');

        // 线性模式：显式目标 U2 的父节点 = 前一个非 FR 消息 M1
        expect(resolveEditTargetNode(null, history, u2)).toEqual({ nodeId: u2, parentNodeId: history[1].id! });
        // 根节点拒绝
        expectBranchError(() => resolveEditTargetNode(null, history, history[0].id!), 'INVALID_BRANCH_RELATION', /root node/);
        // 缺省 = 最后一条可编辑用户消息 U2
        expect(resolveEditTargetNode(null, history).nodeId).toBe(u2);

        // 带 functionResponse 的历史：FR 不参与父节点解析
        const historyWithFr = [
            { id: 'q1-id', role: 'user' as const, parts: [{ text: 'q1' }], timestamp: 1 },
            { id: 'a1-id', role: 'model' as const, parts: [{ text: 'a1' }], timestamp: 2 },
            { id: 'fr-id', role: 'user' as const, parts: [{ functionResponse: { id: 'c1', name: 'read_file', response: { ok: true } } }], timestamp: 3, isFunctionResponse: true },
            { id: 'q2-id', role: 'user' as const, parts: [{ text: 'q2' }], timestamp: 4 },
        ];
        expect(resolveEditTargetNode(null, historyWithFr, 'q2-id')).toEqual({
            nodeId: 'q2-id',
            parentNodeId: 'a1-id', // 跳过 FR，父节点为 M1
        });
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

describe('TREE-03 webview handler：chat.editBranchStream', () => {
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
            streamAbortControllers: new Map() as unknown as Map<string, AbortController>,
            sendResponse: (requestId, data) => { responses.push({ requestId, data }); },
            sendError: (requestId, code, message) => { errors.push({ requestId, code, message }); },
            ...overrides,
        } as unknown as HandlerContext;
    }

    beforeEach(async () => {
        tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'edit-branch-handler-'));
        manager = new ConversationManager(new MemoryStorageAdapter());
        responses = [];
        errors = [];
        setGlobalBranchService(undefined);
    });

    afterEach(async () => {
        setGlobalBranchService(undefined);
        await fsp.rm(tempDir, { recursive: true, force: true });
    });

    test('注册表包含 chat.editBranchStream', () => {
        const registry = createMessageHandlerRegistry();
        expect(registry.has('chat.editBranchStream')).toBe(true);
        expect(typeof registry.get('chat.editBranchStream')).toBe('function');
    });

    test('registerChatHandlers 独立注册（空表也能注册 editBranchStream）', () => {
        const registry = new Map<string, MessageHandler>();
        registerChatHandlers(registry);
        expect(registry.get('chat.editBranchStream')).toBeDefined();
    });

    test('入参校验：缺少 conversationId/configId/newText → EDIT_BRANCH_INVALID_ARGS', async () => {
        await manager.createConversation('c1', 'T');
        await editBranchStream({ conversationId: 'c1' }, 'req-1', makeCtx());
        expect(errors).toEqual([{ requestId: 'req-1', code: 'EDIT_BRANCH_INVALID_ARGS', message: expect.stringContaining('required') }]);
        expect(responses).toHaveLength(0);

        errors = [];
        await editBranchStream({ conversationId: 'c1', configId: 'cfg', newText: '   ' }, 'req-2', makeCtx());
        expect(errors).toHaveLength(1);
        expect(errors[0].code).toBe('EDIT_BRANCH_INVALID_ARGS');
    });

    // R6a-FIX H1：editBranchStream 与 rerollStream 同模式接线——abortManager.create 注册控制器、
    // 透传 abortSignal / summarizeAbortSignal、finally 注销（停止按钮/扩展关闭可取消，isActive 生效）
    test('H1：editBranchStream 注册 AbortController、透传 abortSignal、结束清理（isActive 生命周期）', async () => {
        const abortManager = new StreamAbortManager();
        let receivedAbortSignal: AbortSignal | undefined;
        let receivedSummarySignal: AbortSignal | undefined;
        let isActiveDuringStream = false;
        const fakeChatHandler = {
            handleEditBranchStream: async function* (request: any) {
                receivedAbortSignal = request.abortSignal;
                receivedSummarySignal = request.summarizeAbortSignal;
                isActiveDuringStream = abortManager.isActive(request.conversationId);
                yield { conversationId: request.conversationId, chunk: { text: 'x' } } as any;
            },
        } as any;

        const ctx = makeCtx({
            chatHandler: fakeChatHandler,
            streamAbortControllers: abortManager as unknown as Map<string, AbortController>,
        });

        await editBranchStream(
            { conversationId: 'c1', newText: 'edited', configId: 'cfg' },
            'req-h1',
            ctx
        );

        // 流期间已注册控制器并透传 signal
        expect(isActiveDuringStream).toBe(true);
        expect(receivedAbortSignal).toBeDefined();
        expect(receivedAbortSignal!.aborted).toBe(false);
        expect(receivedSummarySignal).toBeDefined();
        // 结束后 finally 清理：isActive 归 false，无残留控制器
        expect(abortManager.isActive('c1')).toBe(false);
        expect(abortManager.get('c1')).toBeUndefined();
        expect(abortManager.getSummary('c1')).toBeUndefined();
        expect(responses).toEqual([{ requestId: 'req-h1', data: { started: true } }]);
        expect(errors).toHaveLength(0);
    });

    // R6a-FIX H1：停止按钮路径（abortManager.cancel）→ 取消时透出 cancelled 结尾、不报错、控制器已清理
    test('H1：取消后（signal.aborted）透出 cancelled 结尾事件并清理控制器，不产生错误', async () => {
        const abortManager = new StreamAbortManager();
        let capturedSignal: AbortSignal | undefined;
        const fakeChatHandler = {
            handleEditBranchStream: async function* (request: any) {
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

        const pending = editBranchStream(
            { conversationId: 'c1', newText: 'edited', configId: 'cfg' },
            'req-h2',
            ctx
        );
        // 生产「停止」按钮路径：cancel 会 abort controller 并从 map 移除
        abortManager.cancel('c1');
        await pending;

        expect(capturedSignal).toBeDefined();
        expect(capturedSignal!.aborted).toBe(true);
        // 取消路径：不产生 EDIT_BRANCH_ERROR，控制器已清理
        expect(errors).toHaveLength(0);
        expect(abortManager.isActive('c1')).toBe(false);
        expect(abortManager.get('c1')).toBeUndefined();
    });

    test('方案 B：流失败透传底层 ChannelError.type（EDIT_BRANCH_ERROR + type=TIMEOUT_ERROR，前端据此判断可重试）', async () => {
        const posted: Array<{ type: string; data: any }> = [];
        const fakeChatHandler = {
            handleEditBranchStream: async function* (): AsyncGenerator<any> {
                throw new ChannelError(ErrorType.TIMEOUT_ERROR, 'request timed out');
            },
        } as any;

        const ctx = makeCtx({
            chatHandler: fakeChatHandler,
            view: { webview: { postMessage: (msg: any) => posted.push(msg) } } as any,
        });

        await editBranchStream({ conversationId: 'c1', newText: 'edited', configId: 'cfg' }, 'req-type-1', ctx);

        // 请求侧错误码仍为 EDIT_BRANCH_ERROR
        expect(errors).toEqual([{ requestId: 'req-type-1', code: 'EDIT_BRANCH_ERROR', message: 'request timed out' }]);
        // 流式 error chunk 携带底层 type
        const errorMsg = posted.find(m => m.type === 'streamChunk' && m.data?.type === 'error');
        expect(errorMsg).toBeDefined();
        expect(errorMsg!.data.error).toEqual({ code: 'EDIT_BRANCH_ERROR', message: 'request timed out', type: 'TIMEOUT_ERROR' });
    });
});


describe('TREE-03 keep 模式：原地编辑（保持当前分支）', () => {
    let tempDir: string;
    let repo: BranchGraphRepository;
    let manager: ConversationManager;
    let service: BranchService;

    beforeEach(async () => {
        tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'branch-edit-keep-'));
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
        await manager.addBatch(conversationId, branchedHistory());
        return (await manager.getMessagesRaw(conversationId)).map(m => m.id!);
    }

    /**
     * 复刻 ChatFlowService.handleEditBranchStream 的 keep 模式编排：
     * 解析目标 → 更新主历史消息 → 截断其后内容 → syncGraphAfterHistoryDelete → updateActiveNodeParts。
     * 返回目标消息索引。
     */
    async function runEditInPlaceFlow(
        conversationId: string,
        newText: string,
        userNodeId?: string,
    ): Promise<{ targetIndex: number }> {
        const graphResult = await service.getBranchGraph(conversationId);
        const history = await manager.getMessagesRaw(conversationId);
        const target = resolveEditTargetNode(graphResult.graph, history, userNodeId);
        const targetIndex = history.findIndex(message => message.id === target.nodeId);
        if (targetIndex === -1) {
            throw new Error('target not found');
        }

        // 先建图后截断：完整旧历史先进分支图（与 ChatFlowService keep 模式一致）
        await service.ensureBranchGraph(conversationId);

        await manager.updateMessage(conversationId, targetIndex, {
            parts: [{ text: newText }],
            isUserInput: true,
            tokenCountByChannel: {},
        });
        const historyAfterEdit = await manager.getMessagesRaw(conversationId);
        if (targetIndex + 1 < historyAfterEdit.length) {
            const deletedFromMessageId = historyAfterEdit[targetIndex + 1]?.id ?? null;
            const lastKeptMessageId = historyAfterEdit[targetIndex]?.id ?? null;
            await manager.deleteMessagesInRange(conversationId, targetIndex + 1, historyAfterEdit.length - 1);
            await service.syncGraphAfterHistoryDelete(conversationId, deletedFromMessageId, {
                lastKeptMessageId,
            });
        }
        await service.updateActiveNodeParts(conversationId, target.nodeId, [{ text: newText }]);
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

    test('keep 模式编排：改写原消息 + 截断其后内容 + 分支图软删子树，BR-05 一致', async () => {
        const [u1, m1, u2, m2] = await seedConversation('c1');

        await runEditInPlaceFlow('c1', 'edited q2', u2);

        // 主历史：目标消息改写，其后内容截断，节点 id 不变（BR-01：原地编辑不产生新节点）
        const history = await manager.getMessagesRaw('c1');
        expect(history.map(m => m.id)).toEqual([u1, m1, u2]);
        expect(history[2].parts).toEqual([{ text: 'edited q2' }]);
        expect(history[2].isUserInput).toBe(true);

        // 分支图：U2 内容更新；M2 软删（deleted 标记）；指向被删子树的 activeChildId 清空；活跃尾回退到 U2
        const graph = (await service.getBranchGraph('c1')).graph!;
        expect(validate(graph).valid).toBe(true);
        expect(graph.nodes[u2]!.parts).toEqual([{ text: 'edited q2' }]);
        expect(graph.nodes[m2]!.deleted).toBe(true);
        expect(graph.nodes[u2]!.activeChildId).toBeNull();
        expect(graph.activeTailNodeId).toBe(u2);

        // BR-05：主历史非 functionResponse id 链 == 图活跃路径
        const consistency = await service.validateActivePathMatchesHistory('c1');
        expect(consistency.valid).toBe(true);
        expect(consistency.historyIds).toEqual([u1, m1, u2]);
        expect(consistency.activePathIds).toEqual([u1, m1, u2]);
    });

    test('keep 模式不创建新候选：旧分支内容软删保留，可恢复查看', async () => {
        const [u1, m1, u2, m2] = await seedConversation('c1');

        await runEditInPlaceFlow('c1', 'edited q2', u2);

        const graphBefore = (await service.getBranchGraph('c1')).graph!;
        // 没有新增节点：节点数保持不变（原地编辑，不产生 edit/reroll 候选）
        expect(Object.keys(graphBefore.nodes)).toHaveLength(4);
        // 旧子树软删保留：M2 内容仍在，恢复后可见
        expect(graphBefore.nodes[m2]!.parts).toEqual([{ text: 'a2' }]);
        await service.restoreBranchCandidate('c1', m2);
        const graphAfter = (await service.getBranchGraph('c1')).graph!;
        expect(graphAfter.nodes[m2]!.deleted).toBeFalsy();
        expect(graphAfter.nodes[m2]!.parts).toEqual([{ text: 'a2' }]);
        expect(validate(graphAfter).valid).toBe(true);
    });
});