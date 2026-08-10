/**
 * GrayCode - 使用时间统计聚合
 *
 * 从原始采样点聚合出：
 * - 每日使用时长（分钟）与活跃会话明细
 * - 24 小时作息热力（每格 = 该小时活跃分钟数）
 * - 当前连续工作时长（进行中的会话）
 *
 * 纯函数逻辑与 VSCode 解耦，便于单元测试。
 */

import type {
    ActivitySession,
    ActivityStatsQuery,
    ActivityStatsResult,
    CurrentSessionInfo,
    DayActivityFile,
    DayActivityStats,
    MonthlyActivityStats
} from './types';
import { ACTIVITY_SESSION_GAP_MS } from './types';
import type { ActivityStore } from './ActivityStore';

/**
 * 把升序采样点合并为连续会话：
 * 相邻采样间隔 > gapMs 视为两个独立会话。
 * 会话时长 = (最后一个采样 - 第一个采样) 向上取整到分钟，至少 1 分钟。
 */
export function buildSessions(samples: number[], gapMs: number = ACTIVITY_SESSION_GAP_MS): ActivitySession[] {
    const sessions: ActivitySession[] = [];
    if (samples.length === 0) return sessions;

    let start = samples[0];
    let prev = samples[0];

    for (let i = 1; i < samples.length; i++) {
        const t = samples[i];
        if (t - prev > gapMs) {
            sessions.push(makeSession(start, prev));
            start = t;
        }
        prev = t;
    }
    sessions.push(makeSession(start, prev));
    return sessions;
}

function makeSession(start: number, end: number): ActivitySession {
    const minutes = Math.max(1, Math.ceil((end - start) / 60_000));
    return { start, end, minutes };
}

/**
 * 把会话展开为 24 格小时热力（本地时区）：
 * 会话覆盖的每一分钟，对应小时格 +1。
 */
export function hourlyHeatmap(sessions: ActivitySession[]): number[] {
    const hours = new Array<number>(24).fill(0);
    for (const session of sessions) {
        // 会话起点所在整分钟开始，按「本地时区」小时边界切块累加（每块最多 60 分钟），
        // 替代逐分钟展开：长会话从 O(分钟数) 降到 O(小时数)
        const startMinute = Math.floor(session.start / 60_000) * 60_000;
        const endMinute = Math.floor(session.end / 60_000) * 60_000;
        let m = startMinute;
        while (m <= endMinute) {
            // 本地时区小时起点（setMinutes(0,0,0)），而非 UTC 整点边界
            const hourStart = new Date(m).setMinutes(0, 0, 0);
            const hourEnd = hourStart + 3_600_000;
            // +1 分钟：endMinute 本身那一分钟也计入（与逐分钟展开语义一致）
            const blockEnd = Math.min(hourEnd, endMinute + 60_000);
            const minutes = Math.round((blockEnd - m) / 60_000);
            hours[new Date(m).getHours()] += minutes;
            m = hourEnd;
        }
    }
    return hours;
}

/** 单日统计（samples 应为该日升序采样；includeHourly=false 时惰性跳过热力计算） */
export function dayStats(date: string, samples: number[], includeHourly: boolean = true): DayActivityStats {
    return dayStatsFromSessions(date, samples, buildSessions(samples), includeHourly);
}

/** dayStats 内部实现：复用已算好的 sessions，避免同一批采样重复 buildSessions */
function dayStatsFromSessions(
    date: string,
    samples: number[],
    sessions: ActivitySession[],
    includeHourly: boolean
): DayActivityStats {
    return {
        date,
        totalMinutes: sessions.reduce((sum, s) => sum + s.minutes, 0),
        sessionCount: sessions.length,
        sessions,
        firstActiveAt: samples.length > 0 ? samples[0] : null,
        lastActiveAt: samples.length > 0 ? samples[samples.length - 1] : null,
        hourly: includeHourly ? hourlyHeatmap(sessions) : []
    };
}

/**
 * 当前连续工作会话：
 * 取最近一天（含今天）的采样，若距最后采样不超过 gapMs 且最后采样在
 * 近 2 倍 gap 内（防止读旧数据误判为"正在工作"），则视为进行中。
 */
export function currentSessionInfo(
    recentSamples: number[],
    now: number = Date.now(),
    gapMs: number = ACTIVITY_SESSION_GAP_MS
): CurrentSessionInfo {
    if (recentSamples.length === 0) {
        return { active: false, startedAt: null, minutes: 0 };
    }

    const last = recentSamples[recentSamples.length - 1];
    // 最后采样距今超过 gapMs：会话已结束
    if (now - last > gapMs) {
        return { active: false, startedAt: null, minutes: 0 };
    }

    // 从最后采样向前合并同一会话的起点
    let sessionStart = last;
    for (let i = recentSamples.length - 2; i >= 0; i--) {
        if (sessionStart - recentSamples[i] <= gapMs) {
            sessionStart = recentSamples[i];
        } else {
            break;
        }
    }

    return {
        active: true,
        startedAt: sessionStart,
        minutes: Math.max(1, Math.ceil((now - sessionStart) / 60_000))
    };
}

