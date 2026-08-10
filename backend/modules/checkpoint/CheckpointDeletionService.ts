/**
 * CheckpointDeletionService - 检查点删除族（第二批拆分）。
 *
 * 从 CheckpointManager 收敛的 4 个删除方法（deleteCheckpointInternal /
 * deleteCheckpointsFromIndexInternal / deleteCheckpointsBatch /
 * deleteCheckpointsByNodeIds），方法体原样平移，纯重构：
 * - 「强制保留祖先闭包」统一复用 computeForcedKeepIds（原
 *   deleteCheckpointsFromIndexInternal 内联复制了一份相同闭包逻辑，现收敛为同一实现）；
 * - isSafeCheckpointDirName 校验（CP-DEL-1）、引用计数闸门（deleteCheckpointsByNodeIds）、
 *   级联/「写回成功后才删盘」语义与旧实现完全一致；
 * - 锁（CheckpointOperationLock）获取位置随方法体平移（batch/byNodeIds 原方法内获取），
 *   无锁 Internal 版仍由调用方保证已持有工作区级存档锁。
 *
 * 依赖经 deps 注入（conversationManager / manifestRepository / checkpointsDir /
 * 删除锁 ID / 操作进度注册表 / 取消错误判定），避免反向引用 CheckpointManager
 * 造成运行时循环依赖。
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type { ConversationManager } from '../conversation/ConversationManager';
import type {
    BatchCheckpointDeleteItem,
    BatchCheckpointDeleteResult,
    CheckpointOperationProgress,
    CheckpointRecord
} from './types';
import { CheckpointManifestRepository, isSafeCheckpointDirName } from './CheckpointManifestRepository';
import { checkpointOperationLockManager } from './CheckpointOperationLock';
import { throwIfAborted } from './checkpointConcurrency';

/**
 * BCP-06：计算「必须保留」的存档 ID 祖先闭包（CP-05 逻辑抽取，纯函数）。
 *
 * 从所有 keepIds（本次删除集合之外的保留记录）向前遍历完整 baseCheckpointId 祖先链：
 * 被保留记录直接或间接依赖的祖先都不能删（否则保留记录恢复时断链）。
 * 返回集合包含 keepIds 自身 + 全部祖先。
 *
 * 复用方：deleteCheckpointInternal / deleteCheckpointsFromIndexInternal /
 * deleteCheckpointsBatch（CP-05）/ deleteCheckpointsByNodeIds（BCP-06 引用计数删除合并），
 * 保证「引用计数归零但被增量链引用为 base」的存档同样被拒绝。
 */
export function computeForcedKeepIds(
    records: readonly CheckpointRecord[],
    keepIds: ReadonlySet<string>
): Set<string> {
    const byId = new Map(records.map(cp => [cp.id, cp] as const));
    const forcedKeep = new Set<string>();
    for (const cp of records) {
        if (!keepIds.has(cp.id)) {
            continue;
        }
        forcedKeep.add(cp.id);
        let baseId = cp.baseCheckpointId;
        while (baseId && !forcedKeep.has(baseId)) {
            forcedKeep.add(baseId);
            baseId = byId.get(baseId)?.baseCheckpointId;
        }
    }
    return forcedKeep;
}

/** CheckpointDeletionService 依赖（由 CheckpointManager 构造时注入） */
export interface CheckpointDeletionServiceDeps {
    conversationManager: ConversationManager;
    manifestRepository: CheckpointManifestRepository;
    checkpointsDir: string;
    /** 工作区级删除锁 ID（有工作区时沿用工作区锁，无工作区时退回全局存储虚拟键；由壳层计算） */
    getDeletionLockIds: () => string[];
    /** 注册删除操作进度/取消句柄（壳层 operations 注册表；batch 使用） */
    beginOperation: (
        kind: CheckpointOperationProgress['kind'],
        conversationId?: string,
        checkpointId?: string
    ) => { operationId: string; signal: AbortSignal; report: (patch: Partial<CheckpointOperationProgress>) => CheckpointOperationProgress | null };
    /** 结束删除操作（壳层 operations 注册表） */
    endOperation: (operationId: string) => void;
    /** 文件写锁获取被取消的普通 Error 判定（M4/CP-LOCK-1，壳层私有方法） */
    isFileLockCancellationError: (error: unknown) => boolean;
}

