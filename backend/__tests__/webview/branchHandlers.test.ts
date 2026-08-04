/**
 * BranchHandlers 接口层单测（第五阶段 BR-06/07）。
 *
 * 覆盖：
 * - 注册表包含分支处理器（getBranchGraph / getBranchGraphMeta /
 *   createRerollCandidate / switchBranchCandidate / deleteBranchCandidate /
 *   restoreBranchCandidate / renameBranchCandidate / purgeBranchCandidate /
 *   getDeletedBranchCount / pruneDeletedBranches /
 *   getBranchRetentionConfig / updateBranchRetentionConfig）；
 * - getBranchGraph 成功路径（无图 → { graph: null }，建图后返回图）；
 * - createRerollCandidate 成功路径（建基线 + 候选）；
 * - TREE-09：renameBranchCandidate / getDeletedBranchCount / pruneDeletedBranches /
 *   保留期配置 / restore / purge 成功与入参校验；
 * - 错误码映射：BranchErrorCode（NODE_NOT_FOUND）作为 IPC 错误码透出；
 * - BranchService 懒初始化使用 StoragePathManager 的有效数据路径。
 */

import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ConversationManager } from '../../modules/conversation/ConversationManager';
import { MemoryStorageAdapter } from '../../modules/conversation/storage';
import type { ConversationHistory } from '../../modules/conversation/types';
import { setGlobalBranchService, getGlobalBranchService, BranchService } from '../../modules/conversation/branch/BranchService';
import { BranchGraphRepository } from '../../modules/conversation/branch/BranchGraphRepository';
import {
    BRANCH_BUSY_STREAMING_MESSAGE,
    createRerollCandidate,
    deleteBranchCandidate,
    getBranchGraph,
    getBranchGraphMeta,
    getBranchRetentionConfig,
    getDeletedBranchCount,
    pruneDeletedBranches,
    purgeBranchCandidate,
    registerBranchHandlers,
    renameBranchCandidate,
    restoreBranchCandidate,
    switchBranchCandidate,
    updateBranchRetentionConfig,
} from '../../../webview/handlers/BranchHandlers';
import { StreamAbortManager } from '../../../webview/stream/StreamAbortManager';
import { createMessageHandlerRegistry } from '../../../webview/handlers';
import type { HandlerContext, MessageHandler } from '../../../webview/types';

/** 线性历史：root(user) → model(a1) */
function linearHistory(): ConversationHistory {
    return [
        { role: 'user', parts: [{ text: 'q1' }], timestamp: 100 },
        { role: 'model', parts: [{ text: 'a1' }], timestamp: 200 },
    ];
}

/** 建会话并写入线性历史，返回 [userNodeId, modelNodeId] */
async function seedLinear(manager: ConversationManager, conversationId: string): Promise<string[]> {
    await manager.createConversation(conversationId, 'T');
    await manager.addBatch(conversationId, linearHistory());
    return (await manager.getMessagesRaw(conversationId)).map(m => m.id!);
}

describe('BranchHandlers 注册', () => {
    test('注册表包含十二个分支处理器', () => {
        const registry = createMessageHandlerRegistry();
        for (const name of [
            'conversation.getBranchGraph',
            'conversation.getBranchGraphMeta',
            'conversation.createRerollCandidate',
            'conversation.switchBranchCandidate',
            'conversation.deleteBranchCandidate',
            'conversation.restoreBranchCandidate',
            'conversation.renameBranchCandidate',
            'conversation.purgeBranchCandidate',
            'conversation.getDeletedBranchCount',
            'conversation.pruneDeletedBranches',
            'conversation.getBranchRetentionConfig',
            'conversation.updateBranchRetentionConfig',
        ]) {
            expect(registry.has(name)).toBe(true);
            expect(typeof registry.get(name)).toBe('function');
        }
    });

    test('registerBranchHandlers 独立注册（空表也能注册十二项）', () => {
        const registry = new Map<string, MessageHandler>();
        registerBranchHandlers(registry);
        expect(registry.size).toBe(12);
        expect(registry.get('conversation.getBranchGraph')).toBeDefined();
    });
});

