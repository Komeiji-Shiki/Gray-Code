/**
 * LimCode - 检查点恢复服务（CPF-12：从 CheckpointManager 拆分）
 *
 * 承载恢复侧的文件操作与辅助逻辑（纯重构：方法体自 CheckpointManager 原样平移，
 * 仅做依赖重定向，不改变任何行为）：
 * - createIgnoreResolver / collectSnapshotEntries：忽略解析器与条目收集
 * - prepareRestore：恢复公共准备（prune 缺失记录、工作区校验、增量链验证、
 *   收集当前工作区状态、计算删除边界）——restoreCheckpoint / previewRestore 共用
 * - restoreLegacyCheckpointViaEngine：旧版存档（无 fileHashes）恢复
 * - filterRestoreTargetScoped / collectCurrentWorkspaceState：当前规则口径过滤与收集
 * - getIncrementalChain：增量链构建
 * - toDisplayPath / toDisplayUnbackedPaths / formatFailureSummary /
 *   buildIgnoreSnapshot / buildExcludedNote：展示与排除说明辅助
 */

import { t } from '../../i18n';
import * as vscode from 'vscode';
import * as path from 'path';
import type { SettingsManager } from '../settings';
import type { ConversationManager } from '../conversation';
import { CheckpointIgnoreResolver, normalizeCheckpointPath } from './CheckpointIgnoreResolver';
import { DEFAULT_EXCLUSION_MAX_FILE_SIZE_BYTES, DEFAULT_ENABLED_PROFILES, buildIgnoreSnapshot } from './CheckpointExclusionProfiles';
import { CHECKPOINT_MANIFEST_FILENAME, CHECKPOINT_MANIFEST_FILES_FILENAME } from './CheckpointManifestRepository';
import type { CheckpointIgnoreSnapshot, CheckpointManifestMeta } from './types';
import {
    isWorkspaceScopedKey,
    restoreWorkspaceSnapshot,
    toScopedKey,
    type RestoreChainEntry,
    type RestoreTargetState
} from './CheckpointRestoreEngine';
import {
    createWorkspaceScopedPath,
    parseWorkspaceScopedPath,
    validateWorkspaceSnapshot,
    type RuntimeWorkspaceRoot
} from './CheckpointWorkspace';
import { DEFAULT_CHECKPOINT_CONCURRENCY, runBounded } from './checkpointConcurrency';
import { hashFileStreaming } from './fileHashing';
import { Logger } from '../../core/logger';
import type { CheckpointConfig } from '../settings';
import type { CheckpointManifestRepository } from './CheckpointManifestRepository';
import { isSafeCheckpointDirName } from './CheckpointManifestRepository';
import type { CheckpointQueryService } from './CheckpointQueryService';
// L-11（R4 复查）：CheckpointRecord 等公共类型统一从 ./types 导入（单一真源），
// 不再反向依赖 CheckpointManager。
import type {
    CheckpointRecord,
    RestoreFailure,
    RestoreFailureReason,
    CheckpointExcludedNote,
    RestoreResult
} from './types';
import { refreshAffectedDocuments } from './WorkspaceEditorRefresher';

// CPF-12: 保持原日志类别（CheckpointManager），拆分不改变日志过滤/采集行为
const log = Logger.get('CheckpointManager');

// L-11（R4 复查）：以下公共类型已迁移到 ./types（单一真源），此处 re-export 兼容
// 既有导入路径（历史代码曾从本模块导入这些类型）。
export type {
    RestoreFailureReason,
    RestoreFailure,
    CheckpointExcludedNote,
    RestoreResult
} from './types';

/**
 * 恢复准备上下文：restoreCheckpoint 与 previewRestore 共用的校验/计算产物。
 */
interface RestorePreparedContext {
    checkpoint: CheckpointRecord;
    checkpoints: CheckpointRecord[];
    missingBackupDirs: string[];
    autoPrunedCheckpointCount: number;
    /** undefined = 旧版无 fileHashes 存档（legacy 恢复语义：不删除任何文件） */
    targetState?: RestoreTargetState;
    /** EX-11: 目标存档的 manifest 元数据视图（含排除规则快照；旧存档无 manifest 时为 undefined）。
     *  完整 files 映射按需懒加载（CPF-LAZY-1），恢复准备路径只消费元数据字段。 */
    manifest?: CheckpointManifestMeta;
    chain: CheckpointRecord[];
    chainEntries: RestoreChainEntry[];
    currentHashes: Record<string, string>;
    currentEmptyDirs: string[];
    protectedScopedPaths: Set<string>;
    deletableScopedPaths: Set<string>;
}

/**
 * 检查点恢复服务（CPF-12：从 CheckpointManager 拆分的恢复侧文件操作辅助）。
 */
