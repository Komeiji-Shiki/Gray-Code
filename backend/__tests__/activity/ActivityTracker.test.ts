/**
 * ActivityTracker 采样行为单元测试（使用 vscode mock + fake timers）
 *
 * 覆盖：启动采样、心跳采样、事件驱动采样、空闲暂停、活动恢复、
 *       失焦暂停/聚焦恢复、dispose 落盘。
 */

import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ActivityTracker } from '../../modules/activity/ActivityTracker';
import { ActivityStore, toDateStr } from '../../modules/activity/ActivityStore';

jest.useFakeTimers();

/** 触发 mock 注册的文档编辑事件（markActive） */
function fireDocumentChange(): void {
    const handler = (vscode.workspace.onDidChangeTextDocument as unknown as jest.Mock).mock.calls[0][0];
    handler();
}

/** 触发 mock 注册的窗口状态事件 */
function fireWindowState(focused: boolean): void {
    const handler = (vscode.window.onDidChangeWindowState as unknown as jest.Mock).mock.calls[0][0];
    handler({ focused });
}

/** 等待 store 串行队列上的 pending 操作全部完成 */
async function settle(): Promise<void> {
    // appendSample 是 fire-and-forget；连续 await 两次保证排在链尾的操作已完成
    await Promise.resolve();
    await Promise.resolve();
}

/** 用真实定时器重试删除目录（Windows 上文件句柄未释放时 rm 会 ENOTEMPTY） */
async function removeDir(dir: string): Promise<void> {
    for (let i = 0; i < 10; i++) {
        try {
            await fs.rm(dir, { recursive: true, force: true });
            return;
        } catch {
            await new Promise((r) => setTimeout(r, 50));
        }
    }
}

