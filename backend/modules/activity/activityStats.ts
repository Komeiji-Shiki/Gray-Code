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
        // 会话起点所在整分钟开始，逐分钟展开
        const startMinute = Math.floor(session.start / 60_000) * 60_000;
        const endMinute = Math.floor(session.end / 60_000) * 60_000;
        for (let m = startMinute; m <= endMinute; m += 60_000) {
            const d = new Date(m);
            hours[d.getHours()] += 1;
        }
    }
    return hours;
}

/** 单日统计（samples 应为该日升序采样） */
export function dayStats(date: string, samples: number[]): DayActivityStats {
    const sessions = buildSessions(samples);
    return {
        date,
        totalMinutes: sessions.reduce((sum, s) => sum + s.minutes, 0),
        sessionCount: sessions.length,
        sessions,
        firstActiveAt: samples.length > 0 ? samples[0] : null,
        lastActiveAt: samples.length > 0 ? samples[samples.length - 1] : null,
        hourly: hourlyHeatmap(sessions)
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

    // 最近 14 天采样拼接，用于当前连续会话判断（跨午夜不中断）
    const recentAll = recent.flatMap((day) => day.samples);

    const daily: DayActivityStats[] = [];
    for (const day of recent) {
        daily.push(dayStats(day.date, day.samples));
    }
    // 倒序：最新在前
    daily.reverse();

    const today = todayStr ? daily.find((d) => d.date === todayStr) ?? null : null;

    const includeHourly = query.includeHourly === true;
    const hourlyHeatmap = includeHourly
        ? recent.map((day) => ({ date: day.date, hours: dayStats(day.date, day.samples).hourly }))
        : [];

    const monthly = query.includeMonthly === true ? aggregateMonthly(daily) : [];

    return {
        generatedAt: now,
        today,
        currentSession: currentSessionInfo(recentAll, now),
        daily,
        hourlyHeatmap,
        monthly
    };
}

/** 把 DayActivityFile 列表转为统计（供存储无关的测试/工具使用） */
export function statsFromFiles(files: DayActivityFile[], now: number = Date.now()): ActivityStatsResult {
    const recent = [...files].sort((a, b) => a.date.localeCompare(b.date));
    const recentAll = recent.flatMap((f) => f.samples);
    const daily = [...recent].reverse().map((f) => dayStats(f.date, f.samples));
    const todayStr = recent.length > 0 ? recent[recent.length - 1].date : '';

    return {
        generatedAt: now,
        today: todayStr ? daily.find((d) => d.date === todayStr) ?? null : null,
        currentSession: currentSessionInfo(recentAll, now),
        daily,
        hourlyHeatmap: recent.map((f) => ({ date: f.date, hours: dayStats(f.date, f.samples).hourly })),
        monthly: aggregateMonthly(daily)
    };
}
