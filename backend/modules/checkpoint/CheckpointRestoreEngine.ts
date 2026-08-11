/**
 * CheckpointRestoreEngine - 工作区恢复引擎
 *
 * 职责：
 * - 构建增量链文件索引（一次构建，恢复时 O(1) 查询，替代逐文件逐节点 fs.access）
 * - 恢复目标路径安全校验（resolveSafePathInsideRoot，拒绝 `..` 与符号链接越界）
 * - 恢复执行（哈希校验 + 复制 + 删除多余文件 + 空目录重建）
 * - 失败清单（区分 missing_in_chain / hash_mismatch / copy_failed / delete_failed）
 *
 * 路径语义：
 * - 新格式存档使用工作区作用域路径（`ws_xxx/relative/path`）
 * - 旧格式存档是相对路径（`relative/path`），单根工作区时自动按第一个根目录解析
 *
 * 本模块不依赖 CheckpointManager，是独立的纯文件系统逻辑。
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import {
    parseWorkspaceScopedPath,
    resolveSafePathInsideRoot,
    type RuntimeWorkspaceRoot
} from './CheckpointWorkspace';
import {
    DEFAULT_CHECKPOINT_CONCURRENCY,
    runBounded,
    throwIfAborted
} from './checkpointConcurrency';
import { hashFileStreaming } from './fileHashing';

export type RestoreFailureReason = 'missing_in_chain' | 'hash_mismatch' | 'copy_failed' | 'delete_failed';

export interface RestoreFailure {
    path: string;
    reason: RestoreFailureReason;
}

/** 增量节点磁盘上实际保存的变更类型 */
export type RestoreFileChangeType = 'added' | 'modified' | 'deleted';

export interface RestoreFileChange {
    path: string;
    type: RestoreFileChangeType;
}

export interface RestoreEngineResult {
    success: boolean;
    restored: number;
    deleted: number;
    skipped: number;
    failures: RestoreFailure[];
    /** 已恢复/删除的绝对路径（供前端刷新编辑器） */
    modifiedPaths: string[];
    deletedPaths: string[];
}

/** 增量链中的一个存档节点（按时间从旧到新排列） */
export interface RestoreChainEntry {
    checkpointId: string;
    /** 存档目录名（位于 checkpointsDir 下） */
    backupDir: string;
    /** 该存档记录的文件哈希（scoped 或相对路径键；增量节点记录的是完整工作区映射） */
    fileHashes?: Record<string, string>;
    /**
     * 该节点磁盘上实际保存的变更（added/modified 路径）。
     *
     * 增量节点的备份目录只包含相对其 base 变化的文件，而 fileHashes 是完整映射；
     * 提供 changes 时用它限定“该节点目录内真实存在的文件”，避免把未落盘的文件误指到该节点。
     * 缺省（旧记录）时按 fileHashes 全量处理，与旧实现兼容。
     */
    changes?: RestoreFileChange[];
}

export interface RestoreTargetState {
    /** 目标文件哈希（scoped 或相对路径键） */
    fileHashes: Record<string, string>;
    /** 目标空目录（scoped 或相对路径键） */
    emptyDirs: string[];
}

export interface RestoreEngineOptions {
    /** 存档根目录 */
    checkpointsDir: string;
    /** 当前工作区根目录集合 */
    roots: readonly RuntimeWorkspaceRoot[];
    /**
     * 快照时被忽略/未备份的路径：恢复时绝不能删除（scoped 键）。
     * 目录条目按前缀匹配保护其子树（`key === p || key.startsWith(p + '/')`），
     * 见 isProtectedScopedPath。
     */
    protectedScopedPaths?: ReadonlySet<string>;
    /**
     * 允许删除的路径白名单（scoped 键）。
     *
     * 提供时只有白名单内的路径才会被删除；缺省时除 protectedScopedPaths 外均可删除。
     * 与旧实现 #29 语义对齐：只删除目标快照 fileHashes 中记录过的路径，
     * 快照后新建、快照时被忽略/未备份的文件不会被静默删除。
     */
    deletableScopedPaths?: ReadonlySet<string>;
    /**
     * 是否同时删除快照后新建的文件（不在删除白名单内、非受保护路径）。
     *
     * 默认 false（#29 保护语义）；恢复确认流程在用户明确确认待删除文件清单后传 true，
     * 实现 CP-09「撤销工具新建文件」语义。
     */
    deleteUntrackedFiles?: boolean;
    /**
     * 跳过备份内容哈希校验（CP-LEGACY-HASH-2）。
     *
     * legacy 恢复路径（restoreLegacyCheckpointViaEngine）在调用引擎前已对备份目录
     * 逐文件流式哈希得到 rawHashes（fileHashes 的来源），引擎内再次哈希纯属重复；
     * 新格式恢复（fileHashes 来自 manifest）必须保留校验，防止备份与索引不一致。
     */
    skipHashVerification?: boolean;
    /** 有界并发度（CPF-06），默认 8；恢复文件复制与删除循环使用 */
    concurrency?: number;
    /** 取消信号（CPF-11）：操作循环内检查，已取消时抛 CheckpointAbortError */
    signal?: AbortSignal;
    /** 进度回调（CPF-11）：processed 已处理文件数，total 本次待处理文件数 */
    onProgress?: (processed: number, total: number) => void;
}

