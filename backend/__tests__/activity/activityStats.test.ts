/**
 * activityStats 聚合纯函数单元测试
 */

import {
    buildSessions,
    hourlyHeatmap,
    dayStats,
    currentSessionInfo,
    statsFromFiles,
    aggregateMonthly,
    getActivityStats
} from '../../modules/activity/activityStats';
import { ActivityStore, toDateStr } from '../../modules/activity/ActivityStore';
import { ACTIVITY_SESSION_GAP_MS } from '../../modules/activity/types';
import type { DayActivityFile } from '../../modules/activity/types';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

describe('buildSessions', () => {
    it('returns empty for no samples', () => {
        expect(buildSessions([])).toEqual([]);
    });

    it('keeps a single sample as a one-minute session', () => {
        expect(buildSessions([12345])).toEqual([{ start: 12345, end: 12345, minutes: 1 }]);
    });

    it('merges consecutive samples into one session with ceil minutes', () => {
        const base = Date.UTC(2026, 7, 6, 10, 0, 0);
        const samples = [base, base + 60_000, base + 120_000, base + 180_000];
        const sessions = buildSessions(samples);
        expect(sessions).toHaveLength(1);
        expect(sessions[0]).toEqual({ start: base, end: base + 180_000, minutes: 3 });
    });

    it('splits sessions when gap exceeds threshold', () => {
        const base = Date.UTC(2026, 7, 6, 10, 0, 0);
        const gap = ACTIVITY_SESSION_GAP_MS;
        // 间隔必须严格大于 gap 才断开（等于 gap 视为同一会话）
        const samples = [base, base + 60_000, base + gap + 60_001, base + gap + 120_001];
        const sessions = buildSessions(samples);
        expect(sessions).toHaveLength(2);
        expect(sessions[0]).toEqual({ start: base, end: base + 60_000, minutes: 1 });
        expect(sessions[1]).toEqual({ start: base + gap + 60_001, end: base + gap + 120_001, minutes: 1 });
    });

    it('treats samples exactly at the gap as the same session', () => {
        const base = 1000;
        const samples = [base, base + ACTIVITY_SESSION_GAP_MS];
        expect(buildSessions(samples)).toHaveLength(1);
    });
});

describe('hourlyHeatmap', () => {
    it('distributes session minutes across hour buckets (local time)', () => {
        // 10:59:30 → 11:01:30：覆盖 10 点 1 分钟 + 11 点 2 分钟
        const start = Date.UTC(2026, 7, 6, 10, 59, 30);
        const end = Date.UTC(2026, 7, 6, 11, 1, 30);
        const hours = hourlyHeatmap([{ start, end, minutes: 3 }]);
        expect(hours).toHaveLength(24);
        const localStartHour = new Date(start).getHours();
        const localEndHour = new Date(end).getHours();
        // 无论测试机时区，小时桶都落在本地时区的对应小时上
        expect(hours[localStartHour]).toBe(1);
        expect(hours[localEndHour]).toBe(2);
    });

    it('returns 24 zero buckets for empty sessions', () => {
        expect(hourlyHeatmap([])).toEqual(new Array(24).fill(0));
    });
});

describe('dayStats', () => {
    it('aggregates totalMinutes / sessionCount / first-last / hourly', () => {
        const base = Date.UTC(2026, 7, 6, 9, 0, 0);
        // 会话1：09:00-09:05（ceil(5min) = 5 分钟）；会话2：10:30-10:45（ceil(15min) = 15 分钟）
        const samples = [base, base + 60_000, base + 120_000, base + 300_000,
            base + 90 * 60_000, base + 91 * 60_000, base + 92 * 60_000, base + 105 * 60_000];
        const stats = dayStats('2026-08-06', samples);
        expect(stats.date).toBe('2026-08-06');
        expect(stats.sessionCount).toBe(2);
        expect(stats.totalMinutes).toBe(5 + 15);
        expect(stats.firstActiveAt).toBe(samples[0]);
        expect(stats.lastActiveAt).toBe(samples[samples.length - 1]);
        expect(stats.hourly).toHaveLength(24);
    });

    it('handles empty samples', () => {
        const stats = dayStats('2026-08-06', []);
        expect(stats.totalMinutes).toBe(0);
        expect(stats.sessionCount).toBe(0);
        expect(stats.firstActiveAt).toBeNull();
        expect(stats.lastActiveAt).toBeNull();
    });
});