export class CheckpointRestoreService {
    constructor(
        private readonly checkpointsDir: string,
        private readonly settingsManager: SettingsManager,
        private readonly manifestRepository: CheckpointManifestRepository,
        private readonly queryService: CheckpointQueryService,
        private readonly conversationManager: ConversationManager
    ) {}

    /**
     * 为某个根目录创建检查点忽略解析器（H-1：恢复/当前状态过滤接入完整四层排除模型）。
     *
     * `includeCustomPatterns` 用于区分两类场景：
     * - 工作区侧：叠加完整 CheckpointConfig——旧字段 + exclusion.customPatterns 合并、
     *   enabledProfiles（缺省全开）、扩展存储根绝对路径强制排除
     * - 备份目录侧：只按备份内容本身遍历，不再追加工作区配置（不启用默认类别、
     *   不排除存储根——备份目录本身位于存储根内）
     */
    private createIgnoreResolver(rootDir: string, includeCustomPatterns: boolean = true): CheckpointIgnoreResolver {
        const config = this.settingsManager.getCheckpointConfig();
        const extraPatterns = includeCustomPatterns
            ? [
                ...(config.customIgnorePatterns ?? []),
                ...(config.exclusion?.customPatterns ?? [])
            ]
            : [];
        return new CheckpointIgnoreResolver(rootDir, extraPatterns, {
            // 与快照构建同一口径：缺省全部默认类别启用（前端未配置时全开）
            enabledProfiles: includeCustomPatterns
                ? (config.exclusion?.enabledProfiles ?? DEFAULT_ENABLED_PROFILES)
                : undefined,
            // M-2: 类别自定义模式覆盖与快照构建/预览同一口径（profileId -> 模式清单）。
            // 缺省/空 = 使用类别默认清单；漏传会导致恢复侧回退到默认模式，
            // 用户在类别里改过的模式既不参与目标过滤、也不参与当前状态收集。
            profilePatterns: includeCustomPatterns ? config.exclusion?.profilePatterns : undefined,
            // 排除整个扩展存储根（含 checkpoints/memory/conversations 等），
            // 恢复过滤同样不得把文件写回/删除存储目录
            excludeAbsolutePaths: includeCustomPatterns ? [path.dirname(this.checkpointsDir)] : []
        });
    }

    /**
     * 收集某个根目录下应被检查点系统“看见”的文件和空目录。
     *
     * `includeCustomPatterns=false` 用于备份目录侧遍历：只按备份内容本身遍历，
     * 不再追加工作区配置的自定义忽略模式。
     */
    private async collectSnapshotEntries(
        rootDir: string,
        includeCustomPatterns: boolean = true
    ): Promise<{ files: string[]; dirs: string[] }> {
        return this.createIgnoreResolver(rootDir, includeCustomPatterns).collectEntries();
    }

    /**
     * 基于“当前工作区规则”过滤检查点目标状态（多根 scoped 版本）。
     *
     * 每个根目录使用各自的忽略解析器；旧格式相对路径键在单根下自动包装为 scoped 键。
     * 无法解析的键（如旧存档多根下）跳过，不恢复该路径。
     */
    private async filterRestoreTargetScoped(
        fileHashes: Record<string, string>,
        emptyDirs: string[],
        roots: readonly RuntimeWorkspaceRoot[]
    ): Promise<{ fileHashes: Record<string, string>; emptyDirs: string[] }> {
        const resolvers = new Map<string, CheckpointIgnoreResolver>();
        const getResolver = (root: RuntimeWorkspaceRoot): CheckpointIgnoreResolver => {
            let resolver = resolvers.get(root.id);
            if (!resolver) {
                resolver = this.createIgnoreResolver(root.fsPath);
                resolvers.set(root.id, resolver);
            }
            return resolver;
        };

        const filteredFileHashes: Record<string, string> = {};
        // 文件恢复目标和工作区扫描使用同一忽略口径，确保比较一致。
        // C-15: 逐文件串行 await isIgnored 在 10 万+文件时明显慢（首个 isIgnored 还会触发
        // .gitignore 读取），改为共享 runBounded 有界并发。
        const fileTargets = Object.entries(fileHashes).map(([rawKey, hash]) => ({ rawKey, hash }));
        await runBounded(fileTargets, DEFAULT_CHECKPOINT_CONCURRENCY, async ({ rawKey, hash }) => {
            const scopedKey = toScopedKey(rawKey, roots);
            try {
                const parsed = parseWorkspaceScopedPath(scopedKey, roots as RuntimeWorkspaceRoot[]);
                if (!(await getResolver(parsed.root).isIgnored(parsed.relativePath, false))) {
                    filteredFileHashes[scopedKey] = hash;
                }
            } catch (err) {
                console.warn(`[CheckpointManager] Skip unparsable checkpoint path ${scopedKey}:`, err);
            }
        });

        // 空目录同样需要按当前规则过滤，否则 restore 会重新创建当前已忽略的目录壳。
        // C-15: 同样有界并发；结果按下标回填，保持输出顺序稳定。
        const emptyDirResults: Array<string | undefined> = new Array(emptyDirs.length);
        const dirTargets = emptyDirs.map((rawKey, idx) => ({ rawKey, idx }));
        await runBounded(dirTargets, DEFAULT_CHECKPOINT_CONCURRENCY, async ({ rawKey, idx }) => {
            const scopedKey = toScopedKey(rawKey, roots);
            try {
                const parsed = parseWorkspaceScopedPath(scopedKey, roots as RuntimeWorkspaceRoot[]);
                if (!(await getResolver(parsed.root).isIgnored(parsed.relativePath, true))) {
                    emptyDirResults[idx] = scopedKey;
                }
            } catch (err) {
                console.warn(`[CheckpointManager] Skip unparsable checkpoint dir ${scopedKey}:`, err);
            }
        });
        const filteredEmptyDirs: string[] = emptyDirResults.filter((key): key is string => key !== undefined);

        return {
            fileHashes: filteredFileHashes,
            emptyDirs: filteredEmptyDirs
        };
    }

