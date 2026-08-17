/**
 * CheckpointSnapshotBuilder - 工作区快照构建器
 *
 * 职责：
 * - 多根工作区扫描（每个根目录使用 CheckpointIgnoreResolver）
 * - 强制排除绝对路径（存档目录自身等，防止存档把自己再次备份）
 * - 单文件大小上限（超出记录原因，不静默消失）
 * - 流式哈希（createReadStream），不再整文件 readFile
 * - 有界并发，避免无限 Promise.all
 *
 * 输出统一使用工作区作用域路径（`rootId/relative/path`），
 * 与 CheckpointWorkspace.createWorkspaceScopedPath 保持一致。
 *
 * 本模块不依赖 CheckpointManager，是独立的纯文件系统逻辑，
 * 便于单元测试与后续将 CheckpointManager 拆分为协调层。
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import type { Stats, BigIntStats } from 'fs';
import { CheckpointIgnoreResolver, type CheckpointResolverExcludedEntry } from './CheckpointIgnoreResolver';
import { isPathWithin } from './affectedPaths';
import {
    createWorkspaceScopedPath,
    type RuntimeWorkspaceRoot
} from './CheckpointWorkspace';
import {
    buildIgnoreSnapshot,
    DEFAULT_ENABLED_PROFILES
} from './CheckpointExclusionProfiles';
import { runBounded } from './checkpointConcurrency';
import { hashFileStreaming } from './fileHashing';
import { isExcludedAbsolutePath } from './checkpointPathUtils';
import type {
    CheckpointExcludedEntry,
    CheckpointExclusionPreviewResult,
    CheckpointExclusionSummary
} from './types';

/** 单文件 stat 信息（bigint 提供纳秒精度 mtimeNs） */
export interface SnapshotFileStat {
    mtimeMs: number;
    size: number;
    mtimeNs?: string;
}

/** 被排除的文件记录（超限/不可读），恢复时用于解释"为什么没有备份" */
export interface SnapshotExcludedEntry {
    scopedPath: string;
    reason: 'size' | 'unreadable';
    size?: number;
    isDirectory?: boolean;
}

export interface SnapshotBuildOptions {
    /** 参与快照的工作区根目录 */
    roots: readonly RuntimeWorkspaceRoot[];
    /** 用户自定义忽略模式（叠加到每个根目录的 .gitignore 上） */
    customIgnorePatterns?: string[];
    /**
     * 默认排除类别启用状态（EX-01）。
     * 缺省（undefined）＝全部类别启用；`{}` ＝全部按默认启用（全开）。
     * 需要全关时显式传 `false`（前端保存完整记录）。
     */
    enabledProfiles?: Record<string, boolean>;
    /** 每类别自定义模式覆盖（profileId -> 模式清单；缺省/空数组 = 使用该类别的默认清单） */
    profilePatterns?: Record<string, string[]>;
    /** 单文件大小上限（字节）；undefined 或 <= 0 表示不限制 */
    maxFileSizeBytes?: number;
    /** 强制排除的绝对路径（存档目录、临时目录等；位于工作区内时跳过） */
    excludeAbsolutePaths?: string[];
    /** 有界并发度，默认 8 */
    concurrency?: number;
    /** 上一快照的哈希/stat（stat 未变化的文件复用哈希，避免重复读盘） */
    previous?: {
        fileHashes: Record<string, string>;
        fileStats: Record<string, SnapshotFileStat>;
    };
    /**
     * CP-PARTIAL-1：受影响文件绝对路径（工具执行存档性能优化）。
     * 非空时走部分快照分支——不递归扫描整个工作区，只对列出的路径 stat + 哈希；
     * 不在任何工作区根内的路径被跳过。缺省（undefined/空数组）＝全量扫描（既有行为）。
     */
    affectedPaths?: string[];
}