interface FileIndexEntry {
    backupPath: string;
    hash: string;
}

/**
 * 恢复计划（纯计算，无任何文件系统副作用）。
 *
 * 供 previewRestore（恢复前确认待删除文件清单）与 restoreWorkspaceSnapshot（实际执行）共用，
 * 保证“预览看到的删除清单”与“实际执行删除的文件”严格一致。
 */
export interface RestorePlan {
    /** 需要新增的文件（scoped 键） */
    added: string[];
    /** 需要修改的文件（scoped 键） */
    modified: string[];
    /** 需要删除的文件（scoped 键，已过滤受保护路径；白名单内路径，恢复时默认删除） */
    toDelete: string[];
    /**
     * 快照时被工具删除的文件（scoped 键）：当前存在、目标快照缺失、但增量链 base 中存在。
     * 恢复目标快照语义下这些文件应被删除（快照时它们已不在），而非归入 untracked 默认保留。
     */
    deletedInSnapshot: string[];
    /**
     * 快照后新建的文件（scoped 键）：当前存在、目标没有、不在删除白名单、非受保护。
     * 默认不删除（#29 保护），用户确认清单后由恢复流程删除（CP-09）。
     */
    untrackedToDelete: string[];
    /**
     * 快照后出现的空目录（scoped 键）：当前为空、目标没有、非受保护。
     * 默认保留（#29 保护），用户确认清单后由恢复流程清理（CP-09）。
     */
    untrackedEmptyDirs: string[];
    /** 与目标一致、无需操作的文件数 */
    skipped: number;
    /** 目标状态归一化哈希（scoped 键） */
    targetHashes: Record<string, string>;
    /** 目标空目录（scoped 键） */
    targetEmptyDirs: string[];
    /** 当前工作区归一化哈希（scoped 键） */
    currentScopedHashes: Record<string, string>;
}

/**
 * 判断 scoped 键是否受保护：精确命中，或任一祖先前缀命中。
 *
 * 快照时整目录被排除（如 `ws_x/dist`）时，manifest.excluded 只记录目录自身一条
 * （CheckpointIgnoreResolver.collectEntries 命中目录后整棵子树不再遍历，不递归记录内部文件）；
 * 用户放宽规则后目录内文件（`ws_x/dist/app.js`）进入 currentHashes，若只做精确匹配
 * 会被当作“快照后新建文件”删除（deleteUntrackedFiles=true），违反 CP-09 语义。
 * 前缀匹配使目录级保护覆盖其全部子树：`key === p || key.startsWith(p + '/')`。
 *
 * scoped 键统一使用 `/` 分隔符（toScopedKey 已归一化反斜杠），无需平台路径处理；
 * 对文件级条目做前缀匹配无害（文件路径下不存在子文件键，且 `/` 边界保证
 * `secret.log` 不会误保护 `secret.log.bak`）。
 */
export function isProtectedScopedPath(
    scopedKey: string,
    protectedScopedPaths: ReadonlySet<string>
): boolean {
    if (protectedScopedPaths.has(scopedKey)) {
        return true;
    }
    // 逐级向上检查祖先前缀（跳过空串与根级边界）：
    // `ws_x/dist/app.js` → `ws_x/dist` → `ws_x`
    let slashIndex = scopedKey.lastIndexOf('/');
    while (slashIndex > 0) {
        if (protectedScopedPaths.has(scopedKey.slice(0, slashIndex))) {
            return true;
        }
        slashIndex = scopedKey.lastIndexOf('/', slashIndex - 1);
    }
    return false;
}