    /**
     * 获取从基准点到目标点的增量链
     */
    private getIncrementalChain(
        checkpoints: CheckpointRecord[],
        targetCheckpoint: CheckpointRecord
    ): { chain: CheckpointRecord[]; broken: boolean } {
        const chain: CheckpointRecord[] = [];
        let current: CheckpointRecord | undefined = targetCheckpoint;
        let broken = false;
        // CP-PERF-3: 预构建 id → 记录 索引，每跳 O(1) 定位 base；
        // 长链下替代逐跳 checkpoints.find 的 O(n²) 线性扫描。
        const byId = new Map(checkpoints.map(cp => [cp.id, cp] as const));
        // 环检测：损坏元数据（base 指向自身/成环）会让 while 无限循环——
        // visited 集合截断，按链断裂处理（调用方显式报 chainBroken，fail-closed）
        const visited = new Set<string>();

        while (current) {
            if (visited.has(current.id)) {
                broken = true;
                break;
            }
            visited.add(current.id);
            chain.unshift(current);  // 添加到链的开头

            if (current.type !== 'incremental' || !current.baseCheckpointId) {
                break;  // 到达完整备份，停止
            }

            current = byId.get(current.baseCheckpointId);
            if (!current) {
                broken = true;  // #28: 增量链断裂（找不到 baseCheckpointId 对应的检查点）
            }
        }

        return { chain, broken };
    }

