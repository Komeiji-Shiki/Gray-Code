/**
 * 单个 diff review 的生命周期协作者。
 * DiffManager 保持公开 API 与 UI 行为不变，DiffReviewSession 负责集中维护 outcome、关联 message/tool id 与定时器清理。
 */

import type { StructuredHunkPlan } from './diff/types';
import type { LockHolder } from '../types';

export interface PendingDiff {
    /** 唯一 ID */
    id: string;
    /** 所属会话 ID（用于防止 A 会话中断强杀 B 会话的 pending diff） */
    conversationId?: string;
    /** 文件路径（相对路径） */
    filePath: string;
    /** 文件绝对路径 */
    absolutePath: string;
    /** 原始内容 */
    originalContent: string;
    /** 修改后的内容（AI 建议的内容） */
    newContent: string;
    /**
     * 用户新增/替换行摘要（仅当用户修改了AI 建议时存在）。
     *
     * 格式（每行一条记录，多行用`\n` 分隔；空行内容为空字符串）：
     * - 新增：`+ | newLine | 内容`  （newLine 为用户最终保存内容中的1-based 行号）
     * - 替换：`~ | newLine | 内容`  （newLine 为用户最终保存内容中的1-based 行号）
     * - 删除：`- | baseLine | 内容` （baseLine 为系统建议保存内容中的1-based 行号）
     */
    userEditedContent?: string;
    /**
     * 预览前文档中的用户未保存内容（仅当打开文档时 doc.isDirty 才设置）。
     *
     * 为什么要新增：预览会把 buffer 覆盖为 AI 版本，若目标文档原本就有未保存修改，
     * 拒绝/取消/中断恢复时回写磁盘 originalContent 会丢失用户的未保存内容（H1 数据丢失）。
     * 怎么改：预览前发现 dirty 时记录用户版本，并拒绝本次预览（不覆盖 buffer、不显示 diff 视图），
     * 工具链据此返回可读错误提示用户先保存；拒绝/取消路径检测到该字段时跳过 buffer 恢复，
     * 避免把用户未保存内容回滚成磁盘原文。
     * 目的：在任何失败路径下都不丢失用户未保存内容。
     */
    userUnsavedContentBeforePreview?: string;
    /** 创建时间 */
    timestamp: number;
    /** 状态*/
    status: 'pending' | 'accepted' | 'rejected';
    /**
     * 是否为部分接受（用户拒绝了部分块或手动编辑了内容）。
     *
     * 为什么需要：DiffReviewSession 的 outcome 把 partial 映射为 public status 'accepted'，
     * 工具 handler（apply_diff 等）从 PendingDiff 读不到 partial，会把"部分接受"误报成"全部接受"。
     * 怎么改：finalizeAcceptedDiff 在终结时把 partial 标记写到 PendingDiff 上，工具结果据此返回 partial 状态。
     */
    partial?: boolean;
    /** 被用户拒绝的块索引（部分接受时有效；供前端标记块级状态） */
    rejectedBlockIndices?: number[];
    /** 关联的diff 块（用于 CodeLens）*/
    blocks?: Array<{
        index: number;
        startLine: number;
        endLine: number;
    }>;
    /** 原始 diffs 列表 */
    rawDiffs?: any[];
    /** 关联的工具ID */
    toolId?: string;
    /** 原本不存在的文件（write_file 新建）：拒绝或取消时需删除残留空文件 */
    newFile?: boolean;
    /** write_file 递归 mkdir 本次创建的最高层目录；清理不得越过该边界 */
    newFileCreatedDirectoryRoot?: string;
    /** 新文件拒绝/取消后的残留清理失败原因（工具结果必须向调用方暴露） */
    cleanupError?: string;
    /** 新文件及其可安全删除的空父目录已完成清理 */
    newFileCleanupComplete?: boolean;
    /** diff 警戒值警告信息（当删除行数超过阈值时设置）*/
    diffGuardWarning?: string;
    /** 删除行占比（0-100，用于前端显示） */
    diffGuardDeletePercent?: number;
    /**
     * 自动保存失败原因。
     * 为什么新增：autoSave=true 表示工具应自动收敛；如果保存失败仍保持pending，流式提前执行会一直等待。
     * 怎么改：在后端自动保存失败后记录错误并终结diff，工具结果可据此返回明确失败状态。
     * 目的：避免自动确认模式下出现必须用户中止的悬挂状态。
     */
    autoSaveError?: string;
    /**
     * 结构化 hunk 独立精确匹配计划（apply_diff fast path 产出）。
     *
     * 为什么要新增：块级拒绝（rejectBlockUnlocked）与最终内容重算（computeFinalSuggestedContent）
     * 每次都全量重扫 hunks，而首次应用时 fast path 已经算好了全部匹配位置。
     * 怎么改：把 fast path 的产物缓存在 pending diff 上，重放任意子集时直接按计划拼接。
     * 目的：块级接受/拒绝路径不再重复付出相同的扫描成本，且重放结果与首次应用逐字节一致。
     */
    structuredHunkPlan?: StructuredHunkPlan;
    /**
     * checkpoint 写盘屏障：写盘前必须等待其完成（resolve 后写盘；reject 时写盘被阻止并收敛）。
     * 由工具执行层注入，缺省 undefined 时行为与旧实现完全一致。
     */
    checkpointReady?: Promise<unknown>;
    /**
     * PERF-CP：deferred checkpoint 并发模式的写盘锁持有者身份（由 ToolExecutionService 注入）。
     * 该模式下工具入口不持锁；预览显示后由本管理器获取并持有到 diff 终结，与入口持锁语义对齐。
     */
    lockHolder?: LockHolder;
    /** 写盘锁是否已获取（diff 终结时释放的依据） */
    lockAcquired?: boolean;
    /** checkpoint 与 deferred 写锁均已完成；自动保存只能在此后开始倒计时。 */
    writeReady?: boolean;
    /** 后端自动保存的绝对触发时间（Unix 毫秒），供前端只读展示。 */
    autoSaveAt?: number;
    /** 当前自动保存计时器实际使用的延迟。 */
    scheduledAutoSaveDelay?: number;
}