describe('ActivityTracker', () => {
    let dir: string;
    let tracker: ActivityTracker;
    let store: ActivityStore;

    beforeEach(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'graycode-activity-tracker-'));
        tracker = new ActivityTracker(dir);
        store = tracker.getStore();
        (vscode.window.state as { focused: boolean }).focused = true;
        jest.clearAllMocks();
        tracker.start();
    });

    afterEach(async () => {
        // 先落盘再清理：dispose 的 flush 是 fire-and-forget，直接 rm 会撞上写入中的文件
        await tracker.flush();
        tracker.dispose();
        // 再次 flush 排队在 dispose 的 flush 之后，await 它即等链上空闲
        await tracker.flush();
        jest.useRealTimers();
        await removeDir(dir);
        jest.useFakeTimers();
        jest.clearAllTimers();
    });

    async function todaySamples(): Promise<number[]> {
        return await store.loadDay(toDateStr(Date.now()));
    }

    it('samples immediately on start when window is focused', async () => {
        expect(await todaySamples()).toHaveLength(1);
    });

    it('samples on heartbeat while focused and active', async () => {
        const initial = (await todaySamples()).length;
        jest.advanceTimersByTime(60_000);
        expect(await todaySamples()).toHaveLength(initial + 1);
    });

    it('samples immediately on user activity events', async () => {
        const initial = (await todaySamples()).length;
        // 推进 2 秒，避免与 start 采样落在同一去重窗口（1s）内
        jest.advanceTimersByTime(2_000);
        fireDocumentChange();
        await settle();
        expect(await todaySamples()).toHaveLength(initial + 1);
    });

    it('pauses heartbeat after idle timeout and resumes on user activity', async () => {
        const initial = (await todaySamples()).length;
        // 推进 7 分钟：前 5 次心跳（60s~300s，未超 5 分钟空闲线）采样，
        // 第 6 次心跳（360s）超过空闲线 → 暂停
        jest.advanceTimersByTime(7 * 60_000);
        const afterIdle = (await todaySamples()).length;
        expect(afterIdle).toBe(initial + 5);

        // 暂停后不再有心跳采样
        jest.advanceTimersByTime(3 * 60_000);
        expect(await todaySamples()).toHaveLength(afterIdle);

        // 用户回来（编辑事件）→ 恢复采样
        fireDocumentChange();
        await settle();
        const resumed = (await todaySamples()).length;
        expect(resumed).toBe(afterIdle + 1);

        // 恢复后心跳继续
        jest.advanceTimersByTime(60_000);
        expect(await todaySamples()).toHaveLength(resumed + 1);
    });

    it('pauses sampling on window blur and resumes on focus', async () => {
        const initial = (await todaySamples()).length;

        fireWindowState(false);
        jest.advanceTimersByTime(3 * 60_000);
        // 失焦期间不采样（loadDay 走内存缓存，count 不变）
        expect(await todaySamples()).toHaveLength(initial);

        fireWindowState(true);
        await settle();
        expect(await todaySamples()).toHaveLength(initial + 1);

        // 聚焦后心跳恢复
        jest.advanceTimersByTime(60_000);
        expect(await todaySamples()).toHaveLength(initial + 2);
    });

    it('deduplicates burst events within the same second', async () => {
        const initial = (await todaySamples()).length;
        // 与 start 采样错开去重窗口，验证 burst 内部去重为 1 个
        jest.advanceTimersByTime(2_000);
        fireDocumentChange();
        fireDocumentChange();
        fireDocumentChange();
        await settle();
        expect(await todaySamples()).toHaveLength(initial + 1);
    });

    it('flushes samples to disk on dispose', async () => {
        jest.advanceTimersByTime(120_000);
        await tracker.flush();
        tracker.dispose();

        const date = toDateStr(Date.now());
        const filePath = path.join(dir, `${date}.json`);
        const raw = await fs.readFile(filePath, 'utf-8');
        const parsed = JSON.parse(raw);
        expect(parsed.date).toBe(date);
        expect(parsed.samples.length).toBeGreaterThanOrEqual(3); // start + 2 次心跳
    });

    it('is safe to dispose multiple times', async () => {
        tracker.dispose();
        expect(() => tracker.dispose()).not.toThrow();
    });

    describe('AI work integration', () => {
        it('markAiActive keeps sampling during idle (user watching AI output)', async () => {
            const initial = (await todaySamples()).length;
            // 空闲 7 分钟：第 6 次心跳本应触发空闲暂停
            jest.advanceTimersByTime(7 * 60_000);
            const idleCount = (await todaySamples()).length;
            expect(idleCount).toBe(initial + 5); // 已暂停

            // AI 工作信号到达（即使窗口失焦）→ 恢复采样
            fireWindowState(false);
            tracker.markAiActive();
            await settle();
            expect((await todaySamples()).length).toBe(idleCount + 1);

            // AI 持续工作中：空闲超时后心跳仍继续
            // 注意：markAiActive 只刷新一次，6 分钟内第 1-5 次心跳在空闲线内采样，
            // 第 6 次（360s 后）超时暂停
            jest.advanceTimersByTime(6 * 60_000);
            expect((await todaySamples()).length).toBe(idleCount + 1 + 5);
        });

        it('beginAiWork/endAiWork reference counting keeps sampling across idle and blur', async () => {
            const initial = (await todaySamples()).length;

            // 与 start 采样错开去重窗口（1s）
            jest.advanceTimersByTime(2_000);
            tracker.beginAiWork();
            // 失焦：AI 工作中不暂停
            fireWindowState(false);
            await settle();
            const afterBlur = (await todaySamples()).length;
            expect(afterBlur).toBe(initial + 1); // beginAiWork 立即采样

            // 长时间无任何事件：心跳因 AI 工作继续（不受 5 分钟空闲线限制）
            jest.advanceTimersByTime(10 * 60_000);
            expect((await todaySamples()).length).toBe(afterBlur + 10);

            tracker.endAiWork();
            // 模拟最后一段生成结束前的事件刷新（真实场景由 chunk/任务事件持续驱动 lastActivityAt）
            tracker.markAiActive();
            // AI 结束后：窗口仍失焦，下一次心跳因空闲超时暂停
            jest.advanceTimersByTime(6 * 60_000);
            const afterEnd = (await todaySamples()).length;
            // markAiActive 采样 +1，前 5 次心跳在空闲线内继续
            expect(afterEnd).toBe(afterBlur + 10 + 1 + 5);

            // 暂停后不再采样
            jest.advanceTimersByTime(3 * 60_000);
            expect((await todaySamples()).length).toBe(afterEnd);
        });

        it('endAiWork without begin is a no-op', async () => {
            expect(() => tracker.endAiWork()).not.toThrow();
        });
    });
});
