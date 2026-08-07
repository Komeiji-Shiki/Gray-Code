/**
 * CheckpointManifestRepository - 独立存档 manifest 的读写（CPF-01/CPF-02/EX-10/CPF-LAZY-1）。
 *
 * 职责：
 * - 按存档 ID 读写 `checkpoints/cp_xxx/manifest.json`（原子写入：tmp + rename）
 * - 旧记录迁移：旧存档没有 manifest 时，从 CheckpointRecord 的 fileHashes/fileStats/
 *   emptyDirs/changes 生成 manifest 并缓存（MIG-02 前置；生成结果 best-effort 落盘）
 * - 记录补全：新格式记录（元数据不含 fileHashes/fileStats）从 manifest 回填完整数据，
 *   供增量比较 / 恢复链构建使用
 *
 * CPF-LAZY-1（懒加载）：schema version 2 起，重量级 `files` 映射（大工作区 10-20MB）
 * 独立存放于同目录 `files.json`：
 * - `loadManifest` 只读轻量 manifest.json（元数据视图，绝不触碰 files.json）——
 *   列表摘要、排除清单、排除说明等读取路径不再为少量字段解析整张文件哈希表；
 * - `loadManifestWithFiles` / `enrichRecord` 才按需加载 files.json（恢复、增量比较、合并）；
 * - 旧格式（version 1，files 内联于 manifest.json）仍可读取：轻量读取路径解析一次后
 *   files 进缓存（零写放大），完整数据被请求时才 best-effort 拆分为新格式落盘，
 *   失败/未迁移的 v1 存档由内联兜底继续提供数据。
 *
 * 路径语义：manifest 固定位于存档目录（`checkpointId` 即目录名）下的 manifest.json。
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import type { CheckpointManifest, CheckpointManifestMeta, CheckpointIgnoreSnapshot } from './types';
import type { CheckpointRecord } from './CheckpointManager';
import { CheckpointPathError } from './CheckpointWorkspace';

export const CHECKPOINT_MANIFEST_VERSION = 2;
export const CHECKPOINT_MANIFEST_FILENAME = 'manifest.json';
/** CPF-LAZY-1: 重量级 files 映射的独立存储文件名（schema version 2 起） */
export const CHECKPOINT_MANIFEST_FILES_FILENAME = 'files.json';

/** files.json 磁盘载荷：checkpointId 用于一致性校验，files 为完整文件映射 */
export interface CheckpointManifestFilesPayload {
    checkpointId: string;
    files: CheckpointManifest['files'];
}

/**
 * 存档目录名安全校验（CP-DEL-1 / CP-PATH-1 / CP-RET-2 共用）。
 *
 * backupDir / checkpointId 来自对话元数据或 webview 消息，可能被手工编辑、损坏或恶意构造；
 * 删除、合并、manifest 读写路径在使用 `path.join(checkpointsDir, name)` 之前必须校验，
 * 否则 `fs.rm(recursive)` / `fs.cp` / `fs.readFile` 可能越界操作存档目录外内容。
 *
 * 规则：非空、无路径分隔符、非 `.` / `..`、非绝对路径 / 盘符、无空白与控制字符；
 * 等价于「解析后必然落在 checkpointsDir 内的单层目录名」。
 * 测试常用的 `cp-1` / `a-1` 等连字符命名均放行；真实存档名为 `cp_xxx`。
 */
export function isSafeCheckpointDirName(name: string): boolean {
    if (typeof name !== 'string' || name.length === 0) {
        return false;
    }
    if (name === '.' || name === '..' || name.includes('\0')) {
        return false;
    }
    // 单层目录名：拒绝路径分隔符（含 Windows 反斜杠）与绝对路径/盘符前缀
    if (name.includes('/') || name.includes('\\')) {
        return false;
    }
    if (path.isAbsolute(name) || /^[a-zA-Z]:/.test(name)) {
        return false;
    }
    return /^[a-zA-Z0-9_.-]+$/.test(name);
}

/** 校验失败抛 CheckpointPathError（供 manifest 路径等需要硬失败的位置使用） */
export function assertSafeCheckpointDirName(name: string): void {
    if (!isSafeCheckpointDirName(name)) {
        throw new CheckpointPathError('INVALID_CHECKPOINT_PATH', `Unsafe checkpoint dir name: ${name}`);
    }
}