/**
 * 计算恢复计划：归一化目标/当前状态，计算新增、修改、删除与跳过数量。
 *
 * 删除集合已应用两层过滤：
 * 1. 受保护路径（快照时未备份/被忽略，恢复时绝不能删；目录条目按前缀匹配保护子树）；
 * 2. 删除白名单（只删快照 fileHashes 记录过的路径，#29 语义）。
 */
export function computeRestorePlan(
    options: RestoreEngineOptions,
    _chain: readonly RestoreChainEntry[],
    target: RestoreTargetState,
    currentHashes: Record<string, string>,
    currentEmptyDirs: string[]
): RestorePlan {
    const { roots, protectedScopedPaths = new Set(), deletableScopedPaths } = options;

    const targetHashes: Record<string, string> = {};
    for (const [rawKey, hash] of Object.entries(target.fileHashes)) {
        targetHashes[toScopedKey(rawKey, roots)] = hash;
    }
    const targetEmptyDirs = target.emptyDirs.map(raw => toScopedKey(raw, roots));

    const currentScopedHashes: Record<string, string> = {};
    for (const [rawKey, hash] of Object.entries(currentHashes)) {
        currentScopedHashes[toScopedKey(rawKey, roots)] = hash;
    }

    // CP-DEL-IN-SNAP: 收集增量链 base 中（非目标节点）出现过的路径（scoped 键）。
    // 当前工作区存在、目标快照缺失、但 base 链中存在 → 快照时被工具删除的文件：
    // 恢复目标快照语义下应删除（快照时它们已不在），不能归入 untracked 默认保留（否则
    // 恢复后这些文件“复活”，与快照状态不符）。chain 最后一项为目标节点，其 fileHashes
    // 即目标状态（targetHashes），不属于“base 中存在”的判据。
    const baseChainKeys = new Set<string>();
    for (let i = 0; i < _chain.length - 1; i++) {
        const entry = _chain[i];
        for (const rawKey of Object.keys(entry.fileHashes ?? {})) {
            baseChainKeys.add(toScopedKey(rawKey, roots));
        }
        for (const change of entry.changes ?? []) {
            baseChainKeys.add(toScopedKey(change.path, roots));
        }
    }

    // 新增 / 修改
    const added: string[] = [];
    const modified: string[] = [];
    for (const [scopedKey, hash] of Object.entries(targetHashes)) {
        if (!(scopedKey in currentScopedHashes)) {
            added.push(scopedKey);
        } else if (currentScopedHashes[scopedKey] !== hash) {
            modified.push(scopedKey);
        }
    }

    // 删除（过滤受保护路径；白名单内的进入 toDelete，白名单外的进入 untrackedToDelete）
    const toDelete: string[] = [];
    const deletedInSnapshot: string[] = [];
    const untrackedToDelete: string[] = [];
    for (const scopedKey of Object.keys(currentScopedHashes)) {
        if (scopedKey in targetHashes) continue;
        // M-3（R7b 补充）：目录级排除条目只记录目录自身，此处按前缀匹配保护目录内文件
        if (isProtectedScopedPath(scopedKey, protectedScopedPaths)) continue;
        // 快照时被工具删除（base 链中存在、目标缺失）：恢复默认删除（目标状态无此文件）
        if (baseChainKeys.has(scopedKey)) {
            deletedInSnapshot.push(scopedKey);
            continue;
        }
        if (deletableScopedPaths && !deletableScopedPaths.has(scopedKey)) {
            // 快照后新建/未跟踪：默认保留，需用户确认后才删除（CP-09）
            untrackedToDelete.push(scopedKey);
            continue;
        }
        toDelete.push(scopedKey);
    }

    // 快照后出现的空目录：默认保留，需用户确认后才清理（CP-09，#29 语义）
    const targetEmptySet = new Set(targetEmptyDirs);
    const untrackedEmptyDirs: string[] = [];
    for (const scopedKey of currentEmptyDirs) {
        if (targetEmptySet.has(scopedKey)) continue;
        if (isProtectedScopedPath(scopedKey, protectedScopedPaths)) continue;
        untrackedEmptyDirs.push(scopedKey);
    }

    const skipped = Object.keys(targetHashes).length - added.length - modified.length;

    return { added, modified, toDelete, deletedInSnapshot, untrackedToDelete, untrackedEmptyDirs, skipped, targetHashes, targetEmptyDirs, currentScopedHashes };
}

