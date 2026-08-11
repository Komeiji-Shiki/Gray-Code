/**
 * CheckpointManifestRepository 单元测试（CPF-01 / CPF-02 / EX-10 / MIG-02 / CPF-LAZY-1 / CP-PATH-1 / CP-CACHE-1）
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
import type { CheckpointRecord } from '../../modules/checkpoint';
import { createTempDirectory } from '../__fixtures__/checkpointFixtures';
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

        // files.json 紧凑序列化（机器读数据，无缩进换行）：10-20MB 级大对象避免体积/序列化开销放大
        const filesRaw = await fs.readFile(filesPath, 'utf-8');
        expect(filesRaw.includes('\n')).toBe(false);
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

    test('v1 内联存档：files 缓存淘汰且 files.json 不存在时兜底回读内联 files，不误判数据丢失（CPF-LAZY-1 回归）', async () => {
        // 构造 v1 旧格式：files 内联于 manifest.json，且 files.json 不存在
        // （模拟拆分迁移写失败/未发生：只读介质、磁盘满等场景）
        const dir = path.join(storageRoot, 'checkpoints', 'cp-v1-orphan');
        await fs.mkdir(dir, { recursive: true });
        const v1: CheckpointManifest = {
            ...makeManifest('cp-v1-orphan', ['ws_a/legacy.txt']),
            version: 1
        };
        await fs.writeFile(path.join(dir, CHECKPOINT_MANIFEST_FILENAME), JSON.stringify(v1, null, 2), 'utf-8');

        // 确定性构造「meta 缓存命中、files 缓存被淘汰」的分离状态：
        // 直接以 v1 元数据预热 meta 缓存，files 缓存保持为空（不触发拆分迁移写盘）
        repo['metaCache'].set('cp-v1-orphan', {
            version: 1,
            checkpointId: 'cp-v1-orphan',
            workspaceRoots: v1.workspaceRoots,
            emptyDirs: v1.emptyDirs,
            changes: v1.changes,
            excluded: v1.excluded,
            ignoreSnapshot: v1.ignoreSnapshot
        });

        // 完整数据读取：files.json 缺失 → 兜底从 manifest.json 回读内联 files
        const full = await repo.loadManifestWithFiles('cp-v1-orphan');
        expect(full).not.toBeNull();
        expect(full!.files['ws_a/legacy.txt'].hash).toBe('h-0');
    });

    test('旧格式 v1（files 内联）：轻量读零写放大，完整读取时 best-effort 拆分为新格式落盘（CPF-LAZY-1）', async () => {
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

        // 轻量读不写盘：拆分（files.json）推迟到完整数据读取时触发，列表加载零写放大
        await expect(fs.access(path.join(dir, CHECKPOINT_MANIFEST_FILES_FILENAME))).rejects.toThrow();

        // 完整数据：files 由缓存提供（旧格式无需再读盘）；此时触发拆分落盘
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

        // 拆分后：轻量读直接命中缓存/磁盘新布局，再次完整读不再回读内联
        repo.clearCache();
        const fullAgain = await repo.loadManifestWithFiles('cp-v1');
        expect(fullAgain?.files['ws_a/old.txt'].hash).toBe('h-0');
    });

    test('v1 拆分迁移后 metaCache 同步为 v2，后续 loadManifestWithFiles 不重复触发迁移（CPF-LAZY-1 回归）', async () => {
        const dir = path.join(storageRoot, 'checkpoints', 'cp-v1-cache');
        await fs.mkdir(dir, { recursive: true });
        const v1: CheckpointManifest = {
            ...makeManifest('cp-v1-cache', ['ws_a/old.txt']),
            version: 1
        };
        await fs.writeFile(path.join(dir, CHECKPOINT_MANIFEST_FILENAME), JSON.stringify(v1, null, 2), 'utf-8');

        // 首次完整读：触发 v1 -> v2 拆分迁移
        const full = await repo.loadManifestWithFiles('cp-v1-cache');
        expect(full).not.toBeNull();
        // 返回值版本应为 v2（迁移成功后 stamp），而非残留的 v1
        expect(full!.version).toBe(CHECKPOINT_MANIFEST_VERSION);

        // metaCache 应已同步为 v2（不残留 v1 导致后续重复迁移）
        const cachedMeta = repo['metaCache'].get('cp-v1-cache');
        expect(cachedMeta?.version).toBe(CHECKPOINT_MANIFEST_VERSION);

        // 轻量读命中缓存：返回 v2 元数据
        const meta = await repo.loadManifest('cp-v1-cache');
        expect(meta?.version).toBe(CHECKPOINT_MANIFEST_VERSION);

        // 删除 files.json 后再次完整读（缓存命中，不触碰磁盘）：
        // 若 metaCache 残留 v1（bug），loadManifestWithFiles 会再次触发 splitMigrateOnDisk
        // -> writeManifestFiles 重建 files.json；修复后 metaCache 为 v2 -> 不触发迁移
        await fs.rm(path.join(dir, CHECKPOINT_MANIFEST_FILES_FILENAME));
        const fullAgain = await repo.loadManifestWithFiles('cp-v1-cache');
        expect(fullAgain?.files['ws_a/old.txt'].hash).toBe('h-0');
        // files.json 不应被重建（未触发迁移）
        await expect(fs.access(path.join(dir, CHECKPOINT_MANIFEST_FILES_FILENAME))).rejects.toThrow();
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

    test('version 非法（0/缺失）→ 视为损坏，走迁移/回退路径而非误判数据丢失', async () => {
        const dir = path.join(storageRoot, 'checkpoints', 'cp-bad-version');
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(
            path.join(dir, CHECKPOINT_MANIFEST_FILENAME),
            JSON.stringify({ version: 0, checkpointId: 'cp-bad-version', workspaceRoots: [] }),
            'utf-8'
        );

        const record = makeLegacyRecord({ id: 'cp-bad-version', backupDir: 'cp-bad-version' });
        const manifest = await repo.loadManifest('cp-bad-version', record);
        expect(manifest).not.toBeNull();
        expect(manifest!.checkpointId).toBe('cp-bad-version');
        // 迁移产物以当前版本落盘
        const reparsed = JSON.parse(await fs.readFile(path.join(dir, CHECKPOINT_MANIFEST_FILENAME), 'utf-8'));
        expect(reparsed.version).toBe(CHECKPOINT_MANIFEST_VERSION);
    });

    test('version 非整数（如 1.5）→ 视为损坏，走迁移/回退路径而非按未知布局缓存', async () => {
        const dir = path.join(storageRoot, 'checkpoints', 'cp-frac-version');
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(
            path.join(dir, CHECKPOINT_MANIFEST_FILENAME),
            JSON.stringify({ version: 1.5, checkpointId: 'cp-frac-version', workspaceRoots: [] }),
            'utf-8'
        );

        const record = makeLegacyRecord({ id: 'cp-frac-version', backupDir: 'cp-frac-version' });
        const manifest = await repo.loadManifest('cp-frac-version', record);
        expect(manifest).not.toBeNull();
        expect(manifest!.checkpointId).toBe('cp-frac-version');
        // 迁移产物以当前版本落盘（1.5 不被当作 v1/v2 布局缓存）
        const reparsed = JSON.parse(await fs.readFile(path.join(dir, CHECKPOINT_MANIFEST_FILENAME), 'utf-8'));
        expect(reparsed.version).toBe(CHECKPOINT_MANIFEST_VERSION);
        expect(reparsed.files).toBeUndefined();
    });

    test('files.json 为数组形状 → 视为损坏，完整数据读取返回 null（不假空，H1）', async () => {
        await repo.writeManifest('cp-arr', makeManifest('cp-arr', ['ws_a/a.txt']));
        repo.clearCache();
        // 恶意/损坏的 files.json：files 是数组（typeof [] === 'object' 会骗过旧校验）
        await fs.writeFile(
            path.join(storageRoot, 'checkpoints', 'cp-arr', CHECKPOINT_MANIFEST_FILES_FILENAME),
            JSON.stringify({ checkpointId: 'cp-arr', files: [] }),
            'utf-8'
        );

        // 元数据视图仍可读；完整数据读取显式失败（不被当作「空工作区」）
        expect((await repo.loadManifest('cp-arr'))?.checkpointId).toBe('cp-arr');
        expect(await repo.loadManifestWithFiles('cp-arr')).toBeNull();
    });

    test('v1 内联 files 为数组形状 → 视为损坏，走迁移/回退路径（H1）', async () => {
        const dir = path.join(storageRoot, 'checkpoints', 'cp-v1-arr');
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(
            path.join(dir, CHECKPOINT_MANIFEST_FILENAME),
            JSON.stringify({ version: 1, checkpointId: 'cp-v1-arr', workspaceRoots: [], emptyDirs: [], changes: [], excluded: [], ignoreSnapshot: {}, files: [] }),
            'utf-8'
        );

        const record = makeLegacyRecord({ id: 'cp-v1-arr', backupDir: 'cp-v1-arr' });
        const manifest = await repo.loadManifest('cp-v1-arr', record);
        expect(manifest).not.toBeNull();
        expect(manifest!.checkpointId).toBe('cp-v1-arr');
    });

    test('v2 manifest 缺元数据字段（excluded）→ 视为损坏，走迁移/回退路径（M3）', async () => {
        const dir = path.join(storageRoot, 'checkpoints', 'cp-bad-meta');
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(
            path.join(dir, CHECKPOINT_MANIFEST_FILENAME),
            JSON.stringify({ version: 2, checkpointId: 'cp-bad-meta', workspaceRoots: [], emptyDirs: [], changes: [] }),
            'utf-8'
        );

        const record = makeLegacyRecord({ id: 'cp-bad-meta', backupDir: 'cp-bad-meta' });
        const manifest = await repo.loadManifest('cp-bad-meta', record);
        expect(manifest).not.toBeNull();
        expect(manifest!.checkpointId).toBe('cp-bad-meta');
        // 迁移产物以当前版本落盘
        const reparsed = JSON.parse(await fs.readFile(path.join(dir, CHECKPOINT_MANIFEST_FILENAME), 'utf-8'));
        expect(reparsed.version).toBe(CHECKPOINT_MANIFEST_VERSION);
    });

    test('真空工作区存档（fileCount=0）manifest 缺失 → 迁移返回空快照而非误判数据丢失（M2）', async () => {
        const record = makeLegacyRecord({
            id: 'cp-empty',
            backupDir: 'cp-empty',
            fileHashes: undefined,
            fileStats: undefined,
            changes: undefined,
            fileCount: 0,
            emptyDirs: ['ws_a/empty-dir']
        });
        await fs.mkdir(path.join(storageRoot, 'checkpoints', 'cp-empty'), { recursive: true });

        const manifest = await repo.loadManifest('cp-empty', record);
        expect(manifest).not.toBeNull();
        expect(manifest!.checkpointId).toBe('cp-empty');
        // 空快照可完整读取（files 为空映射，emptyDirs 保留）
        const full = await repo.loadManifestWithFiles('cp-empty');
        expect(full).not.toBeNull();
        expect(Object.keys(full!.files)).toEqual([]);
        expect(full!.emptyDirs).toEqual(['ws_a/empty-dir']);
    });

    test('writeManifest 的 manifest.checkpointId 与参数不一致 → 抛错（L2）', async () => {
        await expect(repo.writeManifest('cp-a', makeManifest('cp-b'))).rejects.toThrow('checkpointId mismatch');
    });

    test('clearCache("") 只按指定键清理，不清空全部缓存（L6）', async () => {
        const manifest = makeManifest('cp-1');
        await repo.writeManifest('cp-1', manifest);
        await repo.writeManifest('cp-2', makeManifest('cp-2'));

        repo.clearCache('');
        expect(repo['metaCache'].has('cp-1')).toBe(true);
        expect(repo['metaCache'].has('cp-2')).toBe(true);
        expect(repo['metaCache'].size).toBe(2);
    });

    test('同一存档并发 writeManifest 经单飞队列串行化，全部成功且最终状态一致（M1）', async () => {
        const m1 = makeManifest('cp-conc', ['ws_a/a.txt']);
        const m2 = makeManifest('cp-conc', ['ws_a/b.txt']);

        await Promise.all([
            repo.writeManifest('cp-conc', m1),
            repo.writeManifest('cp-conc', m2)
        ]);

        // 两个写入都成功；磁盘 files.json 与 manifest.json 配对一致（checkpointId 同源）
        const filesPath = path.join(storageRoot, 'checkpoints', 'cp-conc', CHECKPOINT_MANIFEST_FILES_FILENAME);
        const filesPayload = JSON.parse(await fs.readFile(filesPath, 'utf-8')) as { checkpointId: string; files: CheckpointManifest['files'] };
        expect(filesPayload.checkpointId).toBe('cp-conc');
        const keys = Object.keys(filesPayload.files);
        expect(keys.length).toBe(1);
        expect(keys[0] === 'ws_a/a.txt' || keys[0] === 'ws_a/b.txt').toBe(true);
        // 缓存与磁盘一致：清缓存后完整读取仍成功
        repo.clearCache();
        expect((await repo.loadManifestWithFiles('cp-conc'))).not.toBeNull();
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
        await repo.writeManifest('cp-2', makeManifest('cp-2'));
        await repo.loadManifestWithFiles('cp-1');

        repo.clearCache('cp-1');
        expect(repo['metaCache'].has('cp-1')).toBe(false);
        expect(repo['filesCache'].has('cp-1')).toBe(false);
        expect(repo['metaCache'].has('cp-2')).toBe(true);

        repo.clearCache();
        expect(repo['metaCache'].size).toBe(0);
        expect(repo['filesCache'].size).toBe(0);
    });

    test('writeManifest 写盘失败时清空该存档缓存，避免内存与磁盘不一致残留', async () => {
        const manifest = makeManifest('cp-fail', ['ws_a/a.txt']);
        await repo.writeManifest('cp-fail', manifest);
        // 预热双缓存并持有 files 引用（模拟链合并路径：写盘前直接修改缓存对象）
        const full = await repo.loadManifestWithFiles('cp-fail');
        full!.files['ws_a/dirty.txt'] = { hash: 'h-dirty', size: 1, mtimeMs: 1 };
        expect(repo['metaCache'].has('cp-fail')).toBe(true);
        expect(repo['filesCache'].has('cp-fail')).toBe(true);

        // 破坏目录结构：删除存档目录并占位同名文件 → mkdir 失败 → writeManifest 抛错
        const dir = path.join(storageRoot, 'checkpoints', 'cp-fail');
        await fs.rm(dir, { recursive: true, force: true });
        await fs.writeFile(dir, 'not a directory', 'utf-8');

        await expect(repo.writeManifest('cp-fail', manifest)).rejects.toThrow();
        // 失败后双缓存被清理：下次读取回到磁盘真实状态（不会命中被污染的 files）
        expect(repo['metaCache'].has('cp-fail')).toBe(false);
        expect(repo['filesCache'].has('cp-fail')).toBe(false);
    });

    describe('路径校验与 LRU 缓存', () => {
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

    describe('双文件提交配对一致性（ATOMIC-PAIR）', () => {
        let storageRoot: string;
        let repo: CheckpointManifestRepository;

        beforeEach(async () => {
            storageRoot = await createTempDirectory('limcode-manifest-pair-');
            repo = new CheckpointManifestRepository(path.join(storageRoot, 'checkpoints'));
        });

        afterEach(async () => {
            await fs.rm(storageRoot, { recursive: true, force: true });
        });

        const cpDir = () => path.join(storageRoot, 'checkpoints', 'cp-pair');
        const manifestPath = () => path.join(cpDir(), CHECKPOINT_MANIFEST_FILENAME);
        const filesPath = () => path.join(cpDir(), CHECKPOINT_MANIFEST_FILES_FILENAME);

        test('writeManifest 把同一 filesRevision 写入 manifest.json 与 files.json（配对绑定）', async () => {
            await repo.writeManifest('cp-pair', makeManifest('cp-pair', ['ws_a/a.txt']));

            const meta = JSON.parse(await fs.readFile(manifestPath(), 'utf-8')) as CheckpointManifestMeta;
            const filesPayload = JSON.parse(await fs.readFile(filesPath(), 'utf-8')) as {
                checkpointId: string;
                filesRevision: string;
                files: CheckpointManifest['files'];
            };
            expect(meta.filesRevision).toBeDefined();
            expect(filesPayload.filesRevision).toBe(meta.filesRevision);
            // 正常写入不残留备份文件
            await expect(fs.access(`${filesPath()}.prev`)).rejects.toThrow();
        });

        test('崩溃窗口（新 files.json + 旧 manifest.json，.prev 持旧配对）：恢复 manifest 对应配对，不混合版本', async () => {
            await repo.writeManifest('cp-pair', makeManifest('cp-pair', ['ws_a/a.txt']));
            repo.clearCache('cp-pair');
            const meta1 = JSON.parse(await fs.readFile(manifestPath(), 'utf-8')) as CheckpointManifestMeta;

            // 模拟第二次提交在 files.json rename 后、manifest.json（提交点）rename 前崩溃：
            // files.json 是未提交孤儿（rev-2），.prev 是 manifest 对应的旧配对（rev-1）
            const orphan = {
                checkpointId: 'cp-pair',
                filesRevision: 'rev-2',
                files: { 'ws_a/orphan.txt': { hash: 'h-orphan', size: 1, mtimeMs: 1 } }
            };
            const oldPair = {
                checkpointId: 'cp-pair',
                filesRevision: meta1.filesRevision,
                files: { 'ws_a/a.txt': { hash: 'h-0', size: 1, mtimeMs: 1 } }
            };
            await fs.writeFile(filesPath(), JSON.stringify(orphan), 'utf-8');
            await fs.writeFile(`${filesPath()}.prev`, JSON.stringify(oldPair), 'utf-8');

            const full = await repo.loadManifestWithFiles('cp-pair');
            // 读取的是 manifest 对应的旧配对，而不是未提交的孤儿快照
            expect(full).not.toBeNull();
            expect(full!.files['ws_a/a.txt']?.hash).toBe('h-0');
            expect(full!.files['ws_a/orphan.txt']).toBeUndefined();
            // 恢复后磁盘配对一致：files.json 被回滚为 rev-1（孤儿被覆盖）
            const restored = JSON.parse(await fs.readFile(filesPath(), 'utf-8')) as { filesRevision: string };
            expect(restored.filesRevision).toBe(meta1.filesRevision);
        });

        test('崩溃窗口（files.json 缺失，.prev 持完整旧配对）：从 .prev 恢复，不误报数据丢失', async () => {
            await repo.writeManifest('cp-pair', makeManifest('cp-pair', ['ws_a/a.txt']));
            repo.clearCache('cp-pair');
            // 模拟写流程第 3 步后崩溃：旧 files.json 已被挪为 .prev，新 files.json 未 rename 完成
            await fs.rename(filesPath(), `${filesPath()}.prev`);

            const full = await repo.loadManifestWithFiles('cp-pair');
            expect(full?.files['ws_a/a.txt']?.hash).toBe('h-0');
            // 恢复后 files.json 重新存在，备份被消费
            await expect(fs.access(filesPath())).resolves.toBeUndefined();
        });

        test('孤儿 files.json 无 .prev 可恢复：混合配对被拒绝（返回 null，不假空）', async () => {
            await repo.writeManifest('cp-pair', makeManifest('cp-pair', ['ws_a/a.txt']));
            repo.clearCache('cp-pair');
            // 模拟崩溃窗口且备份缺失（极端场景）：files.json 是 rev-2 孤儿，manifest 是 rev-1
            const orphan = {
                checkpointId: 'cp-pair',
                filesRevision: 'rev-2',
                files: { 'ws_a/orphan.txt': { hash: 'h-orphan', size: 1, mtimeMs: 1 } }
            };
            await fs.writeFile(filesPath(), JSON.stringify(orphan), 'utf-8');

            const full = await repo.loadManifestWithFiles('cp-pair');
            // 修复前：孤儿 files 会与旧 manifest 元数据混合返回（版本错配的快照被用于恢复）
            expect(full).toBeNull();
        });

        test('filesRevision 形状非法（非字符串）：manifest 视为损坏，走回退路径', async () => {
            const manifest = makeManifest('cp-pair', ['ws_a/a.txt']);
            await repo.writeManifest('cp-pair', manifest);
            repo.clearCache('cp-pair');
            // 手工把 filesRevision 篡改为非字符串
            const meta = JSON.parse(await fs.readFile(manifestPath(), 'utf-8')) as Record<string, unknown>;
            meta.filesRevision = 123;
            await fs.writeFile(manifestPath(), JSON.stringify(meta), 'utf-8');

            const loaded = await repo.loadManifest('cp-pair');
            expect(loaded).toBeNull(); // 损坏的 manifest 不进入配对校验路径
        });

        test('损坏的 files.json（非法 JSON）：不裸抛，走 .prev 恢复 / 内联兜底', async () => {
            await repo.writeManifest('cp-pair', makeManifest('cp-pair', ['ws_a/a.txt']));
            repo.clearCache('cp-pair');
            // 磁盘位翻：files.json 变成非法 JSON
            await fs.writeFile(filesPath(), '{ not valid json', 'utf-8');

            // 修复前：loadManifestFiles 的 JSON.parse 在 try 外 → 裸抛 SyntaxError；
            // 修复后：按损坏处理 → v2 无内联兜底 → 返回 null（不假空、不抛原始异常）
            const full = await repo.loadManifestWithFiles('cp-pair');
            expect(full).toBeNull();

            // 若存在可恢复的 .prev 配对，则从 .prev 恢复而不是报数据丢失
            const meta = JSON.parse(await fs.readFile(manifestPath(), 'utf-8')) as CheckpointManifestMeta;
            const oldPair = {
                checkpointId: 'cp-pair',
                filesRevision: meta.filesRevision,
                files: { 'ws_a/a.txt': { hash: 'h-0', size: 1, mtimeMs: 1 } }
            };
            await fs.writeFile(`${filesPath()}.prev`, JSON.stringify(oldPair), 'utf-8');
            repo.clearCache('cp-pair');

            const recovered = await repo.loadManifestWithFiles('cp-pair');
            expect(recovered?.files['ws_a/a.txt']?.hash).toBe('h-0');
            // 恢复后磁盘的 files.json 已是合法配对
            const restored = JSON.parse(await fs.readFile(filesPath(), 'utf-8')) as { filesRevision: string };
            expect(restored.filesRevision).toBe(meta.filesRevision);
        });
    });
});