describe('currentSessionInfo', () => {
    it('returns inactive for no samples', () => {
        expect(currentSessionInfo([], Date.now())).toEqual({ active: false, startedAt: null, minutes: 0 });
    });

    it('returns inactive when last sample is older than the gap', () => {
        const now = Date.UTC(2026, 7, 6, 12, 0, 0);
        const last = now - ACTIVITY_SESSION_GAP_MS - 60_000;
        expect(currentSessionInfo([last], now)).toEqual({ active: false, startedAt: null, minutes: 0 });
    });

    it('reports active session with minutes from session start', () => {
        const now = Date.UTC(2026, 7, 6, 12, 0, 0);
        const start = now - 90 * 60_000;
        // 会话持续 90 分钟：采样 15 分钟一个点（间隔 < gap）
        const samples: number[] = [];
        for (let m = 90; m >= 0; m -= 15) {
            samples.push(now - m * 60_000);
        }
        const info = currentSessionInfo(samples, now);
        expect(info.active).toBe(true);
        expect(info.startedAt).toBe(samples[0]);
        expect(info.minutes).toBe(90);
    });

    it('stops extending session at a gap (toilet break resets start)', () => {
        const now = Date.UTC(2026, 7, 6, 12, 0, 0);
        const oldStart = now - 5 * 60 * 60_000; // 5 小时前（与后续间隔远超 gap，独立会话）
        const recentStart = now - 10 * 60_000;
        // 最近段：-10min / -5min / now（间隔 5min < gap，同一会话）
        const samples = [oldStart, oldStart + 60_000, recentStart, recentStart + 5 * 60_000, now];
        const info = currentSessionInfo(samples, now);
        expect(info.active).toBe(true);
        expect(info.startedAt).toBe(recentStart);
        expect(info.minutes).toBe(10); // ceil((now - (now-10min)) / 1min)
    });
});

describe('aggregateMonthly', () => {
    it('groups daily stats by YYYY-MM and sums minutes/days/sessions (desc order)', () => {
        const base = Date.UTC(2026, 7, 6, 10, 0, 0);
        const daily = [
            dayStats('2026-08-06', [base, base + 60_000]),
            dayStats('2026-08-05', [base + 60_000, base + 120_000]),
            dayStats('2026-08-04', []),
            dayStats('2026-07-30', [base, base + 120_000])
        ];
        const monthly = aggregateMonthly(daily);
        expect(monthly.map((m) => m.month)).toEqual(['2026-08', '2026-07']);
        // 08-06 与 08-05 各 1 分钟（两采样间隔 60s → ceil(1min)），08-04 无数据
        expect(monthly[0]).toEqual({ month: '2026-08', totalMinutes: 2, activeDays: 2, sessionCount: 2 });
        // 07-30 两采样间隔 120s → 2 分钟
        expect(monthly[1]).toEqual({ month: '2026-07', totalMinutes: 2, activeDays: 1, sessionCount: 1 });
    });

    it('returns empty for no daily stats', () => {
        expect(aggregateMonthly([])).toEqual([]);
    });
});

