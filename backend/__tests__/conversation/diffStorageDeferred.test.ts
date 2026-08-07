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
});
