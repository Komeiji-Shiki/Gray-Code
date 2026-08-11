/**
 * BCP-06：存档引用计数扫描 + 清理器注册表（兼容导出壳，E1 解环）。
 *
 * E1 环解除（第五批模块化重构）后的角色变化：
 * - 实现（computeCheckpointReferenceCounts / CheckpointRefCountGraphSource /
 *   CheckpointRefCountCleaner / 全局注册表）已收敛到 conversation 侧桥接模块
 *   conversation/branch/checkpointCleanerBridge（引用计数扫描的数据源是 BranchGraph，
 *   归 conversation 域；cleaner 生产实现仍由 CheckpointManager 构造时经桥接注册，
 *   注册时机与语义不变）；
 * - 本文件保留为 checkpoint 域的兼容导出壳：既有导入路径
 *   （checkpoint/index.ts 门面、branchService.test.ts / checkpointRefCounts.test.ts）
 *   零改动，依赖方向收敛为单向 checkpoint → conversation。
 */

export {
    computeCheckpointReferenceCounts,
    setGlobalCheckpointRefCountCleaner,
    getGlobalCheckpointRefCountCleaner,
} from '../conversation/branch/checkpointCleanerBridge';
export type {
    CheckpointRefCountGraphSource,
    CheckpointRefCountCleaner,
} from '../conversation/branch/checkpointCleanerBridge';