    /**
     * 恢复公共准备（CP-09）：prune 缺失记录、工作区校验、增量链完整性验证、
     * 收集当前工作区状态、计算删除边界。
     *
     * restoreCheckpoint 与 previewRestore 共用此路径，保证「预览确认的删除清单」
     * 与「实际执行的删除」基于同一套校验与计算；本方法不执行文件写入。
     *
     * @returns ok=true 时携带恢复上下文；ok=false 时携带可直接返回的失败结果。
     */
    public async prepareRestore(
        conversationId: string,
        checkpointId: string,
        roots: readonly RuntimeWorkspaceRoot[]
    ): Promise<{ ok: true; ctx: RestorePreparedContext } | { ok: false; result: RestoreResult }> {
        // 查找检查点（缺失备份目录的记录先裁剪）
        let checkpoints = await this.queryService.getCheckpointRecords(conversationId);
        let missingBackupDirs: string[] = [];
        let autoPrunedCheckpointCount = 0;

        const pruneResult = await this.queryService.pruneMissingBackupCheckpointRecords(conversationId, checkpoints);
        checkpoints = pruneResult.checkpoints;
        missingBackupDirs = pruneResult.missingBackupDirs;
        autoPrunedCheckpointCount = pruneResult.prunedCount;

        const foundCheckpoint = checkpoints.find(cp => cp.id === checkpointId);
        // CPF-01: 新格式记录（元数据不含 fileHashes/fileStats）从 manifest 回填完整数据；旧记录直接使用
        const checkpoint = foundCheckpoint
            ? await this.manifestRepository.enrichRecord(foundCheckpoint)
            : undefined;
        // EX-11: 目标存档的 manifest（含排除规则快照；enrichRecord 已加载并缓存）
        const restoreManifest = checkpoint
            ? await this.manifestRepository.loadManifest(checkpoint.id, checkpoint)
            : undefined;

        const failResult = (error: string, extra?: Partial<RestoreResult>): { ok: false; result: RestoreResult } => ({
            ok: false,
            result: {
                success: false,
                restored: 0,
                deleted: 0,
                skipped: 0,
                error,
                missingBackupDirs: missingBackupDirs.length > 0 ? missingBackupDirs : undefined,
                autoPrunedCheckpointCount: autoPrunedCheckpointCount > 0 ? autoPrunedCheckpointCount : undefined,
                ...extra
            }
        });

        if (!checkpoint) {
            return failResult(t('modules.checkpoint.restore.checkpointNotFound'));
        }

        // CP-01: 新格式存档（带工作区身份元数据）必须通过工作区校验，
        // 防止项目 A 的存档被静默恢复到项目 B；旧存档无身份元数据，保持兼容。
        if (checkpoint.workspaceRoots?.length) {
            const validation = validateWorkspaceSnapshot(
                checkpoint.workspaceRoots,
                checkpoint.workspaceFingerprint,
                roots
            );
            if (!validation.valid) {
                return failResult(t('modules.checkpoint.restore.workspaceMismatch'));
            }
        }

        // 旧存档（相对路径键）无法在多根工作区中确定文件归属，明确拒绝而不是静默错恢复
        const hasLegacyKeys = checkpoint.fileHashes
            ? Object.keys(checkpoint.fileHashes).some(key => !isWorkspaceScopedKey(key))
            : false;
        if (hasLegacyKeys && roots.length > 1) {
            return failResult(t('modules.checkpoint.restore.multiRootLegacyNotSupported'));
        }

        // 先用当前规则裁剪目标状态（每个根独立 ignore 作用域），再进行 diff / restore。
        const targetState = checkpoint.fileHashes
            ? await this.filterRestoreTargetScoped(
                checkpoint.fileHashes,
                checkpoint.emptyDirs || [],
                roots
            )
            : undefined;

        // 旧版存档（无 fileHashes）：单根走 legacy 语义（只复制、绝不删除）；多根明确拒绝
        if (!checkpoint.fileHashes) {
            // L5: 新格式记录（带 manifestVersion/workspaceRoots）但 manifest 缺失（磁盘文件
            // 丢失/从未写入）→ 不是旧版 legacy 存档，而是存档数据丢失：显式报错，
            // 避免按 legacy 路径“假成功”（只恢复备份目录残留内容）。
            if (checkpoint.manifestVersion !== undefined || (checkpoint.workspaceRoots?.length ?? 0) > 0) {
                return failResult(t('modules.checkpoint.restore.manifestMissing'));
            }
            if (roots.length > 1) {
                return failResult(t('modules.checkpoint.restore.multiRootLegacyNotSupported'));
            }
            return {
                ok: true,
                ctx: {
                    checkpoint,
                    checkpoints,
                    missingBackupDirs,
                    autoPrunedCheckpointCount,
                    targetState: undefined,
                    manifest: restoreManifest ?? undefined,
                    chain: [],
                    chainEntries: [],
                    currentHashes: {},
                    currentEmptyDirs: [],
                    protectedScopedPaths: new Set(),
                    deletableScopedPaths: new Set()
                }
            };
        }

        // 获取增量链（从基准点到目标点）
        const { chain, broken } = this.getIncrementalChain(checkpoints, checkpoint);

        // #28: 增量链断裂时显式失败，不静默降级
        if (broken) {
            return failResult(t('modules.checkpoint.restore.chainBroken'), { failures: [] });
        }

        if (chain.length === 0) {
            return failResult(t('modules.checkpoint.restore.cannotBuildChain'));
        }

        // 验证链的完整性（确保所有备份目录都存在）；缺失记录在链内裁剪
        const chainMissingBackupDirs: string[] = [];
        for (const cp of chain) {
            if (!(await this.queryService.backupDirectoryExists(cp.backupDir))) {
                chainMissingBackupDirs.push(cp.backupDir);
            }
        }
        if (chainMissingBackupDirs.length > 0) {
            const chainMissingSet = new Set(chainMissingBackupDirs);
            const pruned = await this.conversationManager.updateCustomMetadata(conversationId, 'checkpoints', current => {
                const list = Array.isArray(current) ? current as CheckpointRecord[] : [];
                const remained = list.filter(cp => !chainMissingSet.has(cp.backupDir));
                return remained.length === list.length ? current : remained;
            });
            if (Array.isArray(pruned)) {
                autoPrunedCheckpointCount += checkpoints.length - pruned.length;
            }
            const allMissingBackupDirs = Array.from(
                new Set([...missingBackupDirs, ...chainMissingBackupDirs])
            );
            return failResult(
                t('modules.checkpoint.restore.backupDirNotFound', { dirs: allMissingBackupDirs.join(', ') }),
                { missingBackupDirs: allMissingBackupDirs }
            );
        }

        // 工作区当前状态与目标状态使用同一 ignore 口径收集（每个根独立 resolver）
        const { currentHashes, currentEmptyDirs } = await this.collectCurrentWorkspaceState(roots);

        // 快照时可见但未备份的路径（复制失败/大小超限/不可读）：恢复时绝不能删除
        const protectedScopedPaths = new Set<string>();
        for (const rawKey of checkpoint.unbackedPaths ?? []) {
            protectedScopedPaths.add(toScopedKey(rawKey, roots));
        }
        // M-3: 快照时被规则排除的文件/目录（manifest.excluded，reason ∈ {default, gitignore, custom}）
        // 同样纳入保护：用户之后放宽规则（关闭类别/删除自定义模式）后，这些快照时已存在的文件
        // 会进入 currentHashes，若无保护会被当作“快照后新建文件”删除（deleteUntrackedFiles=true），
        // 违反 CP-09“只删快照后新建文件”语义。
        // - forced：永远被当前规则忽略，永远不会进入 currentHashes，无需保护
        // - size/unreadable（文件级）：已在 unbackedPaths 覆盖（快照时可见但未备份）
        // - unreadable（目录级，resolver 阶段不可读目录）：只进 manifest.excluded、不在
        //   unbackedPaths；目录保持不可读时内部文件不会进入 currentHashes，无需保护
        // 目录级排除条目（整目录被排除，如 `ws_x/dist`）只记录目录自身，不递归记录内部文件：
        // 由恢复引擎的前缀匹配（isProtectedScopedPath）保护目录内全部文件。
        for (const entry of restoreManifest?.excluded ?? []) {
            if (entry.reason === 'default' || entry.reason === 'gitignore' || entry.reason === 'custom') {
                protectedScopedPaths.add(toScopedKey(entry.path, roots));
            }
        }

        // #29: 只删除目标快照 fileHashes 中记录过的路径，
        // 快照后新建、快照时被忽略/未备份的文件不会被静默删除
        const deletableScopedPaths = new Set<string>();
        for (const rawKey of Object.keys(checkpoint.fileHashes)) {
            deletableScopedPaths.add(toScopedKey(rawKey, roots));
        }

        // CPF-01/CPF-08: 增量链节点同样从 manifest 回填 fileHashes/changes（新格式记录元数据不含），
        // 恢复引擎据此构建 O(1) 文件路径索引
        const chainEntries: RestoreChainEntry[] = [];
        for (const cp of chain) {
            const enriched = await this.manifestRepository.enrichRecord(cp);
            chainEntries.push({
                checkpointId: cp.id,
                backupDir: cp.backupDir,
                fileHashes: enriched.fileHashes,
                // 增量节点磁盘上只保存 changes 里的文件；引擎据此限定备份文件边界
                changes: enriched.changes
            });
        }

        return {
            ok: true,
            ctx: {
                checkpoint,
                checkpoints,
                missingBackupDirs,
                autoPrunedCheckpointCount,
                targetState,
                manifest: restoreManifest ?? undefined,
                chain,
                chainEntries,
                currentHashes,
                currentEmptyDirs,
                protectedScopedPaths,
                deletableScopedPaths
            }
        };
    }

