/**
 * 维护工具模块（MIG-05 完整性检查）。
 *
 * - integrityCheck.ts：历史 / 存档 / 分支三类数据的只读一致性扫描，
 *   输出结构化报告（每类问题计数 + 示例），不自动修复。
 *
 * 命令入口接线（后续阶段）：
 * 1. 在 webview/handlers/ 或 extension.ts 注册 maintenance.runIntegrityCheck 命令；
 * 2. baseDir = StoragePathManager.getEffectiveDataPath()；
 *    checkpointsDir = CheckpointManager 实例的 checkpointsDir；
 *    branchValidator = (id) => getGlobalBranchService()?.validateActivePathMatchesHistory(id)。
 */

export * from './integrityCheck';
