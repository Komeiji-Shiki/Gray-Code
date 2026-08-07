/**
 * CheckpointManifestRepository 单元测试（CPF-01 / CPF-02 / EX-10 / MIG-02 / CPF-LAZY-1）
 *
 * 覆盖：
 * - 原子写入（tmp + rename）：manifest.json（轻量）+ files.json（重量映射）拆分存储
 * - 懒加载：loadManifest 只读轻量元数据，不触碰 files.json；loadManifestWithFiles 按需加载
 * - 旧格式（v1 内联 files）读取 + best-effort 拆分迁移
 * - 按 ID 加载 + 双缓存（meta LRU / files LRU）
 * - 旧记录迁移：无 manifest 时从 CheckpointRecord 生成并落盘
 * - enrichRecord：新格式记录（元数据无 fileHashes）从 manifest 回填
 * - 损坏 manifest 不缓存、走迁移/回退
 */
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
    CheckpointManifestRepository,
    CHECKPOINT_MANIFEST_VERSION,
    CHECKPOINT_MANIFEST_FILENAME,
    CHECKPOINT_MANIFEST_FILES_FILENAME
} from '../../modules/checkpoint/CheckpointManifestRepository';
import type { CheckpointManifest, CheckpointManifestMeta } from '../../modules/checkpoint/types';
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