/**
 * 检查点管理器
 */
export class CheckpointManifestRepository {
    /**
     * CP-CACHE-1 / CPF-LAZY-1: 轻量元数据缓存 LRU 上限。
     * 条目不含 files 映射（元数据视图，单条 KB 级），无界缓存风险可控但保持既有上限语义。
     */
    private static readonly META_CACHE_LIMIT = 32;
    /**
     * CPF-LAZY-1: files 映射缓存 LRU 上限。
     * 每条含全工作区文件映射（10 万文件 ≈ 10-20MB），按需加载后才进入缓存；
     * 上限取 8 兼顾「预览 → 确认恢复」等短周期复用与内存占用（≈160MB 峰值）。
     */
    private static readonly FILES_CACHE_LIMIT = 8;
    private readonly metaCache = new Map<string, CheckpointManifestMeta>();
    private readonly filesCache = new Map<string, CheckpointManifest['files']>();

    constructor(private readonly checkpointsDir: string) {}

    /** manifest 文件路径（checkpointId 即存档目录名）；非法 ID 抛 CheckpointPathError（CP-PATH-1） */
    getManifestPath(checkpointId: string): string {
        assertSafeCheckpointDirName(checkpointId);
        return path.join(this.checkpointsDir, checkpointId, CHECKPOINT_MANIFEST_FILENAME);
    }

    /** files 映射文件路径（schema version 2 起）；非法 ID 抛 CheckpointPathError（CP-PATH-1） */
    getManifestFilesPath(checkpointId: string): string {
        assertSafeCheckpointDirName(checkpointId);
        return path.join(this.checkpointsDir, checkpointId, CHECKPOINT_MANIFEST_FILES_FILENAME);
    }

    /** 清空缓存（可指定单个存档；meta 与 files 双缓存一并清理） */
    clearCache(checkpointId?: string): void {
        if (checkpointId) {
            this.metaCache.delete(checkpointId);
            this.filesCache.delete(checkpointId);
        } else {
            this.metaCache.clear();
            this.filesCache.clear();
        }
    }

    /** LRU 读取：命中后重插刷新为“最新”（Map 迭代顺序 = 插入顺序） */
    private cacheGet<T>(cache: Map<string, T>, checkpointId: string): T | undefined {
        const hit = cache.get(checkpointId);
        if (hit !== undefined) {
            cache.delete(checkpointId);
            cache.set(checkpointId, hit);
        }
        return hit;
    }

    /** LRU 写入：插入并淘汰最久未使用的条目 */
    private cacheSet<T>(cache: Map<string, T>, checkpointId: string, value: T, limit: number): void {
        cache.delete(checkpointId);
        cache.set(checkpointId, value);
        while (cache.size > limit) {
            const oldest = cache.keys().next().value;
            if (oldest === undefined) {
                break;
            }
            cache.delete(oldest);
        }
    }

    /** 把完整 manifest 拆为元数据视图 + files 映射（写出与迁移共用同一口径） */
    private static splitManifest(manifest: CheckpointManifest): {
        meta: CheckpointManifestMeta;
        files: CheckpointManifest['files'];
    } {
        const { files, ...metaRest } = manifest;
        return { meta: metaRest, files };
    }

