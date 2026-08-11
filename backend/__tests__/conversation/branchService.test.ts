/**
 * BranchService 业务编排单测（第五阶段 BR-05/06/07/09；另覆盖 BS-2、FIX-G3（M-1/M-2/BS-3/BS-4）、TREE-09、BCP-06 行为）。
 *
 * 覆盖：
 * - BR-06：getBranchGraph / getBranchGraphMeta / saveBranchGraph（validate 闸门）/
 *   deleteConversationBranch；
 * - BR-07：createRerollCandidate / editCandidate / switchBranchCandidate / deleteBranchCandidate
 *   全部在会话写锁内（无图先建线性基线、损坏拒绝覆盖、并发串行化）；
 * - BR-05：validateActivePathMatchesHistory（主历史 id 链 vs 图活跃路径）；
 * - BR-09：createBranchConversation → metadata sourceNodeId 双写 + 新对话图（imported +
 *   exportedFrom）+ 源头图 exportedRefs；deleteConversation 级联清理 sidecar。
 *
 * 存储组合：历史走 MemoryStorageAdapter，sidecar 走真实临时目录（注入 baseDir）。
 */

import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
    ConversationManager,
} from '../../modules/conversation';
import {
    MemoryStorageAdapter,
} from '../../modules/conversation';
import type { ConversationHistory } from '../../modules/conversation';
import {
    BranchService,
    getGlobalBranchService,
    setGlobalBranchService,
} from '../../modules/conversation/branch/BranchService';
import { BranchGraphRepository } from '../../modules/conversation/branch/BranchGraphRepository';
import {
    activePath,
    childrenIndex,
    createEmptyBranchGraph,
    importLinearHistory,
    validate,
} from '../../modules/conversation/branch/BranchGraph';
import { BranchError } from '../../modules/conversation/branch/types';
// BCP-06: purge/prune 联动测试（真实 CheckpointManager 作为全局清理器自注册）
import { CheckpointManager, type CheckpointRecord } from '../../modules/checkpoint/CheckpointManager';
import { setGlobalCheckpointRefCountCleaner } from '../../modules/checkpoint/checkpointRefCounts';

/** 线性历史：root(user) → model(a1) */
function linearHistory(): ConversationHistory {
    return [
        { role: 'user', parts: [{ text: 'q1' }], timestamp: 100 },
        { role: 'model', parts: [{ text: 'a1' }], timestamp: 200 },
    ];
}