    /**
     * 收集当前工作区的文件哈希与空目录（scoped 键）。
     *
     * 与目标状态过滤使用同一 ignore 口径（每个根独立 resolver），
     * 保证 diff 与删除边界一致：当前被忽略的文件不进入哈希、也不会被删除。
     */
    private async collectCurrentWorkspaceState(
        roots: readonly RuntimeWorkspaceRoot[]
    ): Promise<{ currentHashes: Record<string, string>; currentEmptyDirs: string[] }> {
        const currentHashes: Record<string, string> = {};
        const currentEmptyDirs: string[] = [];
        // CP-PERF-1: 先收集全部待哈希目标（scoped 键映射与旧实现一致），
        // 再用共享 runBounded 有界并发 + 共享流式哈希，避免对全工作区逐文件顺序读盘。
        const hashTargets: Array<{ filePath: string; scopedPath: string }> = [];
        for (const root of roots) {
            const resolver = this.createIgnoreResolver(root.fsPath);
            const { files, dirs } = await resolver.collectEntries();
            for (const file of files) {
                const relativePath = path.relative(root.fsPath, file).replace(/\\/g, '/');
                hashTargets.push({ filePath: file, scopedPath: createWorkspaceScopedPath(root.id, relativePath) });
            }
            for (const dir of dirs) {
                const relativePath = path.relative(root.fsPath, dir).replace(/\\/g, '/');
                currentEmptyDirs.push(createWorkspaceScopedPath(root.id, relativePath));
            }
        }
        await runBounded(hashTargets, DEFAULT_CHECKPOINT_CONCURRENCY, async ({ filePath, scopedPath }) => {
            try {
                const hash = await hashFileStreaming(filePath);
                if (hash) {
                    currentHashes[scopedPath] = hash;
                }
            } catch {
                // 与 getFileHash 语义一致：读取失败（文件被删/权限）的文件跳过，不进入 currentHashes
            }
        });
        return { currentHashes, currentEmptyDirs };
    }