function makeManifest(id: string, fileKeys: string[] = ['ws_a/a.txt']): CheckpointManifest {
    return {
        version: CHECKPOINT_MANIFEST_VERSION,
        checkpointId: id,
        workspaceRoots: [{ id: 'ws_a', name: 'a', uri: 'file:///a' }],
        files: Object.fromEntries(fileKeys.map((key, i) => [key, { hash: `h-${i}`, size: 1, mtimeMs: 1 }])),
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

    test('writeManifest 原子写入：manifest.json（轻量）+ files.json（重量映射）拆分存储（CPF-LAZY-1）', async () => {
        const manifest = makeManifest('cp-1', ['ws_a/a.txt', 'ws_a/b.txt']);

        await repo.writeManifest('cp-1', manifest);

        const dir = path.join(storageRoot, 'checkpoints', 'cp-1');
        const manifestPath = path.join(dir, CHECKPOINT_MANIFEST_FILENAME);
        const filesPath = path.join(dir, CHECKPOINT_MANIFEST_FILES_FILENAME);
        await expect(fs.access(manifestPath)).resolves.toBeUndefined();
        await expect(fs.access(filesPath)).resolves.toBeUndefined();
        await expect(fs.access(`${manifestPath}.tmp`)).rejects.toThrow();
        await expect(fs.access(`${filesPath}.tmp`)).rejects.toThrow();

        // manifest.json 只含轻量元数据，不含 files 映射
        const parsedMeta = JSON.parse(await fs.readFile(manifestPath, 'utf-8')) as CheckpointManifestMeta;
        expect(parsedMeta.version).toBe(CHECKPOINT_MANIFEST_VERSION);
        expect(parsedMeta.checkpointId).toBe('cp-1');
        expect('files' in parsedMeta).toBe(false);

        // files.json 独立保存重量级映射
        const parsedFiles = JSON.parse(await fs.readFile(filesPath, 'utf-8')) as { checkpointId: string; files: CheckpointManifest['files'] };
        expect(parsedFiles.checkpointId).toBe('cp-1');
        expect(Object.keys(parsedFiles.files)).toEqual(['ws_a/a.txt', 'ws_a/b.txt']);
        expect(parsedFiles.files['ws_a/a.txt'].hash).toBe('h-0');
    });

    test('loadManifest 只读轻量元数据，不触碰 files.json（懒加载，CPF-LAZY-1）', async () => {
        await repo.writeManifest('cp-1', makeManifest('cp-1', ['ws_a/a.txt', 'ws_a/b.txt']));

        const meta = await repo.loadManifest('cp-1');
        expect(meta).not.toBeNull();
        expect(meta!.checkpointId).toBe('cp-1');
        expect(meta!.workspaceRoots[0].id).toBe('ws_a');
        expect('files' in (meta as CheckpointManifestMeta & { files?: unknown })).toBe(false);

        // files.json 损坏/缺失不影响元数据读取（证明读路径不依赖重量级文件）
        await fs.writeFile(
            path.join(storageRoot, 'checkpoints', 'cp-1', CHECKPOINT_MANIFEST_FILES_FILENAME),
            '{ not valid json',
            'utf-8'
        );
        repo.clearCache('cp-1');
        const metaAgain = await repo.loadManifest('cp-1');
        expect(metaAgain?.checkpointId).toBe('cp-1');
    });

    test('loadManifestWithFiles 按需懒加载 files.json 并缓存（CPF-LAZY-1）', async () => {
        const manifest = makeManifest('cp-1', ['ws_a/a.txt', 'ws_a/b.txt']);
        await repo.writeManifest('cp-1', manifest);

        // 懒加载：完整文件映射仅在显式请求时读取
        const full = await repo.loadManifestWithFiles('cp-1');
        expect(full).not.toBeNull();
        expect(Object.keys(full!.files)).toEqual(['ws_a/a.txt', 'ws_a/b.txt']);
        expect(full!.files['ws_a/b.txt'].hash).toBe('h-1');

        // 已缓存：删除磁盘 files.json 后仍可命中缓存返回完整数据
        await fs.rm(path.join(storageRoot, 'checkpoints', 'cp-1', CHECKPOINT_MANIFEST_FILES_FILENAME));
        const cached = await repo.loadManifestWithFiles('cp-1');
        expect(cached?.files['ws_a/a.txt'].hash).toBe('h-0');
    });

    test('files.json 缺失/损坏 → loadManifestWithFiles 返回 null（数据丢失不假空，CPF-LAZY-1）', async () => {
        await repo.writeManifest('cp-1', makeManifest('cp-1', ['ws_a/a.txt']));
        repo.clearCache();
        await fs.rm(path.join(storageRoot, 'checkpoints', 'cp-1', CHECKPOINT_MANIFEST_FILES_FILENAME));

        // 元数据视图仍可读（列表/排除清单等不受影响）
        expect((await repo.loadManifest('cp-1'))?.checkpointId).toBe('cp-1');
        // 完整数据读取显式失败
        expect(await repo.loadManifestWithFiles('cp-1')).toBeNull();
    });

    test('旧格式 v1（files 内联）：读取后 best-effort 拆分为新格式落盘（CPF-LAZY-1 迁移）', async () => {
        const dir = path.join(storageRoot, 'checkpoints', 'cp-v1');
        await fs.mkdir(dir, { recursive: true });
        // 手工构造 v1 布局：manifest.json 内联 files
        const v1: CheckpointManifest = {
            ...makeManifest('cp-v1', ['ws_a/old.txt']),
            version: 1
        };
        await fs.writeFile(path.join(dir, CHECKPOINT_MANIFEST_FILENAME), JSON.stringify(v1, null, 2), 'utf-8');

        // 元数据视图：只读 manifest.json 即可（files 已随解析进缓存）
        const meta = await repo.loadManifest('cp-v1');
        expect(meta).not.toBeNull();
        expect(meta!.version).toBe(1);
        expect('files' in (meta as CheckpointManifestMeta & { files?: unknown })).toBe(false);

        // 完整数据：files 由缓存提供（旧格式无需再读盘）
        const full = await repo.loadManifestWithFiles('cp-v1');
        expect(full?.files['ws_a/old.txt'].hash).toBe('h-0');

        // best-effort 拆分落盘：manifest.json 降为轻量 v2、files.json 独立存放
        const migratedMeta = JSON.parse(
            await fs.readFile(path.join(dir, CHECKPOINT_MANIFEST_FILENAME), 'utf-8')
        ) as CheckpointManifestMeta;
        expect(migratedMeta.version).toBe(CHECKPOINT_MANIFEST_VERSION);
        expect('files' in migratedMeta).toBe(false);
        const migratedFiles = JSON.parse(
            await fs.readFile(path.join(dir, CHECKPOINT_MANIFEST_FILES_FILENAME), 'utf-8')
        ) as { files: CheckpointManifest['files'] };
        expect(migratedFiles.files['ws_a/old.txt'].hash).toBe('h-0');
    });

    test('v1 布局但缺内联 files → 视为损坏，走迁移/回退路径', async () => {
        const dir = path.join(storageRoot, 'checkpoints', 'cp-bad-v1');
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(
            path.join(dir, CHECKPOINT_MANIFEST_FILENAME),
            JSON.stringify({ version: 1, checkpointId: 'cp-bad-v1', workspaceRoots: [] }),
            'utf-8'
        );

        const record = makeLegacyRecord({ id: 'cp-bad-v1', backupDir: 'cp-bad-v1' });
        const manifest = await repo.loadManifest('cp-bad-v1', record);
        expect(manifest).not.toBeNull();
        expect(manifest!.checkpointId).toBe('cp-bad-v1');
        // 迁移生成（拆分格式）落盘
        const reparsed = JSON.parse(await fs.readFile(path.join(dir, CHECKPOINT_MANIFEST_FILENAME), 'utf-8'));
        expect(reparsed.checkpointId).toBe('cp-bad-v1');
        expect(reparsed.version).toBe(CHECKPOINT_MANIFEST_VERSION);
    });

    test('loadManifest 读取磁盘并缓存（删除磁盘后仍命中缓存）', async () => {
        const manifest = makeManifest('cp-1');
        await repo.writeManifest('cp-1', manifest);

        const first = await repo.loadManifest('cp-1');
        expect(first?.checkpointId).toBe('cp-1');

        // 删除磁盘文件后，第二次仍命中内存缓存
        await fs.rm(path.join(storageRoot, 'checkpoints', 'cp-1', CHECKPOINT_MANIFEST_FILENAME));
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
        expect(manifest!.emptyDirs).toEqual(['ws_a/empty']);
        expect(manifest!.changes).toEqual([{ path: 'ws_a/one.txt', type: 'added', hash: 'hash-one' }]);
        // unbackedPaths 迁移为 excluded（reason=unreadable, source=legacy）
        expect(manifest!.excluded).toEqual([{ path: 'ws_a/big.bin', reason: 'unreadable', source: 'legacy' }]);
        expect(manifest!.ignoreSnapshot.customPatterns).toEqual(['*.log']);

        // 完整文件映射经懒加载路径可取（迁移产物 files 进缓存）
        const full = await repo.loadManifestWithFiles('cp-legacy');
        expect(full!.files['ws_a/one.txt']).toMatchObject({ hash: 'hash-one', size: 10, mtimeMs: 1000, mtimeNs: '1000' });
        expect(full!.files['ws_a/two.txt']).toMatchObject({ hash: 'hash-two', size: 20, mtimeMs: 2000 });

        // 已落盘（拆分格式）：再次加载走磁盘/缓存，不再依赖 record
        const manifestPath = path.join(storageRoot, 'checkpoints', 'cp-legacy', CHECKPOINT_MANIFEST_FILENAME);
        await expect(fs.access(manifestPath)).resolves.toBeUndefined();
        const reloaded = await repo.loadManifest('cp-legacy');
        expect(reloaded?.checkpointId).toBe('cp-legacy');
        expect((await repo.loadManifestWithFiles('cp-legacy'))?.files['ws_a/one.txt'].hash).toBe('hash-one');
    });

    test('enrichRecord：新格式记录（无 fileHashes）从 manifest 回填完整数据', async () => {
        const manifest = makeManifest('cp-new', ['ws_a/a.txt', 'ws_a/b.txt']);
        manifest.files['ws_a/a.txt'] = { hash: 'h-a', size: 10, mtimeMs: 1000, mtimeNs: '1000' };
        manifest.files['ws_a/b.txt'] = { hash: 'h-b', size: 20, mtimeMs: 2000 };
        manifest.emptyDirs = ['ws_a/empty'];
        manifest.changes = [{ path: 'ws_a/a.txt', type: 'modified', hash: 'h-a' }];
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
        await fs.writeFile(path.join(dir, CHECKPOINT_MANIFEST_FILENAME), '{ not valid json', 'utf-8');

        const record = makeLegacyRecord({ id: 'cp-broken', backupDir: 'cp-broken' });
        const manifest = await repo.loadManifest('cp-broken', record);

        // 迁移成功并覆盖损坏文件
        expect(manifest).not.toBeNull();
        expect(manifest!.checkpointId).toBe('cp-broken');
        const reparsed = JSON.parse(await fs.readFile(path.join(dir, CHECKPOINT_MANIFEST_FILENAME), 'utf-8'));
        expect(reparsed.checkpointId).toBe('cp-broken');
    });

    test('clearCache 清理指定与全部缓存（meta 与 files 双缓存）', async () => {
        const manifest = makeManifest('cp-1');
        await repo.writeManifest('cp-1', manifest);
        await repo.writeManifest('cp-2', manifest);
        await repo.loadManifestWithFiles('cp-1');

        repo.clearCache('cp-1');
        expect(repo['metaCache'].has('cp-1')).toBe(false);
        expect(repo['filesCache'].has('cp-1')).toBe(false);
        expect(repo['metaCache'].has('cp-2')).toBe(true);

        repo.clearCache();
        expect(repo['metaCache'].size).toBe(0);
        expect(repo['filesCache'].size).toBe(0);
    });

    describe('CP-PATH-1 / CP-CACHE-1 / CPF-LAZY-1（路径校验与 LRU 缓存）', () => {
        test('getManifestPath / getManifestFilesPath 拒绝越界/绝对路径/盘符等非法 checkpointId（CP-PATH-1）', () => {
            for (const evil of [
                '../evil',
                '..\\evil',
                '..',
                '.',
                'cp-x/../../evil',
                'C:\\evil',
                'C:/evil',
                '/abs/path',
                'cp_1\0x'
            ]) {
                expect(() => repo.getManifestPath(evil)).toThrow('Unsafe checkpoint dir name');
                expect(() => repo.getManifestFilesPath(evil)).toThrow('Unsafe checkpoint dir name');
            }
            // 合法 ID（含测试常用的连字符命名）放行
            expect(repo.getManifestPath('cp-1')).toBe(
                path.join(storageRoot, 'checkpoints', 'cp-1', CHECKPOINT_MANIFEST_FILENAME)
            );
            expect(repo.getManifestFilesPath('cp-1')).toBe(
                path.join(storageRoot, 'checkpoints', 'cp-1', CHECKPOINT_MANIFEST_FILES_FILENAME)
            );
            expect(repo.getManifestPath('cp_abc_123')).toContain('cp_abc_123');
        });

        test('loadManifest/writeManifest/loadManifestWithFiles 对非法 checkpointId 抛错而非回退（CP-PATH-1）', async () => {
            await expect(repo.loadManifest('../../evil')).rejects.toThrow('Unsafe checkpoint dir name');
            await expect(
                repo.loadManifest('../../evil', makeLegacyRecord({ id: '../../evil', backupDir: '../../evil' }))
            ).rejects.toThrow('Unsafe checkpoint dir name');
            await expect(repo.writeManifest('../evil', makeManifest('x'))).rejects.toThrow('Unsafe checkpoint dir name');
            await expect(repo.loadManifestWithFiles('../../evil')).rejects.toThrow('Unsafe checkpoint dir name');
            // 目录外文件未被触碰
            await expect(fs.access(path.join(storageRoot, 'evil'))).rejects.toThrow();
        });

        test('meta 缓存 LRU：超过上限淘汰最久未使用，淘汰后可从磁盘重读（CP-CACHE-1）', async () => {
            const count = 40; // 上限 32
            for (let i = 0; i < count; i++) {
                await repo.writeManifest(`cp-lru-${i}`, makeManifest(`cp-lru-${i}`));
            }
            // 缓存有界
            expect(repo['metaCache'].size).toBeLessThanOrEqual(32);
            // 最旧的（cp-lru-0）已被淘汰，再次加载走磁盘
            const reloaded = await repo.loadManifest('cp-lru-0');
            expect(reloaded?.checkpointId).toBe('cp-lru-0');
            // 磁盘文件真实存在
            await expect(
                fs.access(path.join(storageRoot, 'checkpoints', 'cp-lru-0', CHECKPOINT_MANIFEST_FILENAME))
            ).resolves.toBeUndefined();
        });

        test('meta 缓存 LRU：命中的条目刷新为最新，不被优先淘汰（CP-CACHE-1）', async () => {
            for (let i = 0; i < 32; i++) {
                await repo.writeManifest(`cp-lru-b-${i}`, makeManifest(`cp-lru-b-${i}`));
            }
            // 访问 cp-lru-b-0，把它刷新为最新
            await repo.loadManifest('cp-lru-b-0');
            // 再写入 2 条，触发 2 次淘汰：应淘汰 cp-lru-b-1、cp-lru-b-2（而非刚访问的 0）
            await repo.writeManifest('cp-lru-b-32', makeManifest('cp-lru-b-32'));
            await repo.writeManifest('cp-lru-b-33', makeManifest('cp-lru-b-33'));
            expect(repo['metaCache'].has('cp-lru-b-0')).toBe(true);
            expect(repo['metaCache'].has('cp-lru-b-1')).toBe(false);
            expect(repo['metaCache'].has('cp-lru-b-2')).toBe(false);
        });

        test('files 缓存 LRU：超过上限（8）淘汰最久未使用，淘汰后从磁盘重读（CPF-LAZY-1）', async () => {
            const count = 12; // files 缓存上限 8
            for (let i = 0; i < count; i++) {
                const id = `cp-flru-${i}`;
                await repo.writeManifest(id, makeManifest(id));
                await repo.loadManifestWithFiles(id); // 触发 files 加载入缓存
            }
            expect(repo['filesCache'].size).toBeLessThanOrEqual(8);
            // 最旧的已被淘汰，再次加载走磁盘 files.json
            const reloaded = await repo.loadManifestWithFiles('cp-flru-0');
            expect(reloaded?.files['ws_a/a.txt'].hash).toBe('h-0');
        });

        test('删除存档目录后 clearCache 使缓存失效（既有语义保持）', async () => {
            await repo.writeManifest('cp-clear', makeManifest('cp-clear'));
            await repo.loadManifestWithFiles('cp-clear');
            repo.clearCache('cp-clear');
            expect(repo['metaCache'].has('cp-clear')).toBe(false);
            expect(repo['filesCache'].has('cp-clear')).toBe(false);
        });
    });
});
