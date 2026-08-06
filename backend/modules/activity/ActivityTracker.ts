/**
 * GrayCode - 使用时间活动追踪器
 *
 * 采集策略（「使用时长」≈ 人在 VS Code 前真正操作/查看的时间）：
 * - 窗口聚焦时每 60 秒心跳记录一个采样点；
 * - 用户活动事件（编辑文档、光标移动/选择变化、切换活动编辑器）即时记录采样，
 *   并重置空闲计时；
 * - AI 工作事件（模型流式生成 / 工具执行 / 子代理运行）同样视为用户在场：
 *   主人在看 AI 干活时可能长时间不操作编辑器，不能误判为离开；
 * - 连续 5 分钟无任何用户活动事件且无 AI 工作 → 暂停心跳（视为离开，不记录"挂机"时长）；
 * - 窗口失焦 → 立即暂停并落盘（AI 工作中失焦不暂停：后台跑任务也算使用）；
 * - 采样内存累积，每 2 分钟落盘一次，停用时立即落盘。
 *
 * 采样数据只含时间戳，不含任何用户内容，按天文件存储于
 * <dataPath>/activity/YYYY-MM-DD.json。
 */

import * as vscode from 'vscode';
import { ActivityStore } from './ActivityStore';
import {
    ACTIVITY_HEARTBEAT_MS,
    ACTIVITY_IDLE_MS,
    ACTIVITY_FLUSH_INTERVAL_MS,
    ACTIVITY_SAMPLE_DEDUP_MS
} from './types';

export class ActivityTracker implements vscode.Disposable {
    private readonly store: ActivityStore;

    private heartbeatTimer: NodeJS.Timeout | null = null;
    private flushTimer: NodeJS.Timeout | null = null;

    private readonly disposables: vscode.Disposable[] = [];

    /** 最近一次用户/AI 活动事件时间（毫秒） */
    private lastActivityAt = 0;
    /** 最近一次采样时间（毫秒），用于事件驱动的去重 */
    private lastSampleAt = 0;
    /** 是否处于暂停状态（窗口失焦 / 空闲超时 / 已停止） */
    private paused = true;
    private disposed = false;
    /** AI 工作引用计数：>0 表示模型生成/工具执行/子代理运行中，不受空闲与失焦暂停 */
    private aiWorkCount = 0;

    constructor(dir: string) {
        this.store = new ActivityStore(dir);
    }

    /** 访问底层存储（统计查询用） */
    getStore(): ActivityStore {
        return this.store;
    }

    /**
     * 启动追踪：注册 VSCode 事件监听并启动心跳/落盘定时器。
     * 启动时若窗口已聚焦且用户有近期活动，立即恢复采样。
     */
    start(): void {
        if (this.disposed) return;

        this.disposables.push(
            vscode.window.onDidChangeWindowState((state) => {
                if (state.focused) {
                    this.resume();
                } else {
                    this.pause();
                }
            })
        );

        // 用户活动事件：重置空闲计时并在活跃时立即采样；
        // 若因空闲超时已暂停，活动事件本身说明用户回来了，直接恢复采样
        const markUserActive = () => {
            const now = Date.now();
            this.lastActivityAt = now;
            if (this.paused) {
                if (vscode.window.state.focused) {
                    this.resume();
                }
                return;
            }
            this.sample(now);
        };

        // 滚动阅读代码也是有效活动（无编辑/光标移动时不能误判为离开）
        this.disposables.push(
            vscode.workspace.onDidChangeTextDocument(() => markUserActive()),
            vscode.window.onDidChangeTextEditorSelection(() => markUserActive()),
            vscode.window.onDidChangeTextEditorVisibleRanges(() => markUserActive()),
            vscode.window.onDidChangeActiveTextEditor(() => markUserActive()),
            vscode.window.onDidOpenTerminal(() => markUserActive())
        );

        // 心跳：未暂停且（未空闲超时 或 AI 工作中）时记录采样
        this.heartbeatTimer = setInterval(() => {
            if (this.paused || this.disposed) return;
            const now = Date.now();
            // 空闲超时：暂停直到下一次用户/AI 活动；AI 工作期间不受限
            if (this.lastActivityAt > 0 && now - this.lastActivityAt > ACTIVITY_IDLE_MS && !this.isAiWorking()) {
                this.pause();
                return;
            }
            this.sample(now);
        }, ACTIVITY_HEARTBEAT_MS);

        // 定时落盘，防止崩溃/断电丢失当天数据
        this.flushTimer = setInterval(() => {
            if (this.disposed) return;
            this.flush().catch((error) => {
                console.warn('[ActivityTracker] flush failed:', error);
            });
        }, ACTIVITY_FLUSH_INTERVAL_MS);

        // 启动时窗口已聚焦：立即恢复
        if (vscode.window.state.focused) {
            this.resume();
        }
    }

    /**
     * AI 工作信号（模型生成 chunk / 工具执行 / 子代理运行等）：
     * 视为用户在场——主人在看 AI 干活时可能不操作编辑器。
     * AI 工作中即使窗口失焦也恢复采样（后台跑任务也算使用时间）。
     */
    markAiActive(): void {
        const now = Date.now();
        this.lastActivityAt = now;
        if (this.paused) {
            this.resume();
            return;
        }
        this.sample(now);
    }

    /** AI 开始一段工作（引用计数：支持并发流/工具/子代理） */
    beginAiWork(): void {
        this.aiWorkCount++;
        this.markAiActive();
    }

    /** AI 结束一段工作 */
    endAiWork(): void {
        if (this.aiWorkCount > 0) {
            this.aiWorkCount--;
        }
    }

    /** 当前是否有 AI 工作在运行 */
    private isAiWorking(): boolean {
        return this.aiWorkCount > 0;
    }

    /** 恢复采样（窗口重新聚焦或用户/AI 重新活动） */
    private resume(): void {
        if (this.disposed) return;
        const now = Date.now();
        this.lastActivityAt = now;
        this.paused = false;
        // 恢复时立即采样，保证连续工作会话不因失焦/空闲中断而断裂（短离开不算断）
        this.sample(now);
    }

    /** 暂停采样（窗口失焦或空闲超时），并立即落盘；AI 工作中失焦不暂停 */
    private pause(): void {
        if (this.paused) return;
        if (this.isAiWorking()) return;
        this.paused = true;
        this.flush().catch((error) => {
            console.warn('[ActivityTracker] flush on pause failed:', error);
        });
    }

    /** 记录一个采样点（去重：与上次采样间隔小于去重窗口则跳过） */
    private sample(t: number): void {
        if (t - this.lastSampleAt < ACTIVITY_SAMPLE_DEDUP_MS) {
            this.lastSampleAt = t;
            return;
        }
        this.lastSampleAt = t;
        this.store.appendSample(t).catch((error) => {
            console.warn('[ActivityTracker] append sample failed:', error);
        });
    }

    /** 立即落盘当天数据（也可用于测试注入日期） */
    async flush(): Promise<void> {
        await this.store.flushDay();
    }

    /**
     * 停止追踪并落盘。重复调用安全。
     */
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;

        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
        if (this.flushTimer) {
            clearInterval(this.flushTimer);
            this.flushTimer = null;
        }
        for (const d of this.disposables.splice(0)) {
            d.dispose();
        }
        this.paused = true;
        this.aiWorkCount = 0;

        // 停用时立即落盘，尽量不丢数据
        this.flush().catch((error) => {
            console.warn('[ActivityTracker] flush on dispose failed:', error);
        });
    }
}
