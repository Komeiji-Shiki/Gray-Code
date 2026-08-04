/**
 * BCP-02 测试：BranchService.bindWorkspaceCheckpoint（工作区存档头节点绑定到分支节点）。
 *
 * 覆盖（研究文档 1.3⑤ / BCP-08 场景 1-5）：
 * - 绑定写入节点字段（workspaceCheckpointId + workspaceState='checkpointed'）并持久化回读；
 * - 重复绑定新存档直接覆盖（最新存档为准）；同 id 同 state 幂等（返回 false、不落盘）；
 * - 自定义 workspaceState 透传（'unavailable' 等）；
 * - 节点不存在 → NODE_NOT_FOUND；
 * - 软删节点 → BRANCH_OPERATION_CONFLICT（不复活、不写入）；
 * - 无图（线性对话）→ 返回 false 且不强制建图（不创建 sidecar）；
 * - sidecar 损坏 → BRANCH_STORAGE_CORRUPT（拒绝覆盖，原文件不变）。
 *
 * 存储组合：历史走 MemoryStorageAdapter，sidecar 走真实临时目录（注入 baseDir）。
 */

import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ConversationManager } from '../../modules/conversation/ConversationManager';
import { MemoryStorageAdapter } from '../../modules/conversation/storage';
import type { ConversationHistory } from '../../modules/conversation/types';
import { BranchService } from '../../modules/conversation/branch/BranchService';
import { BranchGraphRepository } from '../../modules/conversation/branch/BranchGraphRepository';
import { BranchError } from '../../modules/conversation/branch/types';

/** 线性历史：root(user) → model(a1) */
function linearHistory(): ConversationHistory {
    return [
        { role: 'user', parts: [{ text: 'q1' }], timestamp: 100 },
        { role: 'model', parts: [{ text: 'a1' }], timestamp: 200 },
    ];
}

