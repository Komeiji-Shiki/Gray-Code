/**
 * 分支图版本迁移状态机（MIG-04）。
 *
 * 设计（对齐研究文档 3.4 节「旧数据迁移的幂等策略」第 4 条）：
 * - 迁移函数注册表：Map<fromVersion, step>，`migrateBranchGraph` 逐版本链式升级；
 *   每个 step 负责「从版本 v 的图 → 版本 v+1 的图」，框架在 step 返回后强制把
 *   graph.version 覆写为 v+1（step 无需也不应自行改 version，避免忘记/多写）。
 * - 幂等：graph.version 已等于目标版本 → 原样返回（migrated=false），不执行任何 step；
 *   同一图多次迁移得到同一结果（step 由注册方保证确定性）。
 * - 失败回滚：升级前对输入图深拷贝备份（JSON 序列化，图是纯数据）；每个 step 执行前
 *   再拷贝当前图。step 抛错时恢复备份并抛 BranchError('BRANCH_STORAGE_CORRUPT')——
 *   迁移发生在内存中、未落盘，恢复「原版本」等价于不持久化任何中间态；调用方
 *   （BranchGraphRepository.migrate / 未来 BranchService 接线）可选择重试或降级线性模式。
 * - 未知版本拒绝：version 非正整数、或高于目标版本（未来版本）→ 抛
 *   BRANCH_STORAGE_CORRUPT，绝不猜测式降级/改写。
 * - 可恢复中间状态：注册表按版本逐步注册，未来新增 v2→v3 时只需注册新 step，
 *   存量 v1 图仍可从 v1 一路链式升到最新（v1→v2→v3）。
 */

import {
    BRANCH_GRAPH_VERSION,
    BranchError,
    ConversationBranchGraph,
} from './types';

/** 迁移步骤：输入版本 v 的图，返回版本 v+1 的图（框架负责覆写 version 字段） */
export type BranchMigrationStep = (graph: ConversationBranchGraph) => ConversationBranchGraph;

/** 迁移注册表：fromVersion → 升级到 fromVersion+1 的步骤 */
const migrationSteps = new Map<number, BranchMigrationStep>();

/**
 * 注册一个迁移步骤（fromVersion → fromVersion+1）。
 * 同一 fromVersion 重复注册抛错（防止覆盖导致不可预期行为；测试用 unregister 清理）。
 */
export function registerBranchMigration(fromVersion: number, step: BranchMigrationStep): void {
    if (!Number.isInteger(fromVersion) || fromVersion < 1) {
        throw new Error(`invalid migration fromVersion: ${fromVersion}`);
    }
    if (migrationSteps.has(fromVersion)) {
        throw new Error(`migration step for version ${fromVersion} is already registered`);
    }
    migrationSteps.set(fromVersion, step);
}

/** 注销一个迁移步骤（测试清理 / 动态更新用） */
export function unregisterBranchMigration(fromVersion: number): void {
    migrationSteps.delete(fromVersion);
}

/** 已注册的迁移步骤起点版本列表（升序；供测试/诊断） */
export function getRegisteredBranchMigrationSteps(): number[] {
    return [...migrationSteps.keys()].sort((a, b) => a - b);
}

/** 当前支持的 branch graph 版本（与 types.ts 的 BRANCH_GRAPH_VERSION 同一真源） */
export function getCurrentBranchGraphVersion(): number {
    return BRANCH_GRAPH_VERSION;
}

/** 深拷贝（图是纯 JSON 数据，JSON 序列化即完整备份） */
function cloneGraphDeep(graph: ConversationBranchGraph): ConversationBranchGraph {
    return JSON.parse(JSON.stringify(graph)) as ConversationBranchGraph;
}

/** migrateBranchGraph 的返回结果 */
export interface BranchMigrationResult {
    /** 迁移后的图（未迁移时为原图引用） */
    graph: ConversationBranchGraph;
    /** 迁移前版本 */
    fromVersion: number;
    /** 迁移后版本 */
    toVersion: number;
    /** 是否实际执行了迁移（false = 版本已一致，原样返回） */
    migrated: boolean;
}

/**
 * 链式迁移分支图到目标版本（默认当前支持版本）。
 *
 * - graph.version === targetVersion → 原样返回（幂等）；
 * - graph.version > targetVersion（未来版本 / 显式降级目标）→ BRANCH_STORAGE_CORRUPT；
 * - graph.version 非正整数 → BRANCH_STORAGE_CORRUPT；
 * - 缺少某个版本的迁移步骤 → BRANCH_STORAGE_CORRUPT（不猜测）；
 * - 任一 step 抛错 → 恢复备份并抛 BranchError('BRANCH_STORAGE_CORRUPT')，
 *   输入图对象不被修改（调用方可继续按原版本使用/重试）。
 *
 * @param options.targetVersion 显式目标版本；缺省为当前支持版本（BRANCH_GRAPH_VERSION）。
 *   传入大于当前版本的未来目标需要对应 step 已注册（测试/分阶段灰度场景）。
 */
export function migrateBranchGraph(
    graph: ConversationBranchGraph,
    options: { targetVersion?: number } = {}
): BranchMigrationResult {
    const fromVersion = graph.version;
    if (!Number.isInteger(fromVersion) || fromVersion < 1) {
        throw new BranchError(
            'BRANCH_STORAGE_CORRUPT',
            `cannot migrate branch graph with invalid version: ${fromVersion}`
        );
    }
    const toVersion = options.targetVersion ?? BRANCH_GRAPH_VERSION;
    if (!Number.isInteger(toVersion) || toVersion < 1) {
        throw new BranchError('BRANCH_STORAGE_CORRUPT', `invalid migration target version: ${toVersion}`);
    }
    if (fromVersion === toVersion) {
        return { graph, fromVersion, toVersion, migrated: false };
    }
    if (fromVersion > toVersion) {
        throw new BranchError(
            'BRANCH_STORAGE_CORRUPT',
            `branch graph version ${fromVersion} is newer than supported version ${toVersion}; refusing to migrate`
        );
    }

    // 升级前深拷贝备份：任何 step 失败都不污染输入图（失败回滚的第一道防线）
    let current = cloneGraphDeep(graph);
    for (let version = fromVersion; version < toVersion; version++) {
        const step = migrationSteps.get(version);
        if (!step) {
            throw new BranchError(
                'BRANCH_STORAGE_CORRUPT',
                `no migration step registered from version ${version} to ${version + 1}`
            );
        }
        // 每步前备份当前中间态：step 抛错时恢复该备份（失败回滚第二道防线）
        const backup = cloneGraphDeep(current);
        try {
            const next = step(current);
            if (
                !next ||
                typeof next !== 'object' ||
                typeof next.nodes !== 'object' ||
                next.nodes === null ||
                Array.isArray(next.nodes)
            ) {
                throw new Error('migration step returned an invalid graph (missing nodes record)');
            }
            current = { ...next, version: version + 1 };
        } catch (error) {
            current = backup; // 恢复本步执行前的中间态（内存内，未落盘）
            throw new BranchError(
                'BRANCH_STORAGE_CORRUPT',
                `branch graph migration failed at step ${version} -> ${version + 1}: ${(error as Error)?.message ?? String(error)}`
            );
        }
    }
    return { graph: current, fromVersion, toVersion, migrated: true };
}
