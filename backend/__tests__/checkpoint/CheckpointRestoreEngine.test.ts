import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
    computeRestorePlan,
    restoreWorkspaceSnapshot,
    type RestoreChainEntry,
    type RestoreTargetState
} from '../../modules/checkpoint/CheckpointRestoreEngine';
import {
    createRuntimeWorkspaceRoots,
    createWorkspaceScopedPath,
    type RuntimeWorkspaceRoot
} from '../../modules/checkpoint/CheckpointWorkspace';

/**
 * CheckpointRestoreEngine 测试
 *
 * 覆盖：
 * - 完整备份恢复（文件 + 空目录）
 * - 增量链合并（最新节点覆盖旧节点）
 * - 删除多余文件与受保护路径
 * - missing_in_chain / hash_mismatch 失败清单
 * - 旧格式（相对路径）单根兼容
 */

async function createTempWorkspace(): Promise<string> {
    return fs.mkdtemp(path.join(os.tmpdir(), 'limcode-cp-restore-'));
}

async function writeFile(rootDir: string, relativePath: string, content: string = ''): Promise<void> {
    const fullPath = path.join(rootDir, relativePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, 'utf-8');
}

function md5(content: string): string {
    return crypto.createHash('md5').update(content).digest('hex');
}

interface TestContext {
    workspaceDir: string;
    checkpointsDir: string;
    roots: RuntimeWorkspaceRoot[];
}

async function setupContext(): Promise<TestContext> {
    const workspaceDir = await createTempWorkspace();
    const checkpointsDir = path.join(workspaceDir, '..', `cp-store-${path.basename(workspaceDir)}`);
    await fs.mkdir(checkpointsDir, { recursive: true });
    const roots = createRuntimeWorkspaceRoots([
        { name: 'ws', uri: `file:///${workspaceDir.replace(/\\/g, '/')}`, fsPath: workspaceDir }
    ]);
    return { workspaceDir, checkpointsDir, roots };
}

/** 创建完整备份节点（新布局：scoped 键 → 备份文件位于 backupDir/ws_xxx/relative） */
async function createFullBackup(
    ctx: TestContext,
    id: string,
    files: Record<string, string>
): Promise<RestoreChainEntry> {
    const backupDir = path.join(ctx.checkpointsDir, id);
    const fileHashes: Record<string, string> = {};
    for (const [relativePath, content] of Object.entries(files)) {
        await writeFile(backupDir, `${ctx.roots[0].id}/${relativePath}`, content);
        fileHashes[createWorkspaceScopedPath(ctx.roots[0].id, relativePath)] = md5(content);
    }
    return { checkpointId: id, backupDir: id, fileHashes };
}

/** 创建增量备份节点（只包含变更文件） */
async function createIncrementalBackup(
    ctx: TestContext,
    id: string,
    files: Record<string, string>
): Promise<RestoreChainEntry> {
    return createFullBackup(ctx, id, files);
}

function scoped(ctx: TestContext, relativePath: string): string {
    return createWorkspaceScopedPath(ctx.roots[0].id, relativePath);
}

async function readWorkspaceFile(ctx: TestContext, relativePath: string): Promise<string> {
    return fs.readFile(path.join(ctx.workspaceDir, relativePath), 'utf-8');
}

async function collectCurrentState(
    ctx: TestContext
): Promise<{ hashes: Record<string, string>; emptyDirs: string[] }> {
    const hashes: Record<string, string> = {};
    const emptyDirs: string[] = [];
    const walk = async (dir: string): Promise<void> => {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        let isEmpty = true;
        for (const entry of entries) {
            isEmpty = false;
            const fullPath = path.join(dir, entry.name);
            const relativePath = path.relative(ctx.workspaceDir, fullPath).replace(/\\/g, '/');
            if (entry.isDirectory()) {
                await walk(fullPath);
            } else {
                hashes[scoped(ctx, relativePath)] = md5(await fs.readFile(fullPath, 'utf-8'));
            }
        }
        if (isEmpty && dir !== ctx.workspaceDir) {
            emptyDirs.push(scoped(ctx, path.relative(ctx.workspaceDir, dir).replace(/\\/g, '/')));
        }
    };
    await walk(ctx.workspaceDir);
    return { hashes, emptyDirs };
}