describe('BranchHandlers 行为', () => {
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
            // TREE-13：与生产一致，streamAbortControllers 实际注入 StreamAbortManager 实例
            // （ChatViewProvider L580/803：messageRouter.getAbortManager() as any）
            streamAbortControllers: new StreamAbortManager() as unknown as Map<string, AbortController>,
            sendResponse: (requestId, data) => { responses.push({ requestId, data }); },
            sendError: (requestId, code, message) => { errors.push({ requestId, code, message }); },
            ...overrides,
        } as unknown as HandlerContext;
    }

    beforeEach(async () => {
        tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'branch-handlers-'));
        manager = new ConversationManager(new MemoryStorageAdapter());
        responses = [];
        errors = [];
        setGlobalBranchService(undefined);
    });

    afterEach(async () => {
        setGlobalBranchService(undefined);
        await fsp.rm(tempDir, { recursive: true, force: true });
    });

    test('getBranchGraph：无图返回 { graph: null }，并懒初始化 BranchService（使用有效数据路径）', async () => {
        await manager.createConversation('c1', 'T');
        await getBranchGraph({ conversationId: 'c1' }, 'req-1', makeCtx());

        expect(getGlobalBranchService()).toBeDefined();
        expect(responses).toEqual([{ requestId: 'req-1', data: { graph: null } }]);
        expect(errors).toHaveLength(0);
    });

    test('createRerollCandidate：建线性基线 + reroll 候选，返回 activePathIds', async () => {
        await manager.createConversation('c1', 'T');
        await manager.addBatch('c1', [
            { role: 'user', parts: [{ text: 'q1' }], timestamp: 100 },
            { role: 'model', parts: [{ text: 'a1' }], timestamp: 200 },
        ]);
        const history = await manager.getMessagesRaw('c1');
        const modelNodeId = history[1].id!;

        await createRerollCandidate(
            { conversationId: 'c1', parentNodeId: modelNodeId, parts: [{ text: 'a2' }] },
            'req-2',
            makeCtx()
        );

        expect(errors).toHaveLength(0);
        const data = responses[0].data as Record<string, unknown>;
        expect(data).toMatchObject({ success: true, kind: 'reroll', parentNodeId: modelNodeId });
        expect((data.activePathIds as string[])).toEqual([history[0].id!, modelNodeId, data.nodeId as string]);
        // sidecar 确实落盘在有效数据路径下
        const filePath = path.join(tempDir, 'conversations', 'c1', 'branches.json');
        expect(await fsp.access(filePath).then(() => true).catch(() => false)).toBe(true);
    });

    test('错误码映射：BranchErrorCode（NODE_NOT_FOUND）作为 IPC 错误码透出', async () => {
        await manager.createConversation('c1', 'T');
        await manager.addBatch('c1', [{ role: 'user', parts: [{ text: 'q' }], timestamp: 1 }]);

        await createRerollCandidate(
            { conversationId: 'c1', parentNodeId: 'no-such-node', parts: [{ text: 'x' }] },
            'req-3',
            makeCtx()
        );

        expect(responses).toHaveLength(0);
        expect(errors).toHaveLength(1);
        expect(errors[0]).toMatchObject({ requestId: 'req-3', code: 'NODE_NOT_FOUND' });
        expect(errors[0].message).toContain('no-such-node');
    });

    test('缺失入参返回 BRANCH_OPERATION_CONFLICT', async () => {
        await getBranchGraph({}, 'req-4', makeCtx());
        expect(errors).toHaveLength(1);
        expect(errors[0].code).toBe('BRANCH_OPERATION_CONFLICT');
    });

    test('L-7：非 string 入参（数字等）按缺失处理，返回 BRANCH_OPERATION_CONFLICT', async () => {
        await getBranchGraph({ conversationId: 123 as unknown as string }, 'req-7', makeCtx());
        expect(errors).toHaveLength(1);
        expect(errors[0].code).toBe('BRANCH_OPERATION_CONFLICT');
        expect(errors[0].message).toContain('conversationId');
    });

    test('L-6：未知异常映射为 INTERNAL_ERROR 并透出原始错误信息（不再伪装成 BRANCH_OPERATION_CONFLICT）', async () => {
        // 注入一个会抛普通 Error 的假 service，模拟非 BranchError 的服务端缺陷
        setGlobalBranchService({
            getBranchGraph: async () => { throw new Error('unexpected boom'); }
        } as any);

        await getBranchGraph({ conversationId: 'c1' }, 'req-8', makeCtx());

        expect(responses).toHaveLength(0);
        expect(errors).toHaveLength(1);
        expect(errors[0]).toMatchObject({ requestId: 'req-8', code: 'INTERNAL_ERROR', message: 'unexpected boom' });
    });
});

