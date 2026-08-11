import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
    buildWorkspaceSnapshot,
    previewExclusions,
    type SnapshotBuildOptions
} from '../../modules/checkpoint';
import { hashFileStreaming } from '../../modules/checkpoint/fileHashing';
import {
    createRuntimeWorkspaceRoots,
    createWorkspaceScopedPath
} from '../../modules/checkpoint';
import { createTempWorkspace } from '../__fixtures__/checkpointFixtures';

// L-1: 让 bad.txt 的流式哈希失败，构造“真实不可读文件”（跨平台确定，不依赖 chmod）
jest.mock('fs', () => {
    const actual = jest.requireActual('fs') as typeof import('fs');
    return {
        ...actual,
        createReadStream: jest.fn((filePath: unknown, ...args: unknown[]) => {
            if (String(filePath).split(/[\\/]/).filter(Boolean).pop() === 'bad.txt') {
                const error = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
                error.code = 'EACCES';
                throw error;
            }
            return (actual.createReadStream as unknown as (...a: unknown[]) => unknown)(filePath, ...args);
        })
    };
});

// M-6: 哨兵目录名 `blocked` 模拟不可读目录（readdir 失败），其余路径走真实实现
jest.mock('fs/promises', () => {
    const actual = jest.requireActual('fs/promises') as typeof import('fs/promises');
    return {
        ...actual,
        readdir: jest.fn((dirPath: unknown, ...args: unknown[]) => {
            const isBlocked = String(dirPath).split(/[\\/]/).filter(Boolean).pop() === 'blocked';
            if (isBlocked) {
                const error = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
                error.code = 'EACCES';
                return Promise.reject(error);
            }
            return (actual.readdir as unknown as (...a: unknown[]) => Promise<unknown>)(dirPath, ...args);
        })
    };
});

/**
 * CheckpointSnapshotBuilder 测试
 *
 * 覆盖：
 * - 单根/多根工作区扫描与 scoped 路径
 * - 强制排除绝对路径（存档目录自身）
 * - 大小上限排除
 * - 流式哈希正确性（与 readFile 一致）
 * - stat 复用哈希
 * - 不可读文件记录
 */

async function writeFile(rootDir: string, relativePath: string, content: string = ''): Promise<void> {
    const fullPath = path.join(rootDir, relativePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, 'utf-8');
}

function md5(content: string): string {
    return crypto.createHash('md5').update(content).digest('hex');
}