describe('getActivityStats range handling', () => {
    let dir: string;
    let store: ActivityStore;

    /** 构造若干天前的本地时间戳（10:00） */
    function daysAgo(days: number): number {
        const d = new Date();
        d.setDate(d.getDate() - days);
        d.setHours(10, 0, 0, 0);
        return d.getTime();
    }

    beforeEach(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'graycode-activity-stats-'));
        store = new ActivityStore(dir);
        // 写入今天、40 天前、400 天前三个采样日
        for (const days of [0, 40, 400]) {
            const t = daysAgo(days);
            await store.appendSample(t);
            await store.appendSample(t + 120_000);
            // 按采样所属日期分别落盘（flushDay() 无参只写今天）
            await store.flushDay(toDateStr(t));
        }
    });

    afterEach(async () => {
        await fs.rm(dir, { recursive: true, force: true });
    });

    it('7d range only includes recent days', async () => {
        const result = await getActivityStats(store, { range: '7d' });
        expect(result.daily).toHaveLength(7);
        const active = result.daily.filter((d) => d.totalMinutes > 0);
        expect(active).toHaveLength(1); // 只有今天
    });

    it('90d range includes the 40-days-ago sample but not 400-days-ago', async () => {
        const result = await getActivityStats(store, { range: '90d' });
        const active = result.daily.filter((d) => d.totalMinutes > 0);
        expect(active).toHaveLength(2); // 今天 + 40 天前
    });

    it('365d range excludes 400-days-ago sample', async () => {
        const result = await getActivityStats(store, { range: '365d' });
        const active = result.daily.filter((d) => d.totalMinutes > 0);
        expect(active).toHaveLength(2);
    });

    it('all range includes every stored day with monthly aggregation', async () => {
        const result = await getActivityStats(store, { range: 'all', includeMonthly: true });
        const active = result.daily.filter((d) => d.totalMinutes > 0);
        expect(active).toHaveLength(3);
        // 三个月度（今天 / 40 天前 / 400 天前可能跨月）
        expect(result.monthly.length).toBeGreaterThanOrEqual(2);
        const totalMonthly = result.monthly.reduce((s, m) => s + m.totalMinutes, 0);
        const totalDaily = result.daily.reduce((s, d) => s + d.totalMinutes, 0);
        expect(totalMonthly).toBe(totalDaily);
    });

    it('includeMonthly=false returns empty monthly', async () => {
        const result = await getActivityStats(store, { range: 'all' });
        expect(result.monthly).toEqual([]);
    });
});

describe('statsFromFiles', () => {
    const base = Date.UTC(2026, 7, 6, 10, 0, 0);

    function makeFile(date: string, minutesAgo: number, lengthMinutes: number): DayActivityFile {
        const samples: number[] = [];
        for (let i = 0; i < lengthMinutes; i++) {
            samples.push(base - minutesAgo * 60_000 + i * 60_000);
        }
        return { date, samples };
    }

    it('builds daily stats (desc) + heatmap (asc) + today/currentSession', () => {
        const files = [
            makeFile('2026-08-04', 2 * 24 * 60, 30),
            makeFile('2026-08-05', 24 * 60, 60),
            makeFile('2026-08-06', 0, 45)
        ];
        // 当天最后采样 = base + 44 分钟；now 设为 base + 45 分钟（仍在会话内）
        const now = base + 45 * 60_000;
        const result = statsFromFiles(files, now);

        expect(result.today?.date).toBe('2026-08-06');
        // 45 个采样（1 分钟间隔）→ ceil(44min) = 44 分钟
        expect(result.today?.totalMinutes).toBe(44);
        // daily 倒序（最新在前）
        expect(result.daily.map((d) => d.date)).toEqual(['2026-08-06', '2026-08-05', '2026-08-04']);
        // heatmap 升序
        expect(result.hourlyHeatmap.map((r) => r.date)).toEqual(['2026-08-04', '2026-08-05', '2026-08-06']);
        // 当前会话跨最后一天持续
        expect(result.currentSession.active).toBe(true);
        expect(result.currentSession.startedAt).toBe(base);
        expect(result.currentSession.minutes).toBe(45);
    });

    it('returns empty daily for no files', () => {
        const result = statsFromFiles([], base);
        expect(result.today).toBeNull();
        expect(result.daily).toEqual([]);
        expect(result.hourlyHeatmap).toEqual([]);
        expect(result.currentSession.active).toBe(false);
    });
});