describe('TREE-09 分支管理处理器（软删/恢复/重命名/修剪/保留期）', () => {
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
        tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'branch-handlers-tree09-'));
        manager = new ConversationManager(new MemoryStorageAdapter());
        responses = [];
        errors = [];
        setGlobalBranchService(undefined);
    });

    afterEach(async () => {
        setGlobalBranchService(undefined);
        await fsp.rm(tempDir, { recursive: true, force: true });
    });

    /** 建会话 + 两个 reroll 候选，返回 [user, model, r1, r2] */
    async function seedWithCandidates(conversationId: string): Promise<string[]> {
        const ids = await seedLinear(manager, conversationId);
        await createRerollCandidate(
            { conversationId, parentNodeId: ids[1], parts: [{ text: 'a2' }] }, 'seed-r1', makeCtx());
        const r1 = responses[responses.length - 1].data as { nodeId: string };
        await createRerollCandidate(
            { conversationId, parentNodeId: ids[1], parts: [{ text: 'a3' }] }, 'seed-r2', makeCtx());
        const r2 = responses[responses.length - 1].data as { nodeId: string };
        responses = [];
        errors = [];
        return [ids[0], ids[1], r1.nodeId, r2.nodeId];
    }

    /** 调 getBranchGraph 并返回最近一次响应的 graph */
    async function readGraph(conversationId: string): Promise<any> {
        const before = responses.length;
        await getBranchGraph({ conversationId }, `read-${before}`, makeCtx());
        return (responses[responses.length - 1].data as any).graph as any;
    }

    test('renameBranchCandidate：只改 label，返回成功；空 label → BRANCH_OPERATION_CONFLICT', async () => {
        const ids = await seedWithCandidates('c1');
        await renameBranchCandidate({ conversationId: 'c1', nodeId: ids[2], label: '我的分支 A' }, 'req-t1', makeCtx());
        expect(errors).toHaveLength(0);
        expect(responses[0].data).toMatchObject({ success: true, nodeId: ids[2], label: '我的分支 A' });

        // 图内节点与摘要 label 同步
        const g = await readGraph('c1');
        expect(g.nodes[ids[2]].label).toBe('我的分支 A');
        expect(g.candidateSummaries.find((s: any) => s.nodeId === ids[2]).label).toBe('我的分支 A');
        // contents 未动
        expect(g.nodes[ids[2]].parts).toEqual([{ text: 'a2' }]);

        await renameBranchCandidate({ conversationId: 'c1', nodeId: ids[2], label: '   ' }, 'req-t2', makeCtx());
        expect(errors).toHaveLength(1);
        expect(errors[0]).toMatchObject({ requestId: 'req-t2', code: 'INVALID_BRANCH_RELATION' });
    });

    test('deleteBranchCandidate 软删带 deletedAt；restoreBranchCandidate 恢复后 deleted/deletedAt 清除', async () => {
        const ids = await seedWithCandidates('c1');
        await deleteBranchCandidate({ conversationId: 'c1', nodeId: ids[2] }, 'req-t3', makeCtx());
        const g1 = await readGraph('c1');
        expect(g1.nodes[ids[2]].deleted).toBe(true);
        expect(typeof g1.nodes[ids[2]].deletedAt).toBe('number');
        expect(g1.candidateSummaries.find((s: any) => s.nodeId === ids[2]).deleted).toBe(true);

        await restoreBranchCandidate({ conversationId: 'c1', nodeId: ids[2] }, 'req-t4', makeCtx());
        expect(errors).toHaveLength(0);
        expect(responses[responses.length - 1].data).toMatchObject({ success: true, nodeId: ids[2], restored: true });
        const g2 = await readGraph('c1');
        expect(g2.nodes[ids[2]].deleted).toBeUndefined();
        expect(g2.nodes[ids[2]].deletedAt).toBeUndefined();
    });

    test('purgeBranchCandidate：未软删 → 冲突；软删后彻底删除（节点+摘要消失）', async () => {
        const ids = await seedWithCandidates('c1');
        await purgeBranchCandidate({ conversationId: 'c1', nodeId: ids[2] }, 'req-t5', makeCtx());
        expect(errors).toHaveLength(1);
        expect(errors[0]).toMatchObject({ requestId: 'req-t5', code: 'BRANCH_OPERATION_CONFLICT' });

        await deleteBranchCandidate({ conversationId: 'c1', nodeId: ids[2] }, 'req-t6', makeCtx());
        await purgeBranchCandidate({ conversationId: 'c1', nodeId: ids[2] }, 'req-t7', makeCtx());
        expect(errors).toHaveLength(1); // 仅 t5 的冲突
        expect(responses[responses.length - 1].data).toMatchObject({ success: true, purged: true });
        const g = await readGraph('c1');
        expect(g.nodes[ids[2]]).toBeUndefined();
        expect(g.candidateSummaries.find((s: any) => s.nodeId === ids[2])).toBeUndefined();
    });

    test('getDeletedBranchCount：全量扫描统计软删节点数（缺省 conversationId）', async () => {
        const ids1 = await seedWithCandidates('c1');
        const ids2 = await seedWithCandidates('c2');
        await deleteBranchCandidate({ conversationId: 'c1', nodeId: ids1[2] }, 'req-t8', makeCtx());
        await deleteBranchCandidate({ conversationId: 'c2', nodeId: ids2[2] }, 'req-t9', makeCtx());

        await getDeletedBranchCount({}, 'req-t10', makeCtx());
        expect(errors).toHaveLength(0);
        expect(responses[responses.length - 1].data).toMatchObject({ conversationCount: 2, deletedNodeCount: 2 });

        await getDeletedBranchCount({ conversationId: 'c1' }, 'req-t11', makeCtx());
        expect(responses[responses.length - 1].data).toMatchObject({ conversationCount: 1, deletedNodeCount: 1 });
    });

    test('pruneDeletedBranches：retentionDays=0 永不过期（不清理）；非法值 → BRANCH_OPERATION_CONFLICT', async () => {
        const ids = await seedWithCandidates('c1');
        await deleteBranchCandidate({ conversationId: 'c1', nodeId: ids[2] }, 'req-t12', makeCtx());

        await pruneDeletedBranches({ retentionDays: 0 }, 'req-t13', makeCtx());
        expect(errors).toHaveLength(0);
        expect(responses[responses.length - 1].data).toMatchObject({ conversationsScanned: 1, prunedNodeCount: 0 });

        await pruneDeletedBranches({ retentionDays: -1 }, 'req-t14', makeCtx());
        expect(errors).toHaveLength(1);
        expect(errors[0]).toMatchObject({ requestId: 'req-t14', code: 'BRANCH_OPERATION_CONFLICT' });
    });

    test('getBranchRetentionConfig：缺省返回 30；updateBranchRetentionConfig 持久化并回读', async () => {
        await getBranchRetentionConfig({}, 'req-t15', makeCtx());
        expect(errors).toHaveLength(0);
        expect(responses[0].data).toEqual({ retentionDays: 30 });

        await updateBranchRetentionConfig({ retentionDays: 7 }, 'req-t16', makeCtx());
        expect(responses[1].data).toMatchObject({ success: true, retentionDays: 7 });

        await getBranchRetentionConfig({}, 'req-t17', makeCtx());
        expect(responses[2].data).toEqual({ retentionDays: 7 });

        await updateBranchRetentionConfig({ retentionDays: 1.5 }, 'req-t18', makeCtx());
        expect(errors).toHaveLength(1);
        expect(errors[0]).toMatchObject({ requestId: 'req-t18', code: 'BRANCH_OPERATION_CONFLICT' });
    });

    test('TREE-13 互斥覆盖新变更类处理器：流式中 rename/purge/restore 均 BRANCH_BUSY', async () => {
        const abortManager = new StreamAbortManager();
        abortManager.create('c1');
        const ctx = makeCtx({ streamAbortControllers: abortManager as unknown as Map<string, AbortController> });

        await renameBranchCandidate({ conversationId: 'c1', nodeId: 'n1', label: 'x' }, 'req-b1', ctx);
        await purgeBranchCandidate({ conversationId: 'c1', nodeId: 'n1' }, 'req-b2', ctx);
        await restoreBranchCandidate({ conversationId: 'c1', nodeId: 'n1' }, 'req-b3', ctx);

        expect(responses).toHaveLength(0);
        expect(errors).toHaveLength(3);
        expect(errors.every(e => e.code === 'BRANCH_BUSY')).toBe(true);
    });
});