/**
 * 检查点删除服务
 */
export class CheckpointDeletionService {
    constructor(private readonly deps: CheckpointDeletionServiceDeps) {}

    /**
     * 无锁删除检查点（调用方必须已持有工作区级存档锁）。
     *
     * 供 cleanupOldCheckpoints 等锁内链路复用：createCheckpoint 的锁内
     * 清理旧存档时若再走公开方法，会以不同 ownerId 等待自己持有的锁而死锁。
     */
    async deleteCheckpointInternal(conversationId: string, checkpointId: string): Promise<boolean> {
        // 元数据更新（读-判-算保留集合）在链内原子完成；磁盘删除放在写回成功之后，
        // 此时竞态窗口已收敛，不会出现「读到旧列表 → 删磁盘 → 覆盖他人新写入」的丢记录场景。
        let backupDirToDelete: string | undefined;
        try {
            const result = await this.deps.conversationManager.updateCustomMetadata(conversationId, 'checkpoints', current => {
                const list = Array.isArray(current) ? current as CheckpointRecord[] : [];
                const checkpoint = list.find(cp => cp.id === checkpointId);
                if (!checkpoint) {
                    return current; // 不存在：原引用=无变更跳过写回
                }
                // CP-DEL-1: 损坏/恶意元数据中的 backupDir 可能越界（如 `../../victim`），
                // 绝不把未校验目录名交给 fs.rm(recursive)——拒绝删除并告警，记录保留。
                if (!isSafeCheckpointDirName(checkpoint.backupDir)) {
                    console.warn(`[CheckpointManager] Refusing to delete checkpoint ${checkpointId}: unsafe backupDir ${checkpoint.backupDir}`);
                    return current;
                }
                // CP-05: 被其他检查点引用为基快照时拒绝删除（返回原引用=无变更跳过写回），
                // 否则会破坏增量链，恢复时 chainBroken 100% 失败。
                // 口径与 deleteCheckpointsBatch / deleteCheckpointsByNodeIds 统一：
                // computeForcedKeepIds 祖先闭包（含间接引用）——直接引用检查只覆盖一层，
                // 链 A→B→C 删除 C 时 A 只被 B 间接依赖，闭包口径保证与批量删除的
                // 强制保留集合一致。
                const keepIds = new Set(list.filter(cp => cp.id !== checkpointId).map(cp => cp.id));
                if (computeForcedKeepIds(list, keepIds).has(checkpointId)) {
                    return current;
                }
                backupDirToDelete = checkpoint.backupDir;
                return list.filter(cp => cp.id !== checkpointId);
            });
            void result;
        } catch (err) {
            // C-17: 元数据写回失败是真实存储/IO 错误（区别于「记录不存在/被拒绝」返回 false 的
            // 正常路径），显式记录后返回 false，不冒泡；调用方据此区分「不存在」与「IO 失败」。
            console.error(`[CheckpointManager] Failed to delete checkpoint ${checkpointId} (metadata write failed):`, err);
            return false;
        }

        if (backupDirToDelete === undefined) {
            // 未删除：记录不存在 / 被引用为基快照 / backupDir 越界（以上路径已分别处理或告警）
            return false;
        }

        // CPF-01: 目录删除后清掉 manifest 缓存，避免后续读旧数据
        this.deps.manifestRepository.clearCache(backupDirToDelete);

        // 删除备份目录（写回成功后才删）
        const backupPath = path.join(this.deps.checkpointsDir, backupDirToDelete);
        try {
            await fs.rm(backupPath, { recursive: true, force: true });
        } catch (err) {
            // 元数据已移除；磁盘目录残留为孤儿目录，不影响增量链正确性，但必须记录以便排查
            console.warn(`[CheckpointManager] Failed to remove backup dir ${backupDirToDelete}:`, err);
        }

        return true;
    }

