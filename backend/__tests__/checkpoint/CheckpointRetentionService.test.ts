/**
 * CheckpointRetentionService 测试（CP-RET-1 / CP-RET-2）
 *
 * 覆盖：
 * - 清理时对引用被删项的全部后继循环合并（异常元数据多节点引用同一 base 不悬空）
 * - 合并路径校验 backupDir（CP-RET-2）：越界目录名拒绝合并并中止删除
 * - 删除被拒绝（返回 false）时不以 deleted 标记，后续迭代继续处理其余候选
 */
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { CheckpointRetentionService } from '../../modules/checkpoint';
import { CheckpointManifestRepository, CHECKPOINT_MANIFEST_VERSION } from '../../modules/checkpoint';
import { isSafeCheckpointDirName } from '../../modules/checkpoint/CheckpointManifestRepository';
import type { CheckpointManifest } from '../../modules/checkpoint';
import type { CheckpointRecord } from '../../modules/checkpoint';
import { createTempDirectory, makeRecord } from '../__fixtures__/checkpointFixtures';

async function writeFile(rootDir: string, relativePath: string, content: string = ''): Promise<void> {
    const fullPath = path.join(rootDir, relativePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, 'utf-8');
}

function md5(content: string): string {
    return crypto.createHash('md5').update(content).digest('hex');
}

interface Harness {
    service: CheckpointRetentionService;
    checkpointsDir: string;
    storageRoot: string;
    stored: () => CheckpointRecord[];
    deletedIds: () => string[];
    manifestRepository: CheckpointManifestRepository;
}

/**
 * 构造 RetentionService 测试环境。
 *
 * deleteCheckpointInternal 模拟 CheckpointManager 的真实语义：backupDir 越界（CP-DEL-1）
 * 时拒绝删除并返回 false，其余情况移除记录并返回 true。
 */
/**
 * 保持本地的 createHarness（createHarness 收敛批次）：被测服务为 CheckpointRetentionService
 * （含 deleteCheckpointInternal 模拟与 manifestRepository），与共享 checkpoint harness 被测服务不同，
 * 不收敛，见 ../__fixtures__/harnessFixtures.ts 头注释。
 */
async function createHarness(seed: CheckpointRecord[], maxCheckpoints: number): Promise<Harness> {
    const storageRoot = await createTempDirectory('limcode-retention-');
    const checkpointsDir = path.join(storageRoot, 'checkpoints');
    const manifestRepository = new CheckpointManifestRepository(checkpointsDir);

    const metadata: { custom: { checkpoints: CheckpointRecord[] } } = {
        custom: { checkpoints: [...seed] }
    };
    const conversationManager = {
        getCustomMetadata: jest.fn().mockImplementation(async (_cid: string, key: string) => {
            return (metadata.custom as Record<string, unknown>)[key];
        }),
        getMetadata: jest.fn().mockResolvedValue(metadata),
        setCustomMetadata: jest.fn().mockImplementation(async (_cid: string, key: string, value: unknown) => {
            (metadata.custom as Record<string, unknown>)[key] = value;
        }),
        updateCustomMetadata: jest.fn().mockImplementation(
            (_cid: string, key: string, updater: (current: unknown) => unknown) => {
                const current = (metadata.custom as Record<string, unknown>)[key];
                const next = updater(current);
                if (next !== current) {
                    (metadata.custom as Record<string, unknown>)[key] = next;
                }
                return Promise.resolve(next);
            }
        )
    };

    const deletedIds: string[] = [];
    const service = new CheckpointRetentionService(
        {
            getCheckpointRecords: async () => metadata.custom.checkpoints,
            deleteCheckpointInternal: async (_cid: string, checkpointId: string) => {
                const cp = metadata.custom.checkpoints.find(c => c.id === checkpointId);
                if (!cp) {
                    return false;
                }
                // 与 CheckpointManager.deleteCheckpointInternal 同口径：越界 backupDir 拒绝删除
                if (!isSafeCheckpointDirName(cp.backupDir)) {
                    return false;
                }
                metadata.custom.checkpoints = metadata.custom.checkpoints.filter(c => c.id !== checkpointId);
                deletedIds.push(checkpointId);
                // 镜像真实行为：记录移除后删除备份目录
                try {
                    await fs.rm(path.join(checkpointsDir, cp.backupDir), { recursive: true, force: true });
                } catch {
                    // 目录不存在等：忽略
                }
                return true;
            },
            getCheckpointConfig: () => ({
                enabled: true,
                beforeTools: [],
                afterTools: [],
                messageCheckpoint: { beforeMessages: [], afterMessages: [] },
                maxCheckpoints,
                customIgnorePatterns: []
            })
        },
        checkpointsDir,
        manifestRepository,
        conversationManager as any
    );

    return {
        service,
        checkpointsDir,
        storageRoot,
        stored: () => metadata.custom.checkpoints,
        deletedIds: () => deletedIds,
        manifestRepository
    };
}

