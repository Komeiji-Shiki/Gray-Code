/**
 * CheckpointRetentionService - 存档保留策略（CPF-12 拆分）。
 *
 * 从 CheckpointManager 抽出的保留/合并逻辑：
 * - cleanupOldCheckpoints：超过 maxCheckpoints 时清理最旧存档（增量链保护：被后继
 *   引用为基快照的项先 mergeCheckpointIntoSuccessor 重挂链再删除）
 * - mergeCheckpointIntoSuccessor：把被删存档的备份内容合并进后继（链重挂），
 *   新格式存档同步更新后继 manifest 中的 changes
 *
 * 依赖通过 deps 注入（getCheckpointRecords / deleteCheckpointInternal / getCheckpointConfig），
 * 避免反向引用 CheckpointManager 造成运行时循环依赖。
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import { Logger } from '../../core/logger';
import type { CheckpointConfig } from '../settings';
import type { ConversationManager } from '../conversation';
import type { CheckpointRecord } from './CheckpointManager';
import { CheckpointManifestRepository, CHECKPOINT_MANIFEST_FILENAME, CHECKPOINT_MANIFEST_FILES_FILENAME, isSafeCheckpointDirName } from './CheckpointManifestRepository';
import { isWorkspaceScopedKey } from './CheckpointRestoreEngine';
import { hashFileStreaming } from './fileHashing';

const log = Logger.get('CheckpointRetentionService');

export interface CheckpointRetentionDeps {
    getCheckpointRecords: (conversationId: string) => Promise<CheckpointRecord[]>;
    /** 无锁删除（调用方必须已持有存档锁；createCheckpoint 锁内清理复用） */
    deleteCheckpointInternal: (conversationId: string, checkpointId: string) => Promise<boolean>;
    getCheckpointConfig: () => Readonly<CheckpointConfig>;
}

export class CheckpointRetentionService {
    constructor(
        private readonly deps: CheckpointRetentionDeps,
        private readonly checkpointsDir: string,
        private readonly manifestRepository: CheckpointManifestRepository,
        private readonly conversationManager: ConversationManager
    ) {}

    /**
     * 清理过期检查点（与旧 CheckpointManager.cleanupOldCheckpoints 语义一致）。
     */
    async cleanupOldCheckpoints(conversationId: string): Promise<void> {
        const config = this.deps.getCheckpointConfig();
        // maxCheckpoints <= 0 = 不保留策略：跳过清理自身——cleanupOldCheckpoints 在创建
        // 新检查点之后调用，<=0 时若按「超限即删最旧」执行会把刚创建的检查点立即删除
        if (config.maxCheckpoints <= 0) {
            return;
        }
        try {
            const checkpoints = await this.deps.getCheckpointRecords(conversationId);
            if (checkpoints.length > config.maxCheckpoints) {
                // 同毫秒时间戳时按 id 次键排序，保证删除顺序稳定（避免同批同戳存档顺序抖动）
                const sorted = [...checkpoints].sort((a, b) => a.timestamp - b.timestamp || (a.id < b.id ? -1 : 1));
                const excess = checkpoints.length - config.maxCheckpoints;
                const deleted = new Set<string>();
                // CP-RET-3: 预构建 baseCheckpointId → 后继列表 与 id → 排序位置索引，
                // 每轮 O(1) 取后继，替代对 sorted.slice(i+1) 反复 filter 的 O(n²) 扫描；
                // 「仅合并排序在后的后继」与「未被删除」两个过滤保持原语义。
                const indexById = new Map(sorted.map((c, idx) => [c.id, idx] as const));
                const successorsByBase = new Map<string, CheckpointRecord[]>();
                for (const c of sorted) {
                    if (c.baseCheckpointId) {
                        let list = successorsByBase.get(c.baseCheckpointId);
                        if (!list) {
                            list = [];
                            successorsByBase.set(c.baseCheckpointId, list);
                        }
                        list.push(c);
                    }
                }

                for (let i = 0; i < excess && i < sorted.length; i++) {
                    const cp = sorted[i];
                    // CP-RET-1: 对引用被删项的全部后继循环执行合并——异常元数据可能出现
                    // 多节点引用同一 base，只合并第一个会让其余依赖者悬空断链。
                    const dependents = (successorsByBase.get(cp.id) ?? [])
                        .filter(c => !deleted.has(c.id) && (indexById.get(c.id) ?? -1) > i);
                    let mergeFailed = false;
                    for (const dependent of dependents) {
                        try {
                            await this.mergeCheckpointIntoSuccessor(conversationId, dependent, cp);
                        } catch (err) {
                            console.warn('[CheckpointRetentionService] Failed to re-link checkpoint chain, keeping checkpoint:', err);
                            mergeFailed = true;
                            break;
                        }
                    }
                    if (mergeFailed) {
                        // 合并失败必须中止删除，否则保留节点恢复时断链
                        continue;
                    }
                    // CP-RET-1: 以删除返回值为准——删除被拒绝（被引用/backupDir 校验失败）
                    // 时不得标记 deleted，否则后续迭代会把未删除节点当作已处理。
                    const removed = await this.deps.deleteCheckpointInternal(conversationId, cp.id);
                    if (removed) {
                        deleted.add(cp.id);
                    }
                }
            }
        } catch (err) {
            console.error('[CheckpointRetentionService] Failed to cleanup old checkpoints:', err);
        }
    }