export type DiffReviewSessionOutcome = 'pending' | 'accepted' | 'rejected' | 'partial' | 'timeout' | 'cancelled';

export type DiffReviewSessionPhase = 'created' | 'presented' | 'finalized';

export interface DiffReviewSessionPayload {
    id: string;
    filePath: string;
    absolutePath: string;
    originalContent: string;
    newContent: string;
    timestamp?: number;
    blocks?: PendingDiff['blocks'];
    rawDiffs?: PendingDiff['rawDiffs'];
    toolCallId?: string;
    messageId?: string;
    diffGuardWarning?: string;
    diffGuardDeletePercent?: number;
}

export interface DiffReviewSessionSnapshot {
    id: string;
    messageId?: string;
    toolCallId?: string;
    outcome: DiffReviewSessionOutcome;
    phase: DiffReviewSessionPhase;
    pendingDiff: PendingDiff;
    createdAt: number;
    presentedAt?: number;
    finalizedAt?: number;
}

export interface DiffReviewSessionOptions {
    now?: () => number;
    timeoutMs?: number;
    onFinalize?: (snapshot: DiffReviewSessionSnapshot) => void;
}

export interface DiffReviewAcceptOptions {
    partial?: boolean;
    userEditedContent?: string;
    autoSaveError?: string;
}

export interface DiffReviewRejectOptions {
    autoSaveError?: string;
}

type AutoSaveTimerCallback = (session: DiffReviewSession) => Promise<void> | void;

export class DiffReviewSession {
    private readonly clock: () => number;
    private readonly finalizeListener?: (snapshot: DiffReviewSessionSnapshot) => void;
    private outcomeValue: DiffReviewSessionOutcome;
    private phaseValue: DiffReviewSessionPhase = 'created';
    private presentedAtValue: number | undefined;
    private finalizedAtValue: number | undefined;
    private timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    private autoSaveTimer: ReturnType<typeof setTimeout> | undefined;

    private constructor(
        private readonly diff: PendingDiff,
        private readonly associatedMessageId: string | undefined,
        private readonly associatedToolCallId: string | undefined,
        options?: DiffReviewSessionOptions
    ) {
        this.clock = options?.now ?? Date.now;
        this.finalizeListener = options?.onFinalize;
        this.outcomeValue = this.outcomeFromPendingDiff(diff);

        if (options?.timeoutMs !== undefined && this.outcomeValue === 'pending') {
            this.scheduleTimeout(options.timeoutMs);
        }
    }

    public static create(payload: DiffReviewSessionPayload, options?: DiffReviewSessionOptions): DiffReviewSession {
        const timestamp = payload.timestamp ?? (options?.now ?? Date.now)();
        const pendingDiff: PendingDiff = {
            id: payload.id,
            filePath: payload.filePath,
            absolutePath: payload.absolutePath,
            originalContent: payload.originalContent,
            newContent: payload.newContent,
            timestamp,
            status: 'pending',
            blocks: payload.blocks,
            rawDiffs: payload.rawDiffs,
            toolId: payload.toolCallId,
            diffGuardWarning: payload.diffGuardWarning,
            diffGuardDeletePercent: payload.diffGuardDeletePercent
        };

        return new DiffReviewSession(pendingDiff, payload.messageId, payload.toolCallId, options);
    }

    public static fromPendingDiff(
        pendingDiff: PendingDiff,
        metadata?: { messageId?: string; toolCallId?: string },
        options?: DiffReviewSessionOptions
    ): DiffReviewSession {
        return new DiffReviewSession(
            pendingDiff,
            metadata?.messageId,
            metadata?.toolCallId ?? pendingDiff.toolId,
            options
        );
    }

    public get id(): string {
        return this.diff.id;
    }

    public get messageId(): string | undefined {
        return this.associatedMessageId;
    }

