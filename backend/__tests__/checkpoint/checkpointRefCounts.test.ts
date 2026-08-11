/**
 * BCP-06 测试：computeCheckpointReferenceCounts（引用计数扫描，checkpoint 域新模块）。
 *
 * 覆盖（研究 §5.2 + BCP-08 场景 17-23 的计数侧）：
 * - 多节点同存档去重计数（同一对话多节点引用同一存档 → 累加）；
 * - 跨对话引用计数（全量扫描合并）；
 * - 软删节点不计数（保留期内引用不算，prune 后即失效）；
 * - 无 workspaceCheckpointId / 空串不计数；
 * - 损坏 sidecar 跳过（不抛错）、无 sidecar 目录跳过；
 * - conversationIds 显式限定 vs 缺省全量（listConversationIds）。
 *
 * 存储：真实 BranchGraphRepository（临时目录），与 branchWorkspaceBind.test.ts 同模式。
 */

import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { BranchGraphRepository } from '../../modules/conversation/branch/BranchGraphRepository';
import type { ConversationBranchGraph, ConversationBranchNode } from '../../modules/conversation/branch/types';
import { computeCheckpointReferenceCounts } from '../../modules/checkpoint';

/** 构造一个最小合法节点（workspaceCheckpointId 可覆盖） */
function node(id: string, overrides: Partial<ConversationBranchNode> = {}): ConversationBranchNode {
    return {
        id,
        parentId: null,
        role: 'user',
        parts: [],
        kind: 'normal',
        createdAt: 1000,
        ...overrides,
    };
}

/** 构造最小合法图（version 1 + nodes；rootNodeId 指向第一个节点） */
function graph(nodes: Record<string, ConversationBranchNode>): ConversationBranchGraph {
    const ids = Object.keys(nodes);
    return {
        version: 1,
        rootNodeId: ids[0] ?? null,
        activeTailNodeId: ids[ids.length - 1] ?? null,
        nodes,
    };
}

/** 常见存档 id */
const CP_A = 'cp-a';
const CP_B = 'cp-b';

describe('computeCheckpointReferenceCounts（BCP-06 引用计数扫描）', () => {
    let tempDir: string;
    let repo: BranchGraphRepository;

    beforeEach(async () => {
        tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bcp06-refcounts-'));
        repo = new BranchGraphRepository(tempDir);
    });

    afterEach(async () => {
        await fsp.rm(tempDir, { recursive: true, force: true });
    });

    test('同一对话多节点引用同一存档 → 计数累加（去重按节点，非按存档唯一）', async () => {
        await repo.save('c1', graph({
            n1: node('n1', { workspaceCheckpointId: CP_A }),
            n2: node('n2', { workspaceCheckpointId: CP_A }),
            n3: node('n3', { workspaceCheckpointId: CP_B }),
        }));

        const counts = await computeCheckpointReferenceCounts(repo);
        expect(counts.get(CP_A)).toBe(2);
        expect(counts.get(CP_B)).toBe(1);
        expect(counts.size).toBe(2);
    });

    test('跨对话引用计数：全量扫描合并', async () => {
        await repo.save('c1', graph({
            n1: node('n1', { workspaceCheckpointId: CP_A }),
        }));
        await repo.save('c2', graph({
            n1: node('n1', { workspaceCheckpointId: CP_A }),
            n2: node('n2', { workspaceCheckpointId: CP_A }),
        }));

        const counts = await computeCheckpointReferenceCounts(repo);
        expect(counts.get(CP_A)).toBe(3);
    });

    test('软删节点不计数（保留期内引用不算，prune 后即失效）', async () => {
        await repo.save('c1', graph({
            n1: node('n1', { workspaceCheckpointId: CP_A }),
            n2: node('n2', { workspaceCheckpointId: CP_A, deleted: true, deletedAt: Date.now() }),
            n3: node('n3', { workspaceCheckpointId: CP_B, deleted: true, deletedAt: Date.now() }),
        }));

        const counts = await computeCheckpointReferenceCounts(repo);
        expect(counts.get(CP_A)).toBe(1); // 只有存活节点 n1
        expect(counts.has(CP_B)).toBe(false); // 仅软删节点引用 → 不出现
    });

    test('无 workspaceCheckpointId / 空串节点不计数', async () => {
        await repo.save('c1', graph({
            n1: node('n1'), // 无绑定
            n2: node('n2', { workspaceCheckpointId: '' }), // 空串
        }));

        const counts = await computeCheckpointReferenceCounts(repo);
        expect(counts.size).toBe(0);
    });
    test('非字符串 workspaceCheckpointId（数字）→ typeof 守卫拒绝不计数', async () => {
        await repo.save('c1', graph({
            n1: node('n1', { workspaceCheckpointId: 123 as unknown as string }),
            n2: node('n2', { workspaceCheckpointId: 0 as unknown as string }),
        }));

        const counts = await computeCheckpointReferenceCounts(repo);
        expect(counts.size).toBe(0);
    });

    test('损坏 sidecar 跳过（warn 不抛错）；无 sidecar 会话目录跳过', async () => {
        // c1 正常，c2 损坏，c3 只有会话目录没有 branches.json
        await repo.save('c1', graph({ n1: node('n1', { workspaceCheckpointId: CP_A }) }));
        const corruptPath = repo.getBranchesFilePath('c2');
        await fsp.mkdir(path.dirname(corruptPath), { recursive: true });
        await fsp.writeFile(corruptPath, '{ broken json', 'utf8');
        await fsp.mkdir(path.join(tempDir, 'conversations', 'c3'), { recursive: true });

        const counts = await computeCheckpointReferenceCounts(repo);
        expect(counts.get(CP_A)).toBe(1);
        expect(counts.size).toBe(1);
    });

    test('conversationIds 显式限定：只扫指定会话（不调用 listConversationIds）', async () => {
        const listSpy = jest.spyOn(repo, 'listConversationIds');
        await repo.save('c1', graph({ n1: node('n1', { workspaceCheckpointId: CP_A }) }));
        await repo.save('c2', graph({ n1: node('n1', { workspaceCheckpointId: CP_A }) }));

        const counts = await computeCheckpointReferenceCounts(repo, ['c1']);
        expect(counts.get(CP_A)).toBe(1);
        expect(listSpy).not.toHaveBeenCalled();
    });

    test('缺省 conversationIds：经 listConversationIds 全量扫描', async () => {
        const listSpy = jest.spyOn(repo, 'listConversationIds');
        await repo.save('c1', graph({ n1: node('n1', { workspaceCheckpointId: CP_A }) }));
        await repo.save('c2', graph({ n1: node('n1', { workspaceCheckpointId: CP_A }) }));

        const counts = await computeCheckpointReferenceCounts(repo);
        expect(counts.get(CP_A)).toBe(2);
        expect(listSpy).toHaveBeenCalled();
        expect(listSpy.mock.results[0]?.value).resolves.toEqual(['c1', 'c2']);
    });

    test('无任何 sidecar → 空 Map', async () => {
        const counts = await computeCheckpointReferenceCounts(repo);
        expect(counts.size).toBe(0);
    });
});
