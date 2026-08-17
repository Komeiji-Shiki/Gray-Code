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
import { newUuid } from '../../core/id';
import type { CheckpointManifest, CheckpointManifestMeta, CheckpointIgnoreSnapshot } from './types';
import type { CheckpointRecord } from './CheckpointManager';
import { CheckpointPathError } from './CheckpointWorkspace';

export const CHECKPOINT_MANIFEST_VERSION = 2;
export const CHECKPOINT_MANIFEST_FILENAME = 'manifest.json';
/** CPF-LAZY-1: 重量级 files 映射的独立存储文件名（schema version 2 起） */
export const CHECKPOINT_MANIFEST_FILES_FILENAME = 'files.json';

/**
 * 备份目录内元数据残留/元数据文件名判定（H3）。
 *
 * 写路径（writeManifestFiles）实际可能留下的元数据残留：
 * - manifest.json.tmp / files.json.tmp：写失败或崩溃窗口的未提交临时文件（失败回滚 rm 回收，
 *   崩溃则残留）；
 * - files.json.prev：写新 files.json 前被暂存的旧配对（ATOMIC-PAIR 崩溃窗口回滚）。
 * 只精确匹配这些已知残留名与两个正式元数据文件名，**禁止**用宽泛的 .tmp/.prev 后缀——
 * 备份目录内用户的真实文件（如 notes.tmp、data.prev）不属元数据，恢复/统计/保留合并
 * 不得跳过它们。注意不存在 manifest.json.prev（提交点 rename 前 metaTmpPath 仅以 .tmp 存在）。
 */
export function isCheckpointMetadataEntryName(name: string): boolean {
    return name === CHECKPOINT_MANIFEST_FILENAME
        || name === CHECKPOINT_MANIFEST_FILES_FILENAME
        || name === `${CHECKPOINT_MANIFEST_FILENAME}.tmp`
        || name === `${CHECKPOINT_MANIFEST_FILES_FILENAME}.tmp`
        || name === `${CHECKPOINT_MANIFEST_FILES_FILENAME}.prev`;
}

/** files.json 磁盘载荷：checkpointId 与 filesRevision 用于与 manifest.json 配对一致性校验 */
export interface CheckpointManifestFilesPayload {
    checkpointId: string;
    /**
     * 本次提交的配对版本号：与 manifest.json 的 filesRevision 一致才视为同一提交。
     * 崩溃发生在 files.json 与 manifest.json 两次 rename 之间时，磁盘上会出现
     * 「新 files.json + 旧 manifest.json」的混合配对——读取侧据此识别并拒绝。
     */
    filesRevision: string;
    files: CheckpointManifest['files'];
}

/**
 * files 映射形状校验：非空对象且**非数组**（typeof [] === 'object'）。
 * 数组形状（如 {"files": []}）若被放行会当作「空工作区」进入恢复流程，
 * 导致工作区全部文件被误判为 untracked 可删除（H1，与 integrityCheck 口径一致）。
 */
