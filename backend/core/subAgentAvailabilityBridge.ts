/**
 * GrayCode - SubAgent 可用性查询桥接（backend/core 层）
 *
 * A1 依赖反转修复：backend/modules/channel/ToolDeclarationResolver 不再直接 import
 * backend/tools/subagents 的 hasAvailableSubAgent()（modules 层不允许依赖 tools 层
 * 运行时实现），改为经本 bridge 读取。
 *
 * core 不允许反向依赖 tools，因此这里不 import hasAvailableSubAgent 本身：
 * 只保存一个最小查询函数引用（() => boolean）。组合根（backend/bootstrap）在
 * 初始化阶段调用 setSubAgentAvailabilityQuery 注册 tools 层真实实现；未注册
 * （测试/独立调用路径）时 hasAvailableSubAgentSafe() 回退为 true。
 *
 * 回退值选择理由（行为零变化原则）：
 * - 生产路径：bootstrap 初始化阶段注册真实实现，行为与改造前直连完全一致；
 * - 真实实现（hasAvailableSubAgent）在全局 settingsManager 未注册时同样返回
 *   true：getSubAgentsSettings() 回退 { agents: [], maxConcurrentAgents: 3 }，
 *   generalWorkerEnabled 为 undefined → undefined !== false → true
 *   （General Worker 默认启用）。因此回退 true 与真实实现的「无设置」行为一致；
 * - 回退 false 会在未注册场景隐藏 subagents 工具（F-10 修复方向相反：F-10 正是
 *   防止 subagents 工具被错误隐藏），且现有 channel 测试均未 mock 该查询、
 *   声明列表不含 subagents 工具，true/false 都不影响测试结果；
 * - 综上：无法确认「无可用子代理」时选择宽松语义（不隐藏工具）——true。
 *
 * 测试覆盖：backend/__tests__/core/subAgentAvailabilityBridge.test.ts（契约测试：
 * 未注册回退 / 注册转发（含 false）/ 覆盖 / 清理 / 抛错传播）。
 */

export type SubAgentAvailabilityQuery = () => boolean;

let globalSubAgentAvailabilityQuery: SubAgentAvailabilityQuery | undefined;

/**
 * 注册 tools 层真实实现（hasAvailableSubAgent）。
 *
 * 调用方：backend/bootstrap 组合根（唯一允许依赖 tools 的地方），初始化阶段注册。
 * 传入 undefined 可清理（供测试隔离使用）。
 */
export function setSubAgentAvailabilityQuery(query: SubAgentAvailabilityQuery | undefined): void {
    globalSubAgentAvailabilityQuery = query;
}

/**
 * 读取已注册的查询函数；未注册（测试/独立调用路径）时返回 undefined。
 *
 * @internal 当前仓库内无消费方（0 引用），保留不删除以防外部消费者依赖；
 * 仅供测试断言/未来使用。
 */
export function getSubAgentAvailabilityQuery(): SubAgentAvailabilityQuery | undefined {
    return globalSubAgentAvailabilityQuery;
}

/**
 * 统一判断是否存在可用子代理（modules 层消费入口）。
 *
 * 桥已注册时委托 tools 层真实实现（与改造前直连语义一致）；
 * 未注册时回退 true（宽松：不隐藏 subagents 工具，见文件头理由）。
 */
export function hasAvailableSubAgentSafe(): boolean {
    const query = globalSubAgentAvailabilityQuery;
    return query ? query() : true;
}

