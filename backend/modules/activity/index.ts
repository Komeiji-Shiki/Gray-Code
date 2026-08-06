/**
 * GrayCode - 使用时间统计模块
 *
 * 采集用户在 VS Code 中的活跃时间（心跳 + 活动事件），
 * 按天文件持久化，提供每日时长 / 作息热力 / 连续工作会话统计，
 * 供 AI 工具（get_activity_stats）与前端用量页使用。
 */

export { ActivityStore, toDateStr } from './ActivityStore';
import { ActivityTracker } from './ActivityTracker';
export { ActivityTracker };
export {
    buildSessions,
    hourlyHeatmap,
    dayStats,
    currentSessionInfo,
    getActivityStats,
    aggregateMonthly,
    statsFromFiles
} from './activityStats';

export type {
    DayActivityFile,
    ActivitySession,
    DayActivityStats,
    CurrentSessionInfo,
    ActivityStatsResult,
    ActivityStatsQuery,
    MonthlyActivityStats
} from './types';

export {
    ACTIVITY_HEARTBEAT_MS,
    ACTIVITY_IDLE_MS,
    ACTIVITY_SESSION_GAP_MS,
    ACTIVITY_FLUSH_INTERVAL_MS,
    ACTIVITY_SAMPLE_DEDUP_MS
} from './types';

// ─── 全局单例访问器（供 AI 工具等无上下文入口访问） ───

let _tracker: ActivityTracker | null = null;

/** 设置全局 ActivityTracker 实例 */
export function setGlobalActivityTracker(tracker: ActivityTracker | null): void {
    _tracker = tracker;
}

/** 获取全局 ActivityTracker 实例（未初始化返回 null） */
export function getGlobalActivityTracker(): ActivityTracker | null {
    return _tracker;
}

// ─── AI 工作打点便捷函数（供流式/工具/子代理等热路径调用，null 安全） ───

/** AI 工作信号（chunk/事件到达）：视为用户在场 */
export function markAiActive(): void {
    _tracker?.markAiActive();
}

/** AI 开始一段工作（模型生成 / 工具执行 / 子代理运行） */
export function beginAiWork(): void {
    _tracker?.beginAiWork();
}

/** AI 结束一段工作 */
export function endAiWork(): void {
    _tracker?.endAiWork();
}