    /**
     * 把被删除检查点的备份内容合并进其后继（链重挂），并持久化后继的元数据。
     *
     * 增量链 A → M → B（B.base = M）：直接删除 M 会让 B 的恢复链变成 [A, B]，
     * 而 B 的备份目录只有 B 相对 M 变更的文件——M 独有（B 未改）的文件会从链上
     * 消失，恢复 B 时报 missing_in_chain。
     * 合并 = 把 M 的备份文件复制进 B 的目录（force:false 不覆盖 B 已有的更新版本），
     * 把 M.changes 并入 B.changes（B 未涉及的路径保留），B.baseCheckpointId 改指 M.base。
     * 新格式存档的 changes 存于 manifest，需要同步更新后继的 manifest。
     *
     * M6（跨格式合并）：legacy 节点按相对路径布局（`cp_xxx/relative`），新格式后继按
     * scoped 布局（`cp_xxx/ws_xxx/relative`）。合并时把 legacy 相对路径重写为后继的
     * scoped 键再复制，并把合并文件的 scoped 键并入后继 manifest.files
     * （hash 从 removed 节点 manifest/record 取），否则恢复引擎按 scoped 寻址
     * 找不到合并进来的文件 → missing_in_chain。
     */
    async mergeCheckpointIntoSuccessor(
        conversationId: string,
        successor: CheckpointRecord,
        removed: CheckpointRecord
    ): Promise<void> {
        // CP-RET-2: 合并路径与删除路径同根因——backupDir 未校验时 fs.cp 可越界读写。
        // 校验失败直接抛错：调用方（cleanupOldCheckpoints）会中止删除并保留节点。
        if (!isSafeCheckpointDirName(removed.backupDir) || !isSafeCheckpointDirName(successor.backupDir)) {
            throw new Error(
                `[CheckpointRetentionService] Refusing to merge with unsafe backupDir: ` +
                `removed=${removed.backupDir}, successor=${successor.backupDir}`
            );
        }
        const removedBackupPath = path.join(this.checkpointsDir, removed.backupDir);
        const successorBackupPath = path.join(this.checkpointsDir, successor.backupDir);

        // 枚举 removed 节点磁盘上真实存在的文件（跳过 manifest 元数据），
        // 并取出“磁盘相对路径 → 文件信息”映射（哈希用于合并 manifest.files）。
        const removedFilesByKey = await this.loadRemovedFileEntries(removed);
        const successorRootId = await this.resolveSuccessorRootId(successor);
        const successorUsesScopedLayout = successorRootId !== undefined;
        // 统一逐文件枚举复制（listBackupFiles 已跳过 manifest/files.json 等元数据文件）；
        // 不再用 fs.cp 整目录回退——legacy 目录整目录复制会把元数据文件一并拷入后继
        const diskFiles = await this.listBackupFiles(removedBackupPath);
        const rewriteKey = (rawPath: string): string =>
            successorRootId !== undefined && !isWorkspaceScopedKey(rawPath)
                ? `${successorRootId}/${rawPath.replace(/\\/g, '/').replace(/^\/+/, '')}`
                : rawPath;

        // 1. 文件合并：后继目录优先，不覆盖已存在的更新版本。
        //    无法枚举 removed 文件（真正 legacy 无哈希）时同样逐文件复制
        //   （removedFilesByKey 缺失只影响 manifest 合并的 hash 来源，不影响文件复制）。
        //    CP-RET-4: 复制成功后现场计算真实哈希——真 legacy 节点无哈希记录，若以 hash:''
        //    占位写入 manifest.files，恢复引擎哈希校验必然失败（backupHash !== ''）→ 永久
        //    hash_mismatch。复制成功即对 dest 文件现场哈希，写入合并后的 manifest.files。
        const mergedFileHashes = new Map<string, { hash: string; size: number; mtimeMs: number }>();
        for (const relative of diskFiles) {
            const targetKey = rewriteKey(relative);
            const src = path.join(removedBackupPath, ...relative.split('/'));
            const dest = path.join(successorBackupPath, ...targetKey.split('/'));
            try {
                await fs.access(dest); // 已存在（后继更新版本）→ 不覆盖
            } catch {
                try {
                    await fs.cp(src, dest, { force: false });
                    // 现场计算真实哈希（复制成功即可读）：写入 mergedFileHashes 供 manifest 合并使用
                    try {
                        const hash = await hashFileStreaming(dest);
                        const st = await fs.stat(dest);
                        mergedFileHashes.set(targetKey, { hash, size: st.size, mtimeMs: st.mtimeMs });
                    } catch (hashErr) {
                        // 哈希失败（罕见）：该文件不写入 manifest.files（避免 hash:'' 占位）
                        console.warn(`[CheckpointRetentionService] Failed to hash merged file ${targetKey}:`, hashErr);
                    }
                } catch (err) {
                    // 源文件缺失（manifest 声称有但磁盘没有）：跳过，恢复时按链上缺失处理
                    console.warn(`[CheckpointRetentionService] Skip merging ${relative} into ${successor.backupDir}:`, err);
                }
            }
        }

        // 2. changes 合并：后继未涉及的路径保留被删项的变更记录（元数据语义完整）。
        //    新格式记录从 manifest 回填 changes 后再合并；跨格式时 legacy 相对路径重写为
        //    scoped 键；legacy 完整节点没有 changes 时，用备份目录实际存在的文件合成
        //    added 变更（链重挂后后继必须覆盖这些文件）。
        const enrichedSuccessor = await this.manifestRepository.enrichRecord(successor);
        const enrichedRemoved = await this.manifestRepository.enrichRecord(removed);
        const successorPaths = new Set((enrichedSuccessor.changes ?? []).map(c => c.path));
        const mergedChanges: CheckpointRecord['changes'] = [...(enrichedSuccessor.changes ?? [])];
        const appendChange = (pathKey: string, type: 'added' | 'modified' | 'deleted', hash?: string): void => {
            if (successorPaths.has(pathKey)) return;
            successorPaths.add(pathKey);
            mergedChanges.push({ path: pathKey, type, hash });
        };
        for (const change of enrichedRemoved.changes ?? []) {
            appendChange(rewriteKey(change.path), change.type, change.hash);
        }
        for (const relative of diskFiles) {
            appendChange(rewriteKey(relative), 'added', removedFilesByKey?.[relative]?.hash);
        }

        // 3. 链重挂
        successor.baseCheckpointId = removed.baseCheckpointId;
        successor.changes = mergedChanges;

        // 4. 新格式存档：changes 的权威副本在 manifest，同步更新后继 manifest
        //    （合并需读写 files 映射，走 loadManifestWithFiles 懒加载完整数据）
        const successorManifest = await this.manifestRepository.loadManifestWithFiles(successor.id, successor);
        if (successorManifest) {
            const manifestPaths = new Set(successorManifest.changes.map(c => c.path));
            const deletedInManifest = new Set(
                successorManifest.changes.filter(c => c.type === 'deleted').map(c => c.path)
            );
            for (const change of mergedChanges) {
                if (manifestPaths.has(change.path)) continue;
                manifestPaths.add(change.path);
                successorManifest.changes = [...successorManifest.changes, change];
            }
            // M6: 合并进后继的文件（scoped 键）并入 manifest.files（hash 从 removed 节点
            //     manifest/record 取，真 legacy 无哈希时用复制后的现场哈希）；后继快照已删除的
            //     路径不并入（恢复后继不应复活被删文件）。
            //     CP-RET-4: 两者都不可得（复制/哈希失败）→ 不写占位条目（hash:'' 会让恢复
            //     永久 hash_mismatch），该文件按链上缺失处理。
            for (const relative of diskFiles) {
                const targetKey = rewriteKey(relative);
                if (deletedInManifest.has(targetKey)) continue;
                if (targetKey in successorManifest.files) continue;
                // 优先用复制后的现场哈希（真实磁盘内容）；其次 removed 节点 manifest/record 哈希
                const liveEntry = mergedFileHashes.get(targetKey);
                const entry = liveEntry ?? removedFilesByKey?.[relative];
                if (!entry) {
                    console.warn(`[CheckpointRetentionService] Skip manifest entry for merged file ${targetKey}: no hash available`);
                    continue;
                }
                successorManifest.files[targetKey] = entry;
            }
            try {
                await this.manifestRepository.writeManifest(successor.id, successorManifest);
            } catch (err) {
                // C-3: manifest 写失败与文件合并失败同语义——抛错中止删除。
                // 若只 console.warn 后继续持久化，恢复链仍指向旧 manifest → 必报 missing_in_chain。
                console.warn(`[CheckpointRetentionService] Failed to update manifest of ${successor.backupDir}:`, err);
                throw err;
            }
        }

        // 5. 持久化更新后的后继元数据（deleteCheckpoint 随后会基于最新列表删除被删项）
        //    替换在链内原子完成：并发删除/创建时不会基于旧列表整体写回互相覆盖
        await this.conversationManager.updateCustomMetadata(conversationId, 'checkpoints', current => {
            const list = Array.isArray(current) ? current as CheckpointRecord[] : [];
            return list.map(cp => (cp.id === successor.id ? successor : cp));
        });
    }