/** 把每日统计按 YYYY-MM 聚合为月度统计（输入顺序不限，输出按月份倒序） */
export function aggregateMonthly(daily: DayActivityStats[]): MonthlyActivityStats[] {
    const byMonth = new Map<string, MonthlyActivityStats>();
    for (const d of daily) {
        const month = d.date.slice(0, 7); // YYYY-MM
        let entry = byMonth.get(month);
        if (!entry) {
            entry = { month, totalMinutes: 0, activeDays: 0, sessionCount: 0 };
            byMonth.set(month, entry);
        }
        if (d.totalMinutes > 0) {
            entry.totalMinutes += d.totalMinutes;
            entry.activeDays++;
        }
        entry.sessionCount += d.sessionCount;
    }
    return [...byMonth.values()].sort((a, b) => b.month.localeCompare(a.month));
}

/** 解析查询范围 → 需要加载的天数（'all' 返回 Infinity） */
function rangeToDays(range: NonNullable<ActivityStatsQuery['range']>): number {
    switch (range) {
        case 'today': return 1;
        case '30d': return 30;
        case '90d': return 90;
        case '365d': return 365;
        case 'all': return Infinity;
        case '7d':
        default: return 7;
    }
}

/**
 * 汇总统计结果。
 *
 * @param store 活动存储
 * @param query 查询参数
 * @param now   当前时间（测试注入）
 */
export async function getActivityStats(
    store: ActivityStore,
    query: ActivityStatsQuery = {},
    now: number = Date.now()
): Promise<ActivityStatsResult> {
    const range = query.range ?? '7d';
    const days = rangeToDays(range);

    const recent = days === Infinity
        ? await store.loadAllDays()
        : await store.loadRecentDays(days);
    const todayStr = recent.length > 0 ? recent[recent.length - 1].date : '';

    // 当前连续会话判断只取最近 2 天采样拼接（跨午夜不中断）；
    // range='all' 时不把数年采样全量复制进内存（只用到最后一段）
    const recentAll = recent.slice(-2).flatMap((day) => day.samples);

    const includeHourly = query.includeHourly === true;
    const daily: DayActivityStats[] = [];
    const hourlyRows: Array<{ date: string; hours: number[] }> = [];
    // 每天的 sessions 只算一次：daily 统计与 hourlyHeatmap 复用（避免同一批采样重复 buildSessions）
    for (const day of recent) {
        const sessions = buildSessions(day.samples);
        // daily 统计自身不需要热力（hourlyHeatmap 单独按需计算），惰性跳过
        daily.push(dayStatsFromSessions(day.date, day.samples, sessions, false));
        if (includeHourly) {
            hourlyRows.push({ date: day.date, hours: hourlyHeatmap(sessions) });
        }
    }
    // 倒序：最新在前
    daily.reverse();

    // today 语义：今日无活跃会话时返回 null（与类型注释一致），
    // 而非全零对象——前端据此区分「今天没数据」与「今天活跃 0 分钟」
    const todayEntry = todayStr ? daily.find((d) => d.date === todayStr) ?? null : null;
    const today = todayEntry && todayEntry.sessions.length > 0 ? todayEntry : null;

    const monthly = query.includeMonthly === true ? aggregateMonthly(daily) : [];

    return {
        generatedAt: now,
        today,
        currentSession: currentSessionInfo(recentAll, now),
        daily,
        hourlyHeatmap: hourlyRows,
        monthly
    };
}

/** 把 DayActivityFile 列表转为统计（供存储无关的测试/工具使用） */
export function statsFromFiles(files: DayActivityFile[], now: number = Date.now()): ActivityStatsResult {
    const recent = [...files].sort((a, b) => a.date.localeCompare(b.date));
    // 与 getActivityStats 一致：当前会话只取最近 2 天采样拼接（跨午夜不中断），
    // 不把全部历史采样全量复制进内存（历史数据可能长达数年）
    const recentAll = recent.slice(-2).flatMap((f) => f.samples);
    // 每天的 sessions 只算一次：daily 与 hourlyHeatmap 复用
    const daily: DayActivityStats[] = [];
    const hourlyRows: Array<{ date: string; hours: number[] }> = [];
    for (const f of recent) {
        const sessions = buildSessions(f.samples);
        daily.push(dayStatsFromSessions(f.date, f.samples, sessions, true));
        hourlyRows.push({ date: f.date, hours: hourlyHeatmap(sessions) });
    }
    daily.reverse();
    const todayStr = recent.length > 0 ? recent[recent.length - 1].date : '';

    const todayEntry = todayStr ? daily.find((d) => d.date === todayStr) ?? null : null;
    return {
        generatedAt: now,
        today: todayEntry && todayEntry.sessions.length > 0 ? todayEntry : null,
        currentSession: currentSessionInfo(recentAll, now),
        daily,
        hourlyHeatmap: hourlyRows,
        monthly: aggregateMonthly(daily)
    };
}
