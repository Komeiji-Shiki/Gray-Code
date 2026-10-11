/**
 * GrayCode - 使用时间统计模块
 *
 * 保存宿主采集的活跃时间，
 * 按天文件持久化，提供每日时长 / 作息热力 / 连续工作会话统计，
 * 供 AI 工具（get_activity_stats）与前端用量页使用。
 */

export { ActivityStore, toDateStr } from './ActivityStore';
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