    /**
     * 把引擎返回的 scoped 失败路径转为相对路径展示；解析失败时保留原值。
     */
    public toDisplayPath(scopedKey: string, roots: readonly RuntimeWorkspaceRoot[]): string {
        try {
            return parseWorkspaceScopedPath(scopedKey, roots as RuntimeWorkspaceRoot[]).relativePath;
        } catch {
            return scopedKey;
        }
    }

    /**
     * 把存档记录的 unbackedPaths（scoped 键）批量转为显示路径。
     * 旧存档无该字段时返回空数组。
     */
    public toDisplayUnbackedPaths(
        unbackedPaths: string[] | undefined,
        roots: readonly RuntimeWorkspaceRoot[]
    ): string[] | undefined {
        if (!unbackedPaths || unbackedPaths.length === 0) {
            return undefined;
        }
        const displayed = unbackedPaths.map(pathKey => this.toDisplayPath(pathKey, roots));
        // 限制数量，避免把大量超限文件路径塞进 IPC 响应
        return displayed.length > 50 ? displayed.slice(0, 50) : displayed;
    }

    /** 把失败清单压缩成单行摘要（供前端直接展示），超出 5 条时截断并计数（CP-I18N-1） */
    public formatFailureSummary(failures: RestoreFailure[]): string {
        const shown = failures.slice(0, 5).map(f => `${f.path}: ${f.reason}`).join('; ');
        const rest = failures.length - 5;
        return rest > 0
            ? `${shown}; ${t('modules.checkpoint.restore.moreFailures', { count: rest })}`
            : shown;
    }

