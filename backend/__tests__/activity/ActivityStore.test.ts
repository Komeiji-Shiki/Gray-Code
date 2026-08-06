/**
 * ActivityStore 按天文件存储单元测试
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ActivityStore, toDateStr } from '../../modules/activity/ActivityStore';

/** 构造某天本地时区 10:00 的时间戳（避开午夜时区边界） */
function localTime(date: Date, hour = 10, minute = 0): number {
    const d = new Date(date);
    d.setHours(hour, minute, 0, 0);
    return d.getTime();
}

describe('ActivityStore', () => {
    let dir: string;
    let store: ActivityStore;

    beforeEach(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'graycode-activity-store-'));
        store = new ActivityStore(dir);
    });

    afterEach(async () => {
        await fs.rm(dir, { recursive: true, force: true });
    });

    describe('toDateStr', () => {
        it('formats local date as YYYY-MM-DD', () => {
            const t = localTime(new Date(2026, 7, 6), 10, 0);
            expect(toDateStr(t)).toBe('2026-08-06');
        });
    });

    describe('appendSample / loadDay', () => {
        it('appends samples in order', async () => {
            const t = localTime(new Date(), 10, 0);
            expect(await store.appendSample(t)).toBe(true);
            expect(await store.appendSample(t + 60_000)).toBe(true);
            const samples = await store.loadDay(toDateStr(t));
            expect(samples).toEqual([t, t + 60_000]);
        });

        it('deduplicates samples within the same second', async () => {
            const t = localTime(new Date(), 10, 0);
            await store.appendSample(t);
            expect(await store.appendSample(t + 500)).toBe(false);
            const samples = await store.loadDay(toDateStr(t));
            expect(samples).toHaveLength(1);
        });

        it('keeps samples sorted even when appended out of order', async () => {
            const t = localTime(new Date(), 10, 0);
            await store.appendSample(t + 120_000);
            await store.appendSample(t + 60_000);
            const samples = await store.loadDay(toDateStr(t));
            expect(samples).toEqual([t + 60_000, t + 120_000]);
        });

        it('returns empty array for missing day', async () => {
            expect(await store.loadDay('2026-01-01')).toEqual([]);
        });
    });

    describe('flushDay', () => {
        it('persists samples to disk (round-trip via new store instance)', async () => {
            const date = toDateStr(localTime(new Date(), 10, 0));
            const t = localTime(new Date(), 10, 0);
            await store.appendSample(t);
            await store.appendSample(t + 60_000);
            await store.flushDay(date);

            const filePath = path.join(dir, `${date}.json`);
            const raw = await fs.readFile(filePath, 'utf-8');
            expect(JSON.parse(raw)).toEqual({ date, samples: [t, t + 60_000] });

            // 新实例从磁盘读取
            const fresh = new ActivityStore(dir);
            expect(await fresh.loadDay(date)).toEqual([t, t + 60_000]);
        });

        it('flushDay() without arg flushes today', async () => {
            const t = localTime(new Date(), 10, 0);
            await store.appendSample(t);
            await store.flushDay();
            const filePath = path.join(dir, `${toDateStr(t)}.json`);
            await expect(fs.access(filePath)).resolves.toBeUndefined();
        });

        it('does not create a file when there are no samples', async () => {
            await store.flushDay('2026-01-01');
            await expect(fs.access(path.join(dir, '2026-01-01.json'))).rejects.toThrow();
        });

        it('recovers from a corrupted file (returns empty and removes it)', async () => {
            const date = '2026-01-02';
            await fs.mkdir(dir, { recursive: true });
            await fs.writeFile(path.join(dir, `${date}.json`), '{ not valid json', 'utf-8');
            expect(await store.loadDay(date)).toEqual([]);
            // 坏文件被删除，可重新写入
            await store.appendSample(Date.now());
            // 注意 appendSample 写入的是今天，不是坏文件日期；直接验证坏文件已被清理
            await expect(fs.access(path.join(dir, `${date}.json`))).rejects.toThrow();
        });
    });

    describe('listDays / loadRecentDays', () => {
        it('lists only YYYY-MM-DD.json files in ascending order', async () => {
            await fs.mkdir(dir, { recursive: true });
            await fs.writeFile(path.join(dir, '2026-08-05.json'), '{}', 'utf-8');
            await fs.writeFile(path.join(dir, '2026-08-06.json'), '{}', 'utf-8');
            await fs.writeFile(path.join(dir, 'notes.txt'), 'x', 'utf-8');
            expect(await store.listDays()).toEqual(['2026-08-05', '2026-08-06']);
        });

        it('loadRecentDays returns count days ending today, filling missing days with empty', async () => {
            const today = new Date();
            const yesterday = new Date(today);
            yesterday.setDate(yesterday.getDate() - 1);
            const twoDaysAgo = new Date(today);
            twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);

            const tYesterday = localTime(yesterday, 10, 0);
            await store.appendSample(tYesterday);
            await store.flushDay(toDateStr(tYesterday));

            const recent = await store.loadRecentDays(7);
            expect(recent).toHaveLength(7);
            expect(recent[recent.length - 1].date).toBe(toDateStr(today.getTime()));
            expect(recent[recent.length - 1].samples).toEqual([]);
            expect(recent[recent.length - 2].date).toBe(toDateStr(tYesterday));
            expect(recent[recent.length - 2].samples).toEqual([tYesterday]);
            // 更早的天（两天前）无文件 → 空
            expect(recent[recent.length - 3].date).toBe(toDateStr(twoDaysAgo.getTime()));
            expect(recent[recent.length - 3].samples).toEqual([]);
        });
    });
});