    /**
     * 读取被删节点的“磁盘相对路径键 → 文件信息”映射（跨格式合并的哈希来源）。
     *
     * - 优先用 manifest.files（新格式；legacy 缺失时由 loadManifestWithFiles 迁移生成，键为相对路径）；
     * - 无 manifest 时退回 record.fileHashes；
     * - 都没有（真正 legacy 无哈希）→ undefined，调用方仍逐文件枚举复制
     *   （合并 manifest.files 时以 size 0 占位）。
     */
    private async loadRemovedFileEntries(
        removed: CheckpointRecord
    ): Promise<Record<string, { hash: string; size: number; mtimeMs: number; mtimeNs?: string }> | undefined> {
        const manifest = await this.manifestRepository.loadManifestWithFiles(removed.id, removed);
        if (manifest) {
            return manifest.files;
        }
        if (removed.fileHashes && Object.keys(removed.fileHashes).length > 0) {
            return Object.fromEntries(
                Object.entries(removed.fileHashes).map(([key, hash]) => [key, { hash, size: 0, mtimeMs: 0 }])
            );
        }
        return undefined;
    }

    /**
     * 判断后继是否使用 scoped 布局，并取出用于 legacy 路径重写的根 id。
     * 优先取后继 manifest 元数据视图的 workspaceRoots[0]（CPF-LAZY-1：无需加载 files）；
     * 退化路径（旧格式无 workspaceRoots）才懒加载完整 manifest，从 scoped 键前缀推导。
     * 后继为 legacy（无 scoped 布局）时返回 undefined（不做路径重写）。
     */
    private async resolveSuccessorRootId(successor: CheckpointRecord): Promise<string | undefined> {
        const manifest = await this.manifestRepository.loadManifest(successor.id, successor);
        if (manifest && (manifest.workspaceRoots?.length ?? 0) > 0) {
            return manifest.workspaceRoots[0].id;
        }
        // 退化路径：无 workspaceRoots（旧格式/迁移生成），需要看 files 键是否 scoped——
        // 此时才触发 files 懒加载，避免常规合并路径加载重量级映射
        const fullManifest = manifest
            ? await this.manifestRepository.loadManifestWithFiles(successor.id, successor)
            : null;
        const candidates: Array<Record<string, unknown>> = [];
        if (fullManifest) candidates.push(fullManifest.files);
        if (successor.fileHashes) candidates.push(successor.fileHashes);
        for (const files of candidates) {
            const scopedKey = Object.keys(files).find(key => isWorkspaceScopedKey(key));
            if (scopedKey) {
                return scopedKey.split('/')[0];
            }
        }
        return undefined;
    }

    /** 递归枚举备份目录内的文件（相对路径，posix 分隔）；跳过 manifest 元数据文件 */
    private async listBackupFiles(dir: string): Promise<string[]> {
        const results: string[] = [];
        const walk = async (current: string, prefix: string): Promise<void> => {
            let entries;
            try {
                entries = await fs.readdir(current, { withFileTypes: true });
            } catch {
                return;
            }
            for (const entry of entries) {
                // CPF-LAZY-1: manifest.json 与 files.json 均为元数据文件，不属备份内容；
                // ATOMIC-PAIR: files.json.prev 是崩溃窗口的旧配对备份，同样不属备份内容
                if (entry.name === CHECKPOINT_MANIFEST_FILENAME || entry.name === CHECKPOINT_MANIFEST_FILES_FILENAME
                    || entry.name.endsWith('.tmp') || entry.name.endsWith('.prev')) {
                    continue;
                }
                const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
                if (entry.isDirectory()) {
                    await walk(path.join(current, entry.name), relative);
                } else if (entry.isFile()) {
                    results.push(relative);
                }
            }
        };
        await walk(dir, '');
        return results;
    }
}