    /**
     * 旧版本检查点（无 fileHashes）恢复。
     *
     * 以备份目录实际内容为恢复目标（相对路径键 → scoped 包装），复用恢复引擎
     * 获得路径安全校验与失败清单；删除白名单传空集——旧记录没有“快照时可见/未备份”
     * 清单，无法安全判断当前文件归属，因此绝不删除工作区任何文件。
     */
    public async restoreLegacyCheckpointViaEngine(
        checkpoint: CheckpointRecord,
        roots: RuntimeWorkspaceRoot[],
        missingBackupDirs: string[],
        autoPrunedCheckpointCount: number,
        signal?: AbortSignal
    ): Promise<RestoreResult> {
        // CP-PATH-1: 读取侧与删除侧同一校验口径——越界/损坏 backupDir 绝不拼路径扫描
        //（本方法会对备份目录做 collectSnapshotEntries 的递归 readdir/stat/哈希遍历）。
        if (!isSafeCheckpointDirName(checkpoint.backupDir)) {
            console.warn(`[CheckpointManager] Refusing to restore checkpoint ${checkpoint.id}: unsafe backupDir ${checkpoint.backupDir}`);
            return {
                success: false,
                restored: 0,
                deleted: 0,
                skipped: 0,
                error: 'Refusing to restore checkpoint with unsafe backupDir'
            };
        }
        // 备份目录以“备份内容自身”为遍历边界（不叠加工作区自定义模式）
        const backupPath = path.join(this.checkpointsDir, checkpoint.backupDir);
        let backupFiles: string[];
        let backupDirs: string[];
        try {
            const entries = await this.collectSnapshotEntries(backupPath, false);
            backupFiles = entries.files;
            backupDirs = entries.dirs;
        } catch (err) {
            console.error('[CheckpointManager] Failed to scan legacy checkpoint backup:', err);
            return { success: false, restored: 0, deleted: 0, skipped: 0, error: 'Failed to scan checkpoint backup' };
        }

        // CPF-LAZY-1 / ATOMIC-PAIR: 备份目录内的元数据文件（manifest.json / files.json /
        // *.tmp / files.json.prev）不是备份内容——崩溃窗口（files.json 已 rename、manifest.json
        // 未 rename）或写失败残留时会留在目录里，legacy 恢复不得把它们当作用户文件恢复进工作区
        // （与目录遍历/大小统计的跳过清单同一口径）。
        const isCheckpointMetadataPath = (p: string): boolean => {
            const name = path.basename(p);
            return name === CHECKPOINT_MANIFEST_FILENAME
                || name === CHECKPOINT_MANIFEST_FILES_FILENAME
                || name.endsWith('.tmp')
                || name.endsWith('.prev');
        };
        backupFiles = backupFiles.filter(f => !isCheckpointMetadataPath(path.relative(backupPath, f)));
        backupDirs = backupDirs.filter(d => !isCheckpointMetadataPath(path.relative(backupPath, d)));

        // 以备份目录内容构造目标状态（相对路径键，引擎内自动包装为 scoped）
        const rawHashes: Record<string, string> = {};
        // CP-PERF-1: 备份内容哈希同样有界并发（共享 runBounded + 流式哈希）；
        // 读取失败的文件与 getFileHash 返回 null 的旧语义一致地跳过。
        const backupHashTargets: Array<{ backupFile: string; relativePath: string }> = [];
        for (const backupFile of backupFiles) {
            const relativePath = normalizeCheckpointPath(path.relative(backupPath, backupFile));
            if (relativePath) {
                backupHashTargets.push({ backupFile, relativePath });
            }
        }
        await runBounded(backupHashTargets, DEFAULT_CHECKPOINT_CONCURRENCY, async ({ backupFile, relativePath }) => {
            try {
                const hash = await hashFileStreaming(backupFile);
                if (hash) rawHashes[relativePath] = hash;
            } catch {
                // 读取失败跳过，与 getFileHash 返回 null 的旧语义一致
            }
        });
        const rawEmptyDirs = backupDirs
            .map(dir => normalizeCheckpointPath(path.relative(backupPath, dir)))
            .filter(Boolean);

        // 当前规则裁剪目标状态 + 当前工作区状态（同一 ignore 口径）
        const targetState = await this.filterRestoreTargetScoped(rawHashes, rawEmptyDirs, roots);
        const { currentHashes, currentEmptyDirs } = await this.collectCurrentWorkspaceState(roots);

        // 引擎执行：白名单为空集 → 不删除任何文件
        const engineResult = await restoreWorkspaceSnapshot(
            {
                checkpointsDir: this.checkpointsDir,
                roots,
                deletableScopedPaths: new Set<string>(),
                signal
            },
            [{
                checkpointId: checkpoint.id,
                backupDir: checkpoint.backupDir,
                fileHashes: rawHashes,
                changes: Object.keys(rawHashes).map(rawKey => ({ path: rawKey, type: 'added' as const }))
            }],
            { fileHashes: targetState.fileHashes, emptyDirs: targetState.emptyDirs },
            currentHashes,
            currentEmptyDirs
        );

        await refreshAffectedDocuments(engineResult.modifiedPaths, engineResult.deletedPaths);

        const failures: RestoreFailure[] = engineResult.failures.map(f => ({
            path: this.toDisplayPath(f.path, roots),
            reason: f.reason
        }));
        const hasFailures = failures.length > 0;

        // L-2: 与新格式恢复共用同一“结果 → 状态栏消息”逻辑
        this.showRestoreResultMessage(
            checkpoint,
            { restored: engineResult.restored, deleted: engineResult.deleted, skipped: engineResult.skipped },
            failures.length
        );

        log.info('restore_legacy_backup', { restored: engineResult.restored, skipped: engineResult.skipped, failureCount: failures.length });

        return {
            success: engineResult.success,
            restored: engineResult.restored,
            deleted: 0,
            skipped: engineResult.skipped,
            failures: hasFailures ? failures : undefined,
            error: hasFailures ? this.formatFailureSummary(failures) : undefined,
            missingBackupDirs: missingBackupDirs.length > 0 ? missingBackupDirs : undefined,
            autoPrunedCheckpointCount: autoPrunedCheckpointCount > 0 ? autoPrunedCheckpointCount : undefined,
            unbackedPaths: this.toDisplayUnbackedPaths(checkpoint.unbackedPaths, roots),
        };
    }

    /**
     * 展示恢复结果的状态栏消息（L-2：新格式恢复与 legacy 恢复共用同一套
     * “失败/成功文案 + details 拼接 + setStatusBarMessage”逻辑，避免两处副本漂移）。
     *
     * @returns 拼接后的完整消息文本（日志/测试可复用）
     */
    public showRestoreResultMessage(
        checkpoint: Pick<CheckpointRecord, 'toolName' | 'phase'>,
        counts: { restored: number; deleted: number; skipped: number },
        failureCount: number
    ): string {
        const phaseText = checkpoint.phase === 'before'
            ? t('modules.checkpoint.description.before')
            : t('modules.checkpoint.description.after');
        let message: string;
        if (failureCount > 0) {
            message = `$(warning) ${t('modules.checkpoint.restore.partialFailure', { toolName: checkpoint.toolName, phase: phaseText, count: failureCount })}`;
        } else {
            message = `$(check) ${t('modules.checkpoint.restore.success', { toolName: checkpoint.toolName, phase: phaseText })}`;
        }
        const details: string[] = [];
        if (counts.restored > 0) details.push(t('modules.checkpoint.restore.filesUpdated', { count: counts.restored }));
        if (counts.deleted > 0) details.push(t('modules.checkpoint.restore.filesDeleted', { count: counts.deleted }));
        if (counts.skipped > 0) details.push(t('modules.checkpoint.restore.filesUnchanged', { count: counts.skipped }));
        if (details.length > 0) {
            message += `（${details.join('，')}）`;
        }
        vscode.window.setStatusBarMessage(message, 5000);
        return message;
    }

