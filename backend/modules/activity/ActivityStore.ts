/**
 * GrayCode - 使用时间活动采样存储
 *
 * 按天文件存储：activity/YYYY-MM-DD.json，内容为 { date, samples: number[] }。
 * 内存缓存当天数据，flush 时原子写入（临时文件 + rename），避免写坏文件。
 *
 * 并发模型：所有公开读写方法经 runExclusive 串行排队——心跳与用户活动事件
 * 可能在同一时刻触发 append，且测试/统计会并发读取；不加锁时
 * 「先 loadDay 后改缓存」的间隙会导致采样互相覆盖丢失。
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type { DayActivityFile } from './types';
import { ACTIVITY_SAMPLE_DEDUP_MS } from './types';

/** 本地时区日期字符串 YYYY-MM-DD */
export function toDateStr(t: number): string {
    const d = new Date(t);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

export class ActivityStore {
    private readonly dir: string;

    /** 已加载的按天数据缓存：date -> samples（仅缓存最近读写过的天） */
    private readonly cache = new Map<string, number[]>();

    /** 自上次落盘后是否有新采样追加（无变化时 flush 直接跳过写盘） */
    private dirty = false;

    /** 串行锁链：公开方法排队执行；错误不中断链 */
    private chain: Promise<unknown> = Promise.resolve();

    constructor(dir: string) {
        this.dir = dir;
    }

    /** 将操作加入串行队列（内部方法不得再调用公开方法，避免锁内死锁） */
    private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
        const result = this.chain.then(fn);
        this.chain = result.then(
            () => undefined,
            () => undefined
        );
        return result;
    }

    /** 获取活动存储目录 */
    getDirectory(): string {
        return this.dir;
    }

    private dayFilePath(date: string): string {
        return path.join(this.dir, `${date}.json`);
    }

    private static isDayFile(name: string): boolean {
        return /^\d{4}-\d{2}-\d{2}\.json$/.test(name);
    }

    /**
     * 读取某天的采样（文件不存在返回空数组）。
     * 损坏文件不抛出：返回空并尽力删除坏文件，避免污染后续统计。
     */
    loadDay(date: string): Promise<number[]> {
        return this.runExclusive(() => this.loadDayUnlocked(date));
    }

    private async loadDayUnlocked(date: string): Promise<number[]> {
        const cached = this.cache.get(date);
        if (cached !== undefined) {
            return cached;
        }

        let samples: number[] = [];
        try {
            const raw = await fs.readFile(this.dayFilePath(date), 'utf-8');
            const parsed = JSON.parse(raw) as Partial<DayActivityFile>;
            if (parsed && Array.isArray(parsed.samples)) {
                samples = parsed.samples
                    .filter((t): t is number => typeof t === 'number' && Number.isFinite(t))
                    .sort((a, b) => a - b);
            }
        } catch (error: any) {
            if (error?.code !== 'ENOENT') {
                // 文件损坏：删除坏文件，按无数据处理（下次写入时重建）
                try {
                    await fs.rm(this.dayFilePath(date), { force: true });
                } catch {
                    // 忽略清理失败
                }
            }
        }

        this.cache.set(date, samples);
        return samples;
    }

    /**
     * 追加一个采样点（内存中，保持升序；与任一相邻采样间隔小于 DEDUP 窗口则跳过）。
     * 返回是否真正追加。
     */
    appendSample(t: number): Promise<boolean> {
        return this.runExclusive(() => this.appendSampleUnlocked(t));
    }

    private async appendSampleUnlocked(t: number): Promise<boolean> {
        const date = toDateStr(t);
        const samples = await this.loadDayUnlocked(date);

        // 线性定位插入位置（samples 通常有序且 t 是新的最大值，循环立即退出）
        let i = samples.length;
        while (i > 0 && samples[i - 1] > t) {
            i--;
        }
        // 与前后相邻采样去重（防系统时间回拨导致重复采样）
        if (i > 0 && t - samples[i - 1] < ACTIVITY_SAMPLE_DEDUP_MS) {
            return false;
        }
        if (i < samples.length && samples[i] - t < ACTIVITY_SAMPLE_DEDUP_MS) {
            return false;
        }

        samples.splice(i, 0, t);
        this.cache.set(date, samples);
        this.dirty = true;
        return true;
    }

    /**
     * 将某天（默认今天）的采样落盘。
     * 原子写入：先写临时文件再 rename。
     */
    flushDay(date?: string): Promise<void> {
        return this.runExclusive(() => this.flushDayUnlocked(date ?? toDateStr(Date.now())));
    }

    private async flushDayUnlocked(targetDate: string): Promise<void> {
        const samples = await this.loadDayUnlocked(targetDate);
        if (samples.length === 0) {
            return;
        }
        // 自上次落盘后没有新采样：文件内容未变化，跳过写盘
        // （空闲/暂停期间 flush 定时器仍会触发，避免每 2 分钟无谓地整文件重写 + rename）
        if (!this.dirty) {
            return;
        }

        await fs.mkdir(this.dir, { recursive: true });
        const filePath = this.dayFilePath(targetDate);
        const tmpPath = `${filePath}.tmp`;
        const content = JSON.stringify({ date: targetDate, samples });
        await fs.writeFile(tmpPath, content, 'utf-8');
        await fs.rename(tmpPath, filePath);
        this.dirty = false;
    }

    /**
     * 列出存储中的全部日期（YYYY-MM-DD，升序）。
     */
    listDays(): Promise<string[]> {
        return this.runExclusive(() => this.listDaysUnlocked());
    }

    private async listDaysUnlocked(): Promise<string[]> {
        try {
            const entries = await fs.readdir(this.dir);
            return entries
                .filter((name) => ActivityStore.isDayFile(name))
                .map((name) => name.slice(0, -'.json'.length))
                .sort();
        } catch {
            return [];
        }
    }

    /**
     * 读取最近 count 天（含今天，即使今天还没有文件）。
     * 返回按日期升序的采样列表。
     */
    loadRecentDays(count: number): Promise<Array<{ date: string; samples: number[] }>> {
        return this.runExclusive(async () => {
            const today = toDateStr(Date.now());
            const dates: string[] = [];
            // 从今天往前推 count 天
            const cursor = new Date();
            cursor.setHours(0, 0, 0, 0);
            for (let i = 0; i < count; i++) {
                dates.push(toDateStr(cursor.getTime()));
                cursor.setDate(cursor.getDate() - 1);
            }
            dates.reverse();

            const stored = new Set(await this.listDaysUnlocked());
            const result: Array<{ date: string; samples: number[] }> = [];
            for (const date of dates) {
                const samples = stored.has(date) || date === today
                    ? await this.loadDayUnlocked(date)
                    : [];
                result.push({ date, samples });
            }
            return result;
        });
    }

    /**
     * 读取存储中的全部日期（含今天），按日期升序。
     * 仅当查询全部历史时使用（每次读盘，勿在热路径调用）。
     */
    loadAllDays(): Promise<Array<{ date: string; samples: number[] }>> {
        return this.runExclusive(async () => {
            const dates = await this.listDaysUnlocked();
            const result: Array<{ date: string; samples: number[] }> = [];
            for (const date of dates) {
                result.push({ date, samples: await this.loadDayUnlocked(date) });
            }
            return result;
        });
    }
}