export interface CheckpointSnapshotBuildResult {
    /** scopedPath -> MD5 哈希（只包含真正备份成功的文件） */
    fileHashes: Record<string, string>;
    /** scopedPath -> stat */
    fileStats: Record<string, SnapshotFileStat>;
    /** 空目录 scopedPath 列表 */
    emptyDirs: string[];
    /** 超出大小上限被排除的文件 */
    sizeExcluded: SnapshotExcludedEntry[];
    /** 无法读取/哈希失败的文件 */
    unreadable: SnapshotExcludedEntry[];
    /** 快照时明确不存在的受影响路径（仅 ENOENT/ENOTDIR；不是读取失败，也不受恢复保护） */
    absent: string[];
    /**
     * 被排除路径的完整清单（EX-01/EX-09，scoped 格式）。
     * 包含：强制排除 / 默认类别 / .gitignore / 自定义模式 / 大小上限 / 不可读。
     */
    excluded: CheckpointExcludedEntry[];
    /** 各根目录统计（诊断与日志用） */
    roots: { rootId: string; fileCount: number; emptyDirCount: number }[];
}

/**
 * 构建一个工作区集合的快照。
 *
 * 对每个根目录：
 * 1. 用 CheckpointIgnoreResolver 收集可见文件和空目录；
 * 2. 过滤强制排除绝对路径（存档目录自身）；
 * 3. 有界并发执行 stat + 哈希（stat 未变化时复用上一快照哈希）；
 * 4. 超过大小上限的文件记录为 size 排除，不参与哈希。
 */
export async function buildWorkspaceSnapshot(
    options: SnapshotBuildOptions
): Promise<CheckpointSnapshotBuildResult> {
    // CP-PARTIAL-1：受影响路径限定（工具执行存档性能优化）——非空时走部分快照分支，
    // 不再递归扫描整个工作区（大工作区全量 stat + 哈希可达 10-20MB 哈希表）。
    if (options.affectedPaths && options.affectedPaths.length > 0) {
        return buildAffectedPathsSnapshot(options);
    }

    const { roots, customIgnorePatterns, maxFileSizeBytes, excludeAbsolutePaths = [], concurrency = 8 } = options;
    const previous = options.previous;
    const maxSize = typeof maxFileSizeBytes === 'number' && maxFileSizeBytes > 0
        ? maxFileSizeBytes
        : undefined;

    const fileHashes: Record<string, string> = {};
    const fileStats: Record<string, SnapshotFileStat> = {};
    const emptyDirs: string[] = [];
    const sizeExcluded: SnapshotExcludedEntry[] = [];
    const unreadable: SnapshotExcludedEntry[] = [];
    const absent: string[] = [];
    const excluded: CheckpointExcludedEntry[] = [];
    const rootStats: CheckpointSnapshotBuildResult['roots'] = [];

    for (const root of roots) {
        // 1. 收集该根目录下应被检查点系统看见的文件和空目录（四层排除模型，EX-01）
        const resolver = new CheckpointIgnoreResolver(root.fsPath, customIgnorePatterns ?? [], {
            // 缺省全部类别启用；`{}` 表示全部关闭
            enabledProfiles: options.enabledProfiles ?? DEFAULT_ENABLED_PROFILES,
            profilePatterns: options.profilePatterns,
            excludeAbsolutePaths
        });
        const { files, dirs, excluded: resolverExcluded } = await resolver.collectEntries();

        // 1.5 记录 resolver 层排除（强制/默认类别/.gitignore/自定义），转换为 scoped 路径
        for (const entry of resolverExcluded) {
            excluded.push(toScopedExcludedEntry(root, entry));
        }

        // 2. 过滤强制排除路径 + 计算 scoped 路径
        const entries: { absolutePath: string; scopedPath: string }[] = [];
        for (const file of files) {
            if (isExcludedAbsolutePath(file, excludeAbsolutePaths)) continue;
            const relativePath = path.relative(root.fsPath, file).replace(/\\/g, '/');
            entries.push({
                absolutePath: file,
                scopedPath: createWorkspaceScopedPath(root.id, relativePath)
            });
        }

        const scopedEmptyDirs: string[] = [];
        for (const dir of dirs) {
            if (isExcludedAbsolutePath(dir, excludeAbsolutePaths)) continue;
            const relativePath = path.relative(root.fsPath, dir).replace(/\\/g, '/');
            scopedEmptyDirs.push(createWorkspaceScopedPath(root.id, relativePath));
        }
        scopedEmptyDirs.sort();
        emptyDirs.push(...scopedEmptyDirs);

        // 3. 有界并发执行 stat + 哈希（statAndHashEntry 与部分快照分支共用同一逻辑）
        await runBounded(entries, concurrency, async entry => {
            await statAndHashEntry({
                absolutePath: entry.absolutePath,
                scopedPath: entry.scopedPath,
                maxSize,
                previous,
                fileHashes,
                fileStats,
                sizeExcluded,
                unreadable,
                absent,
                excluded
            });
        });

        rootStats.push({
            rootId: root.id,
            fileCount: entries.length,
            emptyDirCount: scopedEmptyDirs.length
        });
    }

    // 大小上限 / 不可读同样计入 excluded（EX-07/EX-09，不静默消失）
    for (const entry of sizeExcluded) {
        excluded.push({ path: entry.scopedPath, reason: 'size', size: entry.size });
    }
    for (const entry of unreadable) {
        excluded.push({ path: entry.scopedPath, reason: 'unreadable', isDirectory: entry.isDirectory });
    }

    return {
        fileHashes,
        fileStats,
        emptyDirs,
        sizeExcluded,
        unreadable,
        absent,
        excluded,
        roots: rootStats
    };
}