describe('CheckpointSnapshotBuilder', () => {
    test('scans a single root and produces scoped hashes and empty dirs', async () => {
        const rootDir = await createTempWorkspace();
        try {
            await writeFile(rootDir, 'src/main.ts', 'export const a = 1;\n');
            await writeFile(rootDir, 'src/lib/util.ts', 'export const b = 2;\n');
            await writeFile(rootDir, 'empty/nested', ''); // 文件，不是空目录
            await fs.mkdir(path.join(rootDir, 'empty'), { recursive: true });
            // empty/ 下已有文件，需单独建一个真空目录
            await fs.mkdir(path.join(rootDir, 'vacant'), { recursive: true });

            const roots = createRuntimeWorkspaceRoots([
                { name: 'ws', uri: `file:///${rootDir.replace(/\\/g, '/')}`, fsPath: rootDir }
            ]);
            const result = await buildWorkspaceSnapshot({ roots });

            const mainScoped = createWorkspaceScopedPath(roots[0].id, 'src/main.ts');
            expect(result.fileHashes[mainScoped]).toBe(md5('export const a = 1;\n'));
            expect(result.fileHashes[createWorkspaceScopedPath(roots[0].id, 'src/lib/util.ts')])
                .toBe(md5('export const b = 2;\n'));
            expect(result.emptyDirs).toContain(createWorkspaceScopedPath(roots[0].id, 'vacant'));
            expect(result.sizeExcluded).toHaveLength(0);
            expect(result.unreadable).toHaveLength(0);
        } finally {
            await fs.rm(rootDir, { recursive: true, force: true });
        }
    });

    test('scans multiple roots and keeps workspace identity in scoped paths', async () => {
        const rootA = await createTempWorkspace();
        const rootB = await createTempWorkspace();
        try {
            await writeFile(rootA, 'a.txt', 'AAA');
            await writeFile(rootB, 'b.txt', 'BBB');

            const roots = createRuntimeWorkspaceRoots([
                { name: 'A', uri: `file:///${rootA.replace(/\\/g, '/')}`, fsPath: rootA },
                { name: 'B', uri: `file:///${rootB.replace(/\\/g, '/')}`, fsPath: rootB }
            ]);
            const rootAInfo = roots.find(root => root.name === 'A')!;
            const rootBInfo = roots.find(root => root.name === 'B')!;
            const result = await buildWorkspaceSnapshot({ roots });

            expect(Object.keys(result.fileHashes)).toHaveLength(2);
            expect(result.fileHashes[createWorkspaceScopedPath(rootAInfo.id, 'a.txt')]).toBe(md5('AAA'));
            expect(result.fileHashes[createWorkspaceScopedPath(rootBInfo.id, 'b.txt')]).toBe(md5('BBB'));
            expect(result.roots).toHaveLength(2);
        } finally {
            await fs.rm(rootA, { recursive: true, force: true });
            await fs.rm(rootB, { recursive: true, force: true });
        }
    });

    test('excludes absolute paths that live inside the workspace (checkpoint dir itself)', async () => {
        const rootDir = await createTempWorkspace();
        try {
            await writeFile(rootDir, 'src/app.ts', 'code');
            const checkpointDir = path.join(rootDir, '.limcode', 'checkpoints');
            await writeFile(path.join(checkpointDir, 'cp_x', 'src', 'app.ts'), 'backup copy');

            const roots = createRuntimeWorkspaceRoots([
                { name: 'ws', uri: `file:///${rootDir.replace(/\\/g, '/')}`, fsPath: rootDir }
            ]);
            const result = await buildWorkspaceSnapshot({
                roots,
                excludeAbsolutePaths: [checkpointDir]
            });

            const scoped = createWorkspaceScopedPath(roots[0].id, 'src/app.ts');
            expect(result.fileHashes[scoped]).toBe(md5('code'));
            // 存档目录自身绝不进入快照
            expect(Object.keys(result.fileHashes).some(key => key.includes('checkpoints'))).toBe(false);
            expect(Object.keys(result.fileHashes)).toHaveLength(1);
        } finally {
            await fs.rm(rootDir, { recursive: true, force: true });
        }
    });

    test('records size-excluded files instead of hashing them', async () => {
        const rootDir = await createTempWorkspace();
        try {
            await writeFile(rootDir, 'model.bin', 'x'.repeat(100));
            await writeFile(rootDir, 'small.txt', 'ok');

            const roots = createRuntimeWorkspaceRoots([
                { name: 'ws', uri: `file:///${rootDir.replace(/\\/g, '/')}`, fsPath: rootDir }
            ]);
            const result = await buildWorkspaceSnapshot({ roots, maxFileSizeBytes: 50 });

            const modelScoped = createWorkspaceScopedPath(roots[0].id, 'model.bin');
            expect(result.fileHashes[modelScoped]).toBeUndefined();
            expect(result.sizeExcluded).toHaveLength(1);
            expect(result.sizeExcluded[0]).toMatchObject({ scopedPath: modelScoped, reason: 'size', size: 100 });
            // EX-07/EX-09: size 排除同样进入 excluded 清单（不静默消失）
            expect(result.excluded).toContainEqual({ path: modelScoped, reason: 'size', size: 100 });
            expect(result.fileHashes[createWorkspaceScopedPath(roots[0].id, 'small.txt')]).toBe(md5('ok'));
        } finally {
            await fs.rm(rootDir, { recursive: true, force: true });
        }
    });

    test('reuses previous hashes when stat is unchanged', async () => {
        const rootDir = await createTempWorkspace();
        try {
            await writeFile(rootDir, 'src/main.ts', 'stable content');

            const roots = createRuntimeWorkspaceRoots([
                { name: 'ws', uri: `file:///${rootDir.replace(/\\/g, '/')}`, fsPath: rootDir }
            ]);
            const scoped = createWorkspaceScopedPath(roots[0].id, 'src/main.ts');

            // 第一轮：真实哈希
            const first = await buildWorkspaceSnapshot({ roots });
            const realHash = first.fileHashes[scoped];
            expect(realHash).toBe(md5('stable content'));

            // 第二轮：伪造 previous 哈希 + 真实 stat（stat 未变 → 应直接复用伪造值，证明没重新读盘）
            const fakeHash = 'f'.repeat(32);
            const fakePrevious: SnapshotBuildOptions['previous'] = {
                fileHashes: { [scoped]: fakeHash },
                fileStats: {
                    [scoped]: {
                        mtimeMs: first.fileStats[scoped].mtimeMs,
                        size: first.fileStats[scoped].size,
                        mtimeNs: first.fileStats[scoped].mtimeNs
                    }
                }
            };
            const second = await buildWorkspaceSnapshot({ roots, previous: fakePrevious });
            expect(second.fileHashes[scoped]).toBe(fakeHash);

            // 第三轮：stat 变化（mtimeNs 不同）→ 应重新哈希
            const changedPrevious: SnapshotBuildOptions['previous'] = {
                fileHashes: { [scoped]: fakeHash },
                fileStats: { [scoped]: { mtimeMs: 1, size: 99, mtimeNs: '1' } }
            };
            const third = await buildWorkspaceSnapshot({ roots, previous: changedPrevious });
            expect(third.fileHashes[scoped]).toBe(realHash);
        } finally {
            await fs.rm(rootDir, { recursive: true, force: true });
        }
    });

    test('records unreadable files without failing the whole snapshot', async () => {
        const rootDir = await createTempWorkspace();
        try {
            await writeFile(rootDir, 'good.txt', 'fine');
            // L-1: bad.txt 是真实文件，但 createReadStream 被 mock 为失败（EACCES）——
            // 构造“真实不可读文件”，跨平台确定（chmod 0 在 Windows 上不可靠）
            await writeFile(rootDir, 'bad.txt', 'secret');

            const roots = createRuntimeWorkspaceRoots([
                { name: 'ws', uri: `file:///${rootDir.replace(/\\/g, '/')}`, fsPath: rootDir }
            ]);
            const result = await buildWorkspaceSnapshot({ roots });

            expect(result.fileHashes[createWorkspaceScopedPath(roots[0].id, 'good.txt')]).toBe(md5('fine'));
            // bad.txt 哈希流读取失败 → 归入 unreadable，且不进入 fileHashes
            expect(result.unreadable).toHaveLength(1);
            expect(result.unreadable[0]).toMatchObject({
                scopedPath: createWorkspaceScopedPath(roots[0].id, 'bad.txt'),
                reason: 'unreadable'
            });
            expect(result.fileHashes[createWorkspaceScopedPath(roots[0].id, 'bad.txt')]).toBeUndefined();
            // unreadable 同样进入 excluded 清单（EX-09，不静默消失）
            expect(result.excluded).toContainEqual({
                path: createWorkspaceScopedPath(roots[0].id, 'bad.txt'),
                reason: 'unreadable'
            });
        } finally {
            await fs.rm(rootDir, { recursive: true, force: true });
        }
    });

    test('respects custom ignore patterns per root', async () => {
        const rootDir = await createTempWorkspace();
        try {
            await writeFile(rootDir, 'generated/code.ts', 'ignored');
            await writeFile(rootDir, 'src/app.ts', 'tracked');

            const roots = createRuntimeWorkspaceRoots([
                { name: 'ws', uri: `file:///${rootDir.replace(/\\/g, '/')}`, fsPath: rootDir }
            ]);
            const result = await buildWorkspaceSnapshot({ roots, customIgnorePatterns: ['generated/'] });

            expect(Object.keys(result.fileHashes)).toEqual([
                createWorkspaceScopedPath(roots[0].id, 'src/app.ts')
            ]);
        } finally {
            await fs.rm(rootDir, { recursive: true, force: true });
        }
    });

    test('CP-DUP-1: snapshot hashing converges to the shared hashFileStreaming implementation', async () => {
        const rootDir = await createTempWorkspace();
        try {
            await writeFile(rootDir, 'src/main.ts', 'shared hash');

            const roots = createRuntimeWorkspaceRoots([
                { name: 'ws', uri: `file:///${rootDir.replace(/\\/g, '/')}`, fsPath: rootDir }
            ]);
            const result = await buildWorkspaceSnapshot({ roots });

            // 共享实现与 crypto 直算一致，且快照构建器（现引用共享函数）产出一致
            const absolutePath = path.join(rootDir, 'src', 'main.ts');
            const sharedHash = await hashFileStreaming(absolutePath);
            expect(sharedHash).toBe(md5('shared hash'));
            expect(result.fileHashes[createWorkspaceScopedPath(roots[0].id, 'src/main.ts')]).toBe(sharedHash);
        } finally {
            await fs.rm(rootDir, { recursive: true, force: true });
        }
    });

    test('CP-DUP-1: forced absolute-path exclusion is case-insensitive on case-insensitive platforms', async () => {
        // 大小写折叠只在 win32 / darwin（默认大小写不敏感卷）生效；大小写敏感平台跳过
        if (process.platform !== 'win32' && process.platform !== 'darwin') {
            return;
        }
        const rootDir = await createTempWorkspace();
        try {
            await writeFile(rootDir, 'src/app.ts', 'code');
            const checkpointDir = path.join(rootDir, '.limcode', 'checkpoints');
            await writeFile(path.join(checkpointDir, 'cp_x', 'src', 'app.ts'), 'backup copy');

            const roots = createRuntimeWorkspaceRoots([
                { name: 'ws', uri: `file:///${rootDir.replace(/\\/g, '/')}`, fsPath: rootDir }
            ]);
            // 排除配置使用不同大小写（.LIMCODE/CHECKPOINTS）→ 仍应命中强制排除
            const upperDir = path.join(rootDir, '.LIMCODE', 'CHECKPOINTS');
            const result = await buildWorkspaceSnapshot({ roots, excludeAbsolutePaths: [upperDir] });

            expect(Object.keys(result.fileHashes)).toEqual([
                createWorkspaceScopedPath(roots[0].id, 'src/app.ts')
            ]);
            expect(result.fileHashes[createWorkspaceScopedPath(roots[0].id, 'src/app.ts')]).toBe(md5('code'));
        } finally {
            await fs.rm(rootDir, { recursive: true, force: true });
        }
    });

    test('CP-PREV-2: preview exclusion samples are sorted by path and stable across runs', async () => {
        const rootDir = await createTempWorkspace();
        try {
            // 大量超限文件由 runBounded 并发 push（顺序不确定）+ resolver 层顺序条目（logs）
            for (let i = 0; i < 30; i += 1) {
                await writeFile(rootDir, `big-${String(i).padStart(2, '0')}.bin`, 'x'.repeat(200));
            }
            await writeFile(rootDir, 'debug.log', 'log');
            await writeFile(rootDir, 'src/main.ts', 'code');

            const roots = createRuntimeWorkspaceRoots([
                { name: 'ws', uri: `file:///${rootDir.replace(/\\/g, '/')}`, fsPath: rootDir }
            ]);
            const options = { roots, enabledProfiles: { logs: true }, maxFileSizeBytes: 100 };
            const first = await previewExclusions(options);
            const second = await previewExclusions(options);

            const paths1 = first.summary.samples.map(s => s.path);
            const paths2 = second.summary.samples.map(s => s.path);
            // 两次预览顺序一致（确定性）
            expect(paths1).toEqual(paths2);
            // 且按 path 字典序（CP-PREV-2：收集完成后排序再截取样本）
            const sorted = [...paths1].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
            expect(paths1).toEqual(sorted);
            // 各 profile 桶的 samples 同样稳定
            expect(first.byProfile.logs.samples.map(s => s.path))
                .toEqual(second.byProfile.logs.samples.map(s => s.path));
            expect(first.byProfile.other.samples.length).toBeGreaterThan(0);
            expect(first.summary.excludedCount).toBe(31); // 30 超限 + 1 日志
        } finally {
            await fs.rm(rootDir, { recursive: true, force: true });
        }
    });

/**
 * EX-01/EX-02/EX-07/EX-09 专项测试：
 * - 默认排除类别经 builder 生效，且 excluded 清单带原因
 * - 存储自排除进入 excluded（reason=forced, source=storage）
 * - previewExclusions 聚合 / 样本上限 / complete 标记
 */

describe('CheckpointSnapshotBuilder - exclusions (EX-01/EX-02/EX-07/EX-09)', () => {
    test('applies default profiles and reports excluded entries with reasons', async () => {
        const rootDir = await createTempWorkspace();
        try {
            await writeFile(rootDir, 'debug.log', 'log');
            await writeFile(rootDir, 'dist/bundle.js', 'bundle');
            await writeFile(rootDir, 'src/main.ts', 'code');

            const roots = createRuntimeWorkspaceRoots([
                { name: 'ws', uri: `file:///${rootDir.replace(/\\/g, '/')}`, fsPath: rootDir }
            ]);
            const result = await buildWorkspaceSnapshot({
                roots,
                enabledProfiles: { logs: true, buildArtifacts: true }
            });

            expect(Object.keys(result.fileHashes)).toEqual([
                createWorkspaceScopedPath(roots[0].id, 'src/main.ts')
            ]);

            const byPath = Object.fromEntries(result.excluded.map(e => [e.path, e]));
            expect(byPath[createWorkspaceScopedPath(roots[0].id, 'debug.log')])
                .toMatchObject({ reason: 'default', source: 'logs' });
            expect(byPath[createWorkspaceScopedPath(roots[0].id, 'dist')])
                .toMatchObject({ reason: 'default', source: 'buildArtifacts' });
        } finally {
            await fs.rm(rootDir, { recursive: true, force: true });
        }
    });

    test('storage self-exclusion appears in excluded with forced reason (EX-02)', async () => {
        const rootDir = await createTempWorkspace();
        try {
            await writeFile(rootDir, 'src/app.ts', 'code');
            const checkpointDir = path.join(rootDir, '.limcode', 'checkpoints');
            await writeFile(path.join(checkpointDir, 'cp_x', 'src', 'app.ts'), 'backup copy');

            const roots = createRuntimeWorkspaceRoots([
                { name: 'ws', uri: `file:///${rootDir.replace(/\\/g, '/')}`, fsPath: rootDir }
            ]);
            const result = await buildWorkspaceSnapshot({
                roots,
                excludeAbsolutePaths: [checkpointDir]
            });

            expect(Object.keys(result.fileHashes)).toEqual([
                createWorkspaceScopedPath(roots[0].id, 'src/app.ts')
            ]);
            const storageEntry = result.excluded.find(e => e.path.includes('.limcode'));
            expect(storageEntry).toMatchObject({ reason: 'forced', source: 'storage' });
        } finally {
            await fs.rm(rootDir, { recursive: true, force: true });
        }
    });

    test('previewExclusions aggregates by profile and caps samples at 50', async () => {
        const rootDir = await createTempWorkspace();
        try {
            // 日志文件放根目录（`logs/` 目录模式会整目录剪枝，无法统计到 60 个文件）
            for (let i = 0; i < 60; i += 1) {
                await writeFile(rootDir, `log${i}.log`, `log${i}`);
            }
            await writeFile(rootDir, 'dist/bundle.js', 'bundle');
            await writeFile(rootDir, 'big.bin', 'x'.repeat(200));
            await writeFile(rootDir, 'src/main.ts', 'code');

            const roots = createRuntimeWorkspaceRoots([
                { name: 'ws', uri: `file:///${rootDir.replace(/\\/g, '/')}`, fsPath: rootDir }
            ]);
            const result = await previewExclusions({
                roots,
                enabledProfiles: { logs: true, buildArtifacts: true },
                maxFileSizeBytes: 100
            });

            // 60 个日志 + dist 目录 + big.bin 超限
            expect(result.summary.excludedCount).toBe(62);
            expect(result.summary.samples.length).toBeLessThanOrEqual(50);

            expect(result.byProfile.logs.excludedCount).toBe(60);
            expect(result.byProfile.logs.samples.length).toBeLessThanOrEqual(50);
            expect(result.byProfile.buildArtifacts.excludedCount).toBe(1);

            // gitignore/custom/size/forced 归入 other
            const sizeSample = result.byProfile.other.samples.find(s => s.reason === 'size');
            expect(sizeSample).toBeDefined();
            expect(sizeSample?.size).toBe(200);
            expect(result.summary.byReason['size']).toMatchObject({ count: 1, bytes: 200 });
            expect(result.ignoreSnapshot.maxFileSizeBytes).toBe(100);
            expect(result.complete).toBe(true);
        } finally {
            await fs.rm(rootDir, { recursive: true, force: true });
        }
    });

    test('previewExclusions honors custom negation and reports gitignore source', async () => {
        const rootDir = await createTempWorkspace();
        try {
            await writeFile(rootDir, '.gitignore', '*.tmp\n');
            await writeFile(rootDir, 'a.tmp', 'gitignored');
            await writeFile(rootDir, 'debug.log', 'profile');
            await writeFile(rootDir, 'keep.log', 're-included');
            await writeFile(rootDir, 'src/main.ts', 'code');

            const roots = createRuntimeWorkspaceRoots([
                { name: 'ws', uri: `file:///${rootDir.replace(/\\/g, '/')}`, fsPath: rootDir }
            ]);
            const result = await previewExclusions({
                roots,
                enabledProfiles: { logs: true },
                customIgnorePatterns: ['!keep.log']
            });

            const byPath = Object.fromEntries(result.summary.samples.map(s => [s.path, s]));

            const aTmp = byPath[createWorkspaceScopedPath(roots[0].id, 'a.tmp')];
            expect(aTmp).toMatchObject({ reason: 'gitignore', source: '.gitignore', rule: '*.tmp' });
            const debugLog = byPath[createWorkspaceScopedPath(roots[0].id, 'debug.log')];
            expect(debugLog).toMatchObject({ reason: 'default', source: 'logs' });
            // keep.log 被 ! 重新纳入 → 不在排除清单
            expect(byPath[createWorkspaceScopedPath(roots[0].id, 'keep.log')]).toBeUndefined();
        } finally {
            await fs.rm(rootDir, { recursive: true, force: true });
        }
    });

    test('L-2: previewExclusions marks complete=false when an excluded dir walk is truncated (maxDirWalkEntries)', async () => {
        const rootDir = await createTempWorkspace();
        try {
            for (let i = 0; i < 5; i += 1) {
                await writeFile(rootDir, `dist/f${i}.js`, `bundle${i}`);
            }
            await writeFile(rootDir, 'src/main.ts', 'code');

            const roots = createRuntimeWorkspaceRoots([
                { name: 'ws', uri: `file:///${rootDir.replace(/\\/g, '/')}`, fsPath: rootDir }
            ]);
            const result = await previewExclusions({
                roots,
                enabledProfiles: { buildArtifacts: true },
                maxDirWalkEntries: 2
            });

            // dist 目录本身被排除，但大小遍历被截断 → complete=false
            expect(result.summary.excludedCount).toBe(1);
            expect(result.complete).toBe(false);
        } finally {
            await fs.rm(rootDir, { recursive: true, force: true });
        }
    });

    test('L-2: previewExclusions maxFileSizeBytes 0 means unlimited', async () => {
        const rootDir = await createTempWorkspace();
        try {
            await writeFile(rootDir, 'big.bin', 'x'.repeat(200));
            await writeFile(rootDir, 'src/main.ts', 'code');

            const roots = createRuntimeWorkspaceRoots([
                { name: 'ws', uri: `file:///${rootDir.replace(/\\/g, '/')}`, fsPath: rootDir }
            ]);
            const result = await previewExclusions({ roots, maxFileSizeBytes: 0 });

            expect(result.summary.byReason['size']).toBeUndefined();
            expect(result.summary.excludedCount).toBe(0);
            expect(result.complete).toBe(true);
        } finally {
            await fs.rm(rootDir, { recursive: true, force: true });
        }
    });

    test('M-6: previewExclusions marks complete=false and counts unreadable directories', async () => {
        const rootDir = await createTempWorkspace();
        try {
            await writeFile(rootDir, 'src/main.ts', 'code');
            await fs.mkdir(path.join(rootDir, 'blocked'), { recursive: true });
            await writeFile(path.join(rootDir, 'blocked', 'secret.txt'), 'hidden');

            const roots = createRuntimeWorkspaceRoots([
                { name: 'ws', uri: `file:///${rootDir.replace(/\\/g, '/')}`, fsPath: rootDir }
            ]);
            const result = await previewExclusions({ roots });

            // 不可读目录进入 excluded 统计，且扫描被标记为不完整
            expect(result.complete).toBe(false);
            const unreadableSamples = result.summary.samples.filter(s => s.reason === 'unreadable');
            expect(unreadableSamples.length).toBeGreaterThanOrEqual(1);
            expect(result.summary.byReason['unreadable']).toMatchObject({ count: 1 });
        } finally {
            await fs.rm(rootDir, { recursive: true, force: true });
        }
    });
});
});