    /**
     * 无锁版 deleteCheckpointsFromIndex（调用方必须已持有工作区级存档锁）。
     */
    async deleteCheckpointsFromIndexInternal(conversationId: string, fromIndex: number, excludeCheckpointId?: string): Promise<number> {
        try {
            // 计算与写回在链内原子完成（基于最新列表），磁盘删除放在写回成功之后
            let toDelete: CheckpointRecord[] = [];
            let backupDirsToDelete: string[] = [];
            await this.deps.conversationManager.updateCustomMetadata(conversationId, 'checkpoints', current => {
                const checkpoints = Array.isArray(current) ? current as CheckpointRecord[] : [];
                const byId = new Map(checkpoints.map(cp => [cp.id, cp] as const));

                // 需要保留的检查点 ID 集合：目标检查点及其增量基链（否则保留的检查点会因基快照被删而无法恢复）
                // + 消息索引在保留区间内（messageIndex < fromIndex）的节点。
                const keepIds = new Set<string>();
                if (excludeCheckpointId) {
                    let cur = byId.get(excludeCheckpointId);
                    while (cur && !keepIds.has(cur.id)) {
                        keepIds.add(cur.id);
                        cur = cur.baseCheckpointId ? byId.get(cur.baseCheckpointId) : undefined;
                    }
                }
                for (const cp of checkpoints) {
                    if (cp.messageIndex < fromIndex) {
                        keepIds.add(cp.id);
                    }
                }

                // CP-IDX-1: 祖先闭包——从所有保留节点向前遍历完整祖先链，被依赖的基快照
                // 即使消息索引 >= fromIndex 也强制保留。
                // 编辑/回档/重试会让消息索引回退：B(index=10) → 截断对话 → 重试产生
                // R(index=3, base=B) → 再次截断到 fromIndex=4 时，仅按索引判断会删 B 而留 R →
                // R 的 baseCheckpointId 悬空（chainBroken 且无法修复）。
                // 闭包与 deleteCheckpointsBatch 的 CP-05 口径一致。
                const forcedKeep = computeForcedKeepIds(checkpoints, keepIds);

                // 筛选出需要删除的检查点（消息索引 >= fromIndex、不在保留闭包中、backupDir 安全）
                toDelete = checkpoints.filter(cp => {
                    if (cp.messageIndex < fromIndex || forcedKeep.has(cp.id)) {
                        return false;
                    }
                    // CP-DEL-1: 未校验目录名绝不删除（记录保留 + 告警）
                    if (!isSafeCheckpointDirName(cp.backupDir)) {
                        console.warn(`[CheckpointManager] Refusing to delete checkpoint ${cp.id}: unsafe backupDir ${cp.backupDir}`);
                        return false;
                    }
                    return true;
                });
                if (toDelete.length === 0) {
                    return current; // 无变更，跳过写回
                }
                backupDirsToDelete = toDelete.map(cp => cp.backupDir);
                // 保留：索引保留区 + 强制保留闭包 + backupDir 越界被拒绝删除的记录
                const toDeleteIds = new Set(toDelete.map(cp => cp.id));
                return checkpoints.filter(cp => !toDeleteIds.has(cp.id));
            });

            // 删除备份目录（写回成功后才删）；失败只留孤儿目录，不影响增量链正确性
            for (const backupDir of backupDirsToDelete) {
                // CPF-01: 目录删除后清掉 manifest 缓存
                this.deps.manifestRepository.clearCache(backupDir);
                const backupPath = path.join(this.deps.checkpointsDir, backupDir);
                try {
                    await fs.rm(backupPath, { recursive: true, force: true });
                } catch (err) {
                    console.warn(`[CheckpointManager] Failed to remove backup dir ${backupDir}:`, err);
                }
            }
            
            return toDelete.length;
            
        } catch (err) {
            console.error('[CheckpointManager] Failed to delete checkpoints from index:', err);
            return 0;
        }
    }