// ========== CP-PARTIAL-1：受影响路径限定快照（部分快照分支） ==========

/** statAndHashEntry 入参（全量/部分快照分支共用） */
interface StatAndHashEntryParams {
    absolutePath: string;
    scopedPath: string;
    maxSize?: number;
    previous?: SnapshotBuildOptions['previous'];
    fileHashes: Record<string, string>;
    fileStats: Record<string, SnapshotFileStat>;
    sizeExcluded: SnapshotExcludedEntry[];
    unreadable: SnapshotExcludedEntry[];
    absent: string[];
    excluded: CheckpointExcludedEntry[];
    /** 调用方已 lstat（部分快照分支判定文件/目录用）；缺省时内部 lstat */
    stat?: BigIntStats;
}

/**
 * 单文件 stat + 哈希（全量/部分快照分支共用）。
 *
 * 逻辑与全量分支一致：lstat 拒绝链接/特殊文件 → 大小上限排除 → stat 未变化复用上一快照哈希 →
 * 流式哈希；ENOENT/ENOTDIR 记为 absent，其余读取失败记为 unreadable。
 */
async function statAndHashEntry(params: StatAndHashEntryParams): Promise<void> {
    const {
        absolutePath,
        scopedPath,
        maxSize,
        previous,
        fileHashes,
        fileStats,
        sizeExcluded,
        unreadable,
        absent,
        excluded
    } = params;
    try {
        const stat = params.stat ?? (await fs.lstat(absolutePath, { bigint: true }));
        if (!stat.isFile()) {
            excluded.push({
                path: scopedPath,
                reason: 'unsupported_file_type',
                source: 'filesystem',
                isDirectory: stat.isDirectory()
            });
            return;
        }
        const size = Number(stat.size);
        const mtimeMs = Number(stat.mtimeMs);
        const mtimeNs = stat.mtimeNs.toString();

        // 大小上限：超出则记录排除，不进入哈希（避免读入超大文件）
        if (maxSize !== undefined && size > maxSize) {
            sizeExcluded.push({ scopedPath, reason: 'size', size });
            return;
        }

        // stat 复用：与上一快照一致时直接复用哈希，避免重复读盘
        const prevStat = previous?.fileStats[scopedPath];
        const statUnchanged = prevStat
            ? (prevStat.mtimeNs !== undefined
                // mtimeNs 分支同样必须校验 size：在 mtime 精度粗糙的文件系统（FAT32/SMB/容器挂载卷）上，
                // 同一时间刻度内文件被重写且字节数不变时会错误复用旧哈希，恢复时静默得到过期内容
                ? prevStat.mtimeNs === mtimeNs && prevStat.size === size
                : prevStat.mtimeMs === mtimeMs && prevStat.size === size)
            : false;
        if (
            statUnchanged &&
            previous?.fileHashes[scopedPath] !== undefined
        ) {
            fileHashes[scopedPath] = previous.fileHashes[scopedPath];
            fileStats[scopedPath] = { mtimeMs, size, mtimeNs };
            return;
        }

        // 流式哈希
        const hash = await hashFileStreaming(absolutePath);
        fileHashes[scopedPath] = hash;
        fileStats[scopedPath] = { mtimeMs, size, mtimeNs };
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') {
            absent.push(scopedPath);
            return;
        }
        // 权限、I/O 或哈希读取失败才属于不可读；明确缺失不进入保护集合。
        unreadable.push({ scopedPath, reason: 'unreadable' });
    }
}

