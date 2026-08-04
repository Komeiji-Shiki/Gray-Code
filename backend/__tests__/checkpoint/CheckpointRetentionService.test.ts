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
import { CheckpointRetentionService } from '../../modules/checkpoint/CheckpointRetentionService';
import { CheckpointManifestRepository } from '../../modules/checkpoint/CheckpointManifestRepository';
import { isSafeCheckpointDirName } from '../../modules/checkpoint/CheckpointManifestRepository';
import type { CheckpointRecord } from '../../modules/checkpoint/CheckpointManager';

async function createTempDirectory(prefix: string): Promise<string> {
    return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeFile(rootDir: string, relativePath: string, content: string = ''): Promise<void> {
    const fullPath = path.join(rootDir, relativePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, 'utf-8');
}

function md5(content: string): string {
    return crypto.createHash('md5').update(content).digest('hex');
}

function makeRecord(overrides: Partial<CheckpointRecord> & { id: string }): CheckpointRecord {
    return {
        conversationId: 'conv',
        messageIndex: 0,
        toolName: 'write_file',
        phase: 'after',
        timestamp: 1000,
        backupDir: overrides.id,
        fileCount: 0,
        contentHash: 'h',
        type: 'full',
        ...overrides
    };
}

interface Harness {
    service: CheckpointRetentionService;
    checkpointsDir: string;
    storageRoot: string;
    stored: () => CheckpointRecord[];
    deletedIds: () => string[];
}

/**
 * 构造 RetentionService 测试环境。
 *
 * deleteCheckpointInternal 模拟 CheckpointManager 的真实语义：backupDir 越界（CP-DEL-1）
 * 时拒绝删除并返回 false，其余情况移除记录并返回 true。
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
        deletedIds: () => deletedIds
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

            // 合并被拒绝 → 删除中止 → 记录全部保留，外部目录未被触碰
            expect(harness.stored().map(c => c.id).sort()).toEqual(['cp-dep', 'cp-evil']);
            await expect(fs.readFile(path.join(outsideDir, 'victim.txt'), 'utf-8')).resolves.toBe('do not touch');
            expect(harness.deletedIds()).toEqual([]);
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

            // X 无法删除 → 保留；Y 正常删除（X 不在其“排序在后”的后继集合中，不触发合并中止）
            expect(harness.stored().map(c => c.id).sort()).toEqual(['cp-x', 'cp-z']);
            expect(harness.deletedIds()).toEqual(['cp-y']);
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

            // cp-evil 删除被拒绝 → 保留；cp-mid 正常删除；cp-late 因 max=1 保留
            expect(harness.stored().map(c => c.id).sort()).toEqual(['cp-evil', 'cp-late']);
            expect(harness.deletedIds()).toEqual(['cp-mid']);
        } finally {
            await fs.rm(harness.storageRoot, { recursive: true, force: true });
        }
    });
});
