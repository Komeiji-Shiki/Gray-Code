/**
 * 分支图版本迁移状态机单测（MIG-04）。
 *
 * 覆盖：
 * - 迁移注册表：register / unregister / 重复注册拒绝 / 已注册版本列表
 * - migrateBranchGraph：v1→v2 单步、v1→v3 链式、幂等（已最新原样返回）、
 *   未知版本拒绝（未来版本 / 非正整数 / 缺失步骤）、失败回滚（输入图不被污染）
 * - BranchGraphRepository.migrate 集成：落后版本迁移落盘、无 sidecar no-op、
 *   损坏拒绝且不覆盖、已最新不重写
 */

import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
    createEmptyBranchGraph,
    insertNode,
} from '../../modules/conversation/branch/BranchGraph';
import { BranchGraphRepository } from '../../modules/conversation/branch/BranchGraphRepository';
import {
    getCurrentBranchGraphVersion,
    getRegisteredBranchMigrationSteps,
    migrateBranchGraph,
    registerBranchMigration,
    unregisterBranchMigration,
} from '../../modules/conversation/branch/BranchMigration';
import { BranchError, ConversationBranchGraph, ConversationBranchNode } from '../../modules/conversation/branch/types';

function node(id: string, parentId: string | null, overrides: Partial<ConversationBranchNode> = {}): ConversationBranchNode {
    return {
        id,
        parentId,
        role: 'user',
        parts: [{ text: id }],
        kind: 'normal',
        createdAt: 1000,
        ...overrides,
    };
}

/** 一个合法的 v1 图：root(user) → model(a) */
function v1Graph(): ConversationBranchGraph {
    let graph = createEmptyBranchGraph();
    graph = insertNode(graph, node('root', null, { role: 'user', createdAt: 1 }));
    graph = insertNode(graph, node('a', 'root', { role: 'model', createdAt: 2 }));
    return graph;
}

describe('BranchMigration 迁移注册表', () => {
    afterEach(() => {
        unregisterBranchMigration(1);
        unregisterBranchMigration(2);
        unregisterBranchMigration(3);
    });

    test('当前版本与 types.ts 的 BRANCH_GRAPH_VERSION 一致（=1）', () => {
        expect(getCurrentBranchGraphVersion()).toBe(1);
        expect(v1Graph().version).toBe(1);
    });

    test('版本已是最新 → 原样返回 migrated=false，不执行任何 step', () => {
        const graph = v1Graph();
        const result = migrateBranchGraph(graph);
        expect(result.migrated).toBe(false);
        expect(result.fromVersion).toBe(1);
        expect(result.toVersion).toBe(1);
        expect(result.graph).toBe(graph); // 同引用，未拷贝未修改
    });

    test('v1→v2 迁移：注册 step 后链式升级并强制覆写 version', () => {
        registerBranchMigration(1, g => ({
            ...g,
            nodes: { ...g.nodes },
            metadata: { migratedAt: 123 } as unknown as undefined,
        }));
        const graph = v1Graph();
        const result = migrateBranchGraph(graph, { targetVersion: 2 });

        expect(result.migrated).toBe(true);
        expect(result.fromVersion).toBe(1);
        expect(result.toVersion).toBe(2);
        expect(result.graph.version).toBe(2); // 框架覆写 version，step 无需自理
        expect((result.graph as unknown as { metadata: { migratedAt: number } }).metadata.migratedAt).toBe(123);
        // 输入图未被修改（纯函数 + 深拷贝备份）
        expect(graph.version).toBe(1);
        expect(graph.nodes).toHaveProperty('root');
    });

    test('多级链式升级 v1→v3（可恢复中间状态：逐步升级）', () => {
        registerBranchMigration(1, g => ({ ...g, nodes: { ...g.nodes } }));
        registerBranchMigration(2, g => ({
            ...g,
            nodes: { ...g.nodes },
            meta2: true,
        } as unknown as ConversationBranchGraph));
        const result = migrateBranchGraph(v1Graph(), { targetVersion: 3 });

        expect(result.migrated).toBe(true);
        expect(result.toVersion).toBe(3);
        expect(result.graph.version).toBe(3);
        expect((result.graph as unknown as { meta2: boolean }).meta2).toBe(true);
        // 两步都执行了（v1→v2→v3）
        expect(result.graph.nodes).toHaveProperty('root');
    });

    test('未知版本拒绝：未来版本（高于目标版本）→ BRANCH_STORAGE_CORRUPT', () => {
        const graph = { ...v1Graph(), version: 99 };
        expect(() => migrateBranchGraph(graph)).toThrow(BranchError);
        expect(() => migrateBranchGraph(graph)).toThrow(/newer than supported/);
        try {
            migrateBranchGraph(graph);
            throw new Error('should not reach');
        } catch (error) {
            expect((error as BranchError).code).toBe('BRANCH_STORAGE_CORRUPT');
        }
    });

    test('未知版本拒绝：非正整数版本 → BRANCH_STORAGE_CORRUPT', () => {
        for (const badVersion of [0, -1, 1.5, NaN]) {
            const graph = { ...v1Graph(), version: badVersion } as unknown as ConversationBranchGraph;
            expect(() => migrateBranchGraph(graph)).toThrow(BranchError);
            expect(() => migrateBranchGraph(graph)).toThrow(/invalid version/);
        }
    });

    test('缺失迁移步骤 → BRANCH_STORAGE_CORRUPT（不猜测升级）', () => {
        expect(() => migrateBranchGraph(v1Graph(), { targetVersion: 2 })).toThrow(BranchError);
        expect(() => migrateBranchGraph(v1Graph(), { targetVersion: 2 })).toThrow(/no migration step/);
    });

    test('失败回滚：step 抛错 → 抛 BRANCH_STORAGE_CORRUPT 且输入图不被污染', () => {
        registerBranchMigration(1, () => {
            throw new Error('boom');
        });
        const graph = v1Graph();
        const snapshot = JSON.parse(JSON.stringify(graph));
        try {
            migrateBranchGraph(graph, { targetVersion: 2 });
            throw new Error('should not reach');
        } catch (error) {
            expect(error).toBeInstanceOf(BranchError);
            expect((error as BranchError).code).toBe('BRANCH_STORAGE_CORRUPT');
            expect((error as Error).message).toContain('migration failed at step 1 -> 2');
            expect((error as Error).message).toContain('boom');
        }
        // 升级前备份 + 失败恢复：输入图对象完全未被修改
        expect(graph).toEqual(snapshot);
        expect(graph.version).toBe(1);
    });

    test('失败回滚：链式第二步失败时第一步的中间结果不泄漏', () => {
        registerBranchMigration(1, g => ({ ...g, nodes: { ...g.nodes }, step1Done: true } as unknown as ConversationBranchGraph));
        registerBranchMigration(2, () => {
            throw new Error('boom2');
        });
        const graph = v1Graph();
        expect(() => migrateBranchGraph(graph, { targetVersion: 3 })).toThrow(BranchError);
        expect(() => migrateBranchGraph(graph, { targetVersion: 3 })).toThrow(/step 2 -> 3/);
        // 输入仍为 v1 原样
        expect(graph.version).toBe(1);
        expect((graph as unknown as { step1Done?: boolean }).step1Done).toBeUndefined();
    });

    test('重复注册同一版本步骤被拒绝', () => {
        registerBranchMigration(1, g => g);
        expect(() => registerBranchMigration(1, g => g)).toThrow(/already registered/);
    });

    test('unregister 后步骤不再生效', () => {
        registerBranchMigration(1, g => ({ ...g, nodes: { ...g.nodes } }));
        expect(getRegisteredBranchMigrationSteps()).toEqual([1]);
        unregisterBranchMigration(1);
        expect(getRegisteredBranchMigrationSteps()).toEqual([]);
        expect(() => migrateBranchGraph(v1Graph(), { targetVersion: 2 })).toThrow(/no migration step/);
    });
});