/**
 * CP-PARTIAL-1：受影响路径限定快照（工具执行存档性能优化）。
 *
 * 与全量分支的差异：不调用 resolver.collectEntries 递归扫描整个工作区，只对
 * affectedPaths 列出的绝对路径逐个处理：
 * - 匹配所属工作区根（大小写不敏感前缀 + 路径边界；不在任何根内 → 跳过）；
 * - 忽略规则判定（同一 CheckpointIgnoreResolver 四层排除模型）；忽略 → 计入 excluded；
 * - 目录：仅空目录进入 emptyDirs（非空目录不递归——其内容不在受影响路径内时无需记录）；
 * - 文件：大小上限 / previous 复用 / 流式哈希（与全量分支同一 statAndHashEntry 逻辑）；
 * - lstat 的 ENOENT/ENOTDIR → absent；权限或 I/O 错误 → unreadable；
 * - 符号链接与特殊文件 → unsupported_file_type，绝不跟随链接目标。
 *
 * 注意：受影响路径清单来自模型传入参数；副作用不可知的批次（execute_command 等）由
 * 调用方回退全量（affectedPaths 缺省），保证快照完整性。
 */
async function buildAffectedPathsSnapshot(
    options: SnapshotBuildOptions
): Promise<CheckpointSnapshotBuildResult> {
    const { roots, customIgnorePatterns, excludeAbsolutePaths = [] } = options;
    const previous = options.previous;
    const maxSize = typeof options.maxFileSizeBytes === 'number' && options.maxFileSizeBytes > 0
        ? options.maxFileSizeBytes
        : undefined;

    const fileHashes: Record<string, string> = {};
    const fileStats: Record<string, SnapshotFileStat> = {};
    const emptyDirs: string[] = [];
    const sizeExcluded: SnapshotExcludedEntry[] = [];
    const unreadable: SnapshotExcludedEntry[] = [];
    const absent: string[] = [];
    const excluded: CheckpointExcludedEntry[] = [];
    const fileCountByRoot = new Map<string, number>();

    // 每个根目录一个 resolver（与全量分支同一排除语义）
    const resolvers = new Map<string, CheckpointIgnoreResolver>();
    const getResolver = (root: RuntimeWorkspaceRoot): CheckpointIgnoreResolver => {
        let resolver = resolvers.get(root.id);
        if (!resolver) {
            resolver = new CheckpointIgnoreResolver(root.fsPath, customIgnorePatterns ?? [], {
                enabledProfiles: options.enabledProfiles ?? DEFAULT_ENABLED_PROFILES,
                profilePatterns: options.profilePatterns,
                excludeAbsolutePaths
            });
            resolvers.set(root.id, resolver);
        }
        return resolver;
    };

    for (const absPath of options.affectedPaths ?? []) {
        // 匹配所属工作区根（大小写不敏感前缀 + 路径边界；不在任何根内 → 跳过）
        const root = roots.find(candidate => isPathWithin(candidate.fsPath, absPath));
        if (!root) {
            continue;
        }
        const relativePath = path.relative(root.fsPath, absPath).replace(/\\/g, '/');
        const scopedPath = createWorkspaceScopedPath(root.id, relativePath);

        // lstat 不跟随符号链接；明确缺失与无法读取必须保持不同语义。
        let stat: BigIntStats;
        try {
            stat = await fs.lstat(absPath, { bigint: true });
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === 'ENOENT' || code === 'ENOTDIR') {
                absent.push(scopedPath);
            } else {
                unreadable.push({ scopedPath, reason: 'unreadable' });
            }
            continue;
        }

        // 忽略规则判定（四层排除模型）：忽略 → 计入 excluded（与全量分支同形状）
        const ignoreResult = await getResolver(root).checkIgnore(relativePath, stat.isDirectory());
        if (ignoreResult.ignored) {
            excluded.push({
                path: scopedPath,
                reason: ignoreResult.reason ?? 'custom',
                rule: ignoreResult.rule,
                source: ignoreResult.source,
                isDirectory: stat.isDirectory()
            });
            continue;
        }

        if (!stat.isFile() && !stat.isDirectory()) {
            excluded.push({
                path: scopedPath,
                reason: 'unsupported_file_type',
                source: 'filesystem',
                isDirectory: false
            });
            continue;
        }

        if (stat.isDirectory()) {
            // 目录：仅空目录记录（非空目录不递归——其内容不在受影响路径内时无需记录）
            let entries: string[];
            try {
                entries = await fs.readdir(absPath);
            } catch {
                unreadable.push({ scopedPath, reason: 'unreadable', isDirectory: true });
                continue;
            }
            if (entries.length === 0) {
                emptyDirs.push(scopedPath);
            }
            continue;
        }

        fileCountByRoot.set(root.id, (fileCountByRoot.get(root.id) ?? 0) + 1);
        await statAndHashEntry({
            absolutePath: absPath,
            scopedPath,
            maxSize,
            previous,
            fileHashes,
            fileStats,
            sizeExcluded,
            unreadable,
            absent,
            excluded,
            stat
        });
    }

    // 空目录按字典序排序（与全量分支 scopedEmptyDirs.sort() 一致）
    emptyDirs.sort();

    // 大小上限 / 不可读同样计入 excluded（与全量分支一致，EX-07/EX-09）
    for (const entry of sizeExcluded) {
        excluded.push({ path: entry.scopedPath, reason: 'size', size: entry.size });
    }
    for (const entry of unreadable) {
        excluded.push({ path: entry.scopedPath, reason: 'unreadable', isDirectory: entry.isDirectory });
    }

    // 各根目录统计（诊断与日志用）：fileCount = 该根下处理的文件数
    return {
        fileHashes,
        fileStats,
        emptyDirs,
        sizeExcluded,
        unreadable,
        absent,
        excluded,
        roots: roots.map(root => ({
            rootId: root.id,
            fileCount: fileCountByRoot.get(root.id) ?? 0,
            emptyDirCount: emptyDirs.filter(scoped => scoped.startsWith(root.id + '/')).length
        }))
    };
}