    /**
     * 批量删除多个对话的检查点（支持跨对话）
     *
     * 遵循与单删一致的增量链保护规则：被「不在本次删除集合内」的检查点
     * 引用为基快照（baseCheckpointId）时，拒绝删除该检查点；
     * 批量删除整条链（基与后继都在删除集合内）时不受此限制。
     *
     * @param items 每个对话的删除请求；checkpointIds 为空数组时表示删除该对话全部检查点
     */
    async deleteCheckpointsBatch(items: BatchCheckpointDeleteItem[]): Promise<BatchCheckpointDeleteResult[]> {
        const results: BatchCheckpointDeleteResult[] = [];

        for (const item of items) {
            const result: BatchCheckpointDeleteResult = {
                conversationId: item.conversationId,
                deletedIds: [],
                rejectedIds: [],
                success: false
            };

            // M7: 每个对话注册进度/取消句柄（设置页批量删除可展示进度并取消）
            const { operationId, signal, report } = this.deps.beginOperation('delete', item.conversationId);
            try {
                await checkpointOperationLockManager.runExclusive(
                    this.deps.getDeletionLockIds(),
                    'delete',
                    `checkpoint:${item.conversationId}:delete-batch:${operationId}`,
                    async () => {
                        // 计算与写回在链内原子完成；磁盘删除放在写回成功之后
                        let backupDirsToDelete: string[] = [];
                        await this.deps.conversationManager.updateCustomMetadata(item.conversationId, 'checkpoints', current => {
                            const list = Array.isArray(current) ? current as CheckpointRecord[] : [];
                            if (list.length === 0) {
                                return current; // 无变更，跳过写回
                            }

                            // 空 ID 列表 = 删除该对话全部检查点
                            const deleteSet = new Set(
                                item.checkpointIds.length === 0 ? list.map(cp => cp.id) : item.checkpointIds
                            );

                            // CP-05: 闭包计算强制保留集合（BCP-06 抽取为 computeForcedKeepIds）——
                            // 从所有保留节点向前遍历完整祖先链，被保留节点直接或间接依赖的祖先
                            // 都不能删（否则保留节点恢复时断链）。
                            // 旧实现只检查一层直接引用：链 A→B→C 删除 {A,B} 时 A 被删而 B 保留 → B 断链。
                            const keepIds = new Set(list.filter(cp => !deleteSet.has(cp.id)).map(cp => cp.id));
                            const forcedKeep = computeForcedKeepIds(list, keepIds);

                            // 请求删除但被强制保留的 ID 全部拒绝，并返回给前端展示原因
                            const rejectedIds = new Set<string>();
                            for (const id of deleteSet) {
                                if (forcedKeep.has(id)) rejectedIds.add(id);
                            }

                            // CP-DEL-1: backupDir 越界的记录绝不删除（进 rejectedIds 上报前端 + 告警）
                            const toDelete = [...deleteSet].filter(id => !rejectedIds.has(id));
                            for (const id of toDelete) {
                                const cp = list.find(c => c.id === id);
                                if (cp && !isSafeCheckpointDirName(cp.backupDir)) {
                                    console.warn(`[CheckpointManager] Refusing to delete checkpoint ${id}: unsafe backupDir ${cp.backupDir}`);
                                    rejectedIds.add(id);
                                }
                            }

                            result.rejectedIds = [...rejectedIds];
                            const safeToDelete = toDelete.filter(id => !rejectedIds.has(id));
                            if (safeToDelete.length === 0) {
                                return current; // 无变更，跳过写回
                            }

                            result.deletedIds = safeToDelete;
                            backupDirsToDelete = safeToDelete
                                .map(id => list.find(cp => cp.id === id)?.backupDir)
                                .filter((dir): dir is string => !!dir);

                            return list.filter(cp => !safeToDelete.includes(cp.id));
                        });

                        // 删除备份目录（写回成功后才删）；失败只留孤儿目录，不影响增量链正确性
                        report({ phase: 'deleting', processed: 0, total: backupDirsToDelete.length });
                        let deletedCount = 0;
                        for (const backupDir of backupDirsToDelete) {
                            throwIfAborted(signal);
                            // CPF-01: 目录删除后清掉 manifest 缓存
                            this.deps.manifestRepository.clearCache(backupDir);
                            const backupPath = path.join(this.deps.checkpointsDir, backupDir);
                            try {
                                await fs.rm(backupPath, { recursive: true, force: true });
                                deletedCount++;
                            } catch (err) {
                                console.warn(`[CheckpointManager] Failed to remove backup dir ${backupDir}:`, err);
                            }
                            report({ processed: deletedCount });
                        }
                        report({ phase: signal.aborted ? 'cancelled' : 'done', cancelled: signal.aborted });

                        result.success = true;
                    },
                    signal
                );
            } catch (err) {
                // M4: 等待文件写锁期间被取消 → 取消结果（不冒泡）
                if (signal.aborted || this.deps.isFileLockCancellationError(err)) {
                    report({ phase: 'cancelled', cancelled: true });
                } else {
                    console.error(`[CheckpointManager] Failed to delete checkpoints batch for ${item.conversationId}:`, err);
                    report({ phase: 'failed', cancelled: false });
                }
            } finally {
                this.deps.endOperation(operationId);
            }

            results.push(result);
        }

        return results;
    }