describe('TREE-13 流式期间分支互斥（StreamAbortManager.isActive）', () => {
    let tempDir: string;
    let manager: ConversationManager;
    let abortManager: StreamAbortManager;
    let responses: Array<{ requestId: string; data: unknown }>;
    let errors: Array<{ requestId: string; code: string; message: string }>;

    function makeCtx(overrides: Record<string, unknown> = {}): HandlerContext {
        return {
            conversationManager: manager,
            storagePathManager: {
                getEffectiveDataPath: () => tempDir,
            } as unknown as HandlerContext['storagePathManager'],
            streamAbortControllers: abortManager as unknown as Map<string, AbortController>,
            sendResponse: (requestId, data) => { responses.push({ requestId, data }); },
            sendError: (requestId, code, message) => { errors.push({ requestId, code, message }); },
            ...overrides,
        } as unknown as HandlerContext;
    }

    beforeEach(async () => {
        tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'branch-handlers-busy-'));
        manager = new ConversationManager(new MemoryStorageAdapter());
        abortManager = new StreamAbortManager();
        responses = [];
        errors = [];
        setGlobalBranchService(undefined);
    });

    afterEach(async () => {
        setGlobalBranchService(undefined);
        await fsp.rm(tempDir, { recursive: true, force: true });
    });

    test('流式中 createRerollCandidate → BRANCH_BUSY（含明确文案），且不调用 BranchService', async () => {
        const serviceSpy = { createRerollCandidate: jest.fn() } as any;
        setGlobalBranchService(serviceSpy);
        abortManager.create('c1'); // 模拟流式开始

        await createRerollCandidate(
            { conversationId: 'c1', parentNodeId: 'parent', parts: [{ text: 'x' }] },
            'req-b1',
            makeCtx()
        );

        expect(responses).toHaveLength(0);
        expect(errors).toHaveLength(1);
        expect(errors[0]).toMatchObject({ requestId: 'req-b1', code: 'BRANCH_BUSY' });
        expect(errors[0].message).toBe(BRANCH_BUSY_STREAMING_MESSAGE);
        expect(errors[0].message).toContain('流式生成');
        expect(serviceSpy.createRerollCandidate).not.toHaveBeenCalled();
    });

    test('流式中 switchBranchCandidate → BRANCH_BUSY，且不调用 BranchService', async () => {
        const serviceSpy = { switchBranchCandidate: jest.fn() } as any;
        setGlobalBranchService(serviceSpy);
        abortManager.create('c1');

        await switchBranchCandidate({ conversationId: 'c1', nodeId: 'n1' }, 'req-b2', makeCtx());

        expect(responses).toHaveLength(0);
        expect(errors).toHaveLength(1);
        expect(errors[0]).toMatchObject({ requestId: 'req-b2', code: 'BRANCH_BUSY' });
        expect(errors[0].message).toBe(BRANCH_BUSY_STREAMING_MESSAGE);
        expect(serviceSpy.switchBranchCandidate).not.toHaveBeenCalled();
    });

    test('流式中 deleteBranchCandidate → BRANCH_BUSY，且不调用 BranchService', async () => {
        const serviceSpy = { deleteBranchCandidate: jest.fn() } as any;
        setGlobalBranchService(serviceSpy);
        abortManager.create('c1');

        await deleteBranchCandidate({ conversationId: 'c1', nodeId: 'n1' }, 'req-b3', makeCtx());

        expect(responses).toHaveLength(0);
        expect(errors).toHaveLength(1);
        expect(errors[0]).toMatchObject({ requestId: 'req-b3', code: 'BRANCH_BUSY' });
        expect(errors[0].message).toBe(BRANCH_BUSY_STREAMING_MESSAGE);
        expect(serviceSpy.deleteBranchCandidate).not.toHaveBeenCalled();
    });

    test('流式结束后放行：delete controller 后 isActive=false，操作成功', async () => {
        const ids = await seedLinear(manager, 'c1');
        abortManager.create('c1'); // 流式开始
        abortManager.delete('c1'); // 流式结束（正常 / 取消都会清 controller）

        await createRerollCandidate(
            { conversationId: 'c1', parentNodeId: ids[1], parts: [{ text: 'a2' }] },
            'req-b4',
            makeCtx()
        );

        expect(errors).toHaveLength(0);
        expect(responses).toHaveLength(1);
        expect(responses[0].data).toMatchObject({ success: true, kind: 'reroll' });
    });

    test('只读操作不受流式影响：流式中 getBranchGraph / getBranchGraphMeta 正常返回', async () => {
        await seedLinear(manager, 'c1');
        abortManager.create('c1');

        await getBranchGraph({ conversationId: 'c1' }, 'req-b5', makeCtx());
        await getBranchGraphMeta({ conversationId: 'c1' }, 'req-b6', makeCtx());

        expect(errors).toHaveLength(0);
        expect(responses.map(r => r.requestId)).toEqual(['req-b5', 'req-b6']);
    });

    test('互斥按会话粒度：c1 流式不阻塞 c2 的分支操作，c1 自身被拒', async () => {
        const c1Ids = await seedLinear(manager, 'c1');
        const c2Ids = await seedLinear(manager, 'c2');
        abortManager.create('c1'); // 仅 c1 流式

        // c2 无流 → 放行
        await createRerollCandidate(
            { conversationId: 'c2', parentNodeId: c2Ids[1], parts: [{ text: 'c2-reroll' }] },
            'req-b7',
            makeCtx()
        );
        expect(errors).toHaveLength(0);
        expect(responses[0].data).toMatchObject({ success: true });

        // c1 流式中 → 拒绝
        await createRerollCandidate(
            { conversationId: 'c1', parentNodeId: c1Ids[1], parts: [{ text: 'c1-reroll' }] },
            'req-b8',
            makeCtx()
        );
        expect(errors).toHaveLength(1);
        expect(errors[0]).toMatchObject({ requestId: 'req-b8', code: 'BRANCH_BUSY' });
    });

    test('纯 Map 兜底：streamAbortControllers 为真实 Map 且含该会话 controller → 同样拒绝', async () => {
        const map = new Map<string, AbortController>();
        map.set('c1', new AbortController());
        const ctx = makeCtx({ streamAbortControllers: map });

        await createRerollCandidate(
            { conversationId: 'c1', parentNodeId: 'parent', parts: [{ text: 'x' }] },
            'req-b9',
            ctx
        );

        expect(responses).toHaveLength(0);
        expect(errors).toHaveLength(1);
        expect(errors[0]).toMatchObject({ requestId: 'req-b9', code: 'BRANCH_BUSY' });
    });

    test('入参校验优先：流式中缺失 conversationId 仍返回 BRANCH_OPERATION_CONFLICT（而非 BRANCH_BUSY）', async () => {
        abortManager.create('c1');
        await switchBranchCandidate({ nodeId: 'n1' }, 'req-b10', makeCtx());

        expect(errors).toHaveLength(1);
        expect(errors[0]).toMatchObject({ requestId: 'req-b10', code: 'BRANCH_OPERATION_CONFLICT' });
    });

    // R6b-2.1①：生产「停止」按钮路径——cancel() 会 abort 并移除 controller，isActive 归 false，操作放行
    test('cancel() 后放行：停止按钮路径清理 controller，isActive=false，分支操作成功', async () => {
        const ids = await seedLinear(manager, 'c1');
        abortManager.create('c1');
        expect(abortManager.isActive('c1')).toBe(true);

        // 生产停止按钮/取消流走 StreamAbortManager.cancel（abort + delete）
        const cancelled = abortManager.cancel('c1');
        expect(cancelled).toBe(true);
        expect(abortManager.isActive('c1')).toBe(false);
        expect(abortManager.get('c1')).toBeUndefined();

        await createRerollCandidate(
            { conversationId: 'c1', parentNodeId: ids[1], parts: [{ text: 'a2' }] },
            'req-c1',
            makeCtx()
        );
        expect(errors).toHaveLength(0);
        expect(responses[0].data).toMatchObject({ success: true, kind: 'reroll' });
    });

    // R6b-2.1②：createSummary 只登记总结专用控制器，不置流式互斥（summary 请求不拦截分支操作）
    test('createSummary 不置互斥：isConversationStreaming 仍 false，分支操作放行', async () => {
        const ids = await seedLinear(manager, 'c1');
        abortManager.createSummary('c1'); // 总结请求专用控制器

        expect(abortManager.isActive('c1')).toBe(false); // isActive 只看主流请求
        expect(abortManager.get('c1')).toBeUndefined();
        expect(abortManager.getSummary('c1')).toBeDefined();

        await createRerollCandidate(
            { conversationId: 'c1', parentNodeId: ids[1], parts: [{ text: 'a2' }] },
            'req-c2',
            makeCtx()
        );
        expect(errors).toHaveLength(0);
        expect(responses[0].data).toMatchObject({ success: true, kind: 'reroll' });
    });

    // R6b-2.1③：create 两次 → 新流替换旧流（旧流被 abort），isActive 仍 true，互斥继续生效
    test('create 两次：isActive 仍 true、旧流被 abort（新流替换），流式互斥继续生效', async () => {
        const first = abortManager.create('c1');
        const second = abortManager.create('c1'); // 新流启动会中止旧流（生产：reroll 覆盖 chat 流）
        expect(first.signal.aborted).toBe(true);
        expect(second.signal.aborted).toBe(false);
        expect(abortManager.isActive('c1')).toBe(true);
        expect(abortManager.get('c1')).toBe(second);

        // isActive 保持 true：流式中分支操作仍被拒
        const serviceSpy = { createRerollCandidate: jest.fn() } as any;
        setGlobalBranchService(serviceSpy);
        await createRerollCandidate(
            { conversationId: 'c1', parentNodeId: 'parent', parts: [{ text: 'x' }] },
            'req-c3',
            makeCtx()
        );
        expect(errors).toHaveLength(1);
        expect(errors[0]).toMatchObject({ requestId: 'req-c3', code: 'BRANCH_BUSY' });
        expect(serviceSpy.createRerollCandidate).not.toHaveBeenCalled();
    });
});