/** 将 resolver 层排除条目（相对路径）转换为 scoped 格式 */
function toScopedExcludedEntry(
    root: RuntimeWorkspaceRoot,
    entry: CheckpointResolverExcludedEntry
): CheckpointExcludedEntry {
    return {
        path: createWorkspaceScopedPath(root.id, entry.path),
        reason: entry.reason,
        rule: entry.rule,
        source: entry.source,
        isDirectory: entry.isDirectory
    };
}

// ========== 排除预览（EX-09） ==========

/** 预览过程中的排除条目（带目录标记与绝对路径，用于大小统计） */
interface PreviewExcludedEntry extends CheckpointExcludedEntry {
    isDirectory?: boolean;
}

export interface ExclusionPreviewOptions {
    /** 参与扫描的工作区根目录 */
    roots: readonly RuntimeWorkspaceRoot[];
    /** 用户自定义忽略模式 */
    customIgnorePatterns?: string[];
    /** 默认排除类别启用状态（缺省＝全部启用） */
    enabledProfiles?: Record<string, boolean>;
    /** 每类别自定义模式覆盖（profileId -> 模式清单；缺省/空数组 = 使用该类别的默认清单） */
    profilePatterns?: Record<string, string[]>;
    /** 单文件大小上限（字节）；undefined 或 <= 0 表示不限制 */
    maxFileSizeBytes?: number;
    /** 强制排除的绝对路径（扩展存储根等） */
    excludeAbsolutePaths?: string[];
    /** 排除目录大小统计的有界遍历上限（避免 node_modules 全量遍历），默认 2000 */
    maxDirWalkEntries?: number;
}

