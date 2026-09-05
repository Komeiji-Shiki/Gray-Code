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

    /**
     * 内存中有未落盘修改的日期集合（appendSample 标记，flushDay 落盘后清除）。
     * 解决跨午夜采样丢失：所有落盘路径只 flush 今天，某天最后一次 flush 之后追加的
     * 采样没有任何代码路径为其落盘——脏日期集合保证任意一天的未落盘采样都会在
     * 下次 flush 时一并持久化；loadRecentDays/loadAllDays 清理缓存时也跳过脏日期，
     * 避免未落盘采样随缓存一起丢失。
     */
    private readonly dirtyDates = new Set<string>();

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
        // 返回拷贝：缓存数组是内部状态，外部读取方修改会污染后续统计
        return this.runExclusive(async () => [...await this.loadDayUnlocked(date)]);
    }

    private async loadDayUnlocked(date: string): Promise<number[]> {
        const cached = this.cache.get(date);
        if (cached !== undefined) {
            return cached;
        }

        let raw: string;
        try {
            raw = await fs.readFile(this.dayFilePath(date), 'utf-8');
        } catch (error: unknown) {
            // I/O 失败不等于内容损坏：保留文件且不缓存空值，后续读取仍可重试。
            if ((error as { code?: string } | null)?.code !== 'ENOENT') {
                throw error;
            }
            const empty: number[] = [];
            this.cache.set(date, empty);
            return empty;
        }

        let samples: number[] = [];
        try {
            const parsed = JSON.parse(raw) as Partial<DayActivityFile>;
            if (!parsed || !Array.isArray(parsed.samples)) {
                // 合法 JSON 但结构不符（samples 缺失/非数组）：同样视为坏文件，走下方删除重建路径
                throw new Error('day activity file has invalid structure');
            }
            samples = parsed.samples
                .filter((t): t is number => typeof t === 'number' && Number.isFinite(t))
                .sort((a, b) => a - b);
            // 加载时按 DEDUP 窗口去重：磁盘文件可能来自并发写/手工编辑，
            // 间隔 < 1000ms 的重复采样会高估时长，与 appendSample 的窗口语义一致
            const deduped: number[] = [];
            for (const t of samples) {
                if (deduped.length === 0 || t - deduped[deduped.length - 1] >= ACTIVITY_SAMPLE_DEDUP_MS) {
                    deduped.push(t);
                }
            }
            samples = deduped;
        } catch {
            // 已成功读取、但 JSON 或数据结构损坏：沿用重建坏文件的行为。
            try {
                await fs.rm(this.dayFilePath(date), { force: true });
            } catch {
                // 忽略清理失败
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
        this.dirtyDates.add(date);
        return true;
    }

    /**
     * 将某天（默认今天）的采样落盘。
     * 原子写入：先写临时文件再 rename。
     */
    flushDay(date?: string): Promise<void> {
        return this.runExclusive(() => this.flushDayUnlocked(date ?? toDateStr(Date.now())));
    }

    /** 上次落盘时各天的采样签名（date -> samples.join），无变化时跳过写盘 */
    private readonly lastFlushedSignatures = new Map<string, string>();

    private async flushDayUnlocked(targetDate: string): Promise<void> {
        // 目标日期 + 所有脏日期一并落盘：跨午夜后「昨天」的采样不再有专属 flush 路径，
        // 若只写今天，昨天最后一次 flush（最多 2 分钟前）之后追加的采样将永久丢失。
        const dates = new Set<string>(this.dirtyDates);
        dates.add(targetDate);
        for (const date of dates) {
            const samples = await this.loadDayUnlocked(date);
            if (samples.length === 0) {
                this.dirtyDates.delete(date);
                continue;
            }

            // 无变化跳过写盘：采样未变时每 2 分钟的定时 flush 不应重复全量写文件
            const signature = samples.join(',');
            if (this.lastFlushedSignatures.get(date) === signature) {
                this.dirtyDates.delete(date);
                continue;
            }

            await fs.mkdir(this.dir, { recursive: true });
            const filePath = this.dayFilePath(date);
            const tmpPath = `${filePath}.tmp`;
            const content = JSON.stringify({ date, samples });
            await fs.writeFile(tmpPath, content, 'utf-8');
            await fs.rename(tmpPath, filePath);
            this.lastFlushedSignatures.set(date, signature);
            this.dirtyDates.delete(date);
        }
        // lastFlushedSignatures 只保留「将来还可能落盘」的日期签名：采样仅经
        // appendSample 追加（会标记 dirtyDates），既不在脏日期集合、也不是目标日期
        // 的旧条目（跨午夜后的前一天等）不再有任何 flush 路径会用到其签名——
        // 删除，避免 Map 随运行时长无界增长。
        for (const date of this.lastFlushedSignatures.keys()) {
            if (date !== targetDate && !this.dirtyDates.has(date)) {
                this.lastFlushedSignatures.delete(date);
            }
        }
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
     * @param now 基准时间（测试注入；默认 Date.now()），与 getActivityStats 的 now 一致
     */
    loadRecentDays(count: number, now: number = Date.now()): Promise<Array<{ date: string; samples: number[] }>> {
        return this.runExclusive(async () => {
            const today = toDateStr(now);
            const dates: string[] = [];
            // 从今天往前推 count 天
            const cursor = new Date(now);
            cursor.setHours(0, 0, 0, 0);
            for (let i = 0; i < count; i++) {
                dates.push(toDateStr(cursor.getTime()));
                cursor.setDate(cursor.getDate() - 1);
            }
            dates.reverse();

            const stored = new Set(await this.listDaysUnlocked());
            const result: Array<{ date: string; samples: number[] }> = [];
            for (const date of dates) {
                // 脏日期（未落盘）也应从内存读取，否则统计会漏掉跨午夜后未落盘的采样
                const samples = stored.has(date) || date === today || this.dirtyDates.has(date)
                    ? [...await this.loadDayUnlocked(date)]
                    : [];
                result.push({ date, samples });
            }
            // 与 loadAllDays 一致：非今天的天用后即弃，避免 loadRecentDays(365) 把一整年驻留内存缓存；
            // 脏日期（内存有未落盘修改）保留缓存直到 flush 落盘——否则未落盘采样随缓存一起丢失
            for (const date of dates) {
                if (date !== today && !this.dirtyDates.has(date)) {
                    this.cache.delete(date);
                }
            }
            return result;
        });
    }

    /**
     * 读取存储中的全部日期（含今天与内存中未落盘的脏日期），按日期升序。
     * 仅当查询全部历史时使用（每次读盘，勿在热路径调用）。
     * @param now 基准时间（测试注入；默认 Date.now()），与 getActivityStats 的 now 一致
     */
    loadAllDays(now: number = Date.now()): Promise<Array<{ date: string; samples: number[] }>> {
        return this.runExclusive(async () => {
            const dates = await this.listDaysUnlocked();
            // 与 loadRecentDays 一致：全量范围也含今天（今天尚未落盘时内存有采样）
            const today = toDateStr(now);
            if (!dates.includes(today)) {
                dates.push(today);
                dates.sort();
            }
            // 合并内存中未落盘的脏日期：range='all' 统计不应漏掉它们
            for (const date of this.dirtyDates) {
                if (!dates.includes(date)) {
                    dates.push(date);
                    dates.sort();
                }
            }
            const result: Array<{ date: string; samples: number[] }> = [];
            for (const date of dates) {
                result.push({ date, samples: [...await this.loadDayUnlocked(date)] });
            }
            // 全量扫描用后即弃：range='all' 会读数年天文件，不把它们长期滞留内存缓存；
            // 脏日期保留缓存直到 flush 落盘（理由同 loadRecentDays）
            for (const date of dates) {
                if (date !== today && !this.dirtyDates.has(date)) {
                    this.cache.delete(date);
                }
            }
            return result;
        });
    }
}