    /**
     * 构建当前排除规则快照（EX-10/EX-11）。
     *
     * 与快照构建器使用同一口径：自定义模式 = 旧字段 + exclusion.customPatterns 合并。
     */
    private buildIgnoreSnapshot(config: Readonly<CheckpointConfig>): CheckpointIgnoreSnapshot {
        return buildIgnoreSnapshot({
            enabledProfiles: config.exclusion?.enabledProfiles,
            profilePatterns: config.exclusion?.profilePatterns,
            maxFileSizeBytes: config.exclusion?.maxFileSizeBytes ?? DEFAULT_EXCLUSION_MAX_FILE_SIZE_BYTES,
            customPatterns: [
                ...(config.customIgnorePatterns ?? []),
                ...(config.exclusion?.customPatterns ?? [])
            ]
        });
    }

    /**
     * EX-11: 构建恢复时的排除说明（区分快照规则与当前规则）。
     *
     * - 快照规则来自 manifest.ignoreSnapshot（该存档创建时的排除配置）；
     * - 当前规则来自 settingsManager 实时配置；
     * - 恢复仍严格按当前规则过滤（filterRestoreTargetScoped），不会因旧规则宽而覆盖
     *   当前明确忽略的文件。
     */
    public buildExcludedNote(
        manifest: CheckpointManifestMeta | undefined
    ): CheckpointExcludedNote | undefined {
        if (!manifest) {
            return undefined; // 旧存档无规则快照，不生成说明
        }
        const excludedCount = manifest.excluded.length;
        if (excludedCount === 0) {
            return undefined;
        }
        const snapshotRules = manifest.ignoreSnapshot;
        const currentRules = this.buildIgnoreSnapshot(this.settingsManager.getCheckpointConfig());
        const rulesChanged =
            snapshotRules.maxFileSizeBytes !== currentRules.maxFileSizeBytes ||
            snapshotRules.customPatterns.join('\n') !== currentRules.customPatterns.join('\n') ||
            // M-4: 默认类别开关变化同样视为规则变化（键排序后比较）
            serializeEnabledProfiles(snapshotRules.enabledProfiles) !== serializeEnabledProfiles(currentRules.enabledProfiles) ||
            // M-4: 类别自定义模式覆盖变化同样视为规则变化（键排序后稳定序列化比较）
            serializeProfilePatterns(snapshotRules.profilePatterns) !== serializeProfilePatterns(currentRules.profilePatterns) ||
            // 版本号变化（未来规则/类别升级时）同样视为规则变化
            snapshotRules.version !== currentRules.version ||
            snapshotRules.forcedRulesVersion !== currentRules.forcedRulesVersion ||
            snapshotRules.defaultProfileVersion !== currentRules.defaultProfileVersion;
        // CP-I18N-1: 排除说明统一走 t()（缺失语言条目时回退为 key 本身，由后续语言包补齐）
        const message = rulesChanged
            ? t('modules.checkpoint.restore.excludedNoteChanged', { count: excludedCount })
            : t('modules.checkpoint.restore.excludedNote', { count: excludedCount });
        return {
            excludedCount,
            rulesChanged,
            message,
            snapshotRules,
            currentRules
        };
    }
}

/**
 * 规范化序列化 enabledProfiles：键排序后比较，忽略对象键顺序差异（M-4）。
 */
function serializeEnabledProfiles(profiles: Record<string, boolean>): string {
    return Object.entries(profiles)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, value]) => `${key}:${value}`)
        .join('|');
}

/**
 * 规范化序列化 profilePatterns（类别自定义模式覆盖）：键排序后比较，
 * 忽略对象键顺序差异（M-4）。数组内顺序保留——gitignore 否定规则（`!`）的
 * 先后顺序有语义，按序比较是正确行为（R7b 复查确认，不改实现只改注释）。
 *
 * 空数组条目（`{logs: []}`）与 undefined 语义等价（该类别未覆盖 → 使用默认清单），
 * 序列化时跳过，避免 `logs:` 与 `''` 不等价导致的 rulesChanged 偶发误报（M-4-②）。
 * 条目分隔符用 `\u0000`：gitignore 模式中不可能出现该字符，避免模式含 `|` 时
 * 跨类别串扰（M-4-③）。
 */
function serializeProfilePatterns(patterns: Record<string, string[]> | undefined): string {
    if (!patterns) {
        return '';
    }
    return Object.entries(patterns)
        .filter(([, list]) => list.length > 0)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([id, list]) => `${id}:${list.join('\n')}`)
        .join('\u0000');
}