function isFilesMapping(value: unknown): value is CheckpointManifest['files'] {
    return !!value && typeof value === 'object' && !Array.isArray(value);
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
    /** files 缓存条目携带配对 revision（ATOMIC-PAIR）：命中时仍可校验与 manifest 的配对一致性 */
    private readonly filesCache = new Map<string, { filesRevision?: string; files: CheckpointManifest['files'] }>();
    /**
     * per-checkpointId 写队列（single-flight）：同一存档的磁盘写入串行化。
     * 解决并发迁移/合并共享固定 tmp 文件名导致的 ENOENT 竞态，以及
     * files.json 与 manifest.json 被不同写者交错 rename 的配对错乱（M1）；
     * 同时保证 v1→v2 拆分迁移对同一存档只触发一次写盘。
     */
    private readonly writeChains = new Map<string, Promise<void>>();

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
        if (checkpointId !== undefined) {
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

    /**
     * files 映射深拷贝：缓存写入与返回前各拷贝一次（CP-CACHE-2），
     * 防止调用方原地修改（如链合并路径对 files 的直接写入）污染缓存。
     * 10-20MB 级大对象在写入/返回边界各付一次拷贝成本，换取缓存不可变性。
     */
    private static cloneFiles(files: CheckpointManifest['files']): CheckpointManifest['files'] {
        return structuredClone(files);
    }

    /**
     * 按 checkpointId 串行执行写入任务（single-flight 写队列）。
     * 前一任务失败不阻塞后一任务；链尾任务完成后自动移除队列条目。
     */
    private chainWrite(checkpointId: string, task: () => Promise<void>): Promise<void> {
        const prev = this.writeChains.get(checkpointId) ?? Promise.resolve();
        const next = prev.then(task, task);
        this.writeChains.set(checkpointId, next);
        // 链尾自清理：仅当自己仍是链尾时删除，后续任务会覆盖引用
        next.finally(() => {
            if (this.writeChains.get(checkpointId) === next) {
                this.writeChains.delete(checkpointId);
            }
        }).catch(() => {
            // finally 链的拒绝由 next 的调用方处理，此处仅避免未处理拒绝
        });
        return next;
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
     * 原子写入 manifest 拆分文件（CPF-LAZY-1 / ATOMIC-PAIR）。
     *
     * 双文件提交一致性：files.json 与 manifest.json 是同一份快照的两个文件，两次独立
     * rename 无法整体原子——崩溃发生在两次提交之间时，磁盘会出现「新 files.json +
     * 旧 manifest.json」的混合配对，旧实现读取侧无法识别。修复采用双保险：
     * 1. 版本绑定：每次提交生成随机 filesRevision，同时写入两个文件；读取时校验配对，
     *    混合配对被识别并拒绝使用（见 loadManifestFiles）；
     * 2. 旧配对备份：写新 files.json 前把旧 files.json 改名为 files.json.prev，崩溃后
     *    读取路径用 .prev 恢复「manifest 对应」的完整配对（见 tryRestoreFilesBackup），
     *    不产生版本混合、不误报数据丢失。
     *
     * 提交点仍是 manifest.json（最后 rename）：崩溃发生在两次 rename 之间时，恢复路径
     * 以 manifest 的 filesRevision 为准，回滚未提交的 files.json 孤儿。
     *
     * @returns 实际落盘的 stampedMeta（含本次生成的 filesRevision，调用方按它更新缓存）
     */
    private async writeManifestFiles(
        checkpointId: string,
        meta: CheckpointManifestMeta,
        files: CheckpointManifest['files']
    ): Promise<CheckpointManifestMeta> {
        const targetPath = this.getManifestPath(checkpointId);
        const filesPath = this.getManifestFilesPath(checkpointId);
        const filesTmpPath = `${filesPath}.tmp`;
        const metaTmpPath = `${targetPath}.tmp`;
        const filesBackupPath = `${filesPath}.prev`;
        const filesRevision = newUuid();
        const stampedMeta: CheckpointManifestMeta = { ...meta, filesRevision };
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        try {
            const filesPayload: CheckpointManifestFilesPayload = { checkpointId, filesRevision, files };
            // 两个 tmp 全部写完后再开始提交：任一 writeFile 失败都不会改变磁盘既有配对
            // 10-20MB 级大对象：紧凑序列化（无缩进）减小体积与序列化开销；files.json 是机器读数据，无需可读性
            await fs.writeFile(filesTmpPath, JSON.stringify(filesPayload), 'utf-8');
            await fs.writeFile(metaTmpPath, JSON.stringify(stampedMeta, null, 2), 'utf-8');
            // 旧配对暂存为 .prev：崩溃时读取路径可完整回滚到「manifest 对应的 files」
            try {
                await fs.rename(filesPath, filesBackupPath);
            } catch (err: any) {
                if (err?.code !== 'ENOENT') throw err; // 首次写入时无旧 files.json，跳过备份
            }
            await fs.rename(filesTmpPath, filesPath);
            await fs.rename(metaTmpPath, targetPath); // 提交点
        } catch (err) {
            // 失败时回滚：恢复被挪走的旧配对（rename 覆盖目标文件，原子），回收 tmp 残留
            try {
                await fs.rename(filesBackupPath, filesPath);
            } catch {
                // 无备份可恢复（首次写入失败）：本次提交前磁盘本就没有配对
            }
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
        // 提交成功后才清理备份（清理失败不影响已提交状态；残留的 .prev 在下次写入时被覆盖）
        try {
            await fs.rm(filesBackupPath, { force: true });
        } catch {
            // 忽略：残留备份无副作用
        }
        return stampedMeta;
    }

    /**
     * 写入 manifest（schema version 2：manifest.json 轻量元数据 + files.json 文件映射）。
     * 写入成功后更新双缓存；失败时清理残留 tmp 文件（L3），避免半截文件残留。
     */
    async writeManifest(checkpointId: string, manifest: CheckpointManifest): Promise<void> {
        assertSafeCheckpointDirName(checkpointId);
        // L2: manifest.checkpointId 必须与参数一致，否则产出配对不一致的两个文件
        // （manifest.json 与 files.json 各自校验失败 → 完整数据读取恒 null，数据丢失误判）
        if (manifest.checkpointId !== checkpointId) {
            throw new Error(`writeManifest checkpointId mismatch: ${manifest.checkpointId} !== ${checkpointId}`);
        }
        const { meta, files } = CheckpointManifestRepository.splitManifest(manifest);
        // 写出统一 stamp 当前版本：旧格式（v1）数据经任意写路径落盘即迁移为 v2 布局
        const stampedMeta: CheckpointManifestMeta = { ...meta, version: CHECKPOINT_MANIFEST_VERSION };
        let writtenMeta = stampedMeta;
        try {
            // 同一存档的写入经单飞队列串行化，避免并发写者互踩 tmp 文件
            await this.chainWrite(checkpointId, async () => {
                // writeManifestFiles 内部会再 stamp filesRevision；返回值含最终落盘版本，
                // 缓存与磁盘保持一致（配对校验依赖该字段）
                writtenMeta = await this.writeManifestFiles(checkpointId, stampedMeta, files);
            });
        } catch (err) {
            // 写失败（只读介质/磁盘满等）时磁盘未更新或部分更新：清掉该存档缓存，
            // 避免调用方在写盘前修改过的缓存对象（如链合并路径对 files 的直接写入）
            // 残留「内存与磁盘不一致」状态；迁移路径失败后由调用方自行重建缓存。
            this.clearCache(checkpointId);
            throw err;
        }
        this.cacheSet(this.metaCache, checkpointId, writtenMeta, CheckpointManifestRepository.META_CACHE_LIMIT);
        // CP-CACHE-2: 存入深拷贝 + 记录配对 revision（与落盘 stampedMeta 的 filesRevision 一致）
        this.cacheSet(
            this.filesCache,
            checkpointId,
            { filesRevision: writtenMeta.filesRevision, files: CheckpointManifestRepository.cloneFiles(files) },
            CheckpointManifestRepository.FILES_CACHE_LIMIT
        );
    }

    /** manifest.json 磁盘内容是否为可接受的布局（版本已知、checkpointId 匹配、元数据字段形状合法） */
    private isValidManifestJson(parsed: unknown, checkpointId: string): parsed is CheckpointManifest & { files?: unknown } {
        if (!parsed || typeof parsed !== 'object') {
            return false;
        }
        const candidate = parsed as {
            checkpointId?: unknown;
            version?: unknown;
            workspaceRoots?: unknown;
            emptyDirs?: unknown;
            changes?: unknown;
            excluded?: unknown;
            ignoreSnapshot?: unknown;
            files?: unknown;
            filesRevision?: unknown;
        };
        if (typeof candidate.checkpointId !== 'string' || candidate.checkpointId !== checkpointId) {
            return false;
        }
        if (typeof candidate.version !== 'number' || !Number.isInteger(candidate.version) || candidate.version < 1) {
            // 版本缺失/非法（0、负数、非整数如 1.5）→ 视为损坏，落入迁移/回退路径（有机会从记录恢复），
            // 而不是按「未知布局」误判为数据丢失
            return false;
        }
        // 版本未知（> 当前）不读取：布局可能不同，交给迁移/回退路径处理
        if (candidate.version > CHECKPOINT_MANIFEST_VERSION) {
            return false;
        }
        // M3: 元数据字段形状校验——列表摘要/排除说明等路径直接消费这些字段，
        // 缺字段/形状非法的损坏 manifest 若不拦截，会在 toSummary / buildExcludedNote 触发 TypeError
        if (!Array.isArray(candidate.workspaceRoots) || !Array.isArray(candidate.emptyDirs)
            || !Array.isArray(candidate.changes) || !Array.isArray(candidate.excluded)
            || !candidate.ignoreSnapshot || typeof candidate.ignoreSnapshot !== 'object') {
            return false;
        }
        // v1 布局必须内联 files（缺内联/形状非法视为损坏）；v2 布局 files 独立存放，此处不触碰
        if (candidate.version === CHECKPOINT_MANIFEST_VERSION - 1 && !isFilesMapping(candidate.files)) {
            return false;
        }
        // ATOMIC-PAIR：filesRevision 若存在必须是字符串（损坏/手工篡改不进入配对校验路径）
        if (candidate.filesRevision !== undefined && typeof candidate.filesRevision !== 'string') {
            return false;
        }
        return true;
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
     *   写入缓存；**默认 best-effort 落盘**（供恢复/增量等重量级路径持久化迁移产物），
     *   轻量列表路径传 persistMigration:false 只缓存不落盘（CPF-LAZY-1 列表写放大修复）；
     * - 都没有 → 返回 null。
     */
    async loadManifest(
        checkpointId: string,
        fallbackRecord?: CheckpointRecord,
        options?: { persistMigration?: boolean }
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
                // 内联 files 只存在于旧格式（v1，isValidManifestJson 已保证其形状合法）；
                // 新格式（v2）files 独立存放，此处不触碰 files.json
                const inlineFiles = isFilesMapping(parsed.files) ? parsed.files : undefined;
                const { files: _files, ...metaRest } = parsed;
                const meta: CheckpointManifestMeta = metaRest;
                this.cacheSet(this.metaCache, checkpointId, meta, CheckpointManifestRepository.META_CACHE_LIMIT);
                if (inlineFiles) {
                    // 旧格式：files 已随解析在手，进缓存（拆分落盘由完整读取路径触发）；
                    // 配对 revision 取 manifest 内联字段（v1 通常无 → undefined，命中时不校验）
                    this.cacheSet(
                        this.filesCache,
                        checkpointId,
                        { filesRevision: meta.filesRevision, files: CheckpointManifestRepository.cloneFiles(inlineFiles) },
                        CheckpointManifestRepository.FILES_CACHE_LIMIT
                    );
                }
                return meta;
            }
            // 损坏的 manifest：不缓存，继续走迁移/回退路径
        } catch {
            // 文件不存在或不可读：继续
        }

        if (fallbackRecord && (fallbackRecord.fileHashes || fallbackRecord.emptyDirs || fallbackRecord.changes)) {
            const migrated = this.buildManifestFromRecord(fallbackRecord);
            // L5: 新格式记录（元数据不含 fileHashes）但磁盘 manifest 缺失时，迁移产物
            // files 为空并不代表“空工作区”——记录声称应有完整数据，缺失即数据丢失。
            // 但真空工作区存档（fileCount === 0，仅空目录/无文件）是合法空快照：
            // 此时返回迁移产物（空 files + 记录的 emptyDirs），否则返回 null
            // （不落盘空 manifest，避免把“假空”持久化），由恢复路径给出显式错误。
            if (
                !fallbackRecord.fileHashes &&
                Object.keys(migrated.files).length === 0 &&
                (fallbackRecord.fileCount ?? 0) > 0
            ) {
                return null;
            }
            // CPF-LAZY-1: 迁移落盘可选——重量级路径（恢复/增量/合并）默认持久化迁移产物，
            // 轻量列表路径（toSummary）传 persistMigration:false 只缓存不落盘，避免列表加载
            // 为每条缺失 manifest 的旧记录付出 10-20MB 级全量迁移写盘（列表写放大）。
            if (options?.persistMigration !== false) {
                try {
                    await this.writeManifest(checkpointId, migrated);
                } catch {
                    // 迁移落盘失败（只读介质等）不影响本次使用：缓存仍生效
                }
            }
            const { meta, files } = CheckpointManifestRepository.splitManifest(migrated);
            this.cacheSet(this.metaCache, checkpointId, meta, CheckpointManifestRepository.META_CACHE_LIMIT);
            // CP-CACHE-2: 迁移产物无 filesRevision（undefined）——缓存命中时不触发配对校验；
            // 落盘路径（writeManifest）会 stamp 并更新缓存
            this.cacheSet(
                this.filesCache,
                checkpointId,
                { filesRevision: meta.filesRevision, files: CheckpointManifestRepository.cloneFiles(files) },
                CheckpointManifestRepository.FILES_CACHE_LIMIT
            );
            return meta;
        }

        return null;
    }

    /**
     * 按需懒加载 files 映射（CPF-LAZY-1）。
     *
     * - 缓存命中（旧格式内联解析 / 本方法先前加载）直接返回；
     * - 否则读取 files.json 并缓存；
     * - 配对校验（ATOMIC-PAIR）：expectedRevision 传入 manifest 的 filesRevision，
     *   files.json 的 filesRevision 不一致 = 崩溃窗口的未提交孤儿，拒绝使用并尝试从
     *   files.json.prev 恢复「manifest 对应」的完整配对。
     *   兼容限制：升级前的旧 v2 数据无 filesRevision → expectedRevision 为 undefined →
     *   跳过配对校验（无戳可对），升级后第一次写入的崩溃窗口仍可能混合配对；
     *   首个成功写入后窗口自然关闭。
     * - files.json 缺失/损坏 → 兜底回读 manifest.json 内联 files（v1 旧格式在拆分
     *   落盘未发生时数据仍在原处），并在此触发 best-effort 拆分落盘；v2 布局
     *   manifest.json 无内联 files → 返回 null（数据丢失场景，由调用方显式报错，不假空）。
     */
    async loadManifestFiles(checkpointId: string, expectedRevision?: string): Promise<CheckpointManifest['files'] | null> {
        assertSafeCheckpointDirName(checkpointId);
        const cached = this.cacheGet(this.filesCache, checkpointId);
        if (cached) {
            // ATOMIC-PAIR: 缓存命中同样执行配对校验——缓存条目可能来自旧配对
            //（v1 内联解析 / 先前加载的旧 files.json），与 manifest 的 filesRevision
            // 不一致 = 崩溃窗口的未提交孤儿：作废该条目走磁盘路径（重新配对校验 / .prev 恢复），
            // 避免缓存命中跳过配对校验而放行混合配对。
            if (expectedRevision !== undefined && cached.filesRevision !== expectedRevision) {
                this.filesCache.delete(checkpointId);
            } else {
                // CP-CACHE-2: 返回前拷贝，防止调用方原地修改污染缓存
                return CheckpointManifestRepository.cloneFiles(cached.files);
            }
        }
        const filesPath = this.getManifestFilesPath(checkpointId);
        const filesBackupPath = `${filesPath}.prev`;
        let raw: string | null = null;
        try {
            raw = await fs.readFile(filesPath, 'utf-8');
        } catch {
            // 文件不存在或不可读：尝试从 .prev 恢复崩溃窗口的旧配对，否则走内联兜底
        }
        if (raw !== null) {
            let parsed: Partial<CheckpointManifestFilesPayload> | null;
            try {
                parsed = JSON.parse(raw) as Partial<CheckpointManifestFilesPayload> | null;
            } catch {
                parsed = null; // 损坏的 files.json：不缓存（走 .prev 恢复 / 内联兜底）
            }
            if (
                parsed &&
                typeof parsed === 'object' &&
                parsed.checkpointId === checkpointId &&
                isFilesMapping(parsed.files) &&
                // ATOMIC-PAIR：filesRevision 与 manifest 一致才视为同一提交；
                // 缺省（旧数据无该字段）时跳过校验保持兼容
                (expectedRevision === undefined || parsed.filesRevision === expectedRevision)
            ) {
                const files = CheckpointManifestRepository.cloneFiles(parsed.files);
                this.cacheSet(
                    this.filesCache,
                    checkpointId,
                    { filesRevision: parsed.filesRevision, files },
                    CheckpointManifestRepository.FILES_CACHE_LIMIT
                );
                return files;
            }
            // files.json 是未提交的孤儿或损坏文件：尝试从 .prev 恢复 manifest 对应配对
            const restored = await this.tryRestoreFilesBackup(checkpointId, filesBackupPath, expectedRevision);
            if (restored) {
                return restored;
            }
            // 无法恢复：继续走内联兜底（v1）或按数据丢失处理（v2）
        } else {
            const restored = await this.tryRestoreFilesBackup(checkpointId, filesBackupPath, expectedRevision);
            if (restored) {
                return restored;
            }
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
                isFilesMapping(parsed.files)
            ) {
                const files = CheckpointManifestRepository.cloneFiles(parsed.files as CheckpointManifest['files']);
                this.cacheSet(
                    this.filesCache,
                    checkpointId,
                    { filesRevision: (parsed as { filesRevision?: string }).filesRevision, files },
                    CheckpointManifestRepository.FILES_CACHE_LIMIT
                );
                return files;
            }
        } catch {
            // manifest.json 也不可读：按数据丢失处理
        }
        return null;
    }

    /**
     * 从 files.json.prev 恢复「manifest 对应」的完整配对（ATOMIC-PAIR 崩溃窗口回滚）。
     *
     * 场景：写新 files.json 前旧配对被暂存为 .prev，随后崩溃——
     * - 崩溃发生在 .prev 暂存与 files.json rename 之间：files.json 缺失，.prev 持有完整旧配对；
     * - 崩溃发生在 files.json rename 与 manifest.json（提交点）rename 之间：files.json 是
     *   未提交孤儿，.prev 持有 manifest 对应的旧配对。
     * 两种场景下 .prev 的 filesRevision 都等于 manifest 的 filesRevision，恢复（rename 原子）
     * 后磁盘重新回到一致的已提交配对。恢复失败（只读介质等）返回 null，本次读取不采用。
     */
    private async tryRestoreFilesBackup(
        checkpointId: string,
        filesBackupPath: string,
        expectedRevision?: string
    ): Promise<CheckpointManifest['files'] | null> {
        let raw: string;
        try {
            raw = await fs.readFile(filesBackupPath, 'utf-8');
        } catch {
            return null; // 无备份：非崩溃窗口，或首次写入失败
        }
        let parsed: Partial<CheckpointManifestFilesPayload> | null;
        try {
            parsed = JSON.parse(raw) as Partial<CheckpointManifestFilesPayload> | null;
        } catch {
            return null; // 备份损坏：不强行使用
        }
        if (
            !parsed ||
            typeof parsed !== 'object' ||
            parsed.checkpointId !== checkpointId ||
            !isFilesMapping(parsed.files) ||
            // 备份也不是目标配对（旧提交已被更新的提交覆盖）：不强行使用
            (expectedRevision !== undefined && parsed.filesRevision !== expectedRevision)
        ) {
            return null;
        }
        const filesPath = this.getManifestFilesPath(checkpointId);
        // 竞态收敛（TOCTOU 缩窗）：恢复 rename 前复查 files.json——若并发写者恰好完成
        // 提交（配对一致），放弃恢复直接采用新配对；否则恢复覆盖仍停留在崩溃窗口的孤儿。
        try {
            const currentRaw = await fs.readFile(filesPath, 'utf-8');
            const current = JSON.parse(currentRaw) as Partial<CheckpointManifestFilesPayload> | null;
            if (
                current &&
                typeof current === 'object' &&
                current.checkpointId === checkpointId &&
                isFilesMapping(current.files) &&
                (expectedRevision === undefined || current.filesRevision === expectedRevision)
            ) {
                const files = CheckpointManifestRepository.cloneFiles(current.files);
                this.cacheSet(
                    this.filesCache,
                    checkpointId,
                    { filesRevision: current.filesRevision, files },
                    CheckpointManifestRepository.FILES_CACHE_LIMIT
                );
                return files;
            }
        } catch {
            // files.json 缺失/损坏：继续恢复
        }
        try {
            await fs.rename(filesBackupPath, filesPath); // 恢复：覆盖未提交孤儿，rename 原子
        } catch {
            return null; // 恢复失败（只读介质等）：本次读取不采用
        }
        const files = CheckpointManifestRepository.cloneFiles(parsed.files);
        this.cacheSet(
            this.filesCache,
            checkpointId,
            { filesRevision: parsed.filesRevision, files },
            CheckpointManifestRepository.FILES_CACHE_LIMIT
        );
        return files;
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
        const files = await this.loadManifestFiles(checkpointId, meta.filesRevision);
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
            // 与 writeManifest 共用同一单飞写队列：并发完整读取只触发一次拆分写盘
            // writeManifestFiles 返回含 filesRevision 的最终落盘版本，缓存与磁盘保持一致
            let writtenMeta = stampedMeta;
            await this.chainWrite(checkpointId, async () => {
                writtenMeta = await this.writeManifestFiles(checkpointId, stampedMeta, files);
            });
            this.cacheSet(this.metaCache, checkpointId, writtenMeta, CheckpointManifestRepository.META_CACHE_LIMIT);
            // R3 复查：filesCache 必须同步 stamp 为 writtenMeta 的配对 revision——
            // 否则迁移后 metaCache 为 v2（含 filesRevision）而 filesCache 仍持 v1 内联
            // 条目（filesRevision=undefined），下一次 loadManifestFiles 的配对校验会把
            // 这条内容仍有效的缓存误作废（多一次磁盘回读；files.json 缺失时还会误判
            // 数据丢失）。与 writeManifest 的双缓存更新同一口径（内容相同，仅补全 revision）。
            this.cacheSet(
                this.filesCache,
                checkpointId,
                { filesRevision: writtenMeta.filesRevision, files: CheckpointManifestRepository.cloneFiles(files) },
                CheckpointManifestRepository.FILES_CACHE_LIMIT
            );
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
            ignoreSnapshot,
            ...(record.absentPaths && record.absentPaths.length > 0 ? { absentPaths: record.absentPaths } : {}),
            // CP-PARTIAL-2：部分快照标记随迁移产物保留（manifest 缺失时语义不回退为全量）
            ...(record.partial === true ? { partial: true } : {})
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
            changes: manifest.changes.length > 0 ? manifest.changes : record.changes,
            ...(manifest.absentPaths ? { absentPaths: manifest.absentPaths } : {}),
            // CP-PARTIAL-2：部分快照标记从 manifest 回填（恢复侧据此禁用删除判定）
            ...(manifest.partial === true ? { partial: true } : {})
        };
    }
}
