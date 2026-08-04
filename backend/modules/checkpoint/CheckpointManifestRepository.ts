/**
 * CheckpointManifestRepository - 独立存档 manifest 的读写（CPF-01/CPF-02/EX-10）。
 *
 * 职责：
 * - 按存档 ID 读写 `checkpoints/cp_xxx/manifest.json`（原子写入：tmp + rename）
 * - 旧记录迁移：旧存档没有 manifest 时，从 CheckpointRecord 的 fileHashes/fileStats/
 *   emptyDirs/changes 生成 manifest 并缓存（MIG-02 前置；生成结果 best-effort 落盘）
 * - 记录补全：新格式记录（元数据不含 fileHashes/fileStats）从 manifest 回填完整数据，
 *   供增量比较 / 恢复链构建使用
 *
 * 路径语义：manifest 固定位于存档目录（`checkpointId` 即目录名）下的 manifest.json。
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import type { CheckpointManifest, CheckpointIgnoreSnapshot } from './types';
import type { CheckpointRecord } from './CheckpointManager';
import { CheckpointPathError } from './CheckpointWorkspace';

export const CHECKPOINT_MANIFEST_VERSION = 1;
export const CHECKPOINT_MANIFEST_FILENAME = 'manifest.json';

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
     * CP-CACHE-1: manifest 内存缓存 LRU 上限。
     * 每条 manifest 含全工作区 files 映射（10 万文件 ≈ 10-20MB），无界缓存会让
     * 长时间运行的扩展宿主内存持续增长；超出上限时淘汰最久未使用的条目。
     */
    private static readonly CACHE_LIMIT = 32;
    private readonly cache = new Map<string, CheckpointManifest>();

    constructor(private readonly checkpointsDir: string) {}

    /** manifest 文件路径（checkpointId 即存档目录名）；非法 ID 抛 CheckpointPathError（CP-PATH-1） */
    getManifestPath(checkpointId: string): string {
        assertSafeCheckpointDirName(checkpointId);
        return path.join(this.checkpointsDir, checkpointId, CHECKPOINT_MANIFEST_FILENAME);
    }

    /** 清空缓存（可指定单个存档） */
    clearCache(checkpointId?: string): void {
        if (checkpointId) {
            this.cache.delete(checkpointId);
        } else {
            this.cache.clear();
        }
    }

    /** LRU 读取：命中后重插刷新为“最新”（Map 迭代顺序 = 插入顺序） */
    private cacheGet(checkpointId: string): CheckpointManifest | undefined {
        const hit = this.cache.get(checkpointId);
        if (hit !== undefined) {
            this.cache.delete(checkpointId);
            this.cache.set(checkpointId, hit);
        }
        return hit;
    }

    /** LRU 写入：插入并淘汰最久未使用的条目 */
    private cacheSet(checkpointId: string, manifest: CheckpointManifest): void {
        this.cache.delete(checkpointId);
        this.cache.set(checkpointId, manifest);
        while (this.cache.size > CheckpointManifestRepository.CACHE_LIMIT) {
            const oldest = this.cache.keys().next().value;
            if (oldest === undefined) {
                break;
            }
            this.cache.delete(oldest);
        }
    }

    /**
     * 原子写入 manifest：先写 `manifest.json.tmp` 再 rename，避免半截 JSON 被读到。
     * 写入成功后更新内存缓存；失败时清理残留 tmp 文件（L3），避免半截文件残留。
     */
    async writeManifest(checkpointId: string, manifest: CheckpointManifest): Promise<void> {
        const targetPath = this.getManifestPath(checkpointId);
        const tmpPath = `${targetPath}.tmp`;
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        try {
            await fs.writeFile(tmpPath, JSON.stringify(manifest, null, 2), 'utf-8');
            await fs.rename(tmpPath, targetPath);
        } catch (err) {
            // L3: 原子写失败时回收 tmp 文件（只读介质/磁盘满等场景下避免残留垃圾）
            try {
                await fs.rm(tmpPath, { force: true });
            } catch {
                // 清理失败不影响主错误
            }
            throw err;
        }
        this.cacheSet(checkpointId, manifest);
    }

    /**
     * 按 checkpointId 加载 manifest。
     *
     * - 磁盘存在 manifest → 解析并缓存；
     * - 磁盘不存在但提供了旧记录（fallbackRecord）→ 从记录生成 manifest（迁移），
     *   写入缓存并 best-effort 落盘；
     * - 都没有 → 返回 null。
     */
    async loadManifest(
        checkpointId: string,
        fallbackRecord?: CheckpointRecord
    ): Promise<CheckpointManifest | null> {
        // CP-PATH-1: 非法 checkpointId 直接抛错，不允许落入缓存/磁盘/迁移回退路径
        assertSafeCheckpointDirName(checkpointId);
        const cached = this.cacheGet(checkpointId);
        if (cached) {
            return cached;
        }

        try {
            const raw = await fs.readFile(this.getManifestPath(checkpointId), 'utf-8');
            const parsed = JSON.parse(raw) as CheckpointManifest;
            if (
                parsed &&
                typeof parsed === 'object' &&
                typeof parsed.checkpointId === 'string' &&
                parsed.checkpointId === checkpointId &&
                parsed.files &&
                typeof parsed.files === 'object'
            ) {
                this.cacheSet(checkpointId, parsed);
                return parsed;
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
            return migrated;
        }

        return null;
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
        const manifest = await this.loadManifest(record.id, record);
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
