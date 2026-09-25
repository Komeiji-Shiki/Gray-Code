/**
 * get_activity_stats 工具单元测试
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createGetActivityStatsTool } from '../../tools/activity/activity_stats';
import { createActivityStatsTool } from '../../tools/activity/activityRuntime';
import {
    ActivityStore,
    setGlobalActivityTracker,
    getGlobalActivityTracker,
    toDateStr
} from '../../modules/activity';

function localTime(date: Date, hour = 10, minute = 0): number {
    const d = new Date(date);
    d.setHours(hour, minute, 0, 0);
    return d.getTime();
}

describe('get_activity_stats tool', () => {
    let dir: string;
    let store: ActivityStore;

    beforeEach(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'graycode-activity-tool-'));
        store = new ActivityStore(dir);
        // 今天写入两段会话：10:00–10:02（2 分钟）与 12:00–12:01（1 分钟），中间隔 118 分钟空档
        const t = localTime(new Date(), 10, 0);
        await store.appendSample(t);
        await store.appendSample(t + 120_000);
        const t2 = localTime(new Date(), 12, 0);
        await store.appendSample(t2);
        await store.appendSample(t2 + 60_000);
        await store.flushDay();
        // 昨天写入一个采样
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const tY = localTime(yesterday, 14, 0);
        await store.appendSample(tY);
        await store.flushDay(toDateStr(tY));

        setGlobalActivityTracker({ getStore: () => store } as any);
    });

    afterEach(async () => {
        setGlobalActivityTracker(null);
        await fs.rm(dir, { recursive: true, force: true });
    });

    test('returns error when tracker is not initialized', async () => {
        setGlobalActivityTracker(null);
        const tool = createGetActivityStatsTool();
        const result = await tool.handler({});
        expect(result.success).toBe(false);
        expect(result.error).toContain('not initialized');
    });

    test('returns daily stats with readable local times by default (7d range)', async () => {
        const tool = createGetActivityStatsTool();
        const result = await tool.handler({});
        expect(result.success).toBe(true);

        const data = result.data;
        expect(data.today).not.toBeNull();
        expect(data.today.date).toBe(toDateStr(Date.now()));
        expect(data.today.totalMinutes).toBe(3);

        // daily 倒序且包含昨天
        expect(data.daily.length).toBe(7);
        expect(data.daily[0].date).toBe(toDateStr(Date.now()));
        const yesterdayDate = (() => {
            const y = new Date();
            y.setDate(y.getDate() - 1);
            return toDateStr(y.getTime());
        })();
        expect(data.daily[1].date).toBe(yesterdayDate);

        // 时间字符串格式 HH:mm
        expect(data.today.firstActiveAt).toMatch(/^\d{2}:\d{2}$/);

        // 默认不返回热力
        expect(data.hourlyHeatmap).toEqual([]);
    });

    test('lists the work blocks of a day so a break in between stays visible', async () => {
        const tool = createGetActivityStatsTool();
        const result = await tool.handler({});
        const data = result.data;

        // 两段会话分开列出：不会把 10:00 到 12:01 读成一段连续工作
        expect(data.today.sessions).toEqual(['10:00-10:02 (2m)', '12:00-12:01 (1m)']);
        // 空档即用户离开编辑器的时间
        expect(data.today.gaps).toEqual(['10:02-12:00 (118m)']);
        // today 与 daily[0] 是同一份数据
        expect(data.daily[0].sessions).toEqual(data.today.sessions);
        // 无时段的日子也给出空数组（与「不在明细窗口内」区分开）
        expect(data.daily[2].sessions).toEqual([]);
        // 空档只给最近一天
        expect(data.daily[1].gaps).toBeUndefined();
    });

    test('limits session detail to the most recent 7 days', async () => {
        const tool = createGetActivityStatsTool();
        const result = await tool.handler({ range: '30d' });
        expect(result.success).toBe(true);
        const data = result.data;

        expect(data.daily).toHaveLength(30);
        expect(data.daily[6].sessions).toBeDefined();
        expect(data.daily[7].sessions).toBeUndefined();
        expect(data.daily[7].gaps).toBeUndefined();
    });

    test('truncates a day with too many blocks and reports the omitted count', async () => {
        const manyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'graycode-activity-tool-many-'));
        const many = new ActivityStore(manyDir);
        try {
            // 30 段会话：00:00 起每 30 分钟一个采样（间隔大于 15 分钟即各自成段）
            const midnight = new Date();
            midnight.setHours(0, 0, 0, 0);
            for (let i = 0; i < 30; i++) {
                await many.appendSample(midnight.getTime() + i * 30 * 60_000);
            }
            await many.flushDay();
            setGlobalActivityTracker({ getStore: () => many } as any);

            const tool = createGetActivityStatsTool();
            const result = await tool.handler({});
            const data = result.data;

            expect(data.today.sessionCount).toBe(30);
            expect(data.today.sessions).toHaveLength(24);
            expect(data.today.sessionsOmitted).toBe(6);
        } finally {
            setGlobalActivityTracker({ getStore: () => store } as any);
            await fs.rm(manyDir, { recursive: true, force: true });
        }
    });

    test('returns hourly heatmap when includeHourly is true', async () => {
        const tool = createGetActivityStatsTool();
        const result = await tool.handler({ includeHourly: true });
        expect(result.success).toBe(true);
        const data = result.data;
        expect(data.hourlyHeatmap.length).toBe(7);
        // 今天 10 点应至少 2 分钟
        const todayRow = data.hourlyHeatmap[data.hourlyHeatmap.length - 1];
        expect(todayRow.hours[10]).toBeGreaterThanOrEqual(2);
    });

    test('returns monthly aggregates when includeMonthly is true', async () => {
        const tool = createGetActivityStatsTool();
        const result = await tool.handler({ includeMonthly: true });
        expect(result.success).toBe(true);
        const data = result.data;
        // 今天与昨天同月时只有 1 条月度，跨月则 2 条
        expect(data.monthly.length).toBeGreaterThanOrEqual(1);
        const totalMonthly = data.monthly.reduce((s: number, m: any) => s + m.totalMinutes, 0);
        const totalDaily = data.daily.reduce((s: number, d: any) => s + d.totalMinutes, 0);
        expect(totalMonthly).toBe(totalDaily);
    });

    test('respects range=today', async () => {
        const tool = createGetActivityStatsTool();
        const result = await tool.handler({ range: 'today' });
        expect(result.success).toBe(true);
        const data = result.data;
        expect(data.daily).toHaveLength(1);
        expect(data.daily[0].date).toBe(toDateStr(Date.now()));
    });

    test('respects range=30d', async () => {
        const tool = createGetActivityStatsTool();
        const result = await tool.handler({ range: '30d' });
        expect(result.success).toBe(true);
        expect(result.data.daily).toHaveLength(30);
    });

    test('falls back to 7d for invalid range', async () => {
        const tool = createGetActivityStatsTool();
        const result = await tool.handler({ range: 'invalid' });
        expect(result.success).toBe(true);
        expect(result.data.daily).toHaveLength(7);
    });

    test('global tracker accessor works', () => {
        expect(getGlobalActivityTracker()).not.toBeNull();
    });
});

/**
 * 展示层格式化测试：用注入的固定统计结果覆盖与当前时间无关的分支
 * （跨午夜会话的日期前缀、今日无数据）。
 */
describe('get_activity_stats tool display formatting', () => {
    test('a session started before midnight keeps its date', async () => {
        const startedAt = new Date(2026, 7, 5, 23, 40).getTime();
        const tool = createActivityStatsTool(async () => ({
            generatedAt: new Date(2026, 7, 6, 0, 10).getTime(),
            today: null,
            currentSession: { active: true, startedAt, minutes: 30 },
            daily: [],
            hourlyHeatmap: [],
            monthly: []
        }));

        const result = await tool.handler({});
        expect(result.success).toBe(true);
        expect(result.data.currentSession.startedAt).toBe('2026-08-05 23:40');
        // 今日无数据时为 null
        expect(result.data.today).toBeNull();
    });
});
