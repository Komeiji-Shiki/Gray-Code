/**
 * BranchGraphRepository sidecar 存储单测（第五阶段 BR-04）。
 *
 * 覆盖：路径约定、保存/读取往返、原子写（无 tmp 残留）、损坏降级（BRANCH_STORAGE_CORRUPT）、
 * 覆盖写、deleteConversation 清理、并发写串行化。
 * 使用真实临时目录（注入 baseDir），不依赖 vscode mock。
 */

import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { BranchGraphRepository } from '../../modules/conversation/branch/BranchGraphRepository';
import { createEmptyBranchGraph, insertNode, rerollCandidate } from '../../modules/conversation/branch/BranchGraph';
import type { ConversationBranchGraph, ConversationBranchNode } from '../../modules/conversation/branch/types';

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

function sampleGraph(tailSuffix = 'a'): ConversationBranchGraph {
    let g = createEmptyBranchGraph();
    g = insertNode(g, node('root', null, { createdAt: 1 }));
    g = insertNode(g, node('u', 'root', { role: 'user', createdAt: 2 }));
    g = insertNode(g, node(tailSuffix, 'u', { role: 'model', kind: 'reroll', createdAt: 3 }));
    return g;
}

describe('BranchGraphRepository sidecar 读写', () => {
    let tempDir: string;
    let repo: BranchGraphRepository;
    const conversationId = 'conv-test-1';

    beforeEach(async () => {
        tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'branch-repo-'));
        repo = new BranchGraphRepository(tempDir);
    });

    afterEach(async () => {
        await fsp.rm(tempDir, { recursive: true, force: true });
    });

    test('路径遵循会话目录约定 conversations/{id}/branches.json', () => {
        const filePath = repo.getBranchesFilePath('c1');
        expect(filePath).toBe(path.join(tempDir, 'conversations', 'c1', 'branches.json'));
    });

    test('save + load 往返一致（深比较）', async () => {
        const graph = sampleGraph();
        await repo.save(conversationId, graph);
        const result = await repo.load(conversationId);
        expect(result.errorCode).toBeUndefined();
        expect(result.graph).toEqual(graph);
    });

    test('文件不存在 → { graph: null } 且无错误码', async () => {
        const result = await repo.load('no-such-conv');
        expect(result.graph).toBeNull();
        expect(result.errorCode).toBeUndefined();
    });

    test('exists() 在保存前后翻转', async () => {
        expect(await repo.exists(conversationId)).toBe(false);
        await repo.save(conversationId, sampleGraph());
        expect(await repo.exists(conversationId)).toBe(true);
    });

    test('原子写：保存后目录内无 tmp 残留，文件内容为格式化 JSON', async () => {
        const graph = sampleGraph();
        await repo.save(conversationId, graph);
        const convDir = path.join(tempDir, 'conversations', conversationId);
        const files = await fsp.readdir(convDir);
        expect(files).toEqual(['branches.json']);
        const raw = await fsp.readFile(path.join(convDir, 'branches.json'), 'utf8');
        expect(JSON.parse(raw)).toEqual(graph);
        expect(raw).toContain('\n  '); // 保留缩进格式
    });

    test('save 自动创建嵌套目录 conversations/{id}/', async () => {
        await repo.save('nested-conv', sampleGraph());
        const stat = await fsp.stat(path.join(tempDir, 'conversations', 'nested-conv', 'branches.json'));
        expect(stat.isFile()).toBe(true);
    });

    test('覆盖写：后保存的图生效（在旧图上 reroll 出新候选）', async () => {
        const g1 = sampleGraph('a');
        await repo.save(conversationId, g1);
        const g2 = rerollCandidate(g1, 'u', node('b', 'u', { role: 'model', createdAt: 4 }));
        await repo.save(conversationId, g2);
        const result = await repo.load(conversationId);
        expect(result.graph!.activeTailNodeId).toBe('b');
        expect(result.graph!.nodes['a']).toBeTruthy(); // 旧候选仍在图中
    });

    test('损坏 JSON → BRANCH_STORAGE_CORRUPT，graph 为 null（调用方降级线性模式）', async () => {
        const filePath = repo.getBranchesFilePath(conversationId);
        await fsp.mkdir(path.dirname(filePath), { recursive: true });
        await fsp.writeFile(filePath, '{ this is not json', 'utf8');
        const result = await repo.load(conversationId);
        expect(result.graph).toBeNull();
        expect(result.errorCode).toBe('BRANCH_STORAGE_CORRUPT');
        expect(result.errorMessage).toBeTruthy();
    });

    test('结构不符（数组 / 缺字段）→ BRANCH_STORAGE_CORRUPT', async () => {
        const filePath = repo.getBranchesFilePath(conversationId);
        await fsp.mkdir(path.dirname(filePath), { recursive: true });
        for (const bad of ['[]', '{"foo":1}', '"string"', '42']) {
            await fsp.writeFile(filePath, bad, 'utf8');
            const result = await repo.load(conversationId);
            expect(result.graph).toBeNull();
            expect(result.errorCode).toBe('BRANCH_STORAGE_CORRUPT');
        }
    });

    test('version 非 >=1 整数（字符串/0/小数/负数）→ BRANCH_STORAGE_CORRUPT（BG-1 浅层数值校验）', async () => {
        const filePath = repo.getBranchesFilePath(conversationId);
        await fsp.mkdir(path.dirname(filePath), { recursive: true });
        const good = sampleGraph();
        for (const badVersion of ['"1"', '0', '1.5', '-1']) {
            const bad = { ...good, version: JSON.parse(badVersion) };
            await fsp.writeFile(filePath, JSON.stringify(bad), 'utf8');
            const result = await repo.load(conversationId);
            expect(result.graph).toBeNull();
            expect(result.errorCode).toBe('BRANCH_STORAGE_CORRUPT');
            expect(result.errorMessage).toContain('invalid shape');
        }
        // 合法整数版本仍可加载（深层语义校验由 BranchService 读取侧 validate 负责）
        const ok = { ...good, version: 1 };
        await fsp.writeFile(filePath, JSON.stringify(ok), 'utf8');
        expect((await repo.load(conversationId)).graph).toEqual(ok);
    });

    test('deleteConversation 删除 sidecar；再次删除幂等不抛错', async () => {
        await repo.save(conversationId, sampleGraph());
        await repo.deleteConversation(conversationId);
        expect(await repo.exists(conversationId)).toBe(false);
        expect((await repo.load(conversationId)).graph).toBeNull();
        await expect(repo.deleteConversation(conversationId)).resolves.toBeUndefined();
    });

    test('并发写按会话串行化：最终状态为最后发起者，且无 tmp 残留', async () => {
        const g1 = sampleGraph('a');
        const g2 = sampleGraph('b');
        await Promise.all([repo.save(conversationId, g1), repo.save(conversationId, g2)]);
        const result = await repo.load(conversationId);
        expect(result.graph).toEqual(g2);
        const convDir = path.join(tempDir, 'conversations', conversationId);
        const files = await fsp.readdir(convDir);
        expect(files).toEqual(['branches.json']);
    });

    test('不同会话的写入互不干扰', async () => {
        await repo.save('conv-A', sampleGraph('a'));
        await repo.save('conv-B', sampleGraph('b'));
        expect((await repo.load('conv-A')).graph!.activeTailNodeId).toBe('a');
        expect((await repo.load('conv-B')).graph!.activeTailNodeId).toBe('b');
        await repo.deleteConversation('conv-A');
        expect((await repo.load('conv-A')).graph).toBeNull();
        expect((await repo.load('conv-B')).graph).not.toBeNull();
    });

    test('deleteConversation 与会话写串行队列共用：并发 save→delete 后无残留（M-5）', async () => {
        const g1 = sampleGraph('a');
        // save 先入队、delete 后入队 → 先写后删，最终无 sidecar（不串行时 rename 会落在 unlink 之后 → 残留）
        await Promise.all([repo.save(conversationId, g1), repo.deleteConversation(conversationId)]);
        expect(await repo.exists(conversationId)).toBe(false);
        expect((await repo.load(conversationId)).graph).toBeNull();
        const convDir = path.join(tempDir, 'conversations', conversationId);
        const files = await fsp.readdir(convDir);
        expect(files).toEqual([]);
    });

    test('deleteConversation 串行队列：并发 delete→save 后保留最后写入（M-5；迟到写由调用方阻止）', async () => {
        const g2 = sampleGraph('b');
        // delete 先入队、save 后入队 → 删后再写，最终为 g2（BranchService 的已删除会话检查负责阻止迟到写）
        await Promise.all([repo.deleteConversation(conversationId), repo.save(conversationId, g2)]);
        expect(await repo.exists(conversationId)).toBe(true);
        expect((await repo.load(conversationId)).graph!.activeTailNodeId).toBe('b');
        await repo.deleteConversation(conversationId); // 清理
    });

    test('listConversationIds：只列出存在 branches.json 的会话目录，忽略无 sidecar 目录与残留文件', async () => {
        expect(await repo.listConversationIds()).toEqual([]);
        await repo.save('conv-b', sampleGraph('b'));
        await repo.save('conv-a', sampleGraph('a'));
        // 无 sidecar 的会话目录与根下杂项文件不计数
        await fsp.mkdir(path.join(tempDir, 'conversations', 'no-sidecar'), { recursive: true });
        await fsp.writeFile(path.join(tempDir, 'conversations', 'not-a-dir.txt'), 'x', 'utf8');
        expect(await repo.listConversationIds()).toEqual(['conv-a', 'conv-b']);
        // 删除 sidecar 后不再列出
        await repo.deleteConversation('conv-a');
        expect(await repo.listConversationIds()).toEqual(['conv-b']);
    });

    test('保留期配置（R8c-P5）：缺失/损坏返回空对象（上层取构造默认）；save 后回读一致；非法值抛 INVALID_BRANCH_RELATION', async () => {
        // 缺失：retentionDays 为 undefined（BranchService 据此回退构造默认，使构造选项不再是死代码）
        expect(await repo.loadBranchRetentionConfig()).toEqual({});
        await repo.saveBranchRetentionConfig({ retentionDays: 7 });
        expect(await repo.loadBranchRetentionConfig()).toEqual({ retentionDays: 7 });
        // 损坏配置按缺省处理（返回空对象）
        await fsp.writeFile(repo.getBranchConfigFilePath(), '{ not json', 'utf8');
        expect(await repo.loadBranchRetentionConfig()).toEqual({});
        // 非法字段按缺省处理
        await fsp.writeFile(repo.getBranchConfigFilePath(), JSON.stringify({ retentionDays: '30' }), 'utf8');
        expect(await repo.loadBranchRetentionConfig()).toEqual({});
        await fsp.writeFile(repo.getBranchConfigFilePath(), JSON.stringify({ retentionDays: -3 }), 'utf8');
        expect(await repo.loadBranchRetentionConfig()).toEqual({});
        // 保存非法值抛错且不落盘
        await expect(repo.saveBranchRetentionConfig({ retentionDays: -1 })).rejects.toMatchObject({ code: 'INVALID_BRANCH_RELATION' });
        await expect(repo.saveBranchRetentionConfig({ retentionDays: 1.5 })).rejects.toMatchObject({ code: 'INVALID_BRANCH_RELATION' });
        expect(await repo.loadBranchRetentionConfig()).toEqual({});
    });
});
