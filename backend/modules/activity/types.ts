/**
 * GrayCode - 使用时间统计模块类型定义
 *
 * 数据模型：按天文件存储活跃采样时间戳（毫秒），
 * 采样来源为 ActivityTracker 的心跳 + 用户活动事件。
 */

/** 单日活跃采样文件格式（activity/YYYY-MM-DD.json） */
export interface DayActivityFile {
    /** 本地时区日期，格式 YYYY-MM-DD */
    date: string;
    /** 活跃时刻的毫秒时间戳，升序、去重（同一秒只保留一条） */
    samples: number[];
}

/** 一个连续活跃会话（采样间隔不超过 SESSION_GAP 的连续段） */
export interface ActivitySession {
    /** 会话开始毫秒时间戳 */
    start: number;
    /** 会话结束毫秒时间戳（最后一个采样点） */
    end: number;
    /** 会话时长（分钟，向上取整，至少 1） */
    minutes: number;
}

/** 单日统计结果 */
export interface DayActivityStats {
    /** 本地时区日期 YYYY-MM-DD */
    date: string;
    /** 当日活跃总分钟数 */
    totalMinutes: number;
    /** 当日活跃会话数 */
    sessionCount: number;
    /** 活跃会话明细（sessions 按 start 升序） */
    sessions: ActivitySession[];
    /** 当日首个活跃时刻（无数据为 null） */
    firstActiveAt: number | null;
    /** 当日最后一个活跃时刻（无数据为 null） */
    lastActiveAt: number | null;
    /** 24 格作息热力：hours[h] = 该小时内活跃分钟数（本地时区） */
    hourly: number[];
}

/** 当前进行中的连续工作会话 */
export interface CurrentSessionInfo {
    /** 是否有进行中的会话（距最后采样不超过 SESSION_GAP） */
    active: boolean;
    /** 会话开始毫秒时间戳（无进行中会话为 null） */
    startedAt: number | null;
    /** 已连续工作分钟数 */
    minutes: number;
}

/** 时间统计整体结果（AI 工具 / webview 页面共用） */
export interface ActivityStatsResult {
    /** 生成时间（毫秒时间戳） */
    generatedAt: number;
    /** 今日统计（今日无数据为 null） */
    today: DayActivityStats | null;
    /** 当前连续工作会话（今日无采样时仍可能基于最近采样计算） */
    currentSession: CurrentSessionInfo;
    /** 每日统计（含今日），按日期倒序（最新在前） */
    daily: DayActivityStats[];
    /** 作息热力（仅查询 includeHourly 时填充），按日期升序 */
    hourlyHeatmap: Array<{ date: string; hours: number[] }>;
    /** 按月聚合（仅查询 includeMonthly 时填充），按月份倒序（最新在前） */
    monthly: MonthlyActivityStats[];
}

/** 统计查询参数 */
export interface ActivityStatsQuery {
    /** 统计范围，默认 '7d' */
    range?: 'today' | '7d' | '30d' | '90d' | '365d' | 'all';
    /** 是否返回 24 小时作息热力（按天粒度），默认 false */
    includeHourly?: boolean;
    /** 是否返回按月聚合统计（每日数据太多时前端用），默认 false */
    includeMonthly?: boolean;
}

/** 按月聚合的使用时间统计 */
export interface MonthlyActivityStats {
    /** 月份 YYYY-MM */
    month: string;
    /** 当月活跃总分钟数 */
    totalMinutes: number;
    /** 当月有活跃记录的天数 */
    activeDays: number;
    /** 当月活跃会话总数 */
    sessionCount: number;
}

// ─── 采集与聚合常量 ──────────────────────────────

/** 心跳采样间隔：窗口聚焦时每 60 秒记录一个采样点 */
export const ACTIVITY_HEARTBEAT_MS = 60 * 1000;

/** 空闲判定阈值：连续 5 分钟无任何用户活动事件则暂停心跳（视为离开） */
export const ACTIVITY_IDLE_MS = 5 * 60 * 1000;

/** 会话断开阈值：相邻采样间隔超过 15 分钟视为两个独立会话 */
export const ACTIVITY_SESSION_GAP_MS = 15 * 60 * 1000;

/** 内存采样落盘间隔：每 2 分钟落盘一次（失焦/停用时立即落盘） */
export const ACTIVITY_FLUSH_INTERVAL_MS = 2 * 60 * 1000;

/** 采样去重窗口：同一秒内的多次事件只保留一条采样 */
export const ACTIVITY_SAMPLE_DEDUP_MS = 1000;