describe('BCP-03/04/05 切换 + 工作区恢复联动（mode / 安全闸 / 失败不切分支）', () => {
    let tempDir: string;
    let manager: ConversationManager;
    let service: BranchService;
    let responses: Array<{ requestId: string; data: unknown }>;
    let errors: Array<{ requestId: string; code: string; message: string }>;
    let restoreSpy: jest.Mock;
    let previewSpy: jest.Mock;
    let checkpointDeleteSpy: jest.Mock;

    function makeCtx(overrides: Record<string, unknown> = {}): HandlerContext {
        return {
            conversationManager: manager,
            storagePathManager: {
                getEffectiveDataPath: () => tempDir,
            } as unknown as HandlerContext['storagePathManager'],
            streamAbortControllers: new StreamAbortManager() as unknown as Map<string, AbortController>,
            checkpointManager: {
                previewRestore: previewSpy,
                restoreCheckpoint: restoreSpy,
                deleteCheckpointsFromIndex: checkpointDeleteSpy,
            } as unknown as HandlerContext['checkpointManager'],
            sendResponse: (requestId, data) => { responses.push({ requestId, data }); },
            sendError: (requestId, code, message) => { errors.push({ requestId, code, message }); },
            ...overrides,
        } as unknown as HandlerContext;
    }

    /** 建会话 + 两个 reroll 候选（r1 含写工具 apply_diff、r2 纯文本），当前活跃 = r2，返回 [user, model, r1, r2] */
    async function seedWithCandidates(conversationId: string): Promise<string[]> {
        const ids = await seedLinear(manager, conversationId);
        await createRerollCandidate(
            { conversationId, parentNodeId: ids[1], parts: [{ functionCall: { name: 'apply_diff', args: {} } }] },
            'bcp-seed-r1',
            makeCtx()
        );
        const r1 = responses[responses.length - 1].data as { nodeId: string };
        await createRerollCandidate(
            { conversationId, parentNodeId: ids[1], parts: [{ text: 'a3' }] },
            'bcp-seed-r2',
            makeCtx()
        );
        const r2 = responses[responses.length - 1].data as { nodeId: string };
        responses = [];
        errors = [];
        return [ids[0], ids[1], r1.nodeId, r2.nodeId];
    }

    /** 直接改写 sidecar：给节点绑定工作区存档（BCP-02 字段，本批次只读不写 BranchService） */
    async function bindWorkspaceCheckpoint(conversationId: string, nodeId: string, checkpointId: string): Promise<void> {
        const filePath = path.join(tempDir, 'conversations', conversationId, 'branches.json');
        const graph = JSON.parse(await fsp.readFile(filePath, 'utf8'));
        graph.nodes[nodeId].workspaceCheckpointId = checkpointId;
        graph.nodes[nodeId].workspaceState = 'checkpointed';
        await fsp.writeFile(filePath, JSON.stringify(graph), 'utf8');
    }

    /** 读取图活跃尾（断言「不切分支」） */
    async function readActiveTail(conversationId: string): Promise<string | null> {
        const graph = (await service.getBranchGraph(conversationId)).graph;
        return graph ? graph.activeTailNodeId : null;
    }

    beforeEach(async () => {
        tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'branch-handlers-bcp-'));
        manager = new ConversationManager(new MemoryStorageAdapter());
        service = new BranchService(manager, new BranchGraphRepository(tempDir));
        setGlobalBranchService(service);
        responses = [];
        errors = [];
        restoreSpy = jest.fn();
        previewSpy = jest.fn();
        checkpointDeleteSpy = jest.fn(async () => 0);
        // vscode mock 复位（dirty 检测依赖 workspace.textDocuments / workspaceFolders）
        (vscode.workspace as any).textDocuments = [];
        (vscode.workspace as any).workspaceFolders = [];
    });

    afterEach(async () => {
        setGlobalBranchService(undefined);
        (vscode.workspace as any).textDocuments = [];
        (vscode.workspace as any).workspaceFolders = [];
        await fsp.rm(tempDir, { recursive: true, force: true });
    });

    test('BCP-04 getBranchGraph 富化：写工具节点 wroteToWorkspace=true、绑定存档节点 hasWorkspaceState=true', async () => {
        const ids = await seedWithCandidates('c1');
        await bindWorkspaceCheckpoint('c1', ids[2], 'cp_ws_1');

        await getBranchGraph({ conversationId: 'c1' }, 'req-g1', makeCtx());
        expect(errors).toHaveLength(0);
        const graph = (responses[0].data as { graph: { nodes: Record<string, any> } }).graph;

        // r1 路径含写工具 apply_diff → wroteToWorkspace；且已绑定存档 → hasWorkspaceState
        expect(graph.nodes[ids[2]].wroteToWorkspace).toBe(true);
        expect(graph.nodes[ids[2]].hasWorkspaceState).toBe(true);
        // r2 纯文本 → 两者均 false
        expect(graph.nodes[ids[3]].wroteToWorkspace).toBe(false);
        expect(graph.nodes[ids[3]].hasWorkspaceState).toBe(false);
        // 共享前缀（user/model）不因 r1 路径上的写工具而误判
        expect(graph.nodes[ids[0]].wroteToWorkspace).toBe(false);
        expect(graph.nodes[ids[1]].wroteToWorkspace).toBe(false);
        // 只读工具不命中写工具集
        expect(graph.nodes[ids[1]].wroteToWorkspace).toBe(false);
    });

    test('BCP-03 缺省 mode（chat-only）：不触发恢复（restoreSpy 不被调用）且切换成功', async () => {
        const ids = await seedWithCandidates('c1');
        await bindWorkspaceCheckpoint('c1', ids[2], 'cp_ws_1');

        await switchBranchCandidate({ conversationId: 'c1', nodeId: ids[2] }, 'req-s1', makeCtx());
        expect(errors).toHaveLength(0);
        expect(restoreSpy).not.toHaveBeenCalled();
        expect(previewSpy).not.toHaveBeenCalled();
        const data = responses[0].data as Record<string, unknown>;
        expect(data).toMatchObject({ success: true, nodeId: ids[2], rewritten: true });
        // chat-only 不携带 workspace 字段
        expect(data.workspaceRestored).toBeUndefined();
        expect(await readActiveTail('c1')).toBe(ids[2]);
    });

    test('BCP-05 安全闸：目标节点无 workspaceCheckpointId → WORKSPACE_STATE_UNAVAILABLE，不恢复不切分支', async () => {
        const ids = await seedWithCandidates('c1');

        await switchBranchCandidate(
            { conversationId: 'c1', nodeId: ids[2], mode: 'chat-and-workspace' },
            'req-s2',
            makeCtx()
        );

        expect(responses).toHaveLength(0);
        expect(errors).toHaveLength(1);
        expect(errors[0]).toMatchObject({ requestId: 'req-s2', code: 'WORKSPACE_STATE_UNAVAILABLE' });
        expect(restoreSpy).not.toHaveBeenCalled();
        expect(previewSpy).not.toHaveBeenCalled();
        // 不切分支：活跃尾保持 r2
        expect(await readActiveTail('c1')).toBe(ids[3]);
    });

    test('BCP-05 dirty 拦截：工作区内有未保存文件 → 返回 dirtyFiles，不恢复不切分支', async () => {
        const ids = await seedWithCandidates('c1');
        await bindWorkspaceCheckpoint('c1', ids[2], 'cp_ws_1');
        const dirtyPath = path.join(tempDir, 'dirty.ts');
        (vscode.workspace as any).workspaceFolders = [
            { name: 'ws', index: 0, uri: { fsPath: tempDir, scheme: 'file', path: tempDir } },
        ];
        (vscode.workspace as any).textDocuments = [
            { uri: { fsPath: dirtyPath, scheme: 'file' }, isDirty: true },
        ];

        await switchBranchCandidate(
            { conversationId: 'c1', nodeId: ids[2], mode: 'chat-and-workspace' },
            'req-s3',
            makeCtx()
        );

        expect(errors).toHaveLength(0);
        expect(responses).toHaveLength(1);
        expect(responses[0].data).toMatchObject({ success: false, mode: 'chat-and-workspace' });
        expect((responses[0].data as { dirtyFiles: string[] }).dirtyFiles).toEqual([dirtyPath]);
        expect(restoreSpy).not.toHaveBeenCalled();
        expect(previewSpy).not.toHaveBeenCalled();
        expect(await readActiveTail('c1')).toBe(ids[3]);
    });

    test('BCP-05 chat-only 模式不受 dirty 影响：有未保存文件仍正常切换（不检测）', async () => {
        const ids = await seedWithCandidates('c1');
        await bindWorkspaceCheckpoint('c1', ids[2], 'cp_ws_1');
        (vscode.workspace as any).workspaceFolders = [
            { name: 'ws', index: 0, uri: { fsPath: tempDir, scheme: 'file', path: tempDir } },
        ];
        (vscode.workspace as any).textDocuments = [
            { uri: { fsPath: path.join(tempDir, 'dirty.ts'), scheme: 'file' }, isDirty: true },
        ];

        await switchBranchCandidate({ conversationId: 'c1', nodeId: ids[2] }, 'req-s4', makeCtx());
        expect(errors).toHaveLength(0);
        expect(responses[0].data).toMatchObject({ success: true, nodeId: ids[2] });
        expect(await readActiveTail('c1')).toBe(ids[2]);
    });

    test('BCP-03 chat-and-workspace 成功路径：preview → restore → 切换（锁序：恢复先于切图）', async () => {
        const ids = await seedWithCandidates('c1');
        await bindWorkspaceCheckpoint('c1', ids[2], 'cp_ws_1');
        previewSpy.mockResolvedValue({ success: true, restored: 2, deletedIfUnconfirmed: 1, skipped: 0, deletablePaths: ['b.txt'] });
        restoreSpy.mockResolvedValue({ success: true, restored: 2, deleted: 0, skipped: 1 });

        await switchBranchCandidate(
            { conversationId: 'c1', nodeId: ids[2], mode: 'chat-and-workspace' },
            'req-s5',
            makeCtx()
        );

        expect(errors).toHaveLength(0);
        const data = responses[0].data as Record<string, unknown>;
        expect(data).toMatchObject({
            success: true,
            nodeId: ids[2],
            rewritten: true,
            workspaceRestored: true,
            restoredSummary: { restored: 2, deleted: 0, skipped: 1 },
        });
        // 恢复在切换前完成（restoreCheckpoint 收到正确存档与 deleteUntrackedFiles=false）
        expect(restoreSpy).toHaveBeenCalledWith('c1', 'cp_ws_1', { deleteUntrackedFiles: false });
        expect(previewSpy).toHaveBeenCalledWith('c1', 'cp_ws_1');
        // 切图 + 主历史重写 + 检查点清理全部完成
        expect(await readActiveTail('c1')).toBe(ids[2]);
        expect(checkpointDeleteSpy).toHaveBeenCalled();
        expect(await service.validateActivePathMatchesHistory('c1')).toMatchObject({ valid: true });
    });

    test('BCP-03 恢复失败（restoreCheckpoint success:false）→ WORKSPACE_STATE_UNAVAILABLE，不切分支', async () => {
        const ids = await seedWithCandidates('c1');
        await bindWorkspaceCheckpoint('c1', ids[2], 'cp_ws_1');
        previewSpy.mockResolvedValue({ success: true, restored: 2, deletedIfUnconfirmed: 0, skipped: 0 });
        restoreSpy.mockResolvedValue({ success: false, restored: 0, error: 'backup dir missing' });

        await switchBranchCandidate(
            { conversationId: 'c1', nodeId: ids[2], mode: 'chat-and-workspace' },
            'req-s6',
            makeCtx()
        );

        expect(responses).toHaveLength(0);
        expect(errors).toHaveLength(1);
        expect(errors[0]).toMatchObject({ requestId: 'req-s6', code: 'WORKSPACE_STATE_UNAVAILABLE' });
        expect(errors[0].message).toContain('工作区恢复失败');
        // 不切分支（失败原子性硬约束）
        expect(await readActiveTail('c1')).toBe(ids[3]);
        expect(checkpointDeleteSpy).not.toHaveBeenCalled();
    });

    test('BCP-05 存档不可恢复（preview 链断裂）→ WORKSPACE_CHECKPOINT_BROKEN，不切分支', async () => {
        const ids = await seedWithCandidates('c1');
        await bindWorkspaceCheckpoint('c1', ids[2], 'cp_ws_1');
        previewSpy.mockResolvedValue({
            success: false,
            restored: 0,
            deletedIfUnconfirmed: 0,
            skipped: 0,
            failures: [{ path: 'a.txt', reason: 'missing_in_chain' }],
        });

        await switchBranchCandidate(
            { conversationId: 'c1', nodeId: ids[2], mode: 'chat-and-workspace' },
            'req-s7',
            makeCtx()
        );

        expect(responses).toHaveLength(0);
        expect(errors).toHaveLength(1);
        expect(errors[0]).toMatchObject({ requestId: 'req-s7', code: 'WORKSPACE_CHECKPOINT_BROKEN' });
        expect(restoreSpy).not.toHaveBeenCalled();
        expect(await readActiveTail('c1')).toBe(ids[3]);
    });

    test('BCP-03 恢复可安全省略：预览无文件变更 → 跳过 restoreCheckpoint，仍返回 workspaceRestored:true', async () => {
        const ids = await seedWithCandidates('c1');
        await bindWorkspaceCheckpoint('c1', ids[2], 'cp_ws_1');
        previewSpy.mockResolvedValue({ success: true, restored: 0, deletedIfUnconfirmed: 0, skipped: 3 });

        await switchBranchCandidate(
            { conversationId: 'c1', nodeId: ids[2], mode: 'chat-and-workspace' },
            'req-s8',
            makeCtx()
        );

        expect(errors).toHaveLength(0);
        expect(restoreSpy).not.toHaveBeenCalled();
        expect(responses[0].data).toMatchObject({
            success: true,
            workspaceRestored: true,
            restoredSummary: { restored: 0, deleted: 0, skipped: 3 },
        });
        expect(await readActiveTail('c1')).toBe(ids[2]);
    });

    test('BCP-05 confirmedDiscardDirty=true：跳过 dirty 拦截并完成恢复 + 切换', async () => {
        const ids = await seedWithCandidates('c1');
        await bindWorkspaceCheckpoint('c1', ids[2], 'cp_ws_1');
        (vscode.workspace as any).workspaceFolders = [
            { name: 'ws', index: 0, uri: { fsPath: tempDir, scheme: 'file', path: tempDir } },
        ];
        (vscode.workspace as any).textDocuments = [
            { uri: { fsPath: path.join(tempDir, 'dirty.ts'), scheme: 'file' }, isDirty: true },
        ];
        previewSpy.mockResolvedValue({ success: true, restored: 1, deletedIfUnconfirmed: 0, skipped: 0 });
        restoreSpy.mockResolvedValue({ success: true, restored: 1, deleted: 0, skipped: 0 });

        await switchBranchCandidate(
            { conversationId: 'c1', nodeId: ids[2], mode: 'chat-and-workspace', confirmedDiscardDirty: true },
            'req-s9',
            makeCtx()
        );

        expect(errors).toHaveLength(0);
        expect(responses).toHaveLength(1);
        expect(responses[0].data).toMatchObject({ success: true, workspaceRestored: true });
        expect(restoreSpy).toHaveBeenCalled();
        expect(await readActiveTail('c1')).toBe(ids[2]);
    });

    test('BCP-03 目标节点不存在（chat-and-workspace）→ NODE_NOT_FOUND，不切分支', async () => {
        const ids = await seedWithCandidates('c1');

        await switchBranchCandidate(
            { conversationId: 'c1', nodeId: 'no-such-node', mode: 'chat-and-workspace' },
            'req-s10',
            makeCtx()
        );

        expect(responses).toHaveLength(0);
        expect(errors).toHaveLength(1);
        expect(errors[0]).toMatchObject({ requestId: 'req-s10', code: 'NODE_NOT_FOUND' });
        expect(await readActiveTail('c1')).toBe(ids[3]);
    });
});