/** 判断存档键是否为工作区作用域路径（`ws_xxx/relative`） */
export function isWorkspaceScopedKey(rawKey: string): boolean {
    return /^ws_[a-f0-9]{16}\//.test(rawKey.replace(/\\/g, '/'));
}

/** 将存档键归一化为 scoped 路径；旧格式（相对路径）按单根工作区包装 */
export function toScopedKey(rawKey: string, roots: readonly RuntimeWorkspaceRoot[]): string {
    const normalized = rawKey.replace(/\\/g, '/');
    if (isWorkspaceScopedKey(normalized)) {
        return normalized;
    }
    if (roots.length === 1) {
        return `${roots[0].id}/${normalized.replace(/^\/+/, '')}`;
    }
    return normalized;
}

/**
 * 从 scoped/相对键提取备份目录内的相对路径。
 *
 * 新格式存档按 scoped 布局存储（`cp_xxx/ws_xxx/relative`），前缀原样保留；
 * 旧格式存档按工作区相对布局存储（`cp_xxx/relative`），原样返回。
 */
function toBackupRelativePath(rawKey: string): string {
    const normalized = rawKey.replace(/\\/g, '/');
    return normalized.replace(/^\/+/, '');
}

/**
 * 解析 scoped 路径为目标绝对路径；旧格式（相对路径）按单根工作区解析。
 *
 * 解析全程使用 `resolveSafePathInsideRoot`：目标路径的每一层都做 lstat
 * 符号链接检查（含 junction），任何一层是链接即拒绝，防止恢复写出工作区。
 */
async function resolveScopedPath(
    scopedPath: string,
    roots: readonly RuntimeWorkspaceRoot[]
): Promise<{ absolutePath: string; root: RuntimeWorkspaceRoot; relativePath: string }> {
    const normalized = scopedPath.replace(/\\/g, '/');
    if (/^ws_[a-f0-9]{16}\//.test(normalized)) {
        const parsed = parseWorkspaceScopedPath(normalized, roots as RuntimeWorkspaceRoot[]);
        return {
            absolutePath: await resolveSafePathInsideRoot(parsed.root.fsPath, parsed.relativePath),
            root: parsed.root,
            relativePath: parsed.relativePath
        };
    }

    // 旧格式：单根工作区相对路径
    if (roots.length !== 1) {
        throw new Error(`Legacy checkpoint path requires a single workspace root: ${scopedPath}`);
    }
    const root = roots[0];
    const relative = normalized.replace(/^\/+/, '');
    return {
        absolutePath: await resolveSafePathInsideRoot(root.fsPath, relative),
        root,
        relativePath: relative
    };
}

