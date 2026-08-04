/**
 * CheckpointManifestRepository 单元测试（CPF-01 / CPF-02 / EX-10 / MIG-02）
 *
 * 覆盖：
 * - 原子写入（tmp + rename）：manifest.json 存在、无 .tmp 残留
 * - 按 ID 加载 + 内存缓存
 * - 旧记录迁移：无 manifest 时从 CheckpointRecord 生成并落盘
 * - enrichRecord：新格式记录（元数据无 fileHashes）从 manifest 回填
 * - 损坏 manifest 不缓存、走迁移/回退
 */
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { CheckpointManifestRepository, CHECKPOINT_MANIFEST_VERSION } from '../../modules/checkpoint/CheckpointManifestRepository';
import type { CheckpointManifest } from '../../modules/checkpoint/types';
import type { CheckpointRecord } from '../../modules/checkpoint/CheckpointManager';

async function createTempDirectory(prefix: string): Promise<string> {
    return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function makeLegacyRecord(overrides: Partial<CheckpointRecord> = {}): CheckpointRecord {
    return {
        id: 'cp-legacy',
        conversationId: 'conv-1',
        messageIndex: 0,
        toolName: 'write_file',
        phase: 'after',
        timestamp: Date.now(),
        backupDir: 'cp-legacy',
        fileCount: 2,
        contentHash: 'hash',
        type: 'full',
        fileHashes: {
            'ws_a/one.txt': 'hash-one',
            'ws_a/two.txt': 'hash-two'
        },
        fileStats: {
            'ws_a/one.txt': { mtimeMs: 1000, size: 10, mtimeNs: '1000' },
            'ws_a/two.txt': { mtimeMs: 2000, size: 20 }
        },
        emptyDirs: ['ws_a/empty'],
        changes: [{ path: 'ws_a/one.txt', type: 'added', hash: 'hash-one' }],
        unbackedPaths: ['ws_a/big.bin'],
        ignorePatterns: ['*.log'],
        workspaceRoots: [{ id: 'ws_a', name: 'a', uri: 'file:///a' }],
        workspaceFingerprint: 'fp',
        ...overrides
    };
}

describe('CheckpointManifestRepository', () => {
    let storageRoot: string;
    let repo: CheckpointManifestRepository;

    beforeEach(async () => {
        storageRoot = await createTempDirectory('limcode-manifest-storage-');
        repo = new CheckpointManifestRepository(path.join(storageRoot, 'checkpoints'));
    });

    afterEach(async () => {
        await fs.rm(storageRoot, { recursive: true, force: true });
    });

    test('writeManifest 原子写入：manifest.json 存在且无 .tmp 残留', async () => {
        const manifest: CheckpointManifest = {
            version: CHECKPOINT_MANIFEST_VERSION,
            checkpointId: 'cp-1',
            workspaceRoots: [{ id: 'ws_a', name: 'a', uri: 'file:///a' }],
            files: { 'ws_a/a.txt': { hash: 'h', size: 3, mtimeMs: 1 } },
            emptyDirs: [],
            changes: [],
            excluded: [],
            ignoreSnapshot: {
                version: 1,
                forcedRulesVersion: 1,
                defaultProfileVersion: 1,
                enabledProfiles: {},
                maxFileSizeBytes: 0,
                customPatterns: []
            }
        };

        await repo.writeManifest('cp-1', manifest);

        const manifestPath = path.join(storageRoot, 'checkpoints', 'cp-1', 'manifest.json');
        await expect(fs.access(manifestPath)).resolves.toBeUndefined();
        await expect(fs.access(`${manifestPath}.tmp`)).rejects.toThrow();

        const parsed = JSON.parse(await fs.readFile(manifestPath, 'utf-8')) as CheckpointManifest;
        expect(parsed.checkpointId).toBe('cp-1');
        expect(parsed.files['ws_a/a.txt'].hash).toBe('h');
    });

    test('loadManifest 读取磁盘并缓存（删除磁盘后仍命中缓存）', async () => {
        const manifest: CheckpointManifest = {
            version: CHECKPOINT_MANIFEST_VERSION,
            checkpointId: 'cp-1',
            workspaceRoots: [],
            files: { 'ws_a/a.txt': { hash: 'h', size: 1, mtimeMs: 1 } },
            emptyDirs: [],
            changes: [],
            excluded: [],
            ignoreSnapshot: {
                version: 1,
                forcedRulesVersion: 1,
                defaultProfileVersion: 1,
                enabledProfiles: {},
                maxFileSizeBytes: 0,
                customPatterns: []
            }
        };
        await repo.writeManifest('cp-1', manifest);

        const first = await repo.loadManifest('cp-1');
        expect(first?.checkpointId).toBe('cp-1');

        // 删除磁盘文件后，第二次仍命中内存缓存
        await fs.rm(path.join(storageRoot, 'checkpoints', 'cp-1', 'manifest.json'));
        const second = await repo.loadManifest('cp-1');
        expect(second?.checkpointId).toBe('cp-1');

        // clearCache 后缓存失效 → 磁盘已删 → null
        repo.clearCache('cp-1');
        expect(await repo.loadManifest('cp-1')).toBeNull();
    });

    test('旧记录迁移：无 manifest 时从 record 生成并落盘（MIG-02）', async () => {
        const record = makeLegacyRecord();
        await fs.mkdir(path.join(storageRoot, 'checkpoints', 'cp-legacy'), { recursive: true });

        const manifest = await repo.loadManifest('cp-legacy', record);

        expect(manifest).not.toBeNull();
        expect(manifest!.checkpointId).toBe('cp-legacy');
        expect(manifest!.files['ws_a/one.txt']).toMatchObject({ hash: 'hash-one', size: 10, mtimeMs: 1000, mtimeNs: '1000' });
        expect(manifest!.files['ws_a/two.txt']).toMatchObject({ hash: 'hash-two', size: 20, mtimeMs: 2000 });
        expect(manifest!.emptyDirs).toEqual(['ws_a/empty']);
        expect(manifest!.changes).toEqual([{ path: 'ws_a/one.txt', type: 'added', hash: 'hash-one' }]);
        // unbackedPaths 迁移为 excluded（reason=unreadable, source=legacy）
        expect(manifest!.excluded).toEqual([{ path: 'ws_a/big.bin', reason: 'unreadable', source: 'legacy' }]);
        expect(manifest!.ignoreSnapshot.customPatterns).toEqual(['*.log']);

        // 已落盘：再次加载走磁盘/缓存，不再依赖 record
        const manifestPath = path.join(storageRoot, 'checkpoints', 'cp-legacy', 'manifest.json');
        await expect(fs.access(manifestPath)).resolves.toBeUndefined();
        const reloaded = await repo.loadManifest('cp-legacy');
        expect(reloaded?.files['ws_a/one.txt'].hash).toBe('hash-one');
    });

    test('enrichRecord：新格式记录（无 fileHashes）从 manifest 回填完整数据', async () => {
        const manifest: CheckpointManifest = {
            version: CHECKPOINT_MANIFEST_VERSION,
            checkpointId: 'cp-new',
            workspaceRoots: [],
            files: {
                'ws_a/a.txt': { hash: 'h-a', size: 10, mtimeMs: 1000, mtimeNs: '1000' },
                'ws_a/b.txt': { hash: 'h-b', size: 20, mtimeMs: 2000 }
            },
            emptyDirs: ['ws_a/empty'],
            changes: [{ path: 'ws_a/a.txt', type: 'modified', hash: 'h-a' }],
            excluded: [],
            ignoreSnapshot: {
                version: 1,
                forcedRulesVersion: 1,
                defaultProfileVersion: 1,
                enabledProfiles: {},
                maxFileSizeBytes: 0,
                customPatterns: []
            }
        };
        await repo.writeManifest('cp-new', manifest);

        const record: CheckpointRecord = makeLegacyRecord({ id: 'cp-new', backupDir: 'cp-new', fileHashes: undefined, fileStats: undefined, changes: undefined, emptyDirs: undefined });
        const enriched = await repo.enrichRecord(record);

        expect(enriched.fileHashes).toEqual({ 'ws_a/a.txt': 'h-a', 'ws_a/b.txt': 'h-b' });
        expect(enriched.fileStats?.['ws_a/a.txt']).toEqual({ mtimeMs: 1000, size: 10, mtimeNs: '1000' });
        expect(enriched.emptyDirs).toEqual(['ws_a/empty']);
        expect(enriched.changes).toEqual([{ path: 'ws_a/a.txt', type: 'modified', hash: 'h-a' }]);
    });

    test('enrichRecord：旧记录已带 fileHashes 时原样返回（不读 manifest）', async () => {
        const record = makeLegacyRecord();
        const enriched = await repo.enrichRecord(record);
        expect(enriched).toBe(record);
        expect(enriched.fileHashes).toBeDefined();
    });

    test('损坏 manifest 不缓存，回退迁移路径', async () => {
        const dir = path.join(storageRoot, 'checkpoints', 'cp-broken');
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, 'manifest.json'), '{ not valid json', 'utf-8');

        const record = makeLegacyRecord({ id: 'cp-broken', backupDir: 'cp-broken' });
        const manifest = await repo.loadManifest('cp-broken', record);

        // 迁移成功并覆盖损坏文件
        expect(manifest).not.toBeNull();
        expect(manifest!.checkpointId).toBe('cp-broken');
        const reparsed = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf-8'));
        expect(reparsed.checkpointId).toBe('cp-broken');
    });

    test('clearCache 清理指定与全部缓存', async () => {
        const manifest: CheckpointManifest = {
            version: CHECKPOINT_MANIFEST_VERSION,
            checkpointId: 'cp-1',
            workspaceRoots: [],
            files: {},
            emptyDirs: [],
            changes: [],
            excluded: [],
            ignoreSnapshot: {
                version: 1,
                forcedRulesVersion: 1,
                defaultProfileVersion: 1,
                enabledProfiles: {},
                maxFileSizeBytes: 0,
                customPatterns: []
            }
        };
        await repo.writeManifest('cp-1', manifest);
        await repo.writeManifest('cp-2', manifest);

        repo.clearCache('cp-1');
        expect(repo['cache'].has('cp-1')).toBe(false);
        expect(repo['cache'].has('cp-2')).toBe(true);

        repo.clearCache();
        expect(repo['cache'].size).toBe(0);
    });
});