/**
 * 预览排除结果（EX-09）：只收集“会被排除的路径”并统计大小，不哈希大文件。
 *
 * - 使用 CheckpointIgnoreResolver 的扫描能力（复用同一套四层排除语义）
 * - 对排除的目录做有界遍历统计大小；对排除的文件只 stat 不读取
 * - 未被排除的文件只 stat（用于大小上限判断），不做任何哈希
 * - samples 上限 50（类型契约 CheckpointExclusionPreviewResult）
 */
export async function previewExclusions(
    options: ExclusionPreviewOptions
): Promise<CheckpointExclusionPreviewResult> {
    const { roots, customIgnorePatterns, excludeAbsolutePaths = [] } = options;
    const enabledProfiles = options.enabledProfiles ?? DEFAULT_ENABLED_PROFILES;
    const profilePatterns = options.profilePatterns;
    const maxSize = typeof options.maxFileSizeBytes === 'number' && options.maxFileSizeBytes > 0
        ? options.maxFileSizeBytes
        : undefined;
    const maxDirWalk = options.maxDirWalkEntries ?? 2000;

    const allExcluded: PreviewExcludedEntry[] = [];
    let complete = true;

    for (const root of roots) {
        const resolver = new CheckpointIgnoreResolver(root.fsPath, customIgnorePatterns ?? [], {
            enabledProfiles,
            profilePatterns,
            excludeAbsolutePaths
        });
        const { files, excluded: resolverExcluded } = await resolver.collectEntries();

        // 1. resolver 层排除（强制/默认类别/.gitignore/自定义/不可读）：统计大小（目录有界遍历）
        for (const entry of resolverExcluded) {
            // M-6: 不可读目录说明扫描不完整（该子树内容未知）
            if (entry.reason === 'unreadable') {
                complete = false;
            }
            const absolutePath = path.join(root.fsPath, ...entry.path.split('/'));
            let size: number | undefined;
            if (entry.isDirectory) {
                const walk = await boundedDirectorySize(absolutePath, maxDirWalk);
                size = walk.size;
                if (!walk.complete) {
                    complete = false;
                }
            } else {
                try {
                    const stat = await fs.stat(absolutePath);
                    size = Number(stat.size);
                } catch {
                    // stat 失败：大小未知（保留 undefined）
                }
            }
            allExcluded.push({
                ...toScopedExcludedEntry(root, entry),
                size,
                isDirectory: entry.isDirectory
            });
        }

        // 2. 未被排除的文件：只 stat（不哈希），用于大小上限判断
        await runBounded(files, 8, async file => {
            let statSize: number;
            try {
                const stat = await fs.stat(file);
                statSize = Number(stat.size);
            } catch {
                // 不可读：计入 unreadable 排除，并标记扫描不完整
                const relativePath = path.relative(root.fsPath, file).replace(/\\/g, '/');
                allExcluded.push({
                    path: createWorkspaceScopedPath(root.id, relativePath),
                    reason: 'unreadable'
                });
                complete = false;
                return;
            }
            if (maxSize !== undefined && statSize > maxSize) {
                const relativePath = path.relative(root.fsPath, file).replace(/\\/g, '/');
                allExcluded.push({
                    path: createWorkspaceScopedPath(root.id, relativePath),
                    reason: 'size',
                    size: statSize
                });
            }
        });
    }

    // CP-PREV-2: runBounded 并发 push 的条目顺序不确定，聚合前按 path 排序，
    // 保证 samples（前端“为什么被排除”示例）跨预览稳定且按字典序展示
    allExcluded.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

    return {
        summary: aggregateExcluded(allExcluded),
        byProfile: aggregateByProfile(allExcluded),
        ignoreSnapshot: buildIgnoreSnapshot({
            enabledProfiles,
            profilePatterns,
            maxFileSizeBytes: options.maxFileSizeBytes,
            customPatterns: customIgnorePatterns
        }),
        complete
    };
}