describe('BranchGraphRepository.migrate 集成', () => {
    let tempDir: string;
    let repo: BranchGraphRepository;
    const conversationId = 'conv-migrate-1';

    beforeEach(async () => {
        tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'branch-migrate-'));
        repo = new BranchGraphRepository(tempDir);
    });

    afterEach(async () => {
        unregisterBranchMigration(1);
        await fsp.rm(tempDir, { recursive: true, force: true });
    });

    test('sidecar 版本落后 → 迁移并原子保存（saved=true），重新读取为最新版本', async () => {
        registerBranchMigration(1, g => ({ ...g, nodes: { ...g.nodes } }));
        await repo.save(conversationId, v1Graph());

        const result = await repo.migrate(conversationId, { targetVersion: 2 });
        expect(result.migrated).toBe(true);
        expect(result.saved).toBe(true);
        expect(result.graph!.version).toBe(2);

        const loaded = await repo.load(conversationId);
        expect(loaded.graph!.version).toBe(2);
        // 原子写：无 tmp 残留
        const convDir = path.join(tempDir, 'conversations', conversationId);
        const files = await fsp.readdir(convDir);
        expect(files).toEqual(['branches.json']);
    });

    test('无 sidecar → no-op（migrated=false, saved=false, graph=null）', async () => {
        const result = await repo.migrate('no-such-conv');
        expect(result.migrated).toBe(false);
        expect(result.saved).toBe(false);
        expect(result.graph).toBeNull();
    });

    test('损坏 sidecar → 抛 BRANCH_STORAGE_CORRUPT 且不覆盖原文件', async () => {
        const filePath = repo.getBranchesFilePath(conversationId);
        await fsp.mkdir(path.dirname(filePath), { recursive: true });
        await fsp.writeFile(filePath, '{ this is broken json', 'utf8');

        await expect(repo.migrate(conversationId)).rejects.toThrow(/corrupt/i);
        // 原文件保持不变（可恢复数据未被覆盖）
        expect(await fsp.readFile(filePath, 'utf8')).toBe('{ this is broken json');
    });

    test('版本已最新 → saved=false 且文件不重写', async () => {
        await repo.save(conversationId, v1Graph());
        const result = await repo.migrate(conversationId);
        expect(result.migrated).toBe(false);
        expect(result.saved).toBe(false);
        expect(result.graph!.version).toBe(1);
    });
});
