/**
 * get_activity_stats 工具单元测试
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createGetActivityStatsTool } from '../../tools/activity/activity_stats';
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
        // 今天写入两个采样（10:00 / 10:02，覆盖 2 分钟）
        const t = localTime(new Date(), 10, 0);
        await store.appendSample(t);
        await store.appendSample(t + 120_000);
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
        expect(data.today.totalMinutes).toBe(2);

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