/** 样本上限（类型契约：samples 必须限制数量） */
const PREVIEW_SAMPLE_LIMIT = 50;

function stripPreviewExtras(entry: PreviewExcludedEntry): CheckpointExcludedEntry {
    return {
        path: entry.path,
        reason: entry.reason,
        rule: entry.rule,
        source: entry.source,
        size: entry.size
    };
}

/** 按原因聚合（summary） */
function aggregateExcluded(entries: readonly PreviewExcludedEntry[]): CheckpointExclusionSummary {
    const byReason: Record<string, { count: number; bytes: number }> = {};
    let excludedCount = 0;
    let excludedBytes = 0;

    for (const entry of entries) {
        excludedCount += 1;
        const bytes = entry.size ?? 0;
        excludedBytes += bytes;
        const bucket = byReason[entry.reason] ?? (byReason[entry.reason] = { count: 0, bytes: 0 });
        bucket.count += 1;
        bucket.bytes += bytes;
    }

    return {
        excludedCount,
        excludedBytes,
        byReason,
        samples: entries.slice(0, PREVIEW_SAMPLE_LIMIT).map(stripPreviewExtras)
    };
}

/** 按默认类别聚合；gitignore/custom/size/forced/unreadable 归入 `other` */
function aggregateByProfile(
    entries: readonly PreviewExcludedEntry[]
): Record<string, CheckpointExclusionSummary> {
    const buckets = new Map<string, PreviewExcludedEntry[]>();

    for (const entry of entries) {
        const key = entry.reason === 'default' && entry.source ? entry.source : 'other';
        const list = buckets.get(key) ?? [];
        list.push(entry);
        buckets.set(key, list);
    }

    const result: Record<string, CheckpointExclusionSummary> = {};
    for (const [key, list] of buckets) {
        result[key] = aggregateExcluded(list);
    }
    return result;
}

/**
 * 有界遍历目录统计大小（EX-09 预览用）。
 *
 * 避免对 node_modules 等超大目录做全量遍历：超过 maxEntries 立即停止，
 * 返回 partial 结果并标记 complete=false。
 */
async function boundedDirectorySize(
    dirPath: string,
    maxEntries: number
): Promise<{ size: number; complete: boolean }> {
    let size = 0;
    let visited = 0;
    let complete = true;
    const stack: string[] = [dirPath];

    while (stack.length > 0 && visited < maxEntries) {
        const current = stack.pop() as string;
        let entries: ReadonlyArray<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
        try {
            entries = await fs.readdir(current, { withFileTypes: true });
        } catch {
            complete = false;
            continue;
        }

        for (const entry of entries) {
            if (visited >= maxEntries) {
                complete = false;
                break;
            }
            visited += 1;
            const fullPath = path.join(current, entry.name);
            if (entry.isDirectory()) {
                stack.push(fullPath);
            } else if (entry.isFile()) {
                try {
                    const stat = await fs.stat(fullPath);
                    size += Number(stat.size);
                } catch {
                    complete = false;
                }
            }
        }
    }

    if (stack.length > 0) {
        complete = false;
    }
    return { size, complete };
}