    /**
     * 原子写入 manifest 拆分文件（CPF-LAZY-1）。
     *
     * 写入顺序：先 files.json（tmp + rename），再 manifest.json（tmp + rename）——
     * manifest.json 是提交点：崩溃发生在两次写入之间时，manifest.json 仍指向旧内容
     * （旧格式含内联 files 或旧版本），读取路径保持一致；多写的 files.json 是孤儿
     * 数据文件，被目录遍历/大小统计/恢复路径跳过（见 CheckpointQueryService /
     * CheckpointRetentionService 的跳过清单），下次写入自然覆盖。
     * 写入成功后双缓存更新；失败时清理两处残留 tmp 文件（L3）。
     */
    private async writeManifestFiles(checkpointId: string, meta: CheckpointManifestMeta, files: CheckpointManifest['files']): Promise<void> {
        const targetPath = this.getManifestPath(checkpointId);
        const filesPath = this.getManifestFilesPath(checkpointId);
        const filesTmpPath = `${filesPath}.tmp`;
        const metaTmpPath = `${targetPath}.tmp`;
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        try {
            const filesPayload: CheckpointManifestFilesPayload = { checkpointId, files };
            // 10-20MB 级大对象：紧凑序列化（无缩进）减小体积与序列化开销；files.json 是机器读数据，无需可读性
            await fs.writeFile(filesTmpPath, JSON.stringify(filesPayload), 'utf-8');
            await fs.rename(filesTmpPath, filesPath);
            await fs.writeFile(metaTmpPath, JSON.stringify(meta, null, 2), 'utf-8');
            await fs.rename(metaTmpPath, targetPath);
        } catch (err) {
            // L3: 原子写失败时回收 tmp 文件（只读介质/磁盘满等场景下避免残留垃圾）
            try {
                await fs.rm(filesTmpPath, { force: true });
            } catch {
                // 清理失败不影响主错误
            }
            try {
                await fs.rm(metaTmpPath, { force: true });
            } catch {
                // 清理失败不影响主错误
            }
            throw err;
        }
    }

    /**
     * 写入 manifest（schema version 2：manifest.json 轻量元数据 + files.json 文件映射）。
     * 写入成功后更新双缓存；失败时清理残留 tmp 文件（L3），避免半截文件残留。
     */
    async writeManifest(checkpointId: string, manifest: CheckpointManifest): Promise<void> {
        assertSafeCheckpointDirName(checkpointId);
        const { meta, files } = CheckpointManifestRepository.splitManifest(manifest);
        // 写出统一 stamp 当前版本：旧格式（v1）数据经任意写路径落盘即迁移为 v2 布局
        const stampedMeta: CheckpointManifestMeta = { ...meta, version: CHECKPOINT_MANIFEST_VERSION };
        try {
            await this.writeManifestFiles(checkpointId, stampedMeta, files);
        } catch (err) {
            // 写失败（只读介质/磁盘满等）时磁盘未更新或部分更新：清掉该存档缓存，
            // 避免调用方在写盘前修改过的缓存对象（如链合并路径对 files 的直接写入）
            // 残留「内存与磁盘不一致」状态；迁移路径失败后由调用方自行重建缓存。
            this.clearCache(checkpointId);
            throw err;
        }
        this.cacheSet(this.metaCache, checkpointId, stampedMeta, CheckpointManifestRepository.META_CACHE_LIMIT);
        this.cacheSet(this.filesCache, checkpointId, files, CheckpointManifestRepository.FILES_CACHE_LIMIT);
    }

    /** manifest.json 磁盘内容是否为可接受的布局（版本已知、checkpointId 匹配） */
    private isValidManifestJson(parsed: unknown, checkpointId: string): parsed is CheckpointManifest & { files?: unknown } {
        if (!parsed || typeof parsed !== 'object') {
            return false;
        }
        const candidate = parsed as { checkpointId?: unknown; version?: unknown };
        if (typeof candidate.checkpointId !== 'string' || candidate.checkpointId !== checkpointId) {
            return false;
        }
        if (typeof candidate.version !== 'number' || !Number.isInteger(candidate.version) || candidate.version < 1) {
            // 版本缺失/非法（0、负数、非整数如 1.5）→ 视为损坏，落入迁移/回退路径（有机会从记录恢复），
            // 而不是按「未知布局」误判为数据丢失
            return false;
        }
        // 版本未知（> 当前）不读取：布局可能不同，交给迁移/回退路径处理
        return candidate.version <= CHECKPOINT_MANIFEST_VERSION;
    }