describe('BranchService.bindWorkspaceCheckpoint（BCP-02）', () => {
    let tempDir: string;
    let repo: BranchGraphRepository;
    let manager: ConversationManager;
    let service: BranchService;

    beforeEach(async () => {
        tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bcp02-bind-'));
        repo = new BranchGraphRepository(tempDir);
        manager = new ConversationManager(new MemoryStorageAdapter());
        service = new BranchService(manager, repo);
    });

    afterEach(async () => {
        await fsp.rm(tempDir, { recursive: true, force: true });
    });

    /** 建会话并写入线性历史（无 sidecar），返回 [userNodeId, modelNodeId] */
    async function seedConversation(conversationId: string): Promise<string[]> {
        await manager.createConversation(conversationId, 'T');
        await manager.addBatch(conversationId, linearHistory());
        return (await manager.getMessagesRaw(conversationId)).map(m => m.id!);
    }

    /** 建会话 + 建图（createRerollCandidate 惰性建线性基线并挂候选），返回节点 id 列表 */
    async function seedWithGraph(conversationId: string): Promise<string[]> {
        const ids = await seedConversation(conversationId);
        await service.createRerollCandidate(conversationId, ids[1], { parts: [{ text: 'a2' }] });
        return ids;
    }

    test('绑定写入节点字段（workspaceCheckpointId + workspaceState=checkpointed）并持久化回读', async () => {
        const [userNodeId, modelNodeId] = await seedWithGraph('c1');

        const bound = await service.bindWorkspaceCheckpoint('c1', modelNodeId, 'cp-1');
        expect(bound).toBe(true);

        // 从仓库重新读（新实例）验证持久化
        const reloaded = (await new BranchGraphRepository(tempDir).load('c1')).graph!;
        expect(reloaded.nodes[modelNodeId]!.workspaceCheckpointId).toBe('cp-1');
        expect(reloaded.nodes[modelNodeId]!.workspaceState).toBe('checkpointed');
        // 其它节点不受影响
        expect(reloaded.nodes[userNodeId]!.workspaceCheckpointId).toBeUndefined();
        expect(reloaded.nodes[userNodeId]!.workspaceState).toBeUndefined();
    });

    test('重复绑定新存档直接覆盖（最新存档为准）', async () => {
        const [, modelNodeId] = await seedWithGraph('c1');
        await service.bindWorkspaceCheckpoint('c1', modelNodeId, 'cp-1');

        const bound = await service.bindWorkspaceCheckpoint('c1', modelNodeId, 'cp-2');
        expect(bound).toBe(true);

        const graph = (await service.getBranchGraph('c1')).graph!;
        expect(graph.nodes[modelNodeId]!.workspaceCheckpointId).toBe('cp-2');
        expect(graph.nodes[modelNodeId]!.workspaceState).toBe('checkpointed');
    });

    test('同 id 同 state 幂等：返回 false 且不落盘（sidecar 内容不变）', async () => {
        const [, modelNodeId] = await seedWithGraph('c1');
        await service.bindWorkspaceCheckpoint('c1', modelNodeId, 'cp-1');

        const filePath = repo.getBranchesFilePath('c1');
        const before = await fsp.readFile(filePath, 'utf8');

        const bound = await service.bindWorkspaceCheckpoint('c1', modelNodeId, 'cp-1');
        expect(bound).toBe(false);

        const after = await fsp.readFile(filePath, 'utf8');
        expect(after).toBe(before);
    });

    test('自定义 workspaceState 透传（非默认 checkpointed）', async () => {
        const [, modelNodeId] = await seedWithGraph('c1');
        await service.bindWorkspaceCheckpoint('c1', modelNodeId, 'cp-1', 'unavailable');

        const graph = (await service.getBranchGraph('c1')).graph!;
        expect(graph.nodes[modelNodeId]!.workspaceCheckpointId).toBe('cp-1');
        expect(graph.nodes[modelNodeId]!.workspaceState).toBe('unavailable');
    });

    test('节点不存在 → NODE_NOT_FOUND，不落盘', async () => {
        await seedWithGraph('c1');
        await expect(
            service.bindWorkspaceCheckpoint('c1', 'no-such-node', 'cp-1')
        ).rejects.toMatchObject({ code: 'NODE_NOT_FOUND' });
    });

    test('软删节点 → BRANCH_OPERATION_CONFLICT，字段不写入', async () => {
        const [, modelNodeId] = await seedWithGraph('c1');
        // 再建一个候选使 r1 变为非活跃，然后软删 r1
        const r1 = await service.createRerollCandidate('c1', modelNodeId, { parts: [{ text: 'a2' }] });
        await service.createRerollCandidate('c1', modelNodeId, { parts: [{ text: 'a3' }] });
        await service.deleteBranchCandidate('c1', r1.nodeId);
        expect((await service.getBranchGraph('c1')).graph!.nodes[r1.nodeId]!.deleted).toBe(true);

        await expect(
            service.bindWorkspaceCheckpoint('c1', r1.nodeId, 'cp-1')
        ).rejects.toMatchObject({ code: 'BRANCH_OPERATION_CONFLICT' });
        // 绑定失败后字段未写入、节点未被复活
        const graph = (await service.getBranchGraph('c1')).graph!;
        expect(graph.nodes[r1.nodeId]!.workspaceCheckpointId).toBeUndefined();
        expect(graph.nodes[r1.nodeId]!.deleted).toBe(true);
    });

    test('无图（线性对话）→ 返回 false 且不强制建图', async () => {
        const ids = await seedConversation('c1');
        expect(await repo.exists('c1')).toBe(false);

        const bound = await service.bindWorkspaceCheckpoint('c1', ids[1], 'cp-1');
        expect(bound).toBe(false);
        // 不因绑定创建 sidecar
        expect(await repo.exists('c1')).toBe(false);
    });

    test('sidecar 损坏 → BRANCH_STORAGE_CORRUPT（拒绝覆盖，原文件不变）', async () => {
        const [, modelNodeId] = await seedConversation('c1');
        const filePath = repo.getBranchesFilePath('c1');
        await fsp.mkdir(path.dirname(filePath), { recursive: true });
        await fsp.writeFile(filePath, '{ broken json', 'utf8');

        await expect(
            service.bindWorkspaceCheckpoint('c1', modelNodeId, 'cp-1')
        ).rejects.toMatchObject({ code: 'BRANCH_STORAGE_CORRUPT' });
        const raw = await fsp.readFile(filePath, 'utf8');
        expect(raw).toBe('{ broken json');
    });

    test('已删除会话拒绝写（BRANCH_OPERATION_CONFLICT，BS-4 迟到写防护）', async () => {
        const [, modelNodeId] = await seedWithGraph('c1');
        await manager.deleteConversation('c1');

        await expect(
            service.bindWorkspaceCheckpoint('c1', modelNodeId, 'cp-1')
        ).rejects.toMatchObject({ code: 'BRANCH_OPERATION_CONFLICT' });
    });
});