describe('BranchService', () => {
    let tempDir: string;
    let repo: BranchGraphRepository;
    let manager: ConversationManager;
    let service: BranchService;

    beforeEach(async () => {
        tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'branch-service-'));
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

    describe('读写删接口', () => {
        test('getBranchGraph：无图 → { graph: null }；save 后往返一致', async () => {
            const ids = await seedConversation('c1');
            expect((await service.getBranchGraph('c1')).graph).toBeNull();

            const baseline = createEmptyBranchGraph();
            await service.saveBranchGraph('c1', baseline);
            expect((await service.getBranchGraph('c1')).graph).toEqual(baseline);
            expect(ids).toHaveLength(2);
        });

        test('getBranchGraphMeta：无图 exists=false；建图后返回轻量摘要', async () => {
            await seedConversation('c1');
            const empty = await service.getBranchGraphMeta('c1');
            expect(empty).toMatchObject({ conversationId: 'c1', exists: false, nodeCount: 0 });

            await service.createRerollCandidate('c1', (await manager.getMessagesRaw('c1'))[1].id!, {
                parts: [{ text: 'a2' }]
            });
            const meta = await service.getBranchGraphMeta('c1');
            expect(meta.exists).toBe(true);
            expect(meta.rootNodeId).toBe((await manager.getMessagesRaw('c1'))[0].id);
            expect(meta.nodeCount).toBe(3); // root + model + reroll 候选
            expect(meta.candidateCount).toBe(1);
            expect(meta.activePathLength).toBe(3);
            expect(meta.exportedRefs).toEqual([]);
        });

        test('saveBranchGraph：结构无效抛 BRANCH_STORAGE_CORRUPT，不落盘', async () => {
            await seedConversation('c1');
            const invalid = createEmptyBranchGraph();
            invalid.nodes['x'] = { id: 'x', parentId: null, role: 'user', parts: [], kind: 'normal', createdAt: 1 };
            // rootNodeId 为 null 但已有节点 → validate 失败
            await expect(service.saveBranchGraph('c1', invalid)).rejects.toThrow(BranchError);
            await expect(service.saveBranchGraph('c1', invalid)).rejects.toMatchObject({ code: 'BRANCH_STORAGE_CORRUPT' });
            expect((await service.getBranchGraph('c1')).graph).toBeNull();
        });

        test('deleteConversationBranch：幂等删除 sidecar', async () => {
            await seedConversation('c1');
            await service.createRerollCandidate('c1', (await manager.getMessagesRaw('c1'))[1].id!, { parts: [{ text: 'a2' }] });
            expect(await repo.exists('c1')).toBe(true);
            await service.deleteConversationBranch('c1');
            expect(await repo.exists('c1')).toBe(false);
            await expect(service.deleteConversationBranch('c1')).resolves.toBeUndefined();
        });
    });

    describe('候选创建 / 编辑 / 切换 / 删除（会话写锁内）', () => {
        test('createRerollCandidate：无图先建线性基线（imported），新候选 kind=reroll 且激活，旧候选保留', async () => {
            const [userNodeId, modelNodeId] = await seedConversation('c1');
            const result = await service.createRerollCandidate('c1', modelNodeId, {
                parts: [{ text: 'a2' }],
                modelVersion: 'gemini-x'
            });

            expect(result.kind).toBe('reroll');
            expect(result.parentNodeId).toBe(modelNodeId);
            expect(result.activeTailNodeId).toBe(result.nodeId);
            expect(result.activePathIds).toEqual([userNodeId, modelNodeId, result.nodeId]);

            const graph = (await service.getBranchGraph('c1')).graph!;
            expect(validate(graph).valid).toBe(true);
            // 基线节点 kind='imported'，新候选 kind='reroll'
            expect(graph.nodes[userNodeId]!.kind).toBe('imported');
            expect(graph.nodes[modelNodeId]!.kind).toBe('imported');
            expect(graph.nodes[result.nodeId]!.kind).toBe('reroll');
            expect(graph.nodes[result.nodeId]!.modelVersion).toBe('gemini-x');
            // 旧候选仍在图中（不删除）
            expect(graph.nodes[modelNodeId]).toBeTruthy();
            // 候选摘要已写入
            expect(graph.candidateSummaries!.find(s => s.nodeId === result.nodeId)!.preview).toBe('a2');
        });

        test('多次 reroll：同一父节点下多个兄弟候选，尾指针指向最后激活的候选', async () => {
            const [, modelNodeId] = await seedConversation('c1');
            const r1 = await service.createRerollCandidate('c1', modelNodeId, { parts: [{ text: 'a2' }] });
            const r2 = await service.createRerollCandidate('c1', modelNodeId, { parts: [{ text: 'a3' }] });

            const graph = (await service.getBranchGraph('c1')).graph!;
            const children = childrenIndex(graph).get(modelNodeId)!;
            expect(children).toEqual([r1.nodeId, r2.nodeId]); // 按 createdAt 升序
            expect(graph.activeTailNodeId).toBe(r2.nodeId);
            expect(graph.nodes[r1.nodeId]).toBeTruthy();
            expect(graph.nodes[r2.nodeId]).toBeTruthy();
        });

        test('并发 reroll 在会话写锁内串行化：两个候选都成功且不丢失', async () => {
            const [, modelNodeId] = await seedConversation('c1');
            const [r1, r2] = await Promise.all([
                service.createRerollCandidate('c1', modelNodeId, { parts: [{ text: 'a2' }] }),
                service.createRerollCandidate('c1', modelNodeId, { parts: [{ text: 'a3' }] }),
            ]);
            const graph = (await service.getBranchGraph('c1')).graph!;
            expect(graph.nodes[r1.nodeId]).toBeTruthy();
            expect(graph.nodes[r2.nodeId]).toBeTruthy();
            expect(childrenIndex(graph).get(modelNodeId)).toHaveLength(2);
        });

        test('createRerollCandidate：父节点缺失 → NODE_NOT_FOUND', async () => {
            await seedConversation('c1');
            await expect(
                service.createRerollCandidate('c1', 'no-such-node', { parts: [{ text: 'x' }] })
            ).rejects.toMatchObject({ code: 'NODE_NOT_FOUND' });
        });

        test('sidecar 损坏时写操作拒绝覆盖（BRANCH_STORAGE_CORRUPT），读取降级', async () => {
            await seedConversation('c1');
            const filePath = repo.getBranchesFilePath('c1');
            await fsp.mkdir(path.dirname(filePath), { recursive: true });
            await fsp.writeFile(filePath, '{ broken json', 'utf8');

            // 读取：降级不抛错
            const loaded = await service.getBranchGraph('c1');
            expect(loaded.graph).toBeNull();
            expect(loaded.errorCode).toBe('BRANCH_STORAGE_CORRUPT');

            // 写入：拒绝覆盖
            await expect(
                service.createRerollCandidate('c1', 'whatever', { parts: [{ text: 'x' }] })
            ).rejects.toMatchObject({ code: 'BRANCH_STORAGE_CORRUPT' });
            // 原文件未被覆盖
            const raw = await fsp.readFile(filePath, 'utf8');
            expect(raw).toBe('{ broken json');
        });

        test('editCandidate：kind=edit，role=user', async () => {
            const [userNodeId] = await seedConversation('c1');
            const result = await service.editCandidate('c1', userNodeId, {
                parts: [{ text: 'q1-edited' }]
            });
            const graph = (await service.getBranchGraph('c1')).graph!;
            expect(result.kind).toBe('edit');
            expect(graph.nodes[result.nodeId]!.role).toBe('user');
            expect(graph.nodes[result.nodeId]!.parts).toEqual([{ text: 'q1-edited' }]);
            expect(validate(graph).valid).toBe(true);
        });

        test('switchBranchCandidate：切换活跃路径到旧候选（不重写主历史）', async () => {
            const [userNodeId, modelNodeId] = await seedConversation('c1');
            const r1 = await service.createRerollCandidate('c1', modelNodeId, { parts: [{ text: 'a2' }] });
            await service.createRerollCandidate('c1', modelNodeId, { parts: [{ text: 'a3' }] });
            // 当前活跃 = r2；切回 r1（路径 = root→…→目标→目标活跃子树尾，TREE-04 候选切换语义）
            const result = await service.switchBranchCandidate('c1', r1.nodeId);
            expect(result.mainHistoryRewrite).toBe(false);
            expect(result.activePathIds).toEqual([userNodeId, modelNodeId, r1.nodeId]);
            expect(result.activeTailNodeId).toBe(r1.nodeId);

            const graph = (await service.getBranchGraph('c1')).graph!;
            expect(graph.activeTailNodeId).toBe(r1.nodeId);
            expect(graph.nodes[modelNodeId]!.activeChildId).toBe(r1.nodeId);
            // 主历史保持不变（TREE-06 才重写）
            const history = await manager.getMessagesRaw('c1');
            expect(history.map(m => m.id)).toEqual([userNodeId, modelNodeId]);
        });

        test('switchBranchCandidate：目标节点缺失 → NODE_NOT_FOUND', async () => {
            await seedConversation('c1');
            await expect(service.switchBranchCandidate('c1', 'missing')).rejects.toMatchObject({
                code: 'NODE_NOT_FOUND'
            });
        });

        test('deleteBranchCandidate：软删除非活跃候选；活跃路径上的节点拒绝删除', async () => {
            const [, modelNodeId] = await seedConversation('c1');
            const r1 = await service.createRerollCandidate('c1', modelNodeId, { parts: [{ text: 'a2' }] });
            await service.createRerollCandidate('c1', modelNodeId, { parts: [{ text: 'a3' }] });

            // 删非活跃候选 r1（当前活跃是 r2）
            const result = await service.deleteBranchCandidate('c1', r1.nodeId);
            expect(result.deleted).toBe(true);
            const graph = (await service.getBranchGraph('c1')).graph!;
            expect(graph.nodes[r1.nodeId]!.deleted).toBe(true);
            expect(graph.candidateSummaries!.find(s => s.nodeId === r1.nodeId)!.deleted).toBe(true);
            expect(validate(graph).valid).toBe(true);

            // 删活跃路径上的节点（model 在活跃路径上）→ BRANCH_OPERATION_CONFLICT
            await expect(service.deleteBranchCandidate('c1', modelNodeId)).rejects.toMatchObject({
                code: 'BRANCH_OPERATION_CONFLICT'
            });
        });

        test('deleteBranchCandidate：重复删除幂等', async () => {
            const [, modelNodeId] = await seedConversation('c1');
            const r1 = await service.createRerollCandidate('c1', modelNodeId, { parts: [{ text: 'a2' }] });
            await service.createRerollCandidate('c1', modelNodeId, { parts: [{ text: 'a3' }] });
            await service.deleteBranchCandidate('c1', r1.nodeId);
            const again = await service.deleteBranchCandidate('c1', r1.nodeId);
            expect(again.deleted).toBe(true);
            expect(validate((await service.getBranchGraph('c1')).graph!).valid).toBe(true);
        });
    });

    describe('validateActivePathMatchesHistory（调试校验）', () => {
        test('无图且历史为空 → valid；无图但历史非空 → 报图缺失', async () => {
            await manager.createConversation('empty', 'T');
            const empty = await service.validateActivePathMatchesHistory('empty');
            expect(empty.valid).toBe(true);
            expect(empty.graphMissing).toBe(true);

            await manager.createConversation('has-msgs', 'T');
            await manager.addBatch('has-msgs', linearHistory());
            const missing = await service.validateActivePathMatchesHistory('has-msgs');
            expect(missing.valid).toBe(false);
            expect(missing.issues.some(i => i.includes('graph is missing'))).toBe(true);
        });

        test('线性导入后（未分支）图活跃路径 == 主历史 id 链', async () => {
            const ids = await seedConversation('c1');
            // 直接以主历史建线性基线（不触发 reroll，图活跃路径保持与主历史一致）
            const history = await manager.getMessagesRaw('c1');
            await service.saveBranchGraph('c1', importLinearHistory(history));
            const result = await service.validateActivePathMatchesHistory('c1');
            expect(result.valid).toBe(true);
            expect(result.historyIds).toEqual(ids);
            expect(result.activePathIds).toEqual(ids);
        });

        test('reroll 后图活跃路径领先主历史 → 报不匹配（TREE-06 未重写前的预期状态）', async () => {
            const ids = await seedConversation('c1');
            const reroll = await service.createRerollCandidate('c1', ids[1], { parts: [{ text: 'a2' }] });
            const result = await service.validateActivePathMatchesHistory('c1');
            expect(result.valid).toBe(false);
            expect(result.activePathIds).toEqual([ids[0], ids[1], reroll.nodeId]);
            expect(result.historyIds).toEqual([ids[0], ids[1]]);
            expect(result.issues.some(i => i.includes('length mismatch'))).toBe(true);
        });
    });

    describe('跨对话分支建模 + deleteConversation 清理', () => {
        test('createBranchConversation：metadata sourceNodeId 双写 + 新对话图 imported/exportedFrom + 源头图 exportedRefs', async () => {
            const ids = await seedConversation('source');
            const result = await manager.createBranchConversation('source', 1, { conversationId: 'target' });
            expect(result.conversationId).toBe('target');

            // ① metadata：sourceMessageIndex 保留 + sourceNodeId 双写
            const meta = await manager.getMetadata('target');
            expect(meta?.custom?.branch).toMatchObject({
                sourceConversationId: 'source',
                sourceMessageIndex: 1,
                sourceNodeId: ids[1]
            });

            // ② 新对话图：全部 kind='imported'，图元数据 exportedFrom 指向源头节点
            const targetGraph = (await service.getBranchGraph('target')).graph!;
            expect(validate(targetGraph).valid).toBe(true);
            expect(Object.values(targetGraph.nodes).every(n => n.kind === 'imported')).toBe(true);
            expect(targetGraph.exportedFrom).toEqual({ conversationId: 'source', nodeId: ids[1] });
            expect(targetGraph.rootNodeId).toBe(ids[0]);
            expect(targetGraph.activeTailNodeId).toBe(ids[1]);

            // ③ 源头图：exportedRefs 记录导出关系（无图时自动建线性基线）
            const sourceGraph = (await service.getBranchGraph('source')).graph!;
            expect(validate(sourceGraph).valid).toBe(true);
            expect(sourceGraph.exportedRefs).toEqual([
                { targetConversationId: 'target', nodeId: ids[1], exportedAt: expect.any(Number) }
            ]);
        });

        test('createBranchConversation：重复导出同一节点幂等（exportedRefs 不重复）', async () => {
            const ids = await seedConversation('source');
            await manager.createBranchConversation('source', 1, { conversationId: 'target1' });
            await manager.createBranchConversation('source', 1, { conversationId: 'target2' });
            const sourceGraph = (await service.getBranchGraph('source')).graph!;
            expect(sourceGraph.exportedRefs).toHaveLength(2);
            expect(sourceGraph.exportedRefs!.map(r => r.targetConversationId).sort()).toEqual(['target1', 'target2']);
            // 同一 sourceNodeId 被导出两次 → 两个记录（不同目标对话）
            expect(sourceGraph.exportedRefs!.every(r => r.nodeId === ids[1])).toBe(true);
        });

        test('deleteConversation：级联清理 branches.json sidecar', async () => {
            const ids = await seedConversation('c1');
            await service.createRerollCandidate('c1', ids[1], { parts: [{ text: 'a2' }] });
            expect(await repo.exists('c1')).toBe(true);

            await manager.deleteConversation('c1');
            expect(await repo.exists('c1')).toBe(false);
        });

        test('未注册全局分支服务时 createBranchConversation 不建图也不报错', async () => {
            setGlobalBranchService(undefined);
            await seedConversation('source');
            const result = await manager.createBranchConversation('source', 1, { conversationId: 'target' });
            expect(result.conversationId).toBe('target');
            // metadata 仍有 sourceNodeId（不依赖分支服务）
            const meta = await manager.getMetadata('target');
            expect((meta?.custom?.branch as { sourceNodeId?: string } | undefined)?.sourceNodeId).toBeTruthy();
            // 但无分支图（未注册服务 → 跳过）
            expect((await service.getBranchGraph('target')).graph).toBeNull();
            expect((await service.getBranchGraph('source')).graph).toBeNull();
        });
    });

    describe('复查修复（M-1/M-2/BS-3/BS-4）', () => {
        test('getBranchGraphMeta：sidecar 损坏（解析失败）→ exists:false + corrupted:true + errorCode（M-1）', async () => {
            await seedConversation('c1');
            const filePath = repo.getBranchesFilePath('c1');
            await fsp.mkdir(path.dirname(filePath), { recursive: true });
            await fsp.writeFile(filePath, '{ broken json', 'utf8');

            const meta = await service.getBranchGraphMeta('c1');
            expect(meta.exists).toBe(false);
            expect(meta.corrupted).toBe(true);
            expect(meta.errorCode).toBe('BRANCH_STORAGE_CORRUPT');
            expect(meta.nodeCount).toBe(0);
        });

        test('getBranchGraph/getBranchGraphMeta：语义损坏（可解析但结构无效）→ errorCode，写操作拒绝覆盖（M-2）', async () => {
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

            // 读取侧：整图降级 + 元信息降级（均带 errorCode）
            const loaded = await service.getBranchGraph('c1');
            expect(loaded.graph).toBeNull();
            expect(loaded.errorCode).toBe('BRANCH_STORAGE_CORRUPT');
            expect(loaded.errorMessage).toContain('semantic validation failed');

            const meta = await service.getBranchGraphMeta('c1');
            expect(meta.exists).toBe(false);
            expect(meta.corrupted).toBe(true);
            expect(meta.errorCode).toBe('BRANCH_STORAGE_CORRUPT');

            // 写路径：拒绝覆盖（与解析损坏同策略），原文件保持原样
            await expect(service.createRerollCandidate('c1', 'root', { parts: [{ text: 'x' }] }))
                .rejects.toMatchObject({ code: 'BRANCH_STORAGE_CORRUPT' });
            expect(JSON.parse(await fsp.readFile(filePath, 'utf8'))).toEqual(invalidGraph);
            expect(ids).toHaveLength(2);
        });

        test('BS-3：createRerollCandidate/editCandidate 父节点不在活跃路径 → BRANCH_OPERATION_CONFLICT', async () => {
            const ids = await seedConversation('c1');
            const r1 = await service.createRerollCandidate('c1', ids[1], { parts: [{ text: 'a2' }] });
            await service.createRerollCandidate('c1', ids[1], { parts: [{ text: 'a3' }] });
            // r1 已不在活跃路径（活跃 = [U, M, r2]）
            await expect(service.createRerollCandidate('c1', r1.nodeId, { parts: [{ text: 'x' }] }))
                .rejects.toMatchObject({ code: 'BRANCH_OPERATION_CONFLICT' });
            await expect(service.editCandidate('c1', r1.nodeId, { parts: [{ text: 'y' }] }))
                .rejects.toMatchObject({ code: 'BRANCH_OPERATION_CONFLICT' });
            // 父节点缺失仍为 NODE_NOT_FOUND（既有语义不破坏）
            await expect(service.createRerollCandidate('c1', 'ghost', { parts: [] }))
                .rejects.toMatchObject({ code: 'NODE_NOT_FOUND' });
        });

        test('BS-4：已删除会话拒绝分支写入，迟到写不重建 sidecar', async () => {
            const ids = await seedConversation('c1');
            await service.createRerollCandidate('c1', ids[1], { parts: [{ text: 'a2' }] });
            expect(await repo.exists('c1')).toBe(true);

            await manager.deleteConversation('c1');
            expect(await repo.exists('c1')).toBe(false);

            await expect(service.createRerollCandidate('c1', ids[1], { parts: [{ text: 'late' }] }))
                .rejects.toMatchObject({ code: 'BRANCH_OPERATION_CONFLICT' });
            await expect(service.saveBranchGraph('c1', createEmptyBranchGraph()))
                .rejects.toMatchObject({ code: 'BRANCH_OPERATION_CONFLICT' });
            await expect(service.recordExport('c1', 'target', ids[0]))
                .rejects.toMatchObject({ code: 'BRANCH_OPERATION_CONFLICT' });
            expect(await repo.exists('c1')).toBe(false);
        });

        test('BS-4：recordExport 在源会话历史为空时不保存空图', async () => {
            await manager.createConversation('empty-src', 'T');
            await service.recordExport('empty-src', 'target', 'any-node');
            expect(await repo.exists('empty-src')).toBe(false);
            expect((await service.getBranchGraph('empty-src')).graph).toBeNull();
        });
    });

    describe('appendHistoryToGraph（方法级，调用点后续接线）', () => {
        test('无分支图 → 返回 false 且不建 sidecar（线性对话未建图不强制建）', async () => {
            const ids = await seedConversation('c1');
            expect(await repo.exists('c1')).toBe(false);

            const result = await service.appendHistoryToGraph('c1', [
                { role: 'user', parts: [{ text: 'q2' }], id: 'u2', timestamp: 300 },
            ] as any);
            expect(result).toBe(false);
            expect(await repo.exists('c1')).toBe(false);
            // 空数组直接返回 false，不触碰存储
            expect(await service.appendHistoryToGraph('c1', [])).toBe(false);
            expect(ids).toHaveLength(2);
        });

        test('有图：逐条 insertNode 并入活跃路径，functionResponse 合并，validate 通过', async () => {
            const ids = await seedConversation('c1');
            const created = await service.createRerollCandidate('c1', ids[1], { parts: [{ text: 'a2' }] });
            // 活跃路径 = [U, M, R]
            const tail = created.nodeId;

            const result = await service.appendHistoryToGraph('c1', [
                { role: 'user', parts: [{ text: 'q2' }], id: 'u2', timestamp: 300 },
                { role: 'model', parts: [{ text: 'a3' }, { functionCall: { id: 't1', name: 'read_file', args: {} } }], id: 'm3', timestamp: 400, modelVersion: 'gemini-x' },
                { role: 'user', parts: [{ functionResponse: { id: 't1', name: 'read_file', response: { success: true } } }], id: 'fr1', timestamp: 500, isFunctionResponse: true },
            ] as any);
            expect(result).toBe(true);

            const graph = (await service.getBranchGraph('c1')).graph!;
            expect(validate(graph).valid).toBe(true);
            // 新节点挂在旧活跃尾之后；functionResponse 不独立成节点（决策 8）
            expect(graph.nodes['u2']!.parentId).toBe(tail);
            expect(graph.nodes['m3']!.parentId).toBe('u2');
            expect(graph.nodes['fr1']).toBeUndefined();
            expect(graph.nodes['m3']!.parts).toHaveLength(3); // 文本 + functionCall + 合并的 functionResponse
            expect(graph.nodes['m3']!.parts![2]).toMatchObject({ functionResponse: { id: 't1' } });
            expect(graph.activeTailNodeId).toBe('m3');
            expect(activePath(graph)).toEqual([ids[0], ids[1], tail, 'u2', 'm3']);
        });

        test('已删除会话 → BRANCH_OPERATION_CONFLICT，sidecar 不重建（BS-4）', async () => {
            const ids = await seedConversation('c1');
            await service.createRerollCandidate('c1', ids[1], { parts: [{ text: 'a2' }] });
            await manager.deleteConversation('c1');

            await expect(service.appendHistoryToGraph('c1', [
                { role: 'user', parts: [{ text: 'x' }], id: 'x1', timestamp: 1 },
            ] as any)).rejects.toMatchObject({ code: 'BRANCH_OPERATION_CONFLICT' });
            expect(await repo.exists('c1')).toBe(false);
        });

        test('语义损坏图 → appendHistoryToGraph 拒绝（BRANCH_STORAGE_CORRUPT），原文件不被覆盖（M-2）', async () => {
            const ids = await seedConversation('c1');
            const filePath = repo.getBranchesFilePath('c1');
            await fsp.mkdir(path.dirname(filePath), { recursive: true });
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

            await expect(service.appendHistoryToGraph('c1', [
                { role: 'user', parts: [{ text: 'x' }], id: 'x1', timestamp: 1 },
            ] as any)).rejects.toMatchObject({ code: 'BRANCH_STORAGE_CORRUPT' });
            expect(JSON.parse(await fsp.readFile(filePath, 'utf8'))).toEqual(invalidGraph);
            expect(ids).toHaveLength(2);
        });
    });

    describe('旧 sidecar 与主历史对账修复', () => {
        test('遗留空占位导致漏同步：先备份，再追平当前路径，旧候选仍保留', async () => {
            const [userNodeId, modelNodeId] = await seedConversation('c1');
            const oldCandidate = await service.createRerollCandidate('c1', userNodeId, { parts: [] });

            // 模拟旧缺陷：已结束的空 reroll 仍在活跃尾，主历史追加成功但 sidecar 静默停更。
            await manager.addBatch('c1', [
                { role: 'user', parts: [{ text: 'q2' }], timestamp: 300 },
                { role: 'model', parts: [{ text: 'a2' }], timestamp: 400 },
            ]);
            const historyIds = (await manager.getMessagesRaw('c1')).map(message => message.id!);

            const result = await service.ensureMainHistoryRepresentedInGraph('c1');
            expect(result).toMatchObject({
                created: false,
                reconciled: true,
                missingMessageCount: 2,
            });
            expect(result.backupPath).toBeTruthy();

            const graph = (await service.getBranchGraph('c1')).graph!;
            expect(activePath(graph)).toEqual(historyIds);
            expect(graph.nodes[oldCandidate.nodeId]).toBeDefined();
            expect(graph.nodes[modelNodeId]!.activeChildId).toBe(historyIds[2]);
            expect(validate(graph).valid).toBe(true);

            const backup = JSON.parse(await fsp.readFile(result.backupPath!, 'utf8'));
            expect(backup.nodes[oldCandidate.nodeId]).toBeDefined();
            expect(backup.activeTailNodeId).toBe(oldCandidate.nodeId);

            // 第二次对账幂等：不重写、不再制造备份。
            await expect(service.ensureMainHistoryRepresentedInGraph('c1')).resolves.toEqual({
                created: false,
                reconciled: false,
                missingMessageCount: 0,
                unsyncedFunctionResponseCount: 0,
            });
            expect(userNodeId).toBe(historyIds[0]);
        });

        test('切换前发现漏同步即拒绝，activeTail 不发生变化', async () => {
            const [, modelNodeId] = await seedConversation('c1');
            const first = await service.createRerollCandidate('c1', modelNodeId, { parts: [{ text: 'a2' }] });
            const second = await service.createRerollCandidate('c1', modelNodeId, { parts: [{ text: 'a3' }] });
            setGlobalBranchService(undefined);
            await manager.addBatch('c1', [{ role: 'user', parts: [{ text: 'unsynced' }], timestamp: 500 }]);
            setGlobalBranchService(service);

            await expect(service.switchBranchCandidate('c1', first.nodeId)).rejects.toMatchObject({
                code: 'BRANCH_OPERATION_CONFLICT',
            });
            expect((await service.getBranchGraph('c1')).graph!.activeTailNodeId).toBe(second.nodeId);
        });
    });

    describe('逻辑总结结构同步', () => {
        test('已有分支图立即同步总结节点与标记，切出再切回不会丢总结语义', async () => {
            await manager.createConversation('c1', 'T');
            await manager.addBatch('c1', [
                { role: 'user', parts: [{ text: 'q1' }], timestamp: 100, isUserInput: true },
                { role: 'model', parts: [{ text: 'a1' }], timestamp: 200 },
                { role: 'user', parts: [{ text: 'q2' }], timestamp: 300, isUserInput: true },
                { role: 'model', parts: [{ text: 'a2' }], timestamp: 400 },
            ]);
            await service.ensureBranchGraph('c1');
            const before = await manager.getMessagesRaw('c1');
            const [u1, m1, u2, m2] = before.map(message => message.id!);

            await manager.getTranscriptRepository('c1').mutateContents(history => {
                history[1] = { ...history[1], isSummarized: true };
                history.splice(2, 0, {
                    role: 'user',
                    parts: [{ text: 'summary' }],
                    id: 'sum-1',
                    parentId: m1,
                    isSummary: true,
                    isAutoSummary: true,
                    summarizedMessageCount: 1,
                    summaryTokenStats: {
                        sourceTokenCount: 100,
                        summaryTokenCount: 20,
                        estimatedTokensSaved: 80,
                    },
                });
                history[3] = { ...history[3], parentId: 'sum-1' };
                return history.slice();
            });

            await expect(service.syncMainHistoryAfterStructuralMutation('c1', 'summary_inserted'))
                .resolves.toEqual({ synced: true, deferred: false });
            const syncedGraph = (await service.getBranchGraph('c1')).graph!;
            expect(activePath(syncedGraph)).toEqual([u1, m1, 'sum-1', u2, m2]);
            expect(syncedGraph.nodes[m1]!.contentMetadata?.isSummarized).toBe(true);
            expect(syncedGraph.nodes['sum-1']!.contentMetadata).toMatchObject({
                isSummary: true,
                isAutoSummary: true,
                summarizedMessageCount: 1,
                summaryTokenStats: { estimatedTokensSaved: 80 },
            });

            // 先切到同父的另一回答并重写主历史，再切回总结路径，验证图→历史往返字段。
            const alternative = await service.createRerollCandidate('c1', u2, { parts: [{ text: 'alt' }] });
            await manager.rewriteHistoryFromBranchGraph('c1');
            const alternativeHistory = await manager.getMessagesRaw('c1');
            expect(alternativeHistory[alternativeHistory.length - 1]?.id).toBe(alternative.nodeId);
            await service.switchBranchCandidate('c1', m2);
            await manager.rewriteHistoryFromBranchGraph('c1');

            const restored = await manager.getMessagesRaw('c1');
            expect(restored.map(message => message.id)).toEqual([u1, m1, 'sum-1', u2, m2]);
            expect(restored.find(message => message.id === m1)?.isSummarized).toBe(true);
            expect(restored.find(message => message.id === 'sum-1')).toMatchObject({
                isSummary: true,
                isAutoSummary: true,
                summarizedMessageCount: 1,
                summaryTokenStats: { estimatedTokensSaved: 80 },
            });
        });

        test('线性会话不因总结强制创建 sidecar；活动空候选期间延迟同步', async () => {
            const [, modelNodeId] = await seedConversation('linear');
            await expect(service.syncMainHistoryAfterStructuralMutation('linear', 'summary_inserted'))
                .resolves.toEqual({ synced: false, deferred: false });
            expect((await service.getBranchGraph('linear')).graph).toBeNull();

            const started = await service.startReroll('linear', modelNodeId);
            await expect(service.syncMainHistoryAfterStructuralMutation('linear', 'summary_inserted'))
                .resolves.toEqual({ synced: false, deferred: true });
            // 清理测试中的进行中占位，验证空结果终态仍可正常收敛。
            await expect(service.finishReroll('linear', started.candidateNodeId))
                .resolves.toMatchObject({ discardedEmptyCandidate: true });
        });

        test('活动候选期间延迟的总结在 finishReroll 后完整收敛', async () => {
            await manager.createConversation('c1', 'T');
            await manager.addBatch('c1', [
                { role: 'user', parts: [{ text: 'q1' }], timestamp: 100, isUserInput: true },
                { role: 'model', parts: [{ text: 'a1' }], timestamp: 200 },
                { role: 'user', parts: [{ text: 'q2' }], timestamp: 300, isUserInput: true },
                { role: 'model', parts: [{ text: 'a2' }], timestamp: 400 },
            ]);
            const original = await manager.getMessagesRaw('c1');
            const [u1, m1, u2, m2] = original.map(message => message.id!);
            const started = await service.startReroll('c1', m2);

            // 模拟模型请求前自动总结：总结插在最后真实 user（u2）之前，因此不属于候选输出尾。
            await manager.getTranscriptRepository('c1').mutateContents(history => {
                history[1] = { ...history[1], isSummarized: true };
                history.splice(2, 0, {
                    role: 'user',
                    parts: [{ text: 'summary during reroll' }],
                    id: 'sum-during-reroll',
                    parentId: m1,
                    isSummary: true,
                    isAutoSummary: true,
                });
                history[3] = { ...history[3], parentId: 'sum-during-reroll' };
                return history.slice();
            });
            await expect(service.syncMainHistoryAfterStructuralMutation('c1', 'summary_inserted'))
                .resolves.toEqual({ synced: false, deferred: true });

            const persisted = await manager.addContent('c1', {
                role: 'model',
                parts: [{ text: 'new a2' }],
                timestamp: 500,
            });
            const finished = await service.finishReroll('c1', started.candidateNodeId);
            expect(finished.discardedEmptyCandidate).toBe(false);

            const graph = (await service.getBranchGraph('c1')).graph!;
            expect(activePath(graph)).toEqual([u1, m1, 'sum-during-reroll', u2, persisted!.id!]);
            expect(graph.nodes[m1]!.contentMetadata?.isSummarized).toBe(true);
            expect(graph.nodes['sum-during-reroll']!.contentMetadata).toMatchObject({
                isSummary: true,
                isAutoSummary: true,
            });
            expect(graph.nodes[m2]).toBeDefined(); // 旧回答仍是可切回候选
            expect(validate(graph).valid).toBe(true);
        });
    });

    describe('软删 / 恢复 / 重命名 / 修剪 / 保留期', () => {
        /** 建会话 + 两个 reroll 候选，返回 [user, model, r1, r2] */
        async function seedCandidates(conversationId: string): Promise<string[]> {
            const ids = await seedConversation(conversationId);
            const r1 = await service.createRerollCandidate(conversationId, ids[1], { parts: [{ text: 'a2' }] });
            const r2 = await service.createRerollCandidate(conversationId, ids[1], { parts: [{ text: 'a3' }] });
            return [ids[0], ids[1], r1.nodeId, r2.nodeId];
        }

        test('deleteBranchCandidate 软删带 deletedAt；meta.deletedCount 统计软删节点', async () => {
            const ids = await seedCandidates('c1');
            await service.deleteBranchCandidate('c1', ids[2]);
            const graph = (await service.getBranchGraph('c1')).graph!;
            expect(graph.nodes[ids[2]]!.deleted).toBe(true);
            expect(typeof graph.nodes[ids[2]]!.deletedAt).toBe('number');
            expect(graph.candidateSummaries!.find(s => s.nodeId === ids[2])!.deleted).toBe(true);
            expect(typeof graph.candidateSummaries!.find(s => s.nodeId === ids[2])!.deletedAt).toBe('number');
            expect(validate(graph).valid).toBe(true);

            const meta = await service.getBranchGraphMeta('c1');
            expect(meta.deletedCount).toBe(1);
            // 重复删除幂等：deletedAt 保持首次删除时间
            await service.deleteBranchCandidate('c1', ids[2]);
            const again = (await service.getBranchGraph('c1')).graph!;
            expect(again.nodes[ids[2]]!.deletedAt).toBe(graph.nodes[ids[2]]!.deletedAt);
        });

        test('restoreBranchCandidate：恢复后 deleted/deletedAt 清除；未删除幂等；缺失 NODE_NOT_FOUND', async () => {
            const ids = await seedCandidates('c1');
            await service.deleteBranchCandidate('c1', ids[2]);
            const restored = await service.restoreBranchCandidate('c1', ids[2]);
            expect(restored.restored).toBe(true);
            const graph = (await service.getBranchGraph('c1')).graph!;
            expect(graph.nodes[ids[2]]!.deleted).toBeUndefined();
            expect(graph.nodes[ids[2]]!.deletedAt).toBeUndefined();
            expect(graph.candidateSummaries!.find(s => s.nodeId === ids[2])!.deleted).toBeUndefined();
            expect(validate(graph).valid).toBe(true);

            const noop = await service.restoreBranchCandidate('c1', ids[2]);
            expect(noop.restored).toBe(false);
            await expect(service.restoreBranchCandidate('c1', 'ghost')).rejects.toMatchObject({ code: 'NODE_NOT_FOUND' });
        });

        test('renameBranchCandidate：只改 label（节点 + 摘要同步），contents 不动', async () => {
            const ids = await seedCandidates('c1');
            const result = await service.renameBranchCandidate('c1', ids[2], '  分支 A  ');
            expect(result.label).toBe('分支 A');
            const graph = (await service.getBranchGraph('c1')).graph!;
            expect(graph.nodes[ids[2]]!.label).toBe('分支 A');
            expect(graph.candidateSummaries!.find(s => s.nodeId === ids[2])!.label).toBe('分支 A');
            expect(graph.nodes[ids[2]]!.parts).toEqual([{ text: 'a2' }]);
            expect(validate(graph).valid).toBe(true);

            await expect(service.renameBranchCandidate('c1', ids[2], '   ')).rejects.toMatchObject({ code: 'INVALID_BRANCH_RELATION' });
            await expect(service.renameBranchCandidate('c1', ids[2], 'x'.repeat(201))).rejects.toMatchObject({ code: 'INVALID_BRANCH_RELATION' });
            await expect(service.renameBranchCandidate('c1', 'ghost', 'x')).rejects.toMatchObject({ code: 'NODE_NOT_FOUND' });
        });

        test('purgeBranchCandidate：未软删 → 冲突；软删后物理移除节点+子树+摘要', async () => {
            const ids = await seedCandidates('c1');
            // 给 r1 挂一个续接子树（b 下有子节点），一并物理清理
            const graph0 = (await service.getBranchGraph('c1')).graph!;
            await service.switchBranchCandidate('c1', ids[2]); // 切到 r1
            await service.appendHistoryToGraph('c1', [
                { role: 'user', parts: [{ text: 'q2' }], id: 'u-sub', timestamp: 300 },
                { role: 'model', parts: [{ text: 'a-sub' }], id: 'm-sub', timestamp: 400 },
            ] as any);
            expect(graph0).toBeTruthy();

            await expect(service.purgeBranchCandidate('c1', ids[2])).rejects.toMatchObject({ code: 'BRANCH_OPERATION_CONFLICT' });

            // 切回 r2 使 r1 及其子树变为非活跃，然后软删 + 彻底删
            await service.switchBranchCandidate('c1', ids[3]);
            await service.deleteBranchCandidate('c1', ids[2]);
            const purged = await service.purgeBranchCandidate('c1', ids[2]);
            expect(purged.purged).toBe(true);
            expect(purged.prunedNodeCount).toBeGreaterThanOrEqual(3); // r1 + u-sub + m-sub

            const graph = (await service.getBranchGraph('c1')).graph!;
            expect(graph.nodes[ids[2]]).toBeUndefined();
            expect(graph.nodes['u-sub']).toBeUndefined();
            expect(graph.nodes['m-sub']).toBeUndefined();
            expect(graph.candidateSummaries!.find(s => s.nodeId === ids[2])).toBeUndefined();
            expect(validate(graph).valid).toBe(true);
            // R8c-P7：节点不存在 → 幂等返回 purged:false（不再抛 NODE_NOT_FOUND）
            const ghost = await service.purgeBranchCandidate('c1', 'ghost');
            expect(ghost).toEqual({ nodeId: 'ghost', purged: false, prunedNodeCount: 0 });
        });

        test('getDeletedBranchCount：单会话 + 全量扫描', async () => {
            const ids1 = await seedCandidates('c1');
            const ids2 = await seedCandidates('c2');
            // r1 均为非活跃候选（r2 是活跃的，不能删）
            await service.deleteBranchCandidate('c1', ids1[2]);
            await service.deleteBranchCandidate('c2', ids2[2]);

            const single = await service.getDeletedBranchCount({ conversationId: 'c1' });
            expect(single).toEqual({ conversationCount: 1, deletedNodeCount: 1 });
            const all = await service.getDeletedBranchCount();
            expect(all).toEqual({ conversationCount: 2, deletedNodeCount: 2 });
        });

        test('R8c-P4：getDeletedBranchCount 忽略孤儿 sidecar（与 prune 的 skippedConversations 同口径）', async () => {
            const ids = await seedCandidates('c1');
            await service.deleteBranchCandidate('c1', ids[2]);
            // c2：有 sidecar 但会话不存在（孤儿，如外部复制/残留）——不建会话，直接落 sidecar
            await repo.save('c2', importLinearHistory([
                { role: 'user', parts: [{ text: 'q' }], timestamp: 1 },
            ]));
            // 孤儿 sidecar 中标记一个软删节点（旧行为会把它计入，清理后数量不归零）
            const raw = JSON.parse(await fsp.readFile(repo.getBranchesFilePath('c2'), 'utf8'));
            const rootId = raw.rootNodeId;
            raw.nodes[rootId] = { ...raw.nodes[rootId], deleted: true, deletedAt: Date.now() };
            await fsp.writeFile(repo.getBranchesFilePath('c2'), JSON.stringify(raw), 'utf8');

            const all = await service.getDeletedBranchCount();
            expect(all).toEqual({ conversationCount: 1, deletedNodeCount: 1 }); // 只统计真实会话 c1
            const orphanOnly = await service.getDeletedBranchCount({ conversationId: 'c2' });
            expect(orphanOnly).toEqual({ conversationCount: 0, deletedNodeCount: 0 });
        });

        test('R8c-P1：激活续聊 → 切走 → 软删分支头级联软删子孙 → prune 不丢失内容；restore 级联恢复子树完整', async () => {
            const ids = await seedCandidates('c1'); // [user, model, r1, r2]
            // 1. 激活 r1 续聊：r1 下追加 live 子孙 u-sub / m-sub（候选 C 曾被激活续聊）
            await service.switchBranchCandidate('c1', ids[2]);
            await service.appendHistoryToGraph('c1', [
                { role: 'user', parts: [{ text: 'q2' }], id: 'u-sub', timestamp: 300 },
                { role: 'model', parts: [{ text: 'a-sub' }], id: 'm-sub', timestamp: 400 },
            ] as any);
            // 2. 切走（r2 激活）→ r1 子树整体非活跃
            await service.switchBranchCandidate('c1', ids[3]);
            // 3. 软删分支头 r1：级联软删整棵子树（不再留下 live 子孙被 prune 静默物理移除）
            await service.deleteBranchCandidate('c1', ids[2]);
            let graph = (await service.getBranchGraph('c1')).graph!;
            expect(graph.nodes[ids[2]]!.deleted).toBe(true);
            expect(graph.nodes['u-sub']!.deleted).toBe(true);
            expect(graph.nodes['m-sub']!.deleted).toBe(true);
            // 内容不丢失：软删期间节点 parts 完整保留（可整体恢复）
            expect(graph.nodes['m-sub']!.parts).toEqual([{ text: 'a-sub' }]);
            expect(graph.nodes['u-sub']!.parts).toEqual([{ text: 'q2' }]);
            expect(validate(graph).valid).toBe(true);

            // 4. restore 级联恢复：整棵子树完整（含续接内容）
            const restored = await service.restoreBranchCandidate('c1', ids[2]);
            expect(restored.restored).toBe(true);
            graph = (await service.getBranchGraph('c1')).graph!;
            expect(graph.nodes[ids[2]]!.deleted).toBeUndefined();
            expect(graph.nodes['u-sub']!.deleted).toBeUndefined();
            expect(graph.nodes['m-sub']!.deleted).toBeUndefined();
            expect(graph.nodes['m-sub']!.parts).toEqual([{ text: 'a-sub' }]);
            expect(validate(graph).valid).toBe(true);

            // 5. 再次软删 → 拨过期 → prune 物理清理整棵子树（软删期内内容可恢复，prune 后才不可恢复）
            await service.deleteBranchCandidate('c1', ids[2]);
            const past = Date.now() - 31 * 24 * 60 * 60 * 1000;
            const filePath = repo.getBranchesFilePath('c1');
            const raw = JSON.parse(await fsp.readFile(filePath, 'utf8'));
            raw.nodes[ids[2]].deletedAt = past;
            raw.nodes['u-sub'].deletedAt = past;
            raw.nodes['m-sub'].deletedAt = past;
            await fsp.writeFile(filePath, JSON.stringify(raw), 'utf8');
            const pruned = await service.pruneDeletedBranches({ conversationId: 'c1', retentionDays: 30, now: Date.now() });
            expect(pruned.prunedNodeCount).toBe(3); // r1 + u-sub + m-sub
            graph = (await service.getBranchGraph('c1')).graph!;
            expect(graph.nodes[ids[2]]).toBeUndefined();
            expect(graph.nodes['u-sub']).toBeUndefined();
            expect(graph.nodes['m-sub']).toBeUndefined();
            expect(graph.nodes[ids[3]]).toBeTruthy();
            expect(validate(graph).valid).toBe(true);
        });

        test('R8c-P2：切换到软删祖先的 live 子孙（遗留数据）→ BRANCH_OPERATION_CONFLICT，不落盘', async () => {
            const ids = await seedCandidates('c1'); // [user, model, r1, r2]
            // 构造 live 子孙：激活 r1 续聊
            await service.switchBranchCandidate('c1', ids[2]);
            await service.appendHistoryToGraph('c1', [
                { role: 'user', parts: [{ text: 'q2' }], id: 'u-sub', timestamp: 300 },
                { role: 'model', parts: [{ text: 'a-sub' }], id: 'm-sub', timestamp: 400 },
            ] as any);
            // 切走 → r1 非活跃；手工把分支头 r1 标记为软删（模拟级联软删落地前的旧数据：父被软删、子仍 live）
            await service.switchBranchCandidate('c1', ids[3]);
            const filePath = repo.getBranchesFilePath('c1');
            const raw = JSON.parse(await fsp.readFile(filePath, 'utf8'));
            raw.nodes[ids[2]] = { ...raw.nodes[ids[2]], deleted: true, deletedAt: Date.now() };
            await fsp.writeFile(filePath, JSON.stringify(raw), 'utf8');

            // 目标 u-sub 自身 live，但其 parentId 链上 r1 已软删 → 业务冲突（非损坏）
            await expect(service.switchBranchCandidate('c1', 'u-sub'))
                .rejects.toMatchObject({ code: 'BRANCH_OPERATION_CONFLICT' });
            // 目标自身已软删同样冲突
            await expect(service.switchBranchCandidate('c1', ids[2]))
                .rejects.toMatchObject({ code: 'BRANCH_OPERATION_CONFLICT' });
            // 冲突时不得落盘：sidecar 仍保持手工标记的状态（无 validateAndSave 覆盖）
            const after = JSON.parse(await fsp.readFile(filePath, 'utf8'));
            expect(after.nodes[ids[2]].deleted).toBe(true);
            expect(after.nodes['u-sub'].deleted).toBeUndefined();
        });

        test('R8c-P6：重复删除幂等路径不落盘（sidecar 不被重写）', async () => {
            const ids = await seedCandidates('c1');
            await service.deleteBranchCandidate('c1', ids[2]); // 首次：真实落盘
            const saveSpy = jest.spyOn(repo, 'save');
            const again = await service.deleteBranchCandidate('c1', ids[2]); // 幂等：图未变化
            expect(again).toMatchObject({ nodeId: ids[2], deleted: true });
            expect(saveSpy).not.toHaveBeenCalled();
            saveSpy.mockRestore();
        });

        test('pruneDeletedBranches：过期软删（含子树）物理清理；未过期保留；now 可控', async () => {
            const ids = await seedCandidates('c1');
            // r1 下挂续接子树
            await service.switchBranchCandidate('c1', ids[2]);
            await service.appendHistoryToGraph('c1', [
                { role: 'user', parts: [{ text: 'q2' }], id: 'u-sub', timestamp: 300 },
            ] as any);
            await service.switchBranchCandidate('c1', ids[3]);
            await service.deleteBranchCandidate('c1', ids[2]);

            const past = Date.now() - 31 * 24 * 60 * 60 * 1000;
            // 未过期：now = 当前时间，retentionDays = 30 → 保留
            const keep = await service.pruneDeletedBranches({ conversationId: 'c1', retentionDays: 30, now: Date.now() });
            expect(keep.prunedNodeCount).toBe(0);
            expect(keep.conversationsChanged).toBe(0);
            // 过期：直接改 sidecar 把 deletedAt 拨到 31 天前（服务端 delete 用 Date.now()，这里模拟旧删除）
            const filePath = repo.getBranchesFilePath('c1');
            const graph = JSON.parse(await fsp.readFile(filePath, 'utf8'));
            graph.nodes[ids[2]].deletedAt = past;
            await fsp.writeFile(filePath, JSON.stringify(graph), 'utf8');

            const pruned = await service.pruneDeletedBranches({ conversationId: 'c1', retentionDays: 30, now: Date.now() });
            expect(pruned.conversationsScanned).toBe(1);
            expect(pruned.conversationsChanged).toBe(1);
            expect(pruned.prunedNodeCount).toBeGreaterThanOrEqual(2); // r1 + u-sub
            const after = (await service.getBranchGraph('c1')).graph!;
            expect(after.nodes[ids[2]]).toBeUndefined();
            expect(after.nodes['u-sub']).toBeUndefined();
            expect(after.nodes[ids[3]]).toBeTruthy();
            expect(after.candidateSummaries!.find(s => s.nodeId === ids[2])).toBeUndefined();
            expect(validate(after).valid).toBe(true);
        });

        test('pruneDeletedBranches：损坏 sidecar 跳过（不覆盖），无会话的孤儿 sidecar 跳过', async () => {
            const ids = await seedCandidates('c1');
            await seedCandidates('c2');
            await service.deleteBranchCandidate('c1', ids[2]);
            // c2 sidecar 损坏
            const filePath = repo.getBranchesFilePath('c2');
            await fsp.mkdir(path.dirname(filePath), { recursive: true });
            await fsp.writeFile(filePath, '{ broken json', 'utf8');
            // c3：有 sidecar 但会话不存在（孤儿，如外部复制/残留）——不建会话，直接落 sidecar
            await repo.save('c3', importLinearHistory([
                { role: 'user', parts: [{ text: 'q' }], timestamp: 1 },
            ]));

            const result = await service.pruneDeletedBranches({ retentionDays: 0 });
            expect(result.corruptConversations).toEqual(['c2']);
            expect(result.skippedConversations).toEqual(['c3']);
            expect(result.conversationsScanned).toBe(3);
            expect(result.prunedNodeCount).toBe(0);
            // 损坏文件未被覆盖
            expect(await fsp.readFile(filePath, 'utf8')).toBe('{ broken json');
        });

        test('保留期配置：默认 30；update 持久化并回读；非法值抛 INVALID_BRANCH_RELATION', async () => {
            expect(await service.getBranchRetentionConfig()).toEqual({ retentionDays: 30 });
            expect(await service.updateBranchRetentionConfig(7)).toEqual({ retentionDays: 7 });
            expect(await service.getBranchRetentionConfig()).toEqual({ retentionDays: 7 });
            await expect(service.updateBranchRetentionConfig(-1)).rejects.toMatchObject({ code: 'INVALID_BRANCH_RELATION' });
            await expect(service.updateBranchRetentionConfig(1.5)).rejects.toMatchObject({ code: 'INVALID_BRANCH_RELATION' });
        });

        test('pruneDeletedBranches 使用持久化保留期（未显式传 retentionDays）', async () => {
            const ids = await seedCandidates('c1');
            await service.deleteBranchCandidate('c1', ids[2]);
            // 保留期调成 0（永不过期）→ prune 不清理
            await service.updateBranchRetentionConfig(0);
            const result = await service.pruneDeletedBranches({ conversationId: 'c1' });
            expect(result.prunedNodeCount).toBe(0);
            // 显式传 1 天 + now 拨到 31 天前 → 过期
            const graph = JSON.parse(await fsp.readFile(repo.getBranchesFilePath('c1'), 'utf8'));
            graph.nodes[ids[2]].deletedAt = Date.now() - 31 * 24 * 60 * 60 * 1000;
            await fsp.writeFile(repo.getBranchesFilePath('c1'), JSON.stringify(graph), 'utf8');
            const pruned = await service.pruneDeletedBranches({ conversationId: 'c1', retentionDays: 1, now: Date.now() });
            expect(pruned.prunedNodeCount).toBe(1);
        });
    });

    describe('clearHistory / restoreSnapshot 图同步（forceResetToEmpty / rebase 接线）', () => {
        test('clearHistory 整体清空：forceResetToEmpty 空图；新 append 后图以新根重建，不挂旧根/旧尾', async () => {
            const ids = await seedConversation('c1');
            await service.createRerollCandidate('c1', ids[1], { parts: [{ text: 'a2' }] });
            expect((await service.getBranchGraph('c1')).graph!.rootNodeId).toBe(ids[0]);

            // 清空主历史（内部接线 global BranchService → syncGraphAfterHistoryDelete forceResetToEmpty）
            await manager.clearHistory('c1');
            expect(await manager.getMessagesRaw('c1')).toEqual([]);
            const cleared = (await service.getBranchGraph('c1')).graph!;
            expect(cleared.rootNodeId).toBeNull();
            expect(cleared.activeTailNodeId).toBeNull();
            expect(cleared.nodes).toEqual({});
            expect(cleared.activeChildId).toBeNull();
            expect(validate(cleared).valid).toBe(true);

            // 清空后 append 新消息（新写入使用随机 UUID，不会与旧消息 id 冲突）
            await manager.addBatch('c1', [
                { role: 'user', parts: [{ text: 'n1' }], timestamp: 500 },
                { role: 'model', parts: [{ text: 'n2' }], timestamp: 600 },
            ]);
            const newIds = (await manager.getMessagesRaw('c1')).map(m => m.id!);
            expect(newIds[0]).not.toBe(ids[0]);

            // 下一次图同步以当前主历史重建：新根 = 新历史首条消息（不再挂到被清空的旧图/旧尾）
            const reconciled = await service.ensureMainHistoryRepresentedInGraph('c1');
            expect(reconciled.reconciled).toBe(true);
            const rebuilt = (await service.getBranchGraph('c1')).graph!;
            expect(rebuilt.rootNodeId).toBe(newIds[0]);
            expect(activePath(rebuilt)).toEqual(newIds);
            expect(rebuilt.nodes[ids[0]]).toBeUndefined();
            expect(validate(rebuilt).valid).toBe(true);
        });

        test('restoreSnapshot 空历史快照：等价清空 → forceResetToEmpty 空图', async () => {
            await seedConversation('c1');
            await manager.clearHistory('c1');
            const emptySnapshot = await manager.createSnapshot('c1');
            expect(emptySnapshot.history).toEqual([]);

            // 重新写入内容并建图（图非空、根非空），再恢复空快照
            await manager.addBatch('c1', [
                { role: 'user', parts: [{ text: 'q1' }], timestamp: 100 },
                { role: 'model', parts: [{ text: 'a1' }], timestamp: 200 },
            ]);
            await service.ensureMainHistoryRepresentedInGraph('c1');
            await service.createRerollCandidate('c1', (await manager.getMessagesRaw('c1'))[1].id!, { parts: [{ text: 'a2' }] });
            expect((await service.getBranchGraph('c1')).graph!.rootNodeId).not.toBeNull();

            await manager.restoreSnapshot('c1', emptySnapshot.id);

            expect(await manager.getMessagesRaw('c1')).toEqual([]);
            const graph = (await service.getBranchGraph('c1')).graph!;
            expect(graph.rootNodeId).toBeNull();
            expect(graph.activeTailNodeId).toBeNull();
            expect(graph.nodes).toEqual({});
            expect(validate(graph).valid).toBe(true);
        });

        test('restoreSnapshot 非空历史快照：按快照主历史 rebase 活跃路径，旧候选归档保留', async () => {
            const ids = await seedConversation('c1'); // [u1, m1]
            const fullSnapshot = await manager.createSnapshot('c1');
            expect(fullSnapshot.history.map(m => m.id)).toEqual(ids);

            // 快照后继续追加并建候选：图先于快照状态（活跃路径含快照外消息）
            await manager.addBatch('c1', [
                { role: 'user', parts: [{ text: 'q2' }], timestamp: 300 },
                { role: 'model', parts: [{ text: 'a2' }], timestamp: 400 },
            ]);
            const grownIds = (await manager.getMessagesRaw('c1')).map(m => m.id!);
            const candidate = await service.createRerollCandidate('c1', ids[1], { parts: [{ text: 'alt' }] });
            expect(activePath((await service.getBranchGraph('c1')).graph!)).toContain(candidate.nodeId);

            await manager.restoreSnapshot('c1', fullSnapshot.id);

            // 主历史回到快照状态；图活跃路径以快照主历史重建
            expect((await manager.getMessagesRaw('c1')).map(m => m.id!)).toEqual(ids);
            const graph = (await service.getBranchGraph('c1')).graph!;
            expect(graph.rootNodeId).toBe(ids[0]);
            expect(activePath(graph)).toEqual(ids);
            expect(graph.activeTailNodeId).toBe(ids[1]);
            // 快照外的追加消息与候选退化为非活跃节点保留（rebase 归档语义），图仍合法
            expect(graph.nodes[grownIds[2]]!.parentId).toBe(ids[1]);
            expect(graph.nodes[candidate.nodeId]).toMatchObject({ parentId: ids[1], kind: 'reroll' });
            expect(validate(graph).valid).toBe(true);
        });
    });
});

