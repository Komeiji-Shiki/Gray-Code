import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import { DiffStorageManager } from '../../modules/conversation/DiffStorageManager';

/** 读取 diff 文件：识别 gzip 魔数，兼容明文 JSON */
async function readDiffFile(filePath: string): Promise<any> {
    const data = await fsp.readFile(filePath);
    if (data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b) {
        const raw = await new Promise<Buffer>((resolve, reject) => {
            zlib.gunzip(data, (err, result) => {
                if (err) reject(err);
                else resolve(result);
            });
        });
        return JSON.parse(raw.toString('utf8'));
    }
    return JSON.parse(data.toString('utf8'));
}

describe('DiffStorageManager deferred global diff persistence', () => {
    let tempDir: string;
    let manager: DiffStorageManager;

    beforeEach(async () => {
        tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'graycode-diff-cache-'));
        manager = DiffStorageManager.initialize(tempDir);
    });

    afterEach(async () => {
        await fsp.rm(tempDir, { recursive: true, force: true });
    });

    test('deferred 保存立即提供内存预览，并在后台写入 gzip 无损压缩 JSON', async () => {
        const ref = manager.saveGlobalDiffDeferred({
            originalContent: 'before\n',
            newContent: 'after\n',
            filePath: 'src/example.ts'
        }, 'diff_deferred_test');

        expect(ref.diffId).toBe('diff_deferred_test');
        await expect(manager.loadGlobalDiff(ref.diffId)).resolves.toMatchObject({
            originalContent: 'before\n',
            newContent: 'after\n',
            filePath: 'src/example.ts'
        });

        const persistedPath = path.join(tempDir, 'diffs', '__global__', 'diff_deferred_test.json');
        let data: Buffer | null = null;
        for (let i = 0; i < 100; i++) {
            try {
                data = await fsp.readFile(persistedPath);
                break;
            } catch {
                await new Promise(resolve => setTimeout(resolve, 5));
            }
        }

        expect(data).not.toBeNull();
        // 文件是 gzip 压缩的（无损压缩，磁盘占用更小）
        expect(data![0]).toBe(0x1f);
        expect(data![1]).toBe(0x8b);
        expect(await readDiffFile(persistedPath)).toMatchObject({
            originalContent: 'before\n',
            newContent: 'after\n'
        });
    });

    test('旧版明文 JSON 兼容：loadGlobalDiff 可读取未压缩文件', async () => {
        // 模拟旧版本写入的明文 JSON（无 gzip 魔数）
        const dir = path.join(tempDir, 'diffs', '__global__');
        await fsp.mkdir(dir, { recursive: true });
        await fsp.writeFile(
            path.join(dir, 'legacy_diff.json'),
            JSON.stringify({ originalContent: 'old\n', newContent: 'new\n', filePath: 'a.ts', createdAt: 1 }),
            'utf8'
        );

        await expect(manager.loadGlobalDiff('legacy_diff')).resolves.toMatchObject({
            originalContent: 'old\n',
            newContent: 'new\n',
            filePath: 'a.ts'
        });
    });

    test('绑定对话的 diff 落盘到对话目录并写入索引，删除对话后一并清理', async () => {
        const ref = await manager.saveGlobalDiff({
            originalContent: 'v1\n',
            newContent: 'v2\n',
            filePath: 'src/a.ts'
        }, 'conv_bound_diff', 'conv_test_1');

        expect(ref.diffId).toBe('conv_bound_diff');
        // 通过索引 + 对话目录可加载
        await expect(manager.loadGlobalDiff('conv_bound_diff')).resolves.toMatchObject({
            originalContent: 'v1\n',
            newContent: 'v2\n'
        });
        // 文件不在 __global__ 下，而在对话目录下
        const globalPath = path.join(tempDir, 'diffs', '__global__', 'conv_bound_diff.json');
        await expect(fsp.access(globalPath)).rejects.toThrow();
        const convPath = path.join(tempDir, 'diffs', 'conv_test_1', 'conv_bound_diff.json');
        await expect(fsp.access(convPath)).resolves.toBeUndefined();

        // 删除对话 → diff 与索引条目一并清理
        await manager.deleteConversationDiffs('conv_test_1');
        await expect(manager.loadGlobalDiff('conv_bound_diff')).resolves.toBeNull();
        await expect(fsp.access(convPath)).rejects.toThrow();
    });

    test('绑定对话的 diff 在对话删除前可经索引定位，且内存缓存正确淘汰', async () => {
        const content = 'x'.repeat(500);
        const ref = manager.saveGlobalDiffDeferred({
            originalContent: content,
            newContent: content,
            filePath: 'b.ts'
        }, 'conv_deferred_diff', 'conv_test_2');

        await expect(manager.loadGlobalDiff(ref.diffId)).resolves.toMatchObject({
            filePath: 'b.ts'
        });

        // 等待后台持久化完成（避免删除后写盘竞态）
        const convPath = path.join(tempDir, 'diffs', 'conv_test_2', 'conv_deferred_diff.json');
        for (let i = 0; i < 100; i++) {
            try {
                await fsp.access(convPath);
                break;
            } catch {
                await new Promise(resolve => setTimeout(resolve, 5));
            }
        }

        await manager.deleteConversationDiffs('conv_test_2');
        // 会话删除后无幽灵引用（索引与缓存同步清理）
        await expect(manager.loadGlobalDiff(ref.diffId)).resolves.toBeNull();
        await expect(fsp.access(convPath)).rejects.toThrow();
    });

    test('索引写链一次失败后不永久失效（后续索引写入仍可用）', async () => {
        const blockedDir = path.join(tempDir, 'diffs');
        // 桩替换私有 persistDiffIndex：第一次抛错（模拟索引写失败），随后恢复真实实现
        const mgr = manager as any;
        const origPersist = mgr.persistDiffIndex.bind(manager);
        let failWrites = true;
        mgr.persistDiffIndex = async () => {
            if (failWrites) throw new Error('simulated index write failure');
            return origPersist();
        };
        try {
            // 第一次：索引写失败 → 回退 __global__ 仍可保存
            const ref1 = manager.saveGlobalDiffDeferred({
                originalContent: 'a1',
                newContent: 'b1',
                filePath: 'x.ts'
            }, 'index_fail_diff', 'conv_if_1');
            // 等后台落盘完成
            for (let i = 0; i < 100; i++) {
                try {
                    await fsp.access(path.join(blockedDir, '__global__', 'index_fail_diff.json'));
                    break;
                } catch {
                    await new Promise(resolve => setTimeout(resolve, 5));
                }
            }
            // 内存缓存可用（进程内预览不受影响）
            await expect(manager.loadGlobalDiff(ref1.diffId)).resolves.toMatchObject({ filePath: 'x.ts' });

            // 解除故障：后续索引写必须恢复
            failWrites = false;
            const ref2 = manager.saveGlobalDiffDeferred({
                originalContent: 'a2',
                newContent: 'b2',
                filePath: 'y.ts'
            }, 'index_recover_diff', 'conv_if_2');
            for (let i = 0; i < 100; i++) {
                try {
                    await fsp.access(path.join(blockedDir, 'conv_if_2', 'index_recover_diff.json'));
                    break;
                } catch {
                    await new Promise(resolve => setTimeout(resolve, 5));
                }
            }
            // 恢复后索引条目真实落盘：重启等价路径（直读 index.json）能查到归属
            const indexRaw = await fsp.readFile(path.join(blockedDir, 'index.json'), 'utf8');
            const parsed = JSON.parse(indexRaw);
            expect(parsed['index_recover_diff']).toBe('conv_if_2');
            // 故障期间的 diff 因索引失败回退 __global__，不在索引中
            expect(parsed['index_fail_diff']).toBeUndefined();
        } finally {
            mgr.persistDiffIndex = origPersist;
        }
    });

    test('索引指向缺失文件时自愈删除幽灵条目（写文件前崩溃的残留）', async () => {
        // 构造「索引有、文件无」：先正常保存，再手动删文件，并清掉内存缓存强制走磁盘路径
        await manager.saveGlobalDiff({
            originalContent: 'ghost',
            newContent: 'ghost-new',
            filePath: 'ghost.ts'
        }, 'ghost_diff', 'conv_ghost');
        const ghostPath = path.join(tempDir, 'diffs', 'conv_ghost', 'ghost_diff.json');
        await fsp.unlink(ghostPath);
        (manager as any).globalDiffCache.clear();
        (manager as any).globalDiffCacheBytes = 0;

        // load 应返回 null（文件不存在）且索引条目被自愈删除
        await expect(manager.loadGlobalDiff('ghost_diff')).resolves.toBeNull();
        const indexRaw = await fsp.readFile(path.join(tempDir, 'diffs', 'index.json'), 'utf8');
        expect(JSON.parse(indexRaw)['ghost_diff']).toBeUndefined();
    });

    test('getStorageStats 不把 index.json 当会话计数', async () => {
        await manager.saveGlobalDiff({
            originalContent: 's1',
            newContent: 's2',
            filePath: 's.ts'
        }, 'stats_diff', 'conv_stats');

        const stats = await manager.getStorageStats();
        // 会话数 = 绑定对话目录数（__global__ 与 index.json 不计入）
        expect(stats.conversations).toBe(1);
        expect(stats.totalDiffs).toBe(1);
        expect(stats.totalSize).toBeGreaterThan(0);
    });
});
