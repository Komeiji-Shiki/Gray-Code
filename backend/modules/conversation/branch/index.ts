/**
 * 树状分支模块（第五阶段 BR-03/04/08 底座 + BR-05/06/07/09 接线 + MIG-04 版本迁移）。
 *
 * - types.ts：ConversationBranchGraph / ConversationBranchNode / BranchErrorCode 等类型
 * - BranchGraph.ts：纯函数图运算（BR-08，可单测；含 importLinearHistory 线性导入）
 * - BranchGraphRepository.ts：branches.json 读写 / 原子替换 / 损坏降级（BR-04）/
 *   版本迁移入口 migrate（MIG-04）
 * - BranchMigration.ts：迁移函数注册表 + migrateBranchGraph 链式升级（MIG-04）
 * - BranchService.ts：业务编排（BR-06 读写删接口 / BR-07 会话写锁 / BR-05 调试校验 /
 *   BR-09 跨对话分支建模）
 */

export * from './types';
export * from './BranchGraph';
export * from './BranchGraphRepository';
export * from './BranchMigration';
export * from './BranchService';