    /**
     * 按 checkpointId 加载 manifest 轻量元数据视图（CPF-LAZY-1）。
     *
     * 本方法绝不读取 files.json：
     * - schema version 2：manifest.json 不含 files，直接返回元数据视图；
     * - schema version 1（旧格式）：files 内联于 manifest.json，解析一次后 files 进
     *   独立缓存（供 loadManifestWithFiles 复用）；**不在此拆分落盘**——轻量读取路径
     *   （列表摘要/排除清单等）只消费元数据，拆分写盘推迟到完整数据读取时触发
     *   （见 loadManifestFiles 内联兜底），避免列表加载为每条旧存档付出
     *   10-20MB 级磁盘写放大；
     * - 磁盘不存在但提供了旧记录（fallbackRecord）→ 从记录生成 manifest（迁移），
     *   写入缓存并 best-effort 落盘；
     * - 都没有 → 返回 null。
     */
    async loadManifest(
        checkpointId: string,
        fallbackRecord?: CheckpointRecord
    ): Promise<CheckpointManifestMeta | null> {
        // CP-PATH-1: 非法 checkpointId 直接抛错，不允许落入缓存/磁盘/迁移回退路径
        assertSafeCheckpointDirName(checkpointId);
        const cached = this.cacheGet(this.metaCache, checkpointId);
        if (cached) {
            return cached;
        }

        try {
            const raw = await fs.readFile(this.getManifestPath(checkpointId), 'utf-8');
            const parsed = JSON.parse(raw) as CheckpointManifest & { files?: CheckpointManifest['files'] };
            if (this.isValidManifestJson(parsed, checkpointId)) {
                // 内联 files 只存在于旧格式（v1）；新格式（v2）files 独立存放，此处不触碰
                const inlineFiles =
                    parsed.files && typeof parsed.files === 'object' ? parsed.files : undefined;
                // v1 布局必然内联 files：缺内联视为损坏，落入迁移/回退路径
                const legacyLayoutMissingFiles =
                    parsed.version === CHECKPOINT_MANIFEST_VERSION - 1 && !inlineFiles;
                if (!legacyLayoutMissingFiles) {
                    const { files: _files, ...metaRest } = parsed;
                    const meta: CheckpointManifestMeta = metaRest;
                    this.cacheSet(this.metaCache, checkpointId, meta, CheckpointManifestRepository.META_CACHE_LIMIT);
                    if (inlineFiles) {
                        // 旧格式：files 已随解析在手，进缓存（拆分落盘由完整读取路径触发）
                        this.cacheSet(this.filesCache, checkpointId, inlineFiles, CheckpointManifestRepository.FILES_CACHE_LIMIT);
                    }
                    return meta;
                }
            }
            // 损坏的 manifest：不缓存，继续走迁移/回退路径
        } catch {
            // 文件不存在或不可读：继续
        }

        if (fallbackRecord && (fallbackRecord.fileHashes || fallbackRecord.emptyDirs || fallbackRecord.changes)) {
            const migrated = this.buildManifestFromRecord(fallbackRecord);
            // L5: 新格式记录（元数据不含 fileHashes）但磁盘 manifest 缺失时，迁移产物
            // files 为空并不代表“空工作区”——记录声称应有完整数据，缺失即数据丢失。
            // 此时返回 null（不落盘空 manifest，避免把“假空”持久化），由恢复路径给出
            // 显式错误，而不是把空 manifest 当成功。
            if (!fallbackRecord.fileHashes && Object.keys(migrated.files).length === 0) {
                return null;
            }
            try {
                await this.writeManifest(checkpointId, migrated);
            } catch {
                // 迁移落盘失败（只读介质等）不影响本次使用：缓存仍生效
            }
            const { meta, files } = CheckpointManifestRepository.splitManifest(migrated);
            this.cacheSet(this.metaCache, checkpointId, meta, CheckpointManifestRepository.META_CACHE_LIMIT);
            this.cacheSet(this.filesCache, checkpointId, files, CheckpointManifestRepository.FILES_CACHE_LIMIT);
            return meta;
        }

        return null;
    }