    /**
     * BCP-06：按分支节点删除存档（引用计数删除——BranchService purge/prune 物理清理后的联动入口）。
     *
     * 候选 = 本对话中 messageNodeId ∈ nodeIds 的存档记录；旧存档无 messageNodeId 不匹配 → 不误删。
     * 三重拒绝闸门（按序合并进 rejectedIds）：
     * 1. 引用计数：options.referenceCounts 中 refCount > 0 的候选拒绝（仍被其他存活分支节点引用），
     *    除非 options.force = true（force 只跳过引用计数闸门，不跳过链保护）;
     *    缺省 referenceCounts 时跳过本闸门（退化为研究 §5.4 的 nodeId 清理语义，仅链保护）；
     * 2. CP-05 祖先闭包：即使 refCount === 0，被保留存档引用为 base（增量链依赖）的候选也拒绝——
     *    与 deleteCheckpointsBatch 的 rejectedIds 语义合并（BCP-07：增量链共享不因引用计数删除破坏）;
     * 3. CP-DEL-1：backupDir 越界的记录拒绝（绝不把未校验目录名交给 fs.rm）。
     *
     * 写回/删盘与 deleteCheckpointsBatch 同路径：updateCustomMetadata 链内原子写回，
     * 写回成功后才删除备份目录；失败只留孤儿目录，不影响增量链正确性。
     * 锁：工作区级存档锁（delete），调用方必须从会话锁之外发起（锁序约束见 BranchService 头注释）。
     */
    async deleteCheckpointsByNodeIds(
        conversationId: string,
        nodeIds: string[],
        options?: { force?: boolean; referenceCounts?: Map<string, number> }
    ): Promise<BatchCheckpointDeleteResult> {
        const result: BatchCheckpointDeleteResult = {
            conversationId,
            deletedIds: [],
            rejectedIds: [],
            success: false,
        };
        if (!Array.isArray(nodeIds) || nodeIds.length === 0) {
            result.success = true;
            return result;
        }
        try {
            await checkpointOperationLockManager.runExclusive(
                this.deps.getDeletionLockIds(),
                'delete',
                `checkpoint:${conversationId}:delete-by-node-ids:${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                async () => {
                    // 计算与写回在链内原子完成；磁盘删除放在写回成功之后（与 deleteCheckpointsBatch 一致）
                    let backupDirsToDelete: string[] = [];
                    await this.deps.conversationManager.updateCustomMetadata(conversationId, 'checkpoints', current => {
                        const list = Array.isArray(current) ? current as CheckpointRecord[] : [];
                        if (list.length === 0) {
                            result.success = true;
                            return current; // 无变更，跳过写回
                        }

                        const nodeIdSet = new Set(nodeIds);
                        // 候选：messageNodeId 精确匹配被移除节点（旧存档无 messageNodeId → 不误删）
                        const candidates = list.filter(
                            cp => cp.messageNodeId !== undefined && nodeIdSet.has(cp.messageNodeId)
                        );
                        if (candidates.length === 0) {
                            result.success = true;
                            return current; // 无变更，跳过写回
                        }
                        const candidateIds = new Set(candidates.map(cp => cp.id));
                        const rejectedIds = new Set<string>();

                        // 闸门 1：引用计数（refCount>0 → 拒绝，除非 force）
                        const referenceCounts = options?.referenceCounts;
                        if (!options?.force && referenceCounts) {
                            for (const id of candidateIds) {
                                if ((referenceCounts.get(id) ?? 0) > 0) {
                                    rejectedIds.add(id);
                                }
                            }
                        }

                        // 闸门 2：CP-05 祖先闭包（被保留存档引用为 base → 拒绝，即使 refCount 0）
                        const keepIds = new Set(
                            list.filter(cp => !candidateIds.has(cp.id)).map(cp => cp.id)
                        );
                        const forcedKeep = computeForcedKeepIds(list, keepIds);
                        for (const id of candidateIds) {
                            if (forcedKeep.has(id)) {
                                rejectedIds.add(id);
                            }
                        }

                        // 闸门 3：CP-DEL-1 backupDir 越界 → 拒绝 + 告警
                        const toDelete = [...candidateIds].filter(id => !rejectedIds.has(id));
                        for (const id of toDelete) {
                            const cp = list.find(c => c.id === id);
                            if (cp && !isSafeCheckpointDirName(cp.backupDir)) {
                                console.warn(`[CheckpointManager] Refusing to delete checkpoint ${id}: unsafe backupDir ${cp.backupDir}`);
                                rejectedIds.add(id);
                            }
                        }

                        result.rejectedIds = [...rejectedIds];
                        const safeToDelete = toDelete.filter(id => !rejectedIds.has(id));
                        if (safeToDelete.length === 0) {
                            result.success = true;
                            return current; // 无变更，跳过写回
                        }

                        result.deletedIds = safeToDelete;
                        backupDirsToDelete = safeToDelete
                            .map(id => list.find(cp => cp.id === id)?.backupDir)
                            .filter((dir): dir is string => !!dir);
                        return list.filter(cp => !safeToDelete.includes(cp.id));
                    });

                    // 删除备份目录（写回成功后才删）；失败只留孤儿目录，不影响增量链正确性
                    for (const backupDir of backupDirsToDelete) {
                        // CPF-01: 目录删除后清掉 manifest 缓存
                        this.deps.manifestRepository.clearCache(backupDir);
                        const backupPath = path.join(this.deps.checkpointsDir, backupDir);
                        try {
                            await fs.rm(backupPath, { recursive: true, force: true });
                        } catch (err) {
                            console.warn(`[CheckpointManager] Failed to remove backup dir ${backupDir}:`, err);
                        }
                    }
                    result.success = true;
                }
            );
        } catch (err) {
            console.error('[CheckpointManager] Failed to delete checkpoints by node ids:', err);
        }
        return result;
    }
}