/** 判断 target 是否位于 root 目录内（含等于 root 自身） */
function isPathInside(root: string, target: string): boolean {
    const relative = path.relative(root, target);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * 构建增量链文件索引。
 *
 * 从旧到新应用各存档的 fileHashes：最新节点覆盖旧节点。
 * 键统一为 scoped 路径；备份源路径必须位于 checkpointsDir 内
 * （backupDir 来自存档元数据，损坏数据可能含 `..`/绝对路径）。
 *
 * 增量节点提供 changes 时，只索引其中 added/modified 的路径——
 * 该节点磁盘上只保存这些文件，其余路径仍由更早的节点提供。
 */
function buildFileIndex(
    chain: readonly RestoreChainEntry[],
    checkpointsDir: string,
    roots: readonly RuntimeWorkspaceRoot[]
): Map<string, FileIndexEntry> {
    const index = new Map<string, FileIndexEntry>();
    const checkpointsRoot = path.resolve(checkpointsDir);

    for (const entry of chain) {
        if (!entry.fileHashes) continue;
        const backupRoot = path.resolve(checkpointsRoot, entry.backupDir);
        // backupDir 越界（损坏元数据）：该节点全部文件视为链上缺失
        if (!isPathInside(checkpointsRoot, backupRoot)) continue;

        // 增量节点：只信任 changes 里标记的路径（磁盘上真实存在的文件）。
        // 用 truthiness 区分「未提供 changes」（完整节点/旧记录 → 全量索引）与「空数组」
        // （空增量节点 → 空集合，不索引任何文件，文件仍由更早节点提供）。
        // 若把空数组当 null 处理，空增量节点会把全部 fileHashes 指到自己的空备份目录，
        // 覆盖更早节点，恢复任何漂移文件都 missing_in_chain。
        const trackedPaths = entry.changes
            ? new Set(entry.changes.filter(change => change.type !== 'deleted').map(change => change.path))
            : null;

        for (const [rawKey, hash] of Object.entries(entry.fileHashes)) {
            if (trackedPaths && !trackedPaths.has(rawKey)) continue;
            const scopedKey = toScopedKey(rawKey, roots);
            const backupRelative = toBackupRelativePath(rawKey);
            const backupPath = path.resolve(backupRoot, ...backupRelative.split('/'));
            // 备份文件必须位于该节点目录内
            if (!isPathInside(backupRoot, backupPath)) continue;
            index.set(scopedKey, {
                backupPath,
                hash
            });
        }
    }

    return index;
}

/**
 * 恢复工作区到目标状态。
 *
 * @param chain 增量链（从旧到新）
 * @param target 目标文件状态
 * @param currentHashes 当前工作区文件哈希（scoped 键；由调用方用同一 resolver 收集）
 * @param currentEmptyDirs 当前工作区空目录（scoped 键）
 */
export async function restoreWorkspaceSnapshot(
    options: RestoreEngineOptions,
    chain: readonly RestoreChainEntry[],
    target: RestoreTargetState,
    currentHashes: Record<string, string>,
    currentEmptyDirs: string[]
): Promise<RestoreEngineResult> {
    const { checkpointsDir, roots } = options;

    const failures: RestoreFailure[] = [];
    const modifiedPaths: string[] = [];
    const deletedPaths: string[] = [];
    let restored = 0;
    let deleted = 0;

    // 恢复计划：与 previewRestore 共用同一纯计算逻辑，预览清单与实际删除严格一致
    const plan = computeRestorePlan(options, chain, target, currentHashes, currentEmptyDirs);
    const { added, modified, toDelete, deletedInSnapshot, untrackedToDelete, skipped, targetEmptyDirs, untrackedEmptyDirs } = plan;
    // 快照后新建的文件/空目录默认保留（#29）；用户确认删除清单后（CP-09）才一并清理。
    // 快照时被工具删除的文件（deletedInSnapshot）是目标快照语义的一部分：快照状态中它们
    // 已不存在，恢复应默认删除（不归入 untracked 保留，否则恢复后文件“复活”）。
    const deletionList = options.deleteUntrackedFiles
        ? [...toDelete, ...deletedInSnapshot, ...untrackedToDelete]
        : [...toDelete, ...deletedInSnapshot];

    // 1. 构建增量链文件索引（恢复执行时才需要）
    const fileIndex = buildFileIndex(chain, checkpointsDir, roots);

    // 2. 恢复需要添加/修改的文件（有界并发 + 进度回调 + 取消检查）。
    //    复制阶段先于删除阶段（CP-ORDER-1）：备份缺失/复制失败时用户当前文件保持完整，
    //    不存在「已删未补」的破坏性中间态；全部复制成功后最后再删除多余文件。
    const filesToRestore = [...added, ...modified];
    // 进度 total 覆盖复制 + 删除全量（CP-PROG-1），删除阶段进度条不再停滞
    const progressTotal = deletionList.length + filesToRestore.length;
    let processed = 0;
    await runBounded(filesToRestore, options.concurrency ?? DEFAULT_CHECKPOINT_CONCURRENCY, async scopedKey => {
        throwIfAborted(options.signal);
        const indexEntry = fileIndex.get(scopedKey);
        if (!indexEntry) {
            failures.push({ path: scopedKey, reason: 'missing_in_chain' });
            processed += 1;
            options.onProgress?.(processed, progressTotal);
            return;
        }

        let destination: string;
        try {
            destination = (await resolveScopedPath(scopedKey, roots)).absolutePath;
        } catch {
            failures.push({ path: scopedKey, reason: 'copy_failed' });
            processed += 1;
            options.onProgress?.(processed, progressTotal);
            return;
        }

        try {
            // 校验备份内容与目标哈希一致（共享流式哈希实现，CP-DUP-1）。
            // CP-LEGACY-HASH-2: legacy 恢复（skipHashVerification=true）时，fileHashes 是
            // 引擎外对备份目录逐文件流式哈希得到的 rawHashes，与备份内容必然一致——
            // 跳过重复哈希，避免每个文件被扫描+校验两次。
            if (!options.skipHashVerification) {
                const backupHash = await hashFileStreaming(indexEntry.backupPath);
                if (backupHash !== indexEntry.hash) {
                    failures.push({ path: scopedKey, reason: 'hash_mismatch' });
                    processed += 1;
                    options.onProgress?.(processed, progressTotal);
                    return;
                }
            }

            await fs.mkdir(path.dirname(destination), { recursive: true });
            await fs.copyFile(indexEntry.backupPath, destination);
            restored += 1;
            modifiedPaths.push(destination);
        } catch (error) {
            // 备份文件缺失（fileHashes 声称有但实际不存在）归为 missing_in_chain；
            // 其余（权限、IO 等）归为 copy_failed
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                failures.push({ path: scopedKey, reason: 'missing_in_chain' });
            } else {
                failures.push({ path: scopedKey, reason: 'copy_failed' });
            }
        }
        processed += 1;
        options.onProgress?.(processed, progressTotal);
    });

    throwIfAborted(options.signal);

    // 3. 删除多余文件（plan.toDelete 已过滤受保护路径；untracked 仅在确认后删除）。
    //    仅在复制阶段全部成功后执行（CP-ORDER-1）：复制失败时跳过删除，
    //    用户「本可保留」的当前文件不会在恢复失败后一并丢失。
    //    有界并发（CPF-06）；取消信号在循环内检查（CPF-11）；删除阶段同样上报进度（CP-PROG-1）
    if (failures.length === 0) {
        await runBounded(deletionList, options.concurrency ?? DEFAULT_CHECKPOINT_CONCURRENCY, async scopedKey => {
            throwIfAborted(options.signal);
            let absolutePath: string;
            try {
                absolutePath = (await resolveScopedPath(scopedKey, roots)).absolutePath;
            } catch {
                failures.push({ path: scopedKey, reason: 'delete_failed' });
                processed += 1;
                options.onProgress?.(processed, progressTotal);
                return;
            }
            try {
                await fs.unlink(absolutePath);
                deleted += 1;
                deletedPaths.push(absolutePath);
            } catch {
                failures.push({ path: scopedKey, reason: 'delete_failed' });
            }
            processed += 1;
            options.onProgress?.(processed, progressTotal);
        });
    }

    throwIfAborted(options.signal);

    // 4. 恢复空目录（L4：循环内检查取消信号）
    for (const scopedKey of targetEmptyDirs) {
        throwIfAborted(options.signal);
        try {
            const absolutePath = (await resolveScopedPath(scopedKey, roots)).absolutePath;
            await fs.mkdir(absolutePath, { recursive: true });
        } catch {
            // 空目录恢复失败不视为整体失败（不影响文件内容）
        }
    }

    // 5. 删除多余的空目录。直接消费 plan.untrackedEmptyDirs（computeRestorePlan 已按
    //    「目标存在 / 受保护路径」过滤）——此前在此处重算同套过滤逻辑，两处口径可能漂移（C-6）。
    //    快照后出现的空目录默认保留（#29），仅在用户确认删除快照后新建内容时清理
    if (options.deleteUntrackedFiles) {
        for (const scopedKey of untrackedEmptyDirs) {
            throwIfAborted(options.signal);
            try {
                const absolutePath = (await resolveScopedPath(scopedKey, roots)).absolutePath;
                await fs.rmdir(absolutePath);
            } catch {
                // 目录非空或不存在：忽略
            }
        }
    }

    return {
        success: failures.length === 0,
        restored,
        deleted,
        skipped,
        failures,
        modifiedPaths,
        deletedPaths
    };
}