    /**
     * 按需懒加载 files 映射（CPF-LAZY-1）。
     *
     * - 缓存命中（旧格式内联解析 / 本方法先前加载）直接返回；
     * - 否则读取 files.json 并缓存；
     * - files.json 缺失/损坏 → 兜底回读 manifest.json 内联 files（v1 旧格式在拆分
     *   落盘未发生时数据仍在原处），并在此触发 best-effort 拆分落盘；v2 布局
     *   manifest.json 无内联 files → 返回 null（数据丢失场景，由调用方显式报错，不假空）。
     */
    async loadManifestFiles(checkpointId: string): Promise<CheckpointManifest['files'] | null> {
        assertSafeCheckpointDirName(checkpointId);
        const cached = this.cacheGet(this.filesCache, checkpointId);
        if (cached) {
            return cached;
        }
        try {
            const raw = await fs.readFile(this.getManifestFilesPath(checkpointId), 'utf-8');
            const parsed = JSON.parse(raw) as Partial<CheckpointManifestFilesPayload> | null;
            if (
                parsed &&
                typeof parsed === 'object' &&
                parsed.checkpointId === checkpointId &&
                parsed.files &&
                typeof parsed.files === 'object'
            ) {
                this.cacheSet(this.filesCache, checkpointId, parsed.files, CheckpointManifestRepository.FILES_CACHE_LIMIT);
                return parsed.files;
            }
            // 损坏的 files.json：不缓存（继续走内联兜底）
        } catch {
            // 文件不存在或不可读：继续走内联兜底
        }
        // 兜底：v1 旧格式（从未/尚未拆分落盘）——files 仍内联于 manifest.json。
        // 否则 meta 缓存命中而 files 缓存被淘汰时，会把仍在盘上的数据误判为丢失。
        // （拆分落盘由 loadManifestWithFiles 在 v1 判定后触发，本方法只负责数据读取）
        try {
            const raw = await fs.readFile(this.getManifestPath(checkpointId), 'utf-8');
            const parsed = JSON.parse(raw) as { checkpointId?: unknown; files?: unknown };
            if (
                parsed &&
                typeof parsed === 'object' &&
                parsed.checkpointId === checkpointId &&
                parsed.files &&
                typeof parsed.files === 'object'
            ) {
                const files = parsed.files as CheckpointManifest['files'];
                this.cacheSet(this.filesCache, checkpointId, files, CheckpointManifestRepository.FILES_CACHE_LIMIT);
                return files;
            }
        } catch {
            // manifest.json 也不可读：按数据丢失处理
        }
        return null;
    }

    /**
     * 按 checkpointId 加载完整 manifest（元数据视图 + 懒加载 files 映射）。
     *
     * 与 loadManifest 的区别：需要完整文件映射的调用方（恢复链构建、增量比较、合并）
     * 使用本方法；files.json 缺失/损坏时返回 null（由调用方按存档数据丢失处理）。
     *
     * v1 旧格式（meta.version === 1）在此触发 best-effort 拆分落盘：完整数据确实被
     * 请求（恢复/增量比较/合并等重量级操作），一次 10-20MB 级拆分写换取后续读取走
     * 轻量路径；幂等——拆分成功后磁盘为 v2，再次读取 meta.version 为 2 不再重复写。
     */
    async loadManifestWithFiles(
        checkpointId: string,
        fallbackRecord?: CheckpointRecord
    ): Promise<CheckpointManifest | null> {
        const meta = await this.loadManifest(checkpointId, fallbackRecord);
        if (!meta) {
            return null;
        }
        const files = await this.loadManifestFiles(checkpointId);
        if (!files) {
            return null;
        }
        let resultMeta = meta;
        if (meta.version === CHECKPOINT_MANIFEST_VERSION - 1) {
            const stampedMeta: CheckpointManifestMeta = { ...meta, version: CHECKPOINT_MANIFEST_VERSION };
            if (await this.splitMigrateOnDisk(checkpointId, stampedMeta, files)) {
                resultMeta = stampedMeta;
            }
        }
        return { ...resultMeta, files };
    }

    /**
     * CPF-LAZY-1: 旧格式（v1，files 内联）best-effort 拆分为新格式（v2 布局）。
     *
     * 仅在**完整数据读取路径**（loadManifestWithFiles）触发：轻量读取（列表摘要/
     * 排除清单等）不承担 10-20MB 级拆分写盘；完整读取为恢复/增量比较/合并等重量级
     * 操作，一次拆分写后后续读取全部走轻量路径。失败（只读介质等）保留旧格式，
     * 数据由内联兜底继续提供。
     *
     * 写入成功后同步更新 metaCache（stamp 为 v2），避免缓存残留 v1 导致后续
     * loadManifestWithFiles 重复触发迁移写盘；返回 true 表示迁移成功、调用方应
     * 使用 stampedMeta 作为返回值版本。
     */
    private async splitMigrateOnDisk(
        checkpointId: string,
        stampedMeta: CheckpointManifestMeta,
        files: CheckpointManifest['files']
    ): Promise<boolean> {
        try {
            await this.writeManifestFiles(checkpointId, stampedMeta, files);
            this.cacheSet(this.metaCache, checkpointId, stampedMeta, CheckpointManifestRepository.META_CACHE_LIMIT);
            return true;
        } catch {
            // best-effort：失败不影响本次读取（旧格式仍可继续被解析读取）
            return false;
        }
    }