describe('CheckpointRestoreEngine', () => {
    test('restores files and empty dirs from a full backup', async () => {
        const ctx = await setupContext();
        try {
            // 工作区当前状态：一个被修改的文件 + 一个多余文件
            await writeFile(ctx.workspaceDir, 'src/main.ts', 'changed');
            await writeFile(ctx.workspaceDir, 'extra.txt', 'should be deleted');

            const chain = [await createFullBackup(ctx, 'cp_full', {
                'src/main.ts': 'original',
                'src/lib.ts': 'lib'
            })];

            // 备份中的空目录（scoped 布局：cp_full/ws_xxx/docs）
            await fs.mkdir(path.join(ctx.checkpointsDir, 'cp_full', ctx.roots[0].id, 'docs'), { recursive: true });

            const target: RestoreTargetState = {
                fileHashes: {
                    [scoped(ctx, 'src/main.ts')]: md5('original'),
                    [scoped(ctx, 'src/lib.ts')]: md5('lib')
                },
                emptyDirs: [scoped(ctx, 'docs')]
            };

            const current = await collectCurrentState(ctx);
            const result = await restoreWorkspaceSnapshot(
                { checkpointsDir: ctx.checkpointsDir, roots: ctx.roots },
                chain,
                target,
                current.hashes,
                current.emptyDirs
            );

            expect(result.success).toBe(true);
            expect(result.restored).toBe(2);
            expect(result.deleted).toBe(1); // extra.txt
            expect(await readWorkspaceFile(ctx, 'src/main.ts')).toBe('original');
            expect(await readWorkspaceFile(ctx, 'src/lib.ts')).toBe('lib');
            await expect(fs.access(path.join(ctx.workspaceDir, 'extra.txt'))).rejects.toThrow();
            // 空目录已重建
            await expect(fs.access(path.join(ctx.workspaceDir, 'docs'))).resolves.toBeUndefined();
        } finally {
            await fs.rm(ctx.workspaceDir, { recursive: true, force: true });
            await fs.rm(ctx.checkpointsDir, { recursive: true, force: true });
        }
    });

    test('merges incremental chain with newest node winning', async () => {
        const ctx = await setupContext();
        try {
            await writeFile(ctx.workspaceDir, 'a.txt', 'old a');
            await writeFile(ctx.workspaceDir, 'b.txt', 'old b');

            const base = await createFullBackup(ctx, 'cp_base', {
                'a.txt': 'base a',
                'b.txt': 'base b'
            });
            const inc = await createIncrementalBackup(ctx, 'cp_inc', {
                'a.txt': 'inc a'
            });
            const chain = [base, inc];

            const target: RestoreTargetState = {
                fileHashes: {
                    [scoped(ctx, 'a.txt')]: md5('inc a'),
                    [scoped(ctx, 'b.txt')]: md5('base b')
                },
                emptyDirs: []
            };

            const current = await collectCurrentState(ctx);
            const result = await restoreWorkspaceSnapshot(
                { checkpointsDir: ctx.checkpointsDir, roots: ctx.roots },
                chain,
                target,
                current.hashes,
                current.emptyDirs
            );

            expect(result.success).toBe(true);
            expect(await readWorkspaceFile(ctx, 'a.txt')).toBe('inc a');
            expect(await readWorkspaceFile(ctx, 'b.txt')).toBe('base b');
        } finally {
            await fs.rm(ctx.workspaceDir, { recursive: true, force: true });
            await fs.rm(ctx.checkpointsDir, { recursive: true, force: true });
        }
    });

    test('skips protected paths when deleting extra files', async () => {
        const ctx = await setupContext();
        try {
            await writeFile(ctx.workspaceDir, 'keep.txt', 'user file');
            await writeFile(ctx.workspaceDir, 'tracked.txt', 'current');

            const chain = [await createFullBackup(ctx, 'cp_full', {
                'tracked.txt': 'backup'
            })];

            const target: RestoreTargetState = {
                fileHashes: { [scoped(ctx, 'tracked.txt')]: md5('backup') },
                emptyDirs: []
            };

            const current = await collectCurrentState(ctx);
            const result = await restoreWorkspaceSnapshot(
                {
                    checkpointsDir: ctx.checkpointsDir,
                    roots: ctx.roots,
                    protectedScopedPaths: new Set([scoped(ctx, 'keep.txt')])
                },
                chain,
                target,
                current.hashes,
                current.emptyDirs
            );

            expect(result.success).toBe(true);
            expect(result.deleted).toBe(0);
            // 受保护文件保留
            await expect(fs.access(path.join(ctx.workspaceDir, 'keep.txt'))).resolves.toBeUndefined();
        } finally {
            await fs.rm(ctx.workspaceDir, { recursive: true, force: true });
            await fs.rm(ctx.checkpointsDir, { recursive: true, force: true });
        }
    });

    test('reports missing_in_chain when backup file is absent', async () => {
        const ctx = await setupContext();
        try {
            await writeFile(ctx.workspaceDir, 'ghost.txt', 'current');

            // 备份目录里声明了 ghost.txt 但文件不存在
            const chain = [await createFullBackup(ctx, 'cp_full', {})];
            chain[0].fileHashes![scoped(ctx, 'ghost.txt')] = md5('declared');

            const target: RestoreTargetState = {
                fileHashes: { [scoped(ctx, 'ghost.txt')]: md5('declared') },
                emptyDirs: []
            };

            const current = await collectCurrentState(ctx);
            const result = await restoreWorkspaceSnapshot(
                { checkpointsDir: ctx.checkpointsDir, roots: ctx.roots },
                chain,
                target,
                current.hashes,
                current.emptyDirs
            );

            expect(result.success).toBe(false);
            expect(result.failures).toEqual([
                { path: scoped(ctx, 'ghost.txt'), reason: 'missing_in_chain' }
            ]);
        } finally {
            await fs.rm(ctx.workspaceDir, { recursive: true, force: true });
            await fs.rm(ctx.checkpointsDir, { recursive: true, force: true });
        }
    });

    test('reports hash_mismatch when backup content differs from declared hash', async () => {
        const ctx = await setupContext();
        try {
            await writeFile(ctx.workspaceDir, 'bad.txt', 'current');

            const chain = [await createFullBackup(ctx, 'cp_full', { 'bad.txt': 'backup content' })];
            // 篡改声明哈希
            chain[0].fileHashes![scoped(ctx, 'bad.txt')] = 'f'.repeat(32);

            const target: RestoreTargetState = {
                fileHashes: { [scoped(ctx, 'bad.txt')]: 'f'.repeat(32) },
                emptyDirs: []
            };

            const current = await collectCurrentState(ctx);
            const result = await restoreWorkspaceSnapshot(
                { checkpointsDir: ctx.checkpointsDir, roots: ctx.roots },
                chain,
                target,
                current.hashes,
                current.emptyDirs
            );

            expect(result.success).toBe(false);
            expect(result.failures[0]).toMatchObject({
                path: scoped(ctx, 'bad.txt'),
                reason: 'hash_mismatch'
            });
        } finally {
            await fs.rm(ctx.workspaceDir, { recursive: true, force: true });
            await fs.rm(ctx.checkpointsDir, { recursive: true, force: true });
        }
    });

    test('supports legacy relative-path checkpoints with a single root', async () => {
        const ctx = await setupContext();
        try {
            await writeFile(ctx.workspaceDir, 'legacy.txt', 'current');

            // 旧格式：fileHashes 键是相对路径，备份目录内也是相对路径
            const backupDir = path.join(ctx.checkpointsDir, 'cp_legacy');
            await writeFile(backupDir, 'legacy.txt', 'legacy content');
            const chain: RestoreChainEntry[] = [{
                checkpointId: 'cp_legacy',
                backupDir: 'cp_legacy',
                fileHashes: { 'legacy.txt': md5('legacy content') }
            }];

            const target: RestoreTargetState = {
                fileHashes: { 'legacy.txt': md5('legacy content') },
                emptyDirs: []
            };

            const current = await collectCurrentState(ctx);
            const result = await restoreWorkspaceSnapshot(
                { checkpointsDir: ctx.checkpointsDir, roots: ctx.roots },
                chain,
                target,
                current.hashes,
                current.emptyDirs
            );

            expect(result.success).toBe(true);
            expect(await readWorkspaceFile(ctx, 'legacy.txt')).toBe('legacy content');
        } finally {
            await fs.rm(ctx.workspaceDir, { recursive: true, force: true });
            await fs.rm(ctx.checkpointsDir, { recursive: true, force: true });
        }
    });

    test('restores unchanged files from base when incremental node only stores changes', async () => {
        const ctx = await setupContext();
        try {
            await writeFile(ctx.workspaceDir, 'a.txt', 'old a');
            await writeFile(ctx.workspaceDir, 'b.txt', 'old b');

            // base：完整备份 a.txt + b.txt
            const base = await createFullBackup(ctx, 'cp_base', {
                'a.txt': 'base a',
                'b.txt': 'base b'
            });

            // inc：真实增量布局——磁盘上只保存了 a.txt（changes 只有 a.txt），
            // 但 fileHashes 是完整工作区映射（与 CheckpointManager 写入的记录一致）。
            // 未变化的 b.txt 必须从 base 节点恢复，而不是被误指到 inc 节点报 missing_in_chain。
            const incDir = path.join(ctx.checkpointsDir, 'cp_inc');
            await writeFile(incDir, `${ctx.roots[0].id}/a.txt`, 'inc a');
            const inc: RestoreChainEntry = {
                checkpointId: 'cp_inc',
                backupDir: 'cp_inc',
                fileHashes: {
                    [scoped(ctx, 'a.txt')]: md5('inc a'),
                    [scoped(ctx, 'b.txt')]: md5('base b')
                },
                changes: [{ path: scoped(ctx, 'a.txt'), type: 'modified' }]
            };
            const chain = [base, inc];

            const target: RestoreTargetState = {
                fileHashes: {
                    [scoped(ctx, 'a.txt')]: md5('inc a'),
                    [scoped(ctx, 'b.txt')]: md5('base b')
                },
                emptyDirs: []
            };

            const current = await collectCurrentState(ctx);
            const result = await restoreWorkspaceSnapshot(
                { checkpointsDir: ctx.checkpointsDir, roots: ctx.roots },
                chain,
                target,
                current.hashes,
                current.emptyDirs
            );

            expect(result.success).toBe(true);
            expect(result.restored).toBe(2);
            expect(await readWorkspaceFile(ctx, 'a.txt')).toBe('inc a');
            expect(await readWorkspaceFile(ctx, 'b.txt')).toBe('base b');
        } finally {
            await fs.rm(ctx.workspaceDir, { recursive: true, force: true });
            await fs.rm(ctx.checkpointsDir, { recursive: true, force: true });
        }
    });

    test('ignores backup entries whose backupDir escapes checkpointsDir', async () => {
        const ctx = await setupContext();
        let outsideDir: string | undefined;
        try {
            await writeFile(ctx.workspaceDir, 'a.txt', 'current');

            // 越界备份源：checkpointsDir 之外的真实文件（损坏元数据指向它时绝不能读取）
            outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-cp-outside-'));
            await writeFile(outsideDir, 'a.txt', 'outside content');

            const chain: RestoreChainEntry[] = [{
                checkpointId: 'cp-evil',
                backupDir: `../../${path.basename(outsideDir)}`,
                fileHashes: { [scoped(ctx, 'a.txt')]: md5('outside content') }
            }];
            const target: RestoreTargetState = {
                fileHashes: { [scoped(ctx, 'a.txt')]: md5('outside content') },
                emptyDirs: []
            };

            const current = await collectCurrentState(ctx);
            const result = await restoreWorkspaceSnapshot(
                { checkpointsDir: ctx.checkpointsDir, roots: ctx.roots },
                chain,
                target,
                current.hashes,
                current.emptyDirs
            );

            expect(result.success).toBe(false);
            expect(result.failures).toEqual([
                { path: scoped(ctx, 'a.txt'), reason: 'missing_in_chain' }
            ]);
            // 工作区文件保持原样，未被越界内容覆盖
            await expect(readWorkspaceFile(ctx, 'a.txt')).resolves.toBe('current');
        } finally {
            if (outsideDir) {
                await fs.rm(outsideDir, { recursive: true, force: true });
            }
            await fs.rm(ctx.workspaceDir, { recursive: true, force: true });
            await fs.rm(ctx.checkpointsDir, { recursive: true, force: true });
        }
    });

    test('computeRestorePlan filters protected paths and deletion whitelist (CP-09 preview)', async () => {
        const ctx = await setupContext();
        try {
            // 目标状态只有 tracked.txt
            const target: RestoreTargetState = {
                fileHashes: { [scoped(ctx, 'tracked.txt')]: md5('v1') },
                emptyDirs: []
            };
            // 当前工作区：tracked.txt（内容不同 → 修改）、extra-untracked.txt（快照后新建）、protected.bin（未备份受保护）
            const current = {
                [scoped(ctx, 'tracked.txt')]: md5('v2'),
                [scoped(ctx, 'extra-untracked.txt')]: md5('x'),
                [scoped(ctx, 'protected.bin')]: md5('y')
            };

            // 白名单只含 tracked：extra 不在白名单、protected 受保护，都不应进入删除清单
            const plan = computeRestorePlan(
                {
                    checkpointsDir: ctx.checkpointsDir,
                    roots: ctx.roots,
                    protectedScopedPaths: new Set([scoped(ctx, 'protected.bin')]),
                    deletableScopedPaths: new Set([scoped(ctx, 'tracked.txt')])
                },
                [],
                target,
                current,
                []
            );

            expect(plan.added).toEqual([]);
            expect(plan.modified).toEqual([scoped(ctx, 'tracked.txt')]);
            expect(plan.toDelete).toEqual([]);
            // 快照后新建的 extra 不在白名单：默认保留（untrackedToDelete），受保护的 protected 完全排除
            expect(plan.untrackedToDelete).toEqual([scoped(ctx, 'extra-untracked.txt')]);
            expect(plan.skipped).toBe(0);

            // 白名单覆盖 extra 时：extra 进入删除清单，protected 仍受保护
            const plan2 = computeRestorePlan(
                {
                    checkpointsDir: ctx.checkpointsDir,
                    roots: ctx.roots,
                    protectedScopedPaths: new Set([scoped(ctx, 'protected.bin')]),
                    deletableScopedPaths: new Set([scoped(ctx, 'tracked.txt'), scoped(ctx, 'extra-untracked.txt')])
                },
                [],
                target,
                current,
                []
            );
            expect(plan2.toDelete).toEqual([scoped(ctx, 'extra-untracked.txt')]);
            expect(plan2.untrackedToDelete).toEqual([]);
        } finally {
            await fs.rm(ctx.workspaceDir, { recursive: true, force: true });
            await fs.rm(ctx.checkpointsDir, { recursive: true, force: true });
        }
    });

    test('restore keeps untracked empty dirs by default and removes them only after confirmation (CP-09)', async () => {
        const ctx = await setupContext();
        try {
            await writeFile(path.join(ctx.checkpointsDir, 'cp-1'), 'a.txt', 'v1\n');
            const chain: RestoreChainEntry[] = [{
                checkpointId: 'cp-1',
                backupDir: 'cp-1',
                fileHashes: { [scoped(ctx, 'a.txt')]: md5('v1\n') }
            }];
            const target: RestoreTargetState = {
                fileHashes: { [scoped(ctx, 'a.txt')]: md5('v1\n') },
                emptyDirs: []
            };

            // 工作区：a.txt（与目标一致）+ 空目录 newdir/（快照后新建）
            await writeFile(ctx.workspaceDir, 'a.txt', 'v1\n');
            await fs.mkdir(path.join(ctx.workspaceDir, 'newdir'), { recursive: true });

            const current = await collectCurrentState(ctx);
            const options = { checkpointsDir: ctx.checkpointsDir, roots: ctx.roots };

            // 默认（未确认）：快照后新建的空目录保留（#29 语义）
            const resultDefault = await restoreWorkspaceSnapshot(options, chain, target, current.hashes, current.emptyDirs);
            expect(resultDefault.success).toBe(true);
            await expect(fs.access(path.join(ctx.workspaceDir, 'newdir'))).resolves.toBeUndefined();

            // 确认删除快照后新建内容后：空目录被清理
            const resultConfirmed = await restoreWorkspaceSnapshot(
                { ...options, deleteUntrackedFiles: true },
                chain,
                target,
                current.hashes,
                current.emptyDirs
            );
            expect(resultConfirmed.success).toBe(true);
            await expect(fs.access(path.join(ctx.workspaceDir, 'newdir'))).rejects.toBeTruthy();
        } finally {
            await fs.rm(ctx.workspaceDir, { recursive: true, force: true });
            await fs.rm(ctx.checkpointsDir, { recursive: true, force: true });
        }
    });
});