describe('purge/prune 引用归零存档清理联动', () => {
    let tempDir: string;
    let repo: BranchGraphRepository;
    let manager: ConversationManager;
    let service: BranchService;
    let checkpointManager: CheckpointManager;
    let storageRoot: string;
    let workspaceRoot: string;

    beforeEach(async () => {
        tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bcp06-branch-'));
        storageRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'bcp06-cp-'));
        workspaceRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'bcp06-ws-'));
        repo = new BranchGraphRepository(tempDir);
        manager = new ConversationManager(new MemoryStorageAdapter());
        service = new BranchService(manager, repo);
        setGlobalBranchService(service);
        // CheckpointManager 构造时自注册为全局清理器（生产同一路径）
        (vscode.workspace as any).workspaceFolders = [
            { uri: { fsPath: workspaceRoot, scheme: 'file', path: workspaceRoot } }
        ];
        (vscode.workspace as any).textDocuments = [];
        (vscode as any).window = {
            setStatusBarMessage: jest.fn(),
            showTextDocument: jest.fn(),
            tabGroups: { all: [], close: jest.fn() },
        };
        (vscode.commands.executeCommand as jest.Mock).mockResolvedValue(undefined);
        const settingsManager = {
            getCheckpointConfig: jest.fn().mockReturnValue({
                enabled: true,
                beforeTools: [],
                afterTools: [],
                messageCheckpoint: { beforeMessages: [], afterMessages: [] },
                maxCheckpoints: -1,
                customIgnorePatterns: [],
            }),
        };
        checkpointManager = new CheckpointManager(
            settingsManager as any,
            manager as any,
            { globalStorageUri: { fsPath: storageRoot } } as any
        );
        await checkpointManager.initialize();
    });

    afterEach(async () => {
        setGlobalBranchService(undefined);
        setGlobalCheckpointRefCountCleaner(undefined);
        (vscode.workspace as any).workspaceFolders = [];
        await fsp.rm(tempDir, { recursive: true, force: true });
        await fsp.rm(storageRoot, { recursive: true, force: true });
        await fsp.rm(workspaceRoot, { recursive: true, force: true });
    });

    async function writeFile(rootDir: string, relativePath: string, content: string = ''): Promise<void> {
        const fullPath = path.join(rootDir, relativePath);
        await fsp.mkdir(path.dirname(fullPath), { recursive: true });
        await fsp.writeFile(fullPath, content, 'utf-8');
    }

    async function pathExists(targetPath: string): Promise<boolean> {
        try {
            await fsp.access(targetPath);
            return true;
        } catch {
            return false;
        }
    }

    function makeCheckpointRecord(
        overrides: Partial<CheckpointRecord> & { id: string; conversationId: string }
    ): CheckpointRecord {
        return {
            messageIndex: 0,
            toolName: 'apply_diff',
            phase: 'after',
            timestamp: Date.now(),
            backupDir: overrides.id,
            fileCount: 1,
            contentHash: 'h',
            type: 'full',
            ...overrides,
        };
    }

    /** 写入存档记录（真实 ConversationManager 元数据）+ 备份目录 */
    async function seedCheckpoint(conversationId: string, record: CheckpointRecord): Promise<void> {
        await manager.updateCustomMetadata(conversationId, 'checkpoints', current => {
            const list = Array.isArray(current) ? current as CheckpointRecord[] : [];
            return [...list, record];
        });
        await writeFile(path.join(storageRoot, 'checkpoints', record.backupDir), 'x.txt', 'x');
    }

    async function checkpointRecords(conversationId: string): Promise<CheckpointRecord[]> {
        const current = await manager.getCustomMetadata(conversationId, 'checkpoints');
        return Array.isArray(current) ? current as CheckpointRecord[] : [];
    }

    /** 建会话 + 两个 reroll 候选，返回 [user, model, r1, r2]（r2 为活跃候选） */
    async function seedCandidates(conversationId: string): Promise<string[]> {
        await manager.createConversation(conversationId, 'T');
        await manager.addBatch(conversationId, linearHistory());
        const ids = (await manager.getMessagesRaw(conversationId)).map(m => m.id!);
        const r1 = await service.createRerollCandidate(conversationId, ids[1], { parts: [{ text: 'a2' }] });
        const r2 = await service.createRerollCandidate(conversationId, ids[1], { parts: [{ text: 'a3' }] });
        return [ids[0], ids[1], r1.nodeId, r2.nodeId];
    }

    test('purge 物理删除后：引用归零存档被清理（记录移除 + 备份目录删除）', async () => {
        const ids = await seedCandidates('c1');
        await service.bindWorkspaceCheckpoint('c1', ids[2], 'cp-1');
        await seedCheckpoint('c1', makeCheckpointRecord({ id: 'cp-1', conversationId: 'c1', messageNodeId: ids[2] }));

        // 软删（不触发清理）→ purge（物理删除后触发清理）
        await service.deleteBranchCandidate('c1', ids[2]);
        expect((await checkpointRecords('c1')).map(r => r.id)).toEqual(['cp-1']);

        const purged = await service.purgeBranchCandidate('c1', ids[2]);
        expect(purged.purged).toBe(true);
        expect((await checkpointRecords('c1'))).toEqual([]);
        await expect(pathExists(path.join(storageRoot, 'checkpoints', 'cp-1'))).resolves.toBe(false);
    });

    test('purge 后存档仍被其他存活节点引用 → 不删（refCount>0 拒绝）', async () => {
        const ids = await seedCandidates('c1');
        // r1 与 r2（存活）共享同一存档 cp-1
        await service.bindWorkspaceCheckpoint('c1', ids[2], 'cp-1');
        await service.bindWorkspaceCheckpoint('c1', ids[3], 'cp-1');
        await seedCheckpoint('c1', makeCheckpointRecord({ id: 'cp-1', conversationId: 'c1', messageNodeId: ids[2] }));

        await service.deleteBranchCandidate('c1', ids[2]);
        const purged = await service.purgeBranchCandidate('c1', ids[2]);
        expect(purged.purged).toBe(true);

        // r2 仍存活引用 cp-1 → 引用计数 1 → 拒绝删除
        expect((await checkpointRecords('c1')).map(r => r.id)).toEqual(['cp-1']);
        await expect(pathExists(path.join(storageRoot, 'checkpoints', 'cp-1'))).resolves.toBe(true);
    });

    test('prune 过期软删后：引用归零存档被清理', async () => {
        const ids = await seedCandidates('c1');
        await service.bindWorkspaceCheckpoint('c1', ids[2], 'cp-1');
        await seedCheckpoint('c1', makeCheckpointRecord({ id: 'cp-1', conversationId: 'c1', messageNodeId: ids[2] }));

        await service.deleteBranchCandidate('c1', ids[2]);
        // 拨过期（31 天前）→ prune 物理清理
        const filePath = repo.getBranchesFilePath('c1');
        const graph = JSON.parse(await fsp.readFile(filePath, 'utf8'));
        graph.nodes[ids[2]].deletedAt = Date.now() - 31 * 24 * 60 * 60 * 1000;
        await fsp.writeFile(filePath, JSON.stringify(graph), 'utf8');

        const pruned = await service.pruneDeletedBranches({ conversationId: 'c1', retentionDays: 30, now: Date.now() });
        expect(pruned.prunedNodeCount).toBe(1);
        expect((await checkpointRecords('c1'))).toEqual([]);
        await expect(pathExists(path.join(storageRoot, 'checkpoints', 'cp-1'))).resolves.toBe(false);
    });

    test('软删不触发存档清理（保留期未到，节点可能恢复——决策 3 语义）', async () => {
        const ids = await seedCandidates('c1');
        await service.bindWorkspaceCheckpoint('c1', ids[2], 'cp-1');
        await seedCheckpoint('c1', makeCheckpointRecord({ id: 'cp-1', conversationId: 'c1', messageNodeId: ids[2] }));

        await service.deleteBranchCandidate('c1', ids[2]);
        // 未 purge / 未 prune：存档记录与备份目录均保留
        expect((await checkpointRecords('c1')).map(r => r.id)).toEqual(['cp-1']);
        await expect(pathExists(path.join(storageRoot, 'checkpoints', 'cp-1'))).resolves.toBe(true);
        // 恢复后节点绑定仍有效
        const restored = await service.restoreBranchCandidate('c1', ids[2]);
        expect(restored.restored).toBe(true);
        expect((await service.getBranchGraph('c1')).graph!.nodes[ids[2]]!.workspaceCheckpointId).toBe('cp-1');
    });

    test('未注册清理器（无 CheckpointManager）→ purge 正常完成、存档不清理', async () => {
        const ids = await seedCandidates('c1');
        await service.bindWorkspaceCheckpoint('c1', ids[2], 'cp-1');
        await seedCheckpoint('c1', makeCheckpointRecord({ id: 'cp-1', conversationId: 'c1', messageNodeId: ids[2] }));
        await service.deleteBranchCandidate('c1', ids[2]);

        setGlobalCheckpointRefCountCleaner(undefined); // 模拟无 CheckpointManager 环境
        const purged = await service.purgeBranchCandidate('c1', ids[2]);
        expect(purged.purged).toBe(true);

        // 清理器缺失 → 跳过存档清理（图侧删除不受影响）
        expect((await checkpointRecords('c1')).map(r => r.id)).toEqual(['cp-1']);
        await expect(pathExists(path.join(storageRoot, 'checkpoints', 'cp-1'))).resolves.toBe(true);
    });
});