    public get toolCallId(): string | undefined {
        return this.associatedToolCallId;
    }

    public get pendingDiff(): PendingDiff {
        return this.diff;
    }

    public get outcome(): DiffReviewSessionOutcome {
        return this.outcomeValue;
    }

    public get phase(): DiffReviewSessionPhase {
        return this.phaseValue;
    }

    public get createdAt(): number {
        return this.diff.timestamp;
    }

    public get presentedAt(): number | undefined {
        return this.presentedAtValue;
    }

    public get finalizedAt(): number | undefined {
        return this.finalizedAtValue;
    }

    public get status(): DiffReviewSessionOutcome {
        return this.outcomeValue;
    }

    public markPresented(): boolean {
        if (this.outcomeValue !== 'pending' || this.phaseValue === 'finalized') {
            return false;
        }

        if (this.phaseValue !== 'presented') {
            this.phaseValue = 'presented';
            this.presentedAtValue = this.clock();
        }

        return true;
    }

    public accept(options?: DiffReviewAcceptOptions): boolean {
        if (options?.userEditedContent !== undefined) {
            this.diff.userEditedContent = options.userEditedContent;
        }
        if (options?.autoSaveError !== undefined) {
            this.diff.autoSaveError = options.autoSaveError;
        }

        return this.finalize(options?.partial ? 'partial' : 'accepted');
    }

    public reject(options?: DiffReviewRejectOptions): boolean {
        if (options?.autoSaveError !== undefined) {
            this.diff.autoSaveError = options.autoSaveError;
        }

        return this.finalize('rejected');
    }

    public cancel(): boolean {
        return this.finalize('cancelled');
    }

    public timeout(): boolean {
        return this.finalize('timeout');
    }

    public scheduleTimeout(timeoutMs: number): void {
        this.assertNonNegativeDelay(timeoutMs);
        this.clearTimeoutTimer();

        this.timeoutTimer = setTimeout(() => {
            this.timeoutTimer = undefined;
            this.timeout();
        }, timeoutMs);
    }

    public scheduleAutoSave(delayMs: number, callback: AutoSaveTimerCallback): ReturnType<typeof setTimeout> {
        this.assertNonNegativeDelay(delayMs);
        this.clearAutoSave();

        this.autoSaveTimer = setTimeout(() => {
            this.autoSaveTimer = undefined;
            if (this.outcomeValue !== 'pending') {
                return;
            }
            // callback 可能返回 Promise（异步 auto-save）；void 丢弃会吞掉拒绝，
            // 这里 catch 后记日志，避免保存失败静默无痕。
            Promise.resolve(callback(this)).catch((error: unknown) => {
                console.error(`[DiffReviewSession] auto-save callback failed for diff ${this.id}:`, error);
            });
        }, delayMs);

        return this.autoSaveTimer;
    }

    public clearAutoSave(): void {
        if (this.autoSaveTimer) {
            clearTimeout(this.autoSaveTimer);
            this.autoSaveTimer = undefined;
        }
    }

    public hasAutoSaveTimer(): boolean {
        return this.autoSaveTimer !== undefined;
    }

    public dispose(): void {
        this.clearTimeoutTimer();
        this.clearAutoSave();
    }

    public toSnapshot(): DiffReviewSessionSnapshot {
        return {
            id: this.id,
            messageId: this.messageId,
            toolCallId: this.toolCallId,
            outcome: this.outcomeValue,
            phase: this.phaseValue,
            pendingDiff: this.diff,
            createdAt: this.createdAt,
            presentedAt: this.presentedAtValue,
            finalizedAt: this.finalizedAtValue
        };
    }

    private finalize(outcome: Exclude<DiffReviewSessionOutcome, 'pending'>): boolean {
        if (this.outcomeValue !== 'pending') {
            return false;
        }

        this.outcomeValue = outcome;
        this.phaseValue = 'finalized';
        this.finalizedAtValue = this.clock();
        this.diff.status = this.toPublicPendingDiffStatus(outcome);
        this.dispose();
        this.finalizeListener?.(this.toSnapshot());
        return true;
    }

    private clearTimeoutTimer(): void {
        if (this.timeoutTimer) {
            clearTimeout(this.timeoutTimer);
            this.timeoutTimer = undefined;
        }
    }

    private assertNonNegativeDelay(delayMs: number): void {
        if (!Number.isFinite(delayMs) || delayMs < 0) {
            throw new Error(`DiffReviewSession timer delay must be a non-negative finite number, got ${delayMs}`);
        }
    }

    private outcomeFromPendingDiff(diff: PendingDiff): DiffReviewSessionOutcome {
        if (diff.status === 'accepted') {
            return 'accepted';
        }
        if (diff.status === 'rejected') {
            return 'rejected';
        }
        return 'pending';
    }

    private toPublicPendingDiffStatus(outcome: Exclude<DiffReviewSessionOutcome, 'pending'>): PendingDiff['status'] {
        return outcome === 'accepted' || outcome === 'partial' ? 'accepted' : 'rejected';
    }
}
