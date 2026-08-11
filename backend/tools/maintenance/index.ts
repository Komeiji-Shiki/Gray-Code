/**
 * 维护工具模块（MIG-05 完整性检查）。
 *
 * - integrityCheck.ts：历史 / 存档 / 分支三类数据的只读一致性扫描，
 *   输出结构化报告（每类问题计数 + 示例），不自动修复。
 *
 * 命令入口接线（已落地，见 commands.ts 与 backend/bootstrap/index.ts initMaintenanceCommands）：
 * - graycode.runIntegrityCheck 经 registerMaintenanceCommands 注册（commands.ts），
 *   由组合根 BackendRuntime.initMaintenanceCommands() 在扩展激活时调用，
 *   结果输出到专用 OutputChannel（'GrayCode: Integrity Check'），只报告不修复；
 * - baseDir = StoragePathManager.getEffectiveDataPath()；
 *   checkpointsDir = CheckpointManager 实例的 checkpointsDir；
 *   branchValidator = (id) => getGlobalBranchService()?.validateActivePathMatchesHistory(id)。
 */

export * from './integrityCheck';