describe('CheckpointRetentionService', () => {
    test('cleanupOldCheckpoints merges into ALL dependents before deleting a shared base（CP-RET-1）', async () => {
        const baseContent = 'base only\n';
        const baseCp = makeRecord({
            id: 'cp-base', timestamp: 1000, type: 'full',
            fileHashes: { 'a.txt': md5('a v1\n'), 'b.txt': md5(baseContent) }
        });
        const s1 = makeRecord({
            id: 'cp-s1', timestamp: 2000, type: 'incremental', baseCheckpointId: 'cp-base',
            fileHashes: { 'a.txt': md5('a v2\n') },
            changes: [{ path: 'a.txt', type: 'modified', hash: md5('a v2\n') }]
        });
        const s2 = makeRecord({
            id: 'cp-s2', timestamp: 3000, type: 'incremental', baseCheckpointId: 'cp-base',
            fileHashes: { 'a.txt': md5('a v3\n') },
            changes: [{ path: 'a.txt', type: 'modified', hash: md5('a v3\n') }]
        });

        const harness = await createHarness([baseCp, s1, s2], 1);
        try {
            // 磁盘备份：base 独有 b.txt；两个后继各自有 a.txt
            await writeFile(path.join(harness.checkpointsDir, 'cp-base'), 'a.txt', 'a v1\n');
            await writeFile(path.join(harness.checkpointsDir, 'cp-base'), 'b.txt', baseContent);
            await writeFile(path.join(harness.checkpointsDir, 'cp-s1'), 'a.txt', 'a v2\n');
            await writeFile(path.join(harness.checkpointsDir, 'cp-s2'), 'a.txt', 'a v3\n');

            await harness.service.cleanupOldCheckpoints('conv');

            // maxCheckpoints=1 → 保留 1 个：base 与 s1 被删，只剩 s2。
            // 关键断言：s2 也被合并重挂（base 引用清空）——旧实现只合并第一个后继（s1），
            // s2.baseCheckpointId 会残留 'cp-base' 而悬空断链。
            const list = harness.stored();
            expect(list.map(c => c.id)).toEqual(['cp-s2']);
            expect(list[0].baseCheckpointId).toBeUndefined();
            // base 独有文件并入 s2 目录（s1 目录随后被删，不再存在）
            await expect(
                fs.readFile(path.join(harness.checkpointsDir, 'cp-s2', 'b.txt'), 'utf-8')
            ).resolves.toBe(baseContent);
            // base 与 s1 目录均已删除
            await expect(fs.access(path.join(harness.checkpointsDir, 'cp-base'))).rejects.toThrow();
            await expect(fs.access(path.join(harness.checkpointsDir, 'cp-s1'))).rejects.toThrow();
        } finally {
            await fs.rm(harness.storageRoot, { recursive: true, force: true });
        }
    });

    test('mergeCheckpointIntoSuccessor 拒绝越界 backupDir（CP-RET-2），清理中止并保留节点', async () => {
        const evilDir = `..${path.sep}outside`;
        const evilCp = makeRecord({
            id: 'cp-evil', timestamp: 1000,
            backupDir: evilDir,
            fileHashes: { 'a.txt': md5('a\n') }
        });
        const dependent = makeRecord({
            id: 'cp-dep', timestamp: 2000, type: 'incremental', baseCheckpointId: 'cp-evil',
            fileHashes: { 'a.txt': md5('b\n') }
        });

        const harness = await createHarness([evilCp, dependent], 1);
        try {
            // 存档目录外放一个“受害者”目录，验证绝不会被递归删除
            const outsideDir = path.join(harness.storageRoot, 'outside');
            await writeFile(outsideDir, 'victim.txt', 'do not touch');

            await harness.service.cleanupOldCheckpoints('conv');

            // 越界节点合并失败后继续检查下一个候选：成功删除 cp-dep 以满足 max=1，
            // 但 cp-evil 本身仍被保留；外部目录未被触碰。
            expect(harness.stored().map(c => c.id).sort()).toEqual(['cp-evil']);
            await expect(fs.readFile(path.join(outsideDir, 'victim.txt'), 'utf-8')).resolves.toBe('do not touch');
            expect(harness.deletedIds()).toEqual(['cp-dep']);
        } finally {
            await fs.rm(harness.storageRoot, { recursive: true, force: true });
        }
    });

    test('CP-RET-3: 仅合并排序在后的后继——前向 base 的越界依赖项不阻止其 base 被删除', async () => {
        // 异常元数据：X(ts=1000) 的 base 指向更晚的 Y(ts=2000)（前向引用）。
        // X 因 backupDir 越界无法删除；旧实现依赖 sorted.slice(i+1) 的位置约束——
        // 删除 Y 时不会把 X 当作后继合并（否则 CP-RET-2 抛错会中止 Y 的删除）。
        const evilX = makeRecord({
            id: 'cp-x', timestamp: 1000, type: 'incremental', baseCheckpointId: 'cp-y',
            backupDir: `..${path.sep}outside-fwd`
        });
        const y = makeRecord({ id: 'cp-y', timestamp: 2000, type: 'full', fileHashes: {} });
        const z = makeRecord({ id: 'cp-z', timestamp: 3000, type: 'full', fileHashes: {} });

        const harness = await createHarness([evilX, y, z], 1);
        try {
            await writeFile(path.join(harness.checkpointsDir, 'cp-y'), 'a.txt', 'y\n');
            await writeFile(path.join(harness.checkpointsDir, 'cp-z'), 'a.txt', 'z\n');

            await harness.service.cleanupOldCheckpoints('conv');

            // X 无法删除 → 保留；Y 正常删除；继续检查 Z 以满足 max=1。
            expect(harness.stored().map(c => c.id).sort()).toEqual(['cp-x']);
            expect(harness.deletedIds()).toEqual(['cp-y', 'cp-z']);
        } finally {
            await fs.rm(harness.storageRoot, { recursive: true, force: true });
        }
    });

    test('CP-RET-3: 长链清理（2000 节点）正确完成且仅删最旧超额节点', async () => {
        const N = 2000;
        const records: CheckpointRecord[] = [];
        for (let i = 0; i < N; i++) {
            records.push(makeRecord({
                id: `cp-${i}`, timestamp: 1000 + i, type: 'incremental',
                baseCheckpointId: i > 0 ? `cp-${i - 1}` : undefined,
                fileHashes: {}
            }));
        }
        // 超额 10 个：只应删除最旧的 cp-0..cp-9（每个删除前先合并进后继）
        const harness = await createHarness(records, N - 10);
        try {
            await harness.service.cleanupOldCheckpoints('conv');

            // 按数字 id 排序比较（字符串 sort 会把 cp-10 排在 cp-9 前）
            const byNumericId = (a: string, b: string): number =>
                Number(a.slice(3)) - Number(b.slice(3));
            expect(harness.stored()).toHaveLength(N - 10);
            expect(harness.stored().map(c => c.id).sort(byNumericId)).toEqual(
                Array.from({ length: N - 10 }, (_, i) => `cp-${i + 10}`)
            );
            expect(harness.deletedIds().sort(byNumericId)).toEqual(
                Array.from({ length: 10 }, (_, i) => `cp-${i}`)
            );
            // 链重挂完成：剩余最旧节点 cp-10 不再引用已删除的 cp-9
            const head = harness.stored().find(c => c.id === 'cp-10');
            expect(head!.baseCheckpointId).toBeUndefined();
        } finally {
            await fs.rm(harness.storageRoot, { recursive: true, force: true });
        }
    });

    test('删除被拒绝（返回 false）时不标记 deleted，后续候选仍继续清理（CP-RET-1）', async () => {
        const evilCp = makeRecord({
            id: 'cp-evil', timestamp: 1000,
            backupDir: `..${path.sep}outside2`,
            fileHashes: {}
        });
        const midCp = makeRecord({ id: 'cp-mid', timestamp: 2000, fileHashes: { 'a.txt': md5('m\n') } });
        const lateCp = makeRecord({ id: 'cp-late', timestamp: 3000, fileHashes: { 'a.txt': md5('l\n') } });

        const harness = await createHarness([evilCp, midCp, lateCp], 1);
        try {
            await writeFile(path.join(harness.checkpointsDir, 'cp-mid'), 'a.txt', 'm\n');
            await writeFile(path.join(harness.checkpointsDir, 'cp-late'), 'a.txt', 'l\n');

            await harness.service.cleanupOldCheckpoints('conv');

            // cp-evil 删除被拒绝 → 保留；cp-mid、cp-late 继续清理以满足 max=1
            expect(harness.stored().map(c => c.id).sort()).toEqual(['cp-evil']);
            expect(harness.deletedIds()).toEqual(['cp-mid', 'cp-late']);
        } finally {
            await fs.rm(harness.storageRoot, { recursive: true, force: true });
        }
    });

    test('新格式（v2 拆分 manifest）合并：被删节点文件并入后继 manifest/files.json 与磁盘（CPF-LAZY-1）', async () => {
        const baseContent = 'base only\n';
        // 新格式记录：不含 fileHashes，完整数据存于 v2 拆分 manifest（files.json 独立存放）
        const baseCp = makeRecord({ id: 'cp-base', timestamp: 1000, type: 'full' });
        const s2 = makeRecord({ id: 'cp-s2', timestamp: 3000, type: 'incremental', baseCheckpointId: 'cp-base' });

        const harness = await createHarness([baseCp, s2], 1);
        try {
            const baseManifest: CheckpointManifest = {
                version: CHECKPOINT_MANIFEST_VERSION,
                checkpointId: 'cp-base',
                workspaceRoots: [],
                files: {
                    'a.txt': { hash: md5('a v1\n'), size: 5, mtimeMs: 1000 },
                    'b.txt': { hash: md5(baseContent), size: baseContent.length, mtimeMs: 1000 }
                },
                emptyDirs: [],
                changes: [],
                excluded: [],
                ignoreSnapshot: {
                    version: 1, forcedRulesVersion: 1, defaultProfileVersion: 1,
                    enabledProfiles: {}, maxFileSizeBytes: 0, customPatterns: []
                }
            };
            const s2Manifest: CheckpointManifest = {
                ...baseManifest,
                checkpointId: 'cp-s2',
                files: { 'a.txt': { hash: md5('a v2\n'), size: 5, mtimeMs: 2000 } },
                changes: [{ path: 'a.txt', type: 'modified', hash: md5('a v2\n') }]
            };
            await harness.manifestRepository.writeManifest('cp-base', baseManifest);
            await harness.manifestRepository.writeManifest('cp-s2', s2Manifest);

            // 磁盘备份：base 独有 b.txt；后继有更新的 a.txt
            await writeFile(path.join(harness.checkpointsDir, 'cp-base'), 'a.txt', 'a v1\n');
            await writeFile(path.join(harness.checkpointsDir, 'cp-base'), 'b.txt', baseContent);
            await writeFile(path.join(harness.checkpointsDir, 'cp-s2'), 'a.txt', 'a v2\n');

            await harness.service.cleanupOldCheckpoints('conv');

            // 链重挂：base 被删，只剩 s2 且不再引用 base
            const list = harness.stored();
            expect(list.map(c => c.id)).toEqual(['cp-s2']);
            expect(list[0].baseCheckpointId).toBeUndefined();

            // 合并结果：s2 的 files 映射（懒加载自 files.json）包含被删节点的 b.txt
            const merged = await harness.manifestRepository.loadManifestWithFiles('cp-s2');
            expect(Object.keys(merged!.files).sort()).toEqual(['a.txt', 'b.txt']);
            expect(merged!.files['b.txt']).toMatchObject({ hash: md5(baseContent) });
            expect(merged!.changes.map(c => c.path).sort()).toEqual(['a.txt', 'b.txt']);
            // files.json 磁盘载荷同步更新
            const filesOnDisk = JSON.parse(
                await fs.readFile(path.join(harness.checkpointsDir, 'cp-s2', 'files.json'), 'utf-8')
            ) as { files: CheckpointManifest['files'] };
            expect(Object.keys(filesOnDisk.files).sort()).toEqual(['a.txt', 'b.txt']);

            // 被删节点独有文件 b.txt 已并入 s2 备份目录；base 目录已删除
            await expect(
                fs.readFile(path.join(harness.checkpointsDir, 'cp-s2', 'b.txt'), 'utf-8')
            ).resolves.toBe(baseContent);
            await expect(fs.access(path.join(harness.checkpointsDir, 'cp-base'))).rejects.toThrow();
        } finally {
            await fs.rm(harness.storageRoot, { recursive: true, force: true });
        }
    });
});