    /**
     * 从旧记录生成 manifest（MIG-02）。
     *
     * 旧记录只携带 fileHashes / fileStats / emptyDirs / changes / unbackedPaths /
     * ignorePatterns，没有排除统计；迁移时 excluded 用 unbackedPaths 近似表达
     * （原因标记为 unreadable，来源 legacy），ignoreSnapshot 用当时的自定义忽略模式。
     */
    buildManifestFromRecord(record: CheckpointRecord): CheckpointManifest {
        const files: CheckpointManifest['files'] = {};
        for (const [scopedPath, hash] of Object.entries(record.fileHashes ?? {})) {
            const stat = record.fileStats?.[scopedPath];
            files[scopedPath] = {
                hash,
                size: stat?.size ?? 0,
                mtimeMs: stat?.mtimeMs ?? 0,
                mtimeNs: stat?.mtimeNs
            };
        }

        const excluded: CheckpointManifest['excluded'] = (record.unbackedPaths ?? []).map(pathKey => ({
            path: pathKey,
            reason: 'unreadable' as const,
            source: 'legacy'
        }));

        const ignoreSnapshot: CheckpointIgnoreSnapshot = {
            version: 1,
            forcedRulesVersion: 1,
            defaultProfileVersion: 1,
            enabledProfiles: {},
            maxFileSizeBytes: 0,
            // MIG-03: 优先用记录中的合并快照（旧 customIgnorePatterns + 新 exclusion.customPatterns
            // 已在写入时合并进 ignoreSnapshot.customPatterns），旧记录（无 ignoreSnapshot）回退到
            // 历史字段 ignorePatterns，保证回退生成的 manifest 与快照构建口径一致。
            customPatterns: record.ignoreSnapshot?.customPatterns ?? record.ignorePatterns ?? []
        };

        return {
            version: CHECKPOINT_MANIFEST_VERSION,
            checkpointId: record.id,
            workspaceRoots: record.workspaceRoots ?? [],
            files,
            emptyDirs: record.emptyDirs ?? [],
            changes: (record.changes ?? []) as CheckpointManifest['changes'],
            excluded,
            ignoreSnapshot
        };
    }

    /**
     * 用 manifest 数据补全记录（新格式记录在元数据中不存 fileHashes/fileStats，
     * 需要完整数据时从 manifest 回填）。
     *
     * - 记录已有 fileHashes（旧格式）→ 原样返回；
     * - 记录没有但 manifest 可加载（含迁移）→ 回填 fileHashes/fileStats/emptyDirs/changes；
     * - 都没有（真正的 legacy 存档）→ 原样返回。
     */
    async enrichRecord(record: CheckpointRecord): Promise<CheckpointRecord> {
        if (record.fileHashes) {
            return record;
        }
        const manifest = await this.loadManifestWithFiles(record.id, record);
        if (!manifest) {
            return record;
        }

        const fileHashes: Record<string, string> = {};
        const fileStats: Record<string, { mtimeMs: number; size: number; mtimeNs?: string }> = {};
        for (const [scopedPath, file] of Object.entries(manifest.files)) {
            fileHashes[scopedPath] = file.hash;
            fileStats[scopedPath] = { mtimeMs: file.mtimeMs, size: file.size, mtimeNs: file.mtimeNs };
        }

        return {
            ...record,
            fileHashes,
            fileStats,
            emptyDirs: manifest.emptyDirs.length > 0 ? manifest.emptyDirs : record.emptyDirs,
            changes: manifest.changes.length > 0 ? manifest.changes : record.changes
        };
    }
}
