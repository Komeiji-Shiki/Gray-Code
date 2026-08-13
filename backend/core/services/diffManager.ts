/**
 * Diff 管理器- 管理待审阅的文件修改。
 *
 * DiffManager 负责公开 API、diff 预览与工具等待语义；单个 review 的outcome 由DiffReviewSession 协作者承载。
 *
 * 功能：
 * - 管理待处理的 diff 修改
 * - 显示 VS Code diff 视图
 * - 支持自动保存和手动审阅模式
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getGlobalSettingsManager } from '../settingsContext';
import { restoreChatInputFocus, shouldRestoreChatInputFocus } from '../chatFocusGuard';
import { newUuid } from '../id';
import { t } from '../../i18n';

import { getDiffCodeLensProvider } from '../../tools/file/DiffCodeLensProvider';
import {
    applyDiffToContent,
    applyStructuredDiffHunksBestEffort,
    normalizeLineEndings,
    countLineBreaks,
    type StructuredDiffHunk,
    type StructuredHunkPlan
} from '../../tools/file/apply_diff';
import { DiffReviewSession } from '../../tools/file/DiffReviewSession';
import { applyUnifiedDiffHunks, type UnifiedDiffHunk } from '../../tools/file/unifiedDiff';
import { resolveDiffTargetViewColumn } from '../../tools/file/diffViewColumn';
import { fileWriteLockManager, type LockHolder } from '../fileWriteLockManager';
import { countDeletedLines, myersDiffLines, type DiffOp } from './diff/diffAlgorithm';
import { splitLines } from './diff/lineId';
import { computeUserEditedNewLinesSummary } from './diff/summaryStats';

export { countDeletedLines, myersDiffLines, type DiffOp };

/**
 * 待处理的 Diff 修改
 */
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

/**
 * Diff 设置
 */
export interface DiffSettings {
    /** 是否自动保存 */
    autoSave: boolean;
    /** 自动保存延迟（毫秒） */
    autoSaveDelay: number;
}

/**
 * 状态变化监听器
 */
type StatusChangeListener = (pending: PendingDiff[], allProcessed: boolean) => void;

/**
 * Diff 保存监听器（当diff 被实际保存到磁盘时调用）
 */
type DiffSaveListener = (diff: PendingDiff) => void;

/**
 * Diff 结算等待结果。
 *
 * 为什么要新增：多个文件编辑工具都在等待pending diff 结束，但 apply_diff 只靠状态监听，
 * 在用户中断清掉自动保存定时器且没有后续状态事件时可能一直等待。
 * 怎么改：把“正常结束、abort 取消、用户新请求中断”抽象成 DiffManager 级别的通用结果。
 * 目的：所有diff-review 工具共享同一套生命周期等待语义，避免某个工具独自遗漏中断路径。
 */
export type DiffResolutionReason = 'none' | 'abort' | 'user' | 'rejected';

/**
 * 用户中断跟踪（按会话隔离，防止标签页 A 的请求中断强杀 B 会话的 pending diff）。
 * 不传 conversationId 时退化为全局中断（向后兼容）。
 */
let globalUserInterrupt = false;
const interruptedConversationIds = new Set<string>();

export interface CreatePendingDiffOptions {
    confirmedByToolConfirmation?: boolean;
    /** 原本不存在的文件（write_file 新建）：拒绝或取消时需删除残留空文件 */
    newFile?: boolean;
    /** 会话 ID：用于中断判定的会话隔离，避免全局中断标记泄漏误伤 */
    conversationId?: string;
    /** 结构化 hunk 计划（apply_diff 结构化路径产出），块级拒绝/最终内容重放时复用 */
    structuredHunkPlan?: StructuredHunkPlan;
    /** checkpoint 写盘屏障：写盘前必须等待其完成 */
    checkpointReady?: Promise<unknown>;
    /** PERF-CP：deferred 模式的写盘锁持有者身份（缺省 undefined 时保持入口持锁语义不变） */
    lockHolder?: LockHolder;
}

function isLegacySearchReplaceDiff(d: any): d is { search: string; replace: string; start_line?: number } {
    return !!d && typeof d === 'object' && typeof d.search === 'string' && typeof d.replace === 'string';
}

/**
 * 大小写不敏感的文件路径比较（Windows/macOS）。
 *
 * 同一文件可能通过不同大小写的路径打开（UNC/符号链接/手输），严格比较会让监听器/文档查找失效，
 * 导致 diff 悬挂或找不到脏文档；Linux 区分大小写，保持精确比较。
 */
function sameFsPath(a: string | undefined, b: string | undefined): boolean {
    if (!a || !b) return false;
    if (process.platform === 'win32' || process.platform === 'darwin') {
        return a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();
    }
    return a === b; // Linux 区分大小写，保持精确
}

function isUnifiedDiffHunk(d: any): d is UnifiedDiffHunk {
    return (
        !!d &&
        typeof d === 'object' &&
        typeof d.oldStart === 'number' &&
        typeof d.newStart === 'number' &&
        Array.isArray(d.lines)
    );
}

function isStructuredDiffHunk(d: any): d is StructuredDiffHunk {
    // 为什么要识别结构化hunk：apply_diff 新格式存入rawDiffs 后，块级接受/拒绝需要按同一套oldContent/newContent 规则重放。
    // 怎么改：用字段形态区分，不新增工具类型或配置分支，避免前后端出现第三套并行协议。
    // 目的：让 DiffManager 在用户拒绝某个块后仍能准确重算最终文件内容。
    return (
        !!d &&
        typeof d === 'object' &&
        typeof d.oldContent === 'string' &&
        typeof d.newContent === 'string'
    );
}

/**
 * Diff 管理器
 */
export class DiffManager {
    private static instance: DiffManager | null = null;

    /** 待处理的 diff 列表（公开返回值仍为PendingDiff，生命周期状态由 diffSessions 持有同一对象）*/
    private pendingDiffs: Map<string, PendingDiff> = new Map();

    /** 单个 diff review 的内部生命周期协作者*/
    private diffSessions: Map<string, DiffReviewSession> = new Map();

    /** 虚拟文档内容提供者*/
    private contentProvider: OriginalContentProvider;

    /** 内容提供者注册*/
    private providerDisposable: vscode.Disposable | null = null;

    /** 设置 */
    private settings: DiffSettings = {
        autoSave: false,
        autoSaveDelay: 3000
    };

    /** 自动保存定时器*/
    private autoSaveTimers: Map<string, NodeJS.Timeout> = new Map();

    /** 状态变化监听器 */
    private statusListeners: Set<StatusChangeListener> = new Set();

    /** Diff 保存监听器（当文件被实际保存时调用） */
    private saveCompleteListeners: Set<DiffSaveListener> = new Set();

    /** 文档保存事件监听器*/
    private saveListeners: Map<string, vscode.Disposable> = new Map();

    /** 文档即将保存事件监听器*/
    private willSaveListeners: Map<string, vscode.Disposable> = new Map();

    /** 文档关闭事件监听器*/
    private closeListeners: Map<string, vscode.Disposable> = new Map();

    /** 非手动保存（如 auto-save）已直接落盘的 diff；跳过保存后的回退恢复，避免死循环 */
    private nonManualSaveFlushed: Set<string> = new Set();

    /** 已终结 diff 的 FIFO 淘汰队列（延迟删除，终态条目仍可能被工具链路读一次） */
    private finalizedDiffOrder: string[] = [];
    private static readonly MAX_FINALIZED_DIFFS = 50;
    /** 被淘汰 rejected diff 墓碑 Set 的容量上限（C6）：超出时 FIFO 淘汰最旧墓碑 */
    private static readonly MAX_EVICTED_REJECTED_TOMBSTONES = 2000;
    /**
     * 被 FIFO 淘汰的 rejected diff（淘汰后 getDiff 返回 undefined，工具链路无法再查状态）。
     * 只记录 rejected：accepted 按正常结算处理，不会误报。查询后即删除，防止无界增长。
     */
    private evictedRejectedDiffIds: Set<string> = new Set();
    /**
     * 被 FIFO 淘汰的 accepted+partial diff 墓碑（仅存最小状态信息）。
     * 并发终结时，后终结的 diff 可能淘汰掉"已终结但等待者尚未 getDiff"的前一个 diff，
     * 若直接删除，工具链路 getDiff 返回 undefined 会把"部分接受"误报成"全部接受"。
     * 无条件留痕（与 rejected 墓碑同口径）：waitForDiffResolution 可能在淘汰后才注册
     * 等待者（如 autoApply 高积压时拒绝与工具等待建立交错），以"淘汰时已有活跃等待者"
     * 为条件会漏记，getDiff 返回 undefined 后被误判为 accepted；容量上限同 rejected 墓碑。
     */
    private evictedAcceptedPartialInfo: Map<string, { partial: boolean; rejectedBlockIndices?: number[] }> = new Map();

    /** 正在执行接受动作的diff */
    private acceptingDiffIds: Set<string> = new Set();

    /** 正在执行拒绝动作的diff */
    private rejectingDiffIds: Set<string> = new Set();

    /**
     * 预热中的 Diff 两侧文档（uri → openTextDocument promise）。
     * PERF：真实目标文档与 gemini-diff-original 虚拟原文档都要提前打开；只预热右侧时，
     * 首个 Diff 仍会在 vscode.diff 内为左侧文档初始化内容提供器、语言模式与 Diff 模型，
     * 表现为编辑器外壳已经出现但工具状态仍停顿。使用后即删，失败时允许 fallback 重试。
     */
    private prewarmPromises: Map<string, Promise<vscode.TextDocument | undefined>> = new Map();

    /**
     * 单个 Diff 的写入就绪屏障（checkpoint 完成 + deferred 写锁获取）。
     * createPendingDiff、自动确认、手动接受/拒绝和保存事件必须复用同一个 Promise：
     * 状态可以在屏障完成前发布，但任何真正写盘/回滚都不能越过它，也不能重复重入加锁。
     */
    private writeReadyPromises: Map<string, Promise<void>> = new Map();

    /**
     * Diff 动作全局串行队列。
     *
     * 为什么要改：多个 diff 确认入口可能同时触发，例如前端按钮、自动保存、CodeLens 或连续工具调用，单靠 20ms 延迟只能降低概率，不能保证VS Code 文档保存、标签页切换和状态广播按顺序收敛。
     * 怎么改：用Promise 队列把所有会改变 diff 状态或编辑器内容的动作串行执行；每个任务无论成功失败都会释放队列，避免后续确认被永久阻塞。
     * 目的：从协议层消除并发确认竞态，而不是依赖固定时间等待。
     */
    private diffActionQueue: Promise<void> = Promise.resolve();

    private constructor() {
        this.contentProvider = new OriginalContentProvider();
        this.providerDisposable = vscode.workspace.registerTextDocumentContentProvider(
            'gemini-diff-original',
            this.contentProvider
        );
    }

    /**
     * 获取单例实例
     */
    public static getInstance(): DiffManager {
        if (!DiffManager.instance) {
            DiffManager.instance = new DiffManager();
        }
        return DiffManager.instance;
    }

    /**
     * 更新设置
     */
    public updateSettings(settings: Partial<DiffSettings>): void {
        this.settings = { ...this.settings, ...settings };
    }

    /**
     * 获取当前设置
     * 优先从全局设置管理器读取，否则使用本地设置
     */
    public getSettings(): DiffSettings {
        const settingsManager = getGlobalSettingsManager();
        if (settingsManager) {
            const config = settingsManager.getApplyDiffConfig();
            return {
                autoSave: config.autoSave,
                autoSaveDelay: config.autoSaveDelay
            };
        }
        return { ...this.settings };
    }

    /**
     * 刷新自动保存定时器（用于运行时设置变更）
     *
     * 说明：
     * - 当用户在 diff 已经处于 pending 状态后，才开启关闭“启用自动应用”或调整延迟时，
     *   需要通过此方法让当前已存在的 pending diff 立即按最新配置生效。
     *
     * 行为：
     * - autoSave = false：取消所有已调度的自动保存
     * - autoSave = true：为所有pending diff 调度/重置自动保存（使用最新的 autoSaveDelay）
     */
    public refreshAutoSaveTimers(): void {
        const currentSettings = this.getSettings();

        // 关闭自动保存：清理全部定时器和前端展示中的截止时间
        if (!currentSettings.autoSave) {
            for (const [id, timer] of this.autoSaveTimers) {
                clearTimeout(timer);
                this.diffSessions.get(id)?.clearAutoSave();
                const diff = this.pendingDiffs.get(id);
                if (diff) {
                    delete diff.autoSaveAt;
                    delete diff.scheduledAutoSaveDelay;
                }
            }
            this.autoSaveTimers.clear();
            this.notifyStatusChange();
            return;
        }

        // 只为已经通过 checkpoint/写锁屏障的会话重新计时。
        for (const diff of this.getPendingDiffs()) {
            if (diff.writeReady !== false) {
                this.scheduleAutoSave(diff.id, false);
            } else {
                const timer = this.autoSaveTimers.get(diff.id);
                if (timer) clearTimeout(timer);
                this.autoSaveTimers.delete(diff.id);
                this.diffSessions.get(diff.id)?.clearAutoSave();
                delete diff.autoSaveAt;
                delete diff.scheduledAutoSaveDelay;
            }
        }
        this.notifyStatusChange();
    }

    /**
     * 添加状态变化监听器
     */
    public addStatusListener(listener: StatusChangeListener): void {
        this.statusListeners.add(listener);
    }

    /**
     * 移除状态变化监听器
     */
    public removeStatusListener(listener: StatusChangeListener): void {
        this.statusListeners.delete(listener);
    }

    /**
     * 通知状态变化
     */
    private notifyStatusChange(): void {
        const pending = this.getPendingDiffs();
        const allProcessed = this.areAllProcessed();
        for (const listener of this.statusListeners) {
            listener(pending, allProcessed);
        }
    }

    /**
     * 添加 diff 保存完成监听器
     */
    public addSaveCompleteListener(listener: DiffSaveListener): void {
        this.saveCompleteListeners.add(listener);
    }

    /**
     * 移除 diff 保存完成监听器
     */
    public removeSaveCompleteListener(listener: DiffSaveListener): void {
        this.saveCompleteListeners.delete(listener);
    }

    /**
     * 通知 diff 保存完成
     */
    private notifySaveComplete(diff: PendingDiff): void {
        for (const listener of this.saveCompleteListeners) {
            listener(diff);
        }
    }

    /**
     * 某个 diff 是否正处于内部接受拒绝动作处理中
     */
    public isDiffActionInProgress(id: string): boolean {
        return this.acceptingDiffIds.has(id) || this.rejectingDiffIds.has(id);
    }

    private runDiffActionSerialized<T>(action: () => Promise<T>): Promise<T> {
        // 为什么不用setTimeout(20)：固定延迟无法覆盖慢磁盘、慢 VS Code 保存、多个diff 标签页切换等真实耗时差异。
        // 怎么改：把下一个动作接到当前队尾之后，并把队尾归一化为 void Promise，确保失败不会打断后续队列。
        // 目的：让 accept/reject/block/auto-save 的状态变更形成确定顺序，避免并发确认链路互相抢占。
        const previous = this.diffActionQueue.catch(() => undefined);
        const current = previous.then(action);
        this.diffActionQueue = current.then(
            () => undefined,
            () => undefined
        );
        return current;
    }

    /**
     * 释放 diff 相关监听器
     */
    private disposeDiffListeners(id: string): void {
        const saveListener = this.saveListeners.get(id);
        if (saveListener) {
            saveListener.dispose();
            this.saveListeners.delete(id);
        }

        const willSaveListener = this.willSaveListeners.get(id);
        if (willSaveListener) {
            willSaveListener.dispose();
            this.willSaveListeners.delete(id);
        }

        const closeListener = this.closeListeners.get(id);
        if (closeListener) {
            closeListener.dispose();
            this.closeListeners.delete(id);
        }

        this.nonManualSaveFlushed.delete(id);
    }

    private finalizeAcceptedDiff(diff: PendingDiff, options?: { partial?: boolean }): void {
        if (diff.status !== 'pending') {
            return;
        }

        // 部分接受标记必须写回 PendingDiff：session.accept 只把 outcome 存进 DiffReviewSession，
        // 工具 handler 读的是 PendingDiff（getDiff），不记录 partial 就无法区分"全部接受"与"部分接受"。
        const isPartial = options?.partial ?? !!diff.userEditedContent;

        const session = this.diffSessions.get(diff.id);
        const finalized = session
            ? session.accept({ partial: isPartial })
            : this.finalizeLegacyPendingDiff(diff, 'accepted');
        if (!finalized) {
            return;
        }

        if (isPartial) {
            diff.partial = true;
            // 记录被拒绝的块索引（cleanup 会移除 CodeLens session，必须在此前统计）
            const provider = getDiffCodeLensProvider();
            const lensSession = provider.getSession(diff.id);
            // lensSession 为 null（如 skip-diff-view 路径）时显式写空数组，保证
            // partial=true 时 rejectedBlockIndices 恒为数组，消费端 ?? [] 兜底一致
            diff.rejectedBlockIndices = lensSession
                ? lensSession.blocks.filter((b) => b.rejected).map((b) => b.index)
                : [];
        } else {
            // 显式清除可能残留的 partial 字段：若此前一次终结（如防御性早退）曾写入，
            // 后续"全部接受"再终结时必须清掉，避免把全接受误报为 partial
            delete diff.partial;
            delete diff.rejectedBlockIndices;
        }

        this.disposeDiffListeners(diff.id);
        this.cleanup(diff.id);
        this.evictOldFinalizedDiffs(diff.id);
        this.notifyStatusChange();
        this.notifySaveComplete(diff);
    }

    /**
     * 删除"本次会话预创建且未成功应用"的新文件残留（H2）。
     *
     * 为什么下沉到公共终结路径：write_file 预创建空文件后，acquireWriteLockForDiff 冲突、
     * autoSave 失败、用户取消等所有失败路径都会走到 finalizeRejectedDiff/finalizeCancelledDiff，
     * 只在个别路径清理会漏掉残留空文件。
     * 为什么只在拒绝/取消路径调用：newFile 语义是"目标文件之前不存在、AI 要新建"，
     * 确认接受后该文件应保留（finalizeAcceptedDiff 不调用本方法）。
     * 已删除/不存在的文件 unlink 会抛错，统一吞掉。
     */
    private removeNewFileResidue(diff: PendingDiff): void {
        if (!diff.newFile) {
            return;
        }
        try {
            fs.unlinkSync(diff.absolutePath);
        } catch (e) {
            console.warn(`[DiffManager] Failed to remove new file ${diff.filePath}:`, e);
        }
    }

    private finalizeRejectedDiff(diff: PendingDiff): void {
        if (diff.status !== 'pending') {
            return;
        }
        const session = this.diffSessions.get(diff.id);
        const finalized = session
            ? session.reject()
            : this.finalizeLegacyPendingDiff(diff, 'rejected');
        if (!finalized) {
            return;
        }
        this.disposeDiffListeners(diff.id);
        this.cleanup(diff.id);
        this.removeNewFileResidue(diff);
        this.evictOldFinalizedDiffs(diff.id);
        this.notifyStatusChange();
    }

    private finalizeCancelledDiff(diff: PendingDiff): void {
        if (diff.status !== 'pending') {
            return;
        }
        const session = this.diffSessions.get(diff.id);
        const finalized = session
            ? session.cancel()
            : this.finalizeLegacyPendingDiff(diff, 'rejected');
        if (!finalized) {
            return;
        }
        this.disposeDiffListeners(diff.id);
        this.cleanup(diff.id);
        this.removeNewFileResidue(diff);
        this.evictOldFinalizedDiffs(diff.id);
    }

    /**
     * FIFO 延迟淘汰：终态条目可能仍被工具链路读一次，不在 cleanup 里同步删除；
     * 当已终结 diff 超过上限时回收最老的。
     */
    private evictOldFinalizedDiffs(id: string): void {
        this.finalizedDiffOrder.push(id);
        while (this.finalizedDiffOrder.length > DiffManager.MAX_FINALIZED_DIFFS) {
            const oldest = this.finalizedDiffOrder.shift()!;
            const evicted = this.pendingDiffs.get(oldest);
            // 淘汰会让工具链路的 getDiff 返回 undefined：被拒绝的必须留痕，
            // 否则 write_file 等会把"用户拒绝"误报为"写入成功"。
            // 无条件留痕：waitForDiffResolution 可能在淘汰后才注册等待者
            // （如用户拒绝发生在工具等待建立之前），此时没有活跃等待者，
            // 不记录会让 getDiff 返回 undefined 后被误判为 accepted。
            // 墓碑集合有容量上限（FIFO 淘汰最旧墓碑），不会随会话无界增长。
            if (evicted && evicted.status === 'rejected') {
                this.recordEvictedRejectedDiff(oldest);
            } else if (
                evicted && evicted.status === 'accepted'
                && (evicted.partial || (evicted.rejectedBlockIndices?.length ?? 0) > 0)
            ) {
                // accepted+partial 无条件留痕（与 rejected 同口径）：并发终结时当前 diff
                // 可能先被淘汰、等待者后 getDiff，或等待者在淘汰后才注册（autoApply 高积压时
                // 工具链路的 waitForDiffResolution 可能尚未建立）；不记录会把"部分接受"
                // 误报为"全部接受"（与 rejected 墓碑同源问题）
                this.evictedAcceptedPartialInfo.set(oldest, {
                    partial: true,
                    rejectedBlockIndices: evicted.rejectedBlockIndices,
                });
                if (this.evictedAcceptedPartialInfo.size > DiffManager.MAX_EVICTED_REJECTED_TOMBSTONES) {
                    const oldestKey = this.evictedAcceptedPartialInfo.keys().next().value;
                    if (oldestKey !== undefined) this.evictedAcceptedPartialInfo.delete(oldestKey);
                }
            }
            this.pendingDiffs.delete(oldest);
            this.diffSessions.delete(oldest);
        }
    }

    /**
     * 记录被淘汰的 rejected diff 墓碑（C6）。
     * Set 随会话无界增长会变成内存泄漏，这里加容量上限（FIFO 淘汰最旧墓碑）。
     */
    private recordEvictedRejectedDiff(id: string): void {
        this.evictedRejectedDiffIds.add(id);
        if (this.evictedRejectedDiffIds.size > DiffManager.MAX_EVICTED_REJECTED_TOMBSTONES) {
            const oldest = this.evictedRejectedDiffIds.values().next().value;
            if (oldest !== undefined) {
                this.evictedRejectedDiffIds.delete(oldest);
            }
        }
    }

    private finalizeLegacyPendingDiff(diff: PendingDiff, status: PendingDiff['status']): boolean {
        diff.status = status;
        return true;
    }

    /**
     * 创建待审阅的 diff
     */
    private getFullApplyDiffConfig() {
        const settingsManager = getGlobalSettingsManager();
        if (settingsManager) {
            return settingsManager.getApplyDiffConfig();
        }
        return null;
    }

    /**
     * 检查diff 警戒值
     * 计算删除行数占原始文件总行数的百分比
     */
    private checkDiffGuard(originalContent: string, newContent: string): { warning?: string; deletePercent: number } {
        const config = this.getFullApplyDiffConfig();
        if (!config || !config.diffGuardEnabled) {
            return { deletePercent: 0 };
        }

        // 使用统一的按行切分（处理 CRLF/尾部换行），避免行数统计偏差
        const originalLines = splitLines(originalContent);
        const newLines = splitLines(newContent);
        const totalOriginalLines = originalLines.length;

        if (totalOriginalLines === 0) {
            return { deletePercent: 0 };
        }

        // 计算“真实删除行数”（而非净行数变化）：
        // - 例如 3 行被删除，同时插入1 行，净减少 2 行；
        //   但删除行数应记为 3 行。
        // 基于编辑距离直接推导删除行数（无需完整 diff 回溯），超大重写自动退化为线性估算。
        const deletedLineCount = countDeletedLines(originalLines, newLines);

        const deletePercent = Math.round((deletedLineCount / totalOriginalLines) * 100);

        if (deletePercent >= config.diffGuardThreshold) {
            const warning = t('tools.file.diffManager.diffGuardWarning', {
                deletePercent: String(deletePercent),
                threshold: String(config.diffGuardThreshold),
                deletedLines: String(deletedLineCount),
                totalLines: String(totalOriginalLines)
            });
            return { warning, deletePercent };
        }

        return { deletePercent };
    }

    private getOriginalContentUri(diff: Pick<PendingDiff, 'id' | 'filePath'>): vscode.Uri {
        return vscode.Uri.parse(`gemini-diff-original:${diff.id}/${path.basename(diff.filePath)}`);
    }

    private getPrewarmKey(uri: vscode.Uri): string {
        const serialized = uri.toString();
        // 单元测试/受限 mock 可能只提供普通对象并继承 Object#toString；生产 URI 不走此分支。
        return serialized === '[object Object]'
            ? `${uri.scheme || ''}:${uri.fsPath || uri.path || ''}`
            : serialized;
    }

    /**
     * PERF：预热 Diff 文档——提前发起 openTextDocument（读盘/内容提供 + 语言服务初始化），
     * 与 hunk 应用、diff 警戒检查等耗时操作并行。真实目标文档和虚拟原文档均走此入口。
     *
     * fire-and-forget：失败静默移除缓存，消费时会 fallback 重新打开；同一 uri 幂等。
     */
    public prewarmDocument(fileUri: vscode.Uri): void {
        const key = this.getPrewarmKey(fileUri);
        if (this.prewarmPromises.has(key)) {
            return;
        }
        try {
            const raw = vscode.workspace.openTextDocument(fileUri);
            let promise!: Promise<vscode.TextDocument | undefined>;
            promise = Promise.resolve(raw).then(
                (doc) => doc,
                () => {
                    // 仅删除当前失败的 Promise，避免旧请求迟到失败时误删同 URI 的新预热。
                    if (this.prewarmPromises.get(key) === promise) {
                        this.prewarmPromises.delete(key);
                    }
                    return undefined;
                }
            );
            this.prewarmPromises.set(key, promise);
        } catch {
            // 环境不支持（测试 mock 缺失等）：消费时走原始打开路径
        }
    }

    private async consumePrewarmedDocument(fileUri: vscode.Uri): Promise<vscode.TextDocument> {
        const key = this.getPrewarmKey(fileUri);
        const promise = this.prewarmPromises.get(key);
        try {
            const prewarmed = await promise;
            return (prewarmed && vscode.workspace.textDocuments.includes(prewarmed))
                ? prewarmed
                : await vscode.workspace.openTextDocument(fileUri);
        } finally {
            // 仅消费自己观察到的 Promise；同 URI 若已开始新预热，不得误删。
            if (promise && this.prewarmPromises.get(key) === promise) {
                this.prewarmPromises.delete(key);
            }
        }
    }

    /**
     * 创建待审阅的 diff（原始方法）
     */
    public async createPendingDiff(
        filePath: string,
        absolutePath: string,
        originalContent: string,
        newContent: string,
        blocks?: Array<{ index: number; startLine: number; endLine: number }>,
        rawDiffs?: any[],
        toolId?: string,
        options?: CreatePendingDiffOptions
    ): Promise<PendingDiff> {
        const id = `diff-${Date.now()}-${newUuid()}`;
        // PERF：预热目标文档——与后续 checkDiffGuard / 视图打开并行，
        // 覆盖所有调用方（apply_diff / insert_code / delete_code / write_file）。
        this.prewarmDocument(vscode.Uri.file(absolutePath));
        const session = DiffReviewSession.create({
            id,
            filePath,
            absolutePath,
            originalContent,
            newContent,
            blocks,
            rawDiffs,
            toolCallId: toolId
        });
        const pendingDiff = session.pendingDiff;

        this.diffSessions.set(id, session);
        this.pendingDiffs.set(id, pendingDiff);

        // 提前标记 newFile：避免 createPendingDiff 返回后、write_file 设置前
        // 取消路径无法识别并清理空文件（#14）。
        if (options?.newFile) {
            pendingDiff.newFile = true;
        }

        // 绑定会话 ID：让 waitForDiffResolution 的中断判定能按会话隔离，
        // 避免全局中断标记泄漏导致 autoSave 已应用后仍返回 "cancelled by user"。
        if (options?.conversationId) {
            pendingDiff.conversationId = options.conversationId;
        }

        // 缓存结构化 hunk 计划：块级拒绝/最终内容重放时跳过重复扫描
        if (options?.structuredHunkPlan) {
            pendingDiff.structuredHunkPlan = options.structuredHunkPlan;
        }

        // checkpoint 写盘屏障：写盘前必须等待其完成（缺省 undefined 行为不变）
        if (options?.checkpointReady) {
            pendingDiff.checkpointReady = options.checkpointReady;
        }

        // PERF-CP：deferred 模式的写盘锁持有者身份（缺省 undefined 时入口持锁语义不变）
        if (options?.lockHolder) {
            pendingDiff.lockHolder = options.lockHolder;
        }

        // 显式记录屏障状态，前端在尚未就绪时显示“准备中”，而不是提前进入 0.0s/执行中。
        pendingDiff.writeReady = !options?.checkpointReady && !options?.lockHolder;

        // 检查diff 警戒值
        const guardResult = this.checkDiffGuard(originalContent, newContent);
        if (guardResult.warning) {
            pendingDiff.diffGuardWarning = guardResult.warning;
        }
        pendingDiff.diffGuardDeletePercent = guardResult.deletePercent;

        // 获取完整配置以决定是否跳过diff 视图
        // 当 confirmedByToolConfirmation 为 true 时，说明上层（如 SubAgent 或工具确认弹窗）
        // 已经批准了本次写入，此时直接应用保存，不再要求 autoSave 也必须开启。
        // autoSave 是控制”diff 预览中是否自动保存内容”的独立设置，与”用户是否已确认”正交。
        const fullConfig = this.getFullApplyDiffConfig();
        const shouldDirectApplyConfirmedToolDiff =
            options?.confirmedByToolConfirmation === true;
        const shouldSkipDiffView = shouldDirectApplyConfirmedToolDiff ||
            (fullConfig?.autoSave && fullConfig?.autoApplyWithoutDiffView);

        // 无条件注册并预热虚拟原文档。上一轮只预热真实目标文档，首个 vscode.diff
        // 仍需冷启动左侧内容提供器/语言模式/Diff 模型，界面外壳出现后仍可能停顿。
        this.contentProvider.setContent(id, originalContent);
        this.prewarmDocument(this.getOriginalContentUri(pendingDiff));

        // 如果有块信息且不跳过 diff 视图，懒注册 CodeLens 会话
        if (blocks && !shouldSkipDiffView) {
            const provider = getDiffCodeLensProvider();
            provider.addSession({
                id,
                filePath,
                absolutePath,
                blocks: blocks.map(b => ({ ...b, confirmed: false, rejected: false })),
                originalContent,
                newContent,
                timestamp: Date.now()
            });

            // 设置回调
            provider.setConfirmCallback(async (sessionId, blockIndex) => {
                if (blockIndex === undefined) {
                    await this.acceptDiff(sessionId, true);
                } else {
                    await this.confirmBlock(sessionId, blockIndex);
                }
            });

            provider.setRejectCallback(async (sessionId, blockIndex) => {
                if (blockIndex === undefined) {
                    await this.rejectDiff(sessionId);
                } else {
                    await this.rejectBlock(sessionId, blockIndex);
                }
            });
        }

        let pendingStatePublished = false;
        let publishedBeforeWriteReady = false;

        // 根据配置决定是否显示 diff 视图
        if (shouldSkipDiffView) {
            // 跳过 diff 视图：先完成 checkpoint + 写锁屏障，再直接写入并保存
            await this.ensureDiffWriteReady(pendingDiff);
            await this.directApplyAndSave(pendingDiff);
        } else {
            // 显示 diff 视图
            try {
                await this.showDiffView(pendingDiff);
            } catch (error) {
                console.warn(
                    `[DiffManager] Failed to open diff view for ${filePath}; keeping pending diff available for manual apply/reject.`,
                    error
                );
            }

            if (pendingDiff.status === 'pending') {
                // 无屏障路径在首次发布前即可启动计时，整条状态只广播一次。
                // 有屏障路径先发布“准备中”，屏障完成后再发布真实倒计时。
                if (pendingDiff.writeReady && this.getSettings().autoSave) {
                    this.scheduleAutoSave(id, false);
                }
                this.notifyStatusChange();
                pendingStatePublished = true;
                publishedBeforeWriteReady = !pendingDiff.writeReady;
            }

            // checkpoint 与预览并发；真正写盘、手动接受和自动保存都复用同一屏障。
            await this.ensureDiffWriteReady(pendingDiff);
        }

        // 屏障完成后才按最新配置启动倒计时。配置可能在 checkpoint 扫描期间被修改，
        // 因而不能复用 createPendingDiff 开头读取的旧快照。
        if (pendingDiff.status === 'pending' && (!pendingStatePublished || publishedBeforeWriteReady)) {
            if (this.getSettings().autoSave) {
                this.scheduleAutoSave(id, false);
            }
            this.notifyStatusChange();
        }

        return pendingDiff;
    }

    /**
     * checkpoint 写盘屏障：存在 checkpointReady 时先等待其完成再写盘。
     * reject 时向上抛，由调用方走现有失败收敛（转 rejected / 回退 diff 视图 / 失败返回），
     * 避免在 checkpoint 未落盘时把内容写到磁盘。
     */
    private async awaitCheckpointBeforeWrite(diff: PendingDiff): Promise<void> {
        if (diff.checkpointReady) {
            await diff.checkpointReady;
        }
    }

    /**
     * 返回单个 Diff 的共享写入就绪 Promise。
     *
     * 状态发布与自动确认可以先发生，但 checkpoint 完成和 deferred 写锁获取必须只执行一次；
     * 否则 createPendingDiff 与 50ms 自动确认同时等待后会对同一 holder 重入加锁，终结时只
     * release 一次便会残留锁。所有写盘/回滚入口都通过本方法汇合。
     */
    private ensureDiffWriteReady(diff: PendingDiff): Promise<void> {
        if (diff.writeReady || diff.lockAcquired) {
            diff.writeReady = true;
            return Promise.resolve();
        }

        const existing = this.writeReadyPromises.get(diff.id);
        if (existing) {
            return existing;
        }

        const promise = this.acquireWriteLockForDiff(diff).then(() => {
            if (diff.status === 'pending') {
                diff.writeReady = true;
            }
        });
        this.writeReadyPromises.set(diff.id, promise);
        const clear = () => {
            if (this.writeReadyPromises.get(diff.id) === promise) {
                this.writeReadyPromises.delete(diff.id);
            }
        };
        // 同时注册成功/失败清理，返回的 then Promise 不会 reject，避免 fire-and-forget 未处理拒绝。
        void promise.then(clear, clear);
        return promise;
    }

    /**
     * PERF-CP：等待 checkpoint 后获取 deferred 写盘锁。
     * 冲突时把 diff 收敛为 rejected 并抛错；缺省无 lockHolder 时只执行 checkpoint 屏障。
     */
    private async acquireWriteLockForDiff(diff: PendingDiff): Promise<void> {
        await this.awaitCheckpointBeforeWrite(diff);
        // 等待期间可能已被取消/拒绝；此时绝不能迟到加锁，否则 cleanup 已执行而锁无人释放。
        if (diff.status !== 'pending' || diff.lockAcquired) {
            return;
        }
        if (!diff.lockHolder) {
            return;
        }
        const result = fileWriteLockManager.tryAcquire([diff.absolutePath], diff.lockHolder);
        if (!result.acquired) {
            const conflictText = result.conflicts
                .map(c => {
                    const holderName = c.holder.kind === 'subagent'
                        ? `agent "${c.holder.label}"`
                        : (c.holder.kind === 'checkpoint' ? 'a checkpoint operation' : c.holder.label);
                    return `'${c.path}' is currently being modified by ${holderName}`;
                })
                .join('; ');
            // H4：锁冲突时 diff 预览可能已把编辑器 buffer 覆盖为 AI 内容并标脏，
            // 必须先恢复原始内容并清 dirty，否则用户 Ctrl+S 会把未确认的 AI 内容写盘。
            // 恢复期间标记 rejecting：doc.save() 清 dirty 会触发 willSave/save 监听器，
            // 与 rejectDiffUnlocked 的做法一致，避免监听器在 finalize 之前抢先结算 diff。
            // 恢复是 best-effort（失败只告警，不掩盖锁冲突错误）；dirty 拒绝预览等 buffer
            // 未污染的幂等场景由 restoreOriginalContentBestEffort 内部按 H1 判据跳过。
            let restoreSucceeded = true;
            this.rejectingDiffIds.add(diff.id);
            try {
                await this.restoreOriginalContentBestEffort(diff);
            } catch (error) {
                restoreSucceeded = false;
                console.warn(`[DiffManager] Failed to restore original content after write lock conflict for ${diff.filePath}:`, error);
            } finally {
                this.rejectingDiffIds.delete(diff.id);
            }
            this.finalizeRejectedDiff(diff);
            // 恢复成功才关 tab：closeDiffTab 对 dirty 文档有静默 save 兜底，恢复失败时
            // buffer 仍是未确认的 AI 内容，此时关 tab 会把 AI 内容写盘（与 rejectDiffUnlocked
            // 在恢复失败时中断、不进入 closeDiffTab 的安全语义一致）。
            if (restoreSucceeded) {
                try {
                    await this.closeDiffTab(diff.absolutePath);
                } catch (error) {
                    console.warn(`[DiffManager] Failed to close diff tab after write lock conflict for ${diff.filePath}:`, error);
                }
            }
            throw new Error(
                `File write conflict: ${conflictText}. `
                + `Do not loop on this file. Work on other parts of your task first, `
                + `then retry after the current holder finishes (the lock is released automatically). `
                + `If it is still locked on retry, mention it in your final response so the main session can coordinate.`
            );
        }
        diff.lockAcquired = true;
    }

    /**
     * 直接应用修改并保存（不打开 diff 视图）
     * 用于 autoApplyWithoutDiffView 模式
     */
    private async directApplyAndSave(diff: PendingDiff): Promise<void> {
        try {
            // checkpoint 写盘屏障：checkpoint 未就绪（或失败）前不落盘
            await this.awaitCheckpointBeforeWrite(diff);

            // 直接写入文件到磁盘
            fs.writeFileSync(diff.absolutePath, diff.newContent, 'utf8');

            // 如果文档已在编辑器中打开，用 WorkspaceEdit 静默替换为 AI 内容：
            // 不能调用 openDoc.save() —— save 会把编辑器缓冲区（旧内容 + 用户未保存编辑）写回磁盘，
            // 覆盖刚写入的 AI 内容；也不能用 workbench.action.files.revert —— 文档 dirty 时会弹出
            // VS Code 原生"是否放弃更改？"确认框，阻塞整个 diff 流程直到用户点击。
            // 正确顺序：先写盘，再把编辑器内容替换为同一份 newContent，最后 save() 清理 dirty
            // （此时缓冲区与磁盘一致，保存无害、无弹框）。
            const openDoc = vscode.workspace.textDocuments.find(d => sameFsPath(d.uri.fsPath, diff.absolutePath));
            if (openDoc) {
                try {
                    const fullRange = new vscode.Range(
                        openDoc.positionAt(0),
                        openDoc.positionAt(openDoc.getText().length)
                    );
                    const edit = new vscode.WorkspaceEdit();
                    edit.replace(openDoc.uri, fullRange, diff.newContent);
                    const applied = await vscode.workspace.applyEdit(edit);
                    if (applied) {
                        // applyEdit 会把文档标脏（即便内容与磁盘一致），save() 清理 dirty
                        await openDoc.save();
                    } else {
                        console.warn(
                            `[DiffManager] directApplyAndSave: failed to sync editor content for ${diff.filePath}`
                        );
                    }
                } catch (error) {
                    // 编辑器同步失败不影响已完成的磁盘写入，仅记录
                    console.warn(`[DiffManager] directApplyAndSave: editor sync failed for ${diff.filePath}`, error);
                }
            }

            // 标记为已接受
            this.finalizeAcceptedDiff(diff);

            vscode.window.setStatusBarMessage(
                `$(check) ${t('tools.file.diffManager.savedShort', { filePath: diff.filePath })}`,
                3000
            );
        } catch (error) {
            console.error('[DiffManager] directApplyAndSave failed:', error);
            // 回退到显示diff 视图
            await this.showDiffView(diff);
        }
    }

    /**
     * 确认单个块
     */
    public async confirmBlock(sessionId: string, blockIndex: number): Promise<void> {
        const diff = this.pendingDiffs.get(sessionId);
        if (!diff || diff.status !== 'pending') {
            return;
        }
        try {
            // 状态可能在首个 checkpoint 完成前已发布；先在全局动作队列外等待共享屏障，
            // 避免块级操作占住队列，阻塞取消与其他 Diff 动作。
            await this.ensureDiffWriteReady(diff);
        } catch {
            return;
        }
        if (diff.status !== 'pending') {
            return;
        }
        await this.runDiffActionSerialized(() => this.confirmBlockUnlocked(sessionId, blockIndex));
    }

    private async confirmBlockUnlocked(sessionId: string, blockIndex: number): Promise<void> {
        this.diffSessions.get(sessionId)?.markPresented();
        const provider = getDiffCodeLensProvider();
        provider.updateBlockStatus(sessionId, blockIndex, true);

        // 如果所有块都处理完了，自动结束整个 diff
        if (provider.isSessionComplete(sessionId)) {
            const session = provider.getSession(sessionId);
            // 理论上confirmBlock 一定会有confirmed，因此不太可能allRejected，但这里仍做保护
            const allRejected = !!session && session.blocks.length > 0 && session.blocks.every(b => b.rejected);
            if (allRejected) {
                await this.rejectDiffUnlocked(sessionId);
            } else {
                await this.acceptDiffUnlocked(sessionId, true);
            }
        }
    }

    /**
     * 拒绝单个块
     */
    public async rejectBlock(sessionId: string, blockIndex: number): Promise<void> {
        const diff = this.pendingDiffs.get(sessionId);
        if (!diff || diff.status !== 'pending') {
            return;
        }
        try {
            await this.ensureDiffWriteReady(diff);
        } catch {
            return;
        }
        if (diff.status !== 'pending') {
            return;
        }
        await this.runDiffActionSerialized(() => this.rejectBlockUnlocked(sessionId, blockIndex));
    }

    private async rejectBlockUnlocked(sessionId: string, blockIndex: number): Promise<void> {
        this.diffSessions.get(sessionId)?.markPresented();
        const provider = getDiffCodeLensProvider();
        provider.updateBlockStatus(sessionId, blockIndex, false);

        // 实时更新编辑器内容，移除被拒绝的块
        const diff = this.pendingDiffs.get(sessionId);
        if (diff && diff.rawDiffs && diff.rawDiffs.length > 0) {
            let tempContent = diff.originalContent;
            const session = provider.getSession(sessionId);
            if (session) {
                // 本次需要应用的块（未被拒绝）
                const applyIndices = new Set<number>();
                for (let i = 0; i < diff.rawDiffs.length; i++) {
                    const blockInfo = session.blocks.find(b => b.index === i);
                    if (blockInfo && !blockInfo.rejected) {
                        applyIndices.add(i);
                    }
                }

                const first = diff.rawDiffs[0];

                if (isStructuredDiffHunk(first)) {
                    // 为什么结构化 hunk 要优先处理：它和 legacy search/replace 字段名不同，但同样需要支持块级拒绝后的内容重算。
                    // 怎么改：复用 apply_diff 导出的结构化应用函数，并传入未拒绝块索引集合；
                    // 同时传入首次应用时缓存的计划，起始内容一致且计划覆盖时直接按计划拼接，跳过重复扫描。
                    // 目的：避免拒绝某个hunk 后用旧start_line 逻辑误算后续重复内容，并复用已算好的匹配结果。
                    try {
                        const hunks = diff.rawDiffs as StructuredDiffHunk[];
                        const r = applyStructuredDiffHunksBestEffort(tempContent, hunks, { applyIndices, plan: diff.structuredHunkPlan });
                        tempContent = r.newContent;

                        for (const h of r.blocks) {
                            const blockInfo = session.blocks.find(b => b.index === h.index);
                            if (blockInfo) {
                                blockInfo.startLine = h.startLine;
                                blockInfo.endLine = h.endLine;
                            }
                        }
                    } catch (e) {
                        console.warn('[DiffManager] Failed to recompute structured diff content after rejecting a block:', e);
                    }
                } else if (isUnifiedDiffHunk(first)) {
                    // unified diff hunks：重新从 originalContent 计算“仅包含未拒绝块”的最终内容
                    try {
                        const hunks = diff.rawDiffs as UnifiedDiffHunk[];
                        const r = applyUnifiedDiffHunks(tempContent, hunks, { applyIndices });
                        tempContent = r.newContent;

                        // 更新各块在当前内容中的范围
                        for (const h of r.appliedHunks) {
                            const blockInfo = session.blocks.find(b => b.index === h.index);
                            if (blockInfo) {
                                blockInfo.startLine = h.startLine;
                                blockInfo.endLine = h.endLine;
                            }
                        }
                    } catch (e) {
                        console.warn('[DiffManager] Failed to recompute unified diff content after rejecting a block:', e);
                    }
                } else {
                    // legacy search/replace diffs（向后兼容）
                    let lineDelta = 0;
                    for (let i = 0; i < diff.rawDiffs.length; i++) {
                        const blockInfo = session.blocks.find(b => b.index === i);
                        const d = diff.rawDiffs[i];
                        if (!blockInfo || blockInfo.rejected || !isLegacySearchReplaceDiff(d)) {
                            continue;
                        }

                        const replaceLines = d.replace.split('\n').length;

                        // start_line 相对原始文件：前序 hunk 应用改变了行数后必须累计偏移，
                        // 否则第二个及以后的 hunk 整体错位
                        const adjustedStartLine = typeof d.start_line === 'number' && d.start_line > 0
                            ? d.start_line + lineDelta
                            : d.start_line;

                        const result = applyDiffToContent(tempContent, d.search, d.replace, adjustedStartLine);
                        if (result.success && result.matchedLine !== undefined) {
                            tempContent = result.result;

                            // 更新此块在当前内容中的范围
                            blockInfo.startLine = result.matchedLine;
                            blockInfo.endLine = result.matchedLine + replaceLines - 1;

                            // 累计行数变化：replace 行数 - search 行数（replaceLines 是展示行数，勿用于偏移）
                            lineDelta += countLineBreaks(normalizeLineEndings(d.replace)) - countLineBreaks(normalizeLineEndings(d.search));
                        }
                    }
                }

                // 更新编辑器
                const uri = vscode.Uri.file(diff.absolutePath);
                const doc = vscode.workspace.textDocuments.find(d => sameFsPath(d.uri.fsPath, diff.absolutePath));
                if (doc) {
                    const edit = new vscode.WorkspaceEdit();
                    const fullRange = new vscode.Range(
                        doc.positionAt(0),
                        doc.positionAt(doc.getText().length)
                    );
                    edit.replace(uri, fullRange, tempContent);
                    await vscode.workspace.applyEdit(edit);
                }
            }
        }

        // 如果所有块都处理完了，自动结束
        if (provider.isSessionComplete(sessionId)) {
            const session = provider.getSession(sessionId);
            const allRejected = !!session && session.blocks.length > 0 && session.blocks.every(b => b.rejected);

            // 全部块都被拒绝：视为用户明确拒绝本次 diff（不保存任何更改）
            if (allRejected) {
                await this.rejectDiffUnlocked(sessionId);
            } else {
                // 部分接受/部分拒绝：保存“剩余接受的块”
                await this.acceptDiffUnlocked(sessionId, true);
            }
        }
    }

    private hasRejectedBlocks(id: string): boolean {
        const session = getDiffCodeLensProvider().getSession(id);
        return !!session && session.blocks.some(b => b.rejected);
    }

    private computeFinalSuggestedContent(id: string, diff: PendingDiff): string {
        // 计算最终内容（仅包含已确认的块）
        let finalContent = diff.newContent;

        if (!diff.rawDiffs || diff.rawDiffs.length === 0) {
            return finalContent;
        }

        const provider = getDiffCodeLensProvider();
        const session = provider.getSession(id);
        if (!session) {
            return finalContent;
        }

        const rejectedBlocks = session.blocks.filter(b => b.rejected);
        if (rejectedBlocks.length === 0) {
            return finalContent;
        }

        // 有被拒绝的块，重新计算内容
        finalContent = diff.originalContent;

        // 需要应用的块（未被拒绝）
        const applyIndices = new Set<number>();
        for (let i = 0; i < diff.rawDiffs.length; i++) {
            const blockInfo = session.blocks.find(b => b.index === i);
            if (blockInfo && !blockInfo.rejected) {
                applyIndices.add(i);
            }
        }

        const first = diff.rawDiffs[0];

        if (isStructuredDiffHunk(first)) {
            // 为什么finalContent 也要支持结构化hunk：保存前会根据用户拒绝的块重新计算最终建议内容。
            // 怎么改：复用同一个结构化应用函数，只应用未拒绝的 hunk 索引；
            // 同时传入首次应用时缓存的计划，起始内容一致且计划覆盖时直接按计划拼接，跳过重复扫描。
            // 目的：确保编辑器实时内容和最终落盘内容使用完全一致的重放规则，且不重复付出扫描成本。
            try {
                const hunks = diff.rawDiffs as StructuredDiffHunk[];
                const r = applyStructuredDiffHunksBestEffort(finalContent, hunks, { applyIndices, plan: diff.structuredHunkPlan });
                finalContent = r.newContent;
            } catch (e) {
                console.warn('[DiffManager] Failed to recompute final suggested content for structured diff:', e);
            }
        } else if (isUnifiedDiffHunk(first)) {
            // unified diff hunks
            try {
                const hunks = diff.rawDiffs as UnifiedDiffHunk[];
                const r = applyUnifiedDiffHunks(finalContent, hunks, { applyIndices });
                finalContent = r.newContent;
            } catch (e) {
                console.warn('[DiffManager] Failed to recompute final suggested content for unified diff:', e);
            }
        } else {
            // legacy search/replace diffs
            for (let i = 0; i < diff.rawDiffs.length; i++) {
                const blockInfo = session.blocks.find(b => b.index === i);
                const d = diff.rawDiffs[i];
                if (!blockInfo || blockInfo.rejected || !isLegacySearchReplaceDiff(d)) {
                    continue;
                }

                const result = applyDiffToContent(finalContent, d.search, d.replace, d.start_line);
                if (result.success) {
                    finalContent = result.result;
                }
            }
        }

        return finalContent;
    }

    /**
     * 显示内联 diff 视图（入串行队列，M13/C7）
     */
    private async showDiffView(diff: PendingDiff): Promise<void> {
        await this.runDiffActionSerialized(() => this.showDiffViewUnlocked(diff));
    }

    /**
     * 显示内联 diff 视图（队列内执行体）
     */
    private async showDiffViewUnlocked(diff: PendingDiff): Promise<void> {
        const fileUri = vscode.Uri.file(diff.absolutePath);
        this.diffSessions.get(diff.id)?.markPresented();

        const isPending = () => diff.status === 'pending';

        const restoreToOriginalBestEffort = async (): Promise<void> => {
            try {
                const doc = vscode.workspace.textDocuments.find(d => sameFsPath(d.uri.fsPath, diff.absolutePath));
                const targetDoc = doc || (await vscode.workspace.openTextDocument(fileUri));
                const edit = new vscode.WorkspaceEdit();
                const fullRange = new vscode.Range(
                    targetDoc.positionAt(0),
                    targetDoc.positionAt(targetDoc.getText().length)
                );
                // H1：预览前若已捕获用户未保存内容（dirty 拒绝预览场景），
                // 恢复时优先回写用户版本而非磁盘 originalContent，避免丢失未保存编辑。
                const restoreContent = diff.userUnsavedContentBeforePreview ?? diff.originalContent;
                edit.replace(fileUri, fullRange, restoreContent);
                await vscode.workspace.applyEdit(edit);
            } catch {
                // ignore
            }
        };

        // 如果在进入showDiffView 之前就已被处理（例如 cancelAllPending 先一步发生），直接短路
        if (!isPending()) {
            return;
        }

        // 1. 打开并修改目标文档（不保存）。
        // 用 WorkspaceEdit 而非 showTextDocument + editor.edit：
        // - 不需要打开可见的文件本体 tab（后面只展示 diff tab），
        //   避免多开一个 tab 并把焦点从聊天输入框抢走（用户可能正在打字）
        const document = await this.consumePrewarmedDocument(fileUri);
        if (!isPending()) {
            return;
        }

        // H1 数据丢失防护：目标文档存在未保存修改时拒绝本次预览。
        //
        // 为什么拒绝而不是"记录用户版本 + 预览后恢复"：
        // - 预览覆盖 buffer 显示 AI 版本后，拒绝/取消恢复时若回写磁盘 originalContent，
        //   用户的未保存内容会永久丢失（本 bug 的根因）；
        // - diff 对象仅存在于内存，若会话在预览期间被 reload（扩展重启/工作区重载），
        //   用户 buffer 无法从任何持久化源恢复；
        // - "接受"路径同样有风险：缓冲区的用户未保存内容可能被 AI 内容静默覆盖。
        // 取舍：dirty 时直接不覆盖 buffer、不显示 diff 视图，记录用户版本并向用户提示先保存，
        // 工具结果返回可读错误（autoSaveError），用户保存后重试即可。简单可靠，零数据丢失。
        if (document && document.isDirty) {
            diff.userUnsavedContentBeforePreview = document.getText();
            diff.autoSaveError = 'The file has unsaved changes in the editor. Save the file first, then retry the tool call. The change was not applied to avoid overwriting your unsaved edits.';
            try {
                vscode.window.showWarningMessage?.(
                    `"${diff.filePath}" 存在未保存的修改。为避免丢失您的内容，本次修改未应用。请先保存文件（Ctrl+S）后再重试。`
                );
            } catch {
                // ignore
            }
            this.finalizeRejectedDiff(diff);
            return;
        }

        const fullRange = new vscode.Range(
            document.positionAt(0),
            document.positionAt(document.getText().length)
        );
        const applyModificationEdit = new vscode.WorkspaceEdit();
        applyModificationEdit.replace(fileUri, fullRange, diff.newContent);
        await vscode.workspace.applyEdit(applyModificationEdit);

        // 若在 apply edit 过程中被取消/拒绝，立即恢复原始内容并退出，避免留下脏文档
        if (!isPending()) {
            await restoreToOriginalBestEffort();
            try {
                await this.closeDiffTab(diff.absolutePath);
            } catch {
                // ignore
            }
            return;
        }

        // 2. 复用提前打开的原始内容虚拟文档。目标文档预热只覆盖右侧；左侧若留到
        // vscode.diff 内部首次打开，仍会在编辑器外壳出现后触发内容提供器与 Diff 模型冷启动。
        const originalUri = this.getOriginalContentUri(diff);
        await this.consumePrewarmedDocument(originalUri);
        if (!isPending()) {
            await restoreToOriginalBestEffort();
            return;
        }

        // 3. 打开 diff 视图
        const title = t('tools.file.diffManager.diffTitle', { filePath: diff.filePath });
        if (!isPending()) {
            await restoreToOriginalBestEffort();
            return;
        }
        const targetViewColumn = resolveDiffTargetViewColumn();
        await vscode.commands.executeCommand('vscode.diff', originalUri, fileUri, title, {
            preview: false,
            preserveFocus: true,
            // 原生工具审阅不经过 Webview DiffHandlers，必须在统一 DiffManager 入口显式指定列。
            // 否则焦点位于 SubAgent Monitor 时，VS Code 会把 diff 打开到 Monitor 所在编辑器组。
            viewColumn: targetViewColumn
        });

        // 若在打开 diff 视图期间被取消拒绝，关闭diff 并恢复原始内容，避免 UI 残留
        if (!isPending()) {
            try {
                await this.closeDiffTab(diff.absolutePath);
            } catch {
                // ignore
            }
            await restoreToOriginalBestEffort();
            return;
        }

        // 5. 监听文档即将保存事件
        const willSaveListener = vscode.workspace.onWillSaveTextDocument((event) => {
            if (!sameFsPath(event.document.uri.fsPath, diff.absolutePath) || diff.status !== 'pending') {
                return;
            }

            if (this.isDiffActionInProgress(diff.id)) {
                return;
            }

            const currentSettings = this.getSettings();
            const isManualOrAutoSave = currentSettings.autoSave || event.reason === vscode.TextDocumentSaveReason.Manual;

            // 预览可在 checkpoint/写锁就绪前发布；只有确实存在屏障时才挂 waitUntil，
            // 保持普通（入口已持锁、无 checkpoint）路径零额外 Promise。
            if (diff.checkpointReady || (diff.lockHolder && !diff.lockAcquired)) {
                event.waitUntil(this.ensureDiffWriteReady(diff));
            }

            if (isManualOrAutoSave) {
                return;
            }

            // 非手动保存（如 files.autoSave）：记标记让自动保存直接落盘，
            // 不再触发 event.waitUntil 回退 + restorePendingDraft 的回写循环。
            this.nonManualSaveFlushed.add(diff.id);
        });

        // 6. 监听文档保存事件
        const saveListener = vscode.workspace.onDidSaveTextDocument(async (savedDoc) => {
            if (!sameFsPath(savedDoc.uri.fsPath, diff.absolutePath) || diff.status !== 'pending') {
                return;
            }

            if (this.isDiffActionInProgress(diff.id)) {
                return;
            }

            // 非手动保存（auto-save 等）已直接落盘：跳过回退恢复，保持 diff pending
            if (this.nonManualSaveFlushed.has(diff.id)) {
                this.nonManualSaveFlushed.delete(diff.id);
                return;
            }

            // 检查用户是否修改了内容（保存时的最终内容）
            const savedContent = savedDoc.getText();

            if (savedContent === diff.originalContent) {
                this.finalizeRejectedDiff(diff);

                const currentSettings = this.getSettings();
                if (!currentSettings.autoSave) {
                    await this.closeDiffTab(diff.absolutePath);
                }
                return;
            }

            // 以“系统建议将保存的内容”为基准（考虑 CodeLens 拒绝块等）
            const baseSuggestedContent = this.computeFinalSuggestedContent(diff.id, diff);

            if (savedContent !== baseSuggestedContent && savedContent !== diff.originalContent) {
                // 仅保留摘要，不在工具响应里发送完整文件内容
                diff.userEditedContent = computeUserEditedNewLinesSummary(baseSuggestedContent, savedContent);
            }

            this.finalizeAcceptedDiff(diff, { partial: !!diff.userEditedContent || this.hasRejectedBlocks(diff.id) });

            // 非自动保存模式下，用户手动保存后自动关闭 diff 标签页
            const currentSettings = this.getSettings();
            if (!currentSettings.autoSave) {
                await this.closeDiffTab(diff.absolutePath);
            }
        });

        // 7. 监听文档关闭事件
        const closeListener = vscode.workspace.onDidCloseTextDocument((closedDoc) => {
            if (!sameFsPath(closedDoc.uri.fsPath, diff.absolutePath) || diff.status !== 'pending') {
                return;
            }

            if (this.isDiffActionInProgress(diff.id)) {
                return;
            }

            try {
                const currentContent = fs.readFileSync(diff.absolutePath, 'utf8');
                if (currentContent === diff.newContent) {
                    // 磁盘已是 AI 内容（如 files.autoSave 直接落盘后用户关闭标签页）：
                    // 收敛为接受，避免 diff 永久 pending 导致工具等待链悬挂
                    this.finalizeAcceptedDiff(diff);
                } else {
                    this.finalizeRejectedDiff(diff);
                }
            } catch (e) {
                // 读文件失败（文件被删除、权限问题等）：收敛 diff 为拒绝，避免永久 pending
                this.finalizeRejectedDiff(diff);
                if (diff.newFile) {
                    try { fs.unlinkSync(diff.absolutePath); } catch { /* ignore */ }
                }
            }
        });

        // 若在注册监听器期间被取消/拒绝，立即释放监听器并恢复内容，避免残留订阅造成后续错乱
        if (!isPending()) {
            try {
                willSaveListener.dispose();
            } catch {
                // ignore
            }
            try {
                saveListener.dispose();
            } catch {
                // ignore
            }
            try {
                closeListener.dispose();
            } catch {
                // ignore
            }
            try {
                await this.closeDiffTab(diff.absolutePath);
            } catch {
                // ignore
            }
            await restoreToOriginalBestEffort();
            return;
        }

        this.willSaveListeners.set(diff.id, willSaveListener);
        this.saveListeners.set(diff.id, saveListener);
        this.closeListeners.set(diff.id, closeListener);
    }

    /**
     * 设置自动保存定时器
     */
    private scheduleAutoSave(id: string, notify: boolean = true): void {
        const diff = this.pendingDiffs.get(id);
        if (!diff || diff.status !== 'pending') {
            return;
        }

        const hasWriteBarrier = !!diff.checkpointReady || (!!diff.lockHolder && !diff.lockAcquired);
        if (diff.writeReady === false || (diff.writeReady !== true && hasWriteBarrier)) {
            // 运行时修改配置或旧调用方可能在屏障完成前请求调度。不要提前消耗延迟，
            // 复用共享屏障；失败时明确拒绝，避免 pending 工具永久悬挂。
            void this.ensureDiffWriteReady(diff).then(
                () => {
                    if (diff.status === 'pending' && this.getSettings().autoSave) {
                        this.scheduleAutoSave(id, notify);
                    }
                },
                async () => {
                    await this.finalizeAutoSaveFailure(
                        id,
                        'Auto-save failed while accepting diff because the diff write barrier failed. The diff was rejected to unblock tool execution.'
                    );
                }
            );
            return;
        }
        diff.writeReady = true;

        const existingTimer = this.autoSaveTimers.get(id);
        if (existingTimer) {
            clearTimeout(existingTimer);
        }

        const currentSettings = this.getSettings();
        if (!currentSettings.autoSave) {
            this.autoSaveTimers.delete(id);
            this.diffSessions.get(id)?.clearAutoSave();
            delete diff.autoSaveAt;
            delete diff.scheduledAutoSaveDelay;
            if (notify) this.notifyStatusChange();
            return;
        }

        const delay = Math.max(0, currentSettings.autoSaveDelay);
        const session = this.diffSessions.get(id);
        diff.scheduledAutoSaveDelay = delay;
        diff.autoSaveAt = Date.now() + delay;

        const runAutoSave = async () => {
            this.autoSaveTimers.delete(id);
            delete diff.autoSaveAt;
            delete diff.scheduledAutoSaveDelay;
            // 自动保存：强制使用AI 建议的内容（避免覆盖用户可能正在进行的手动修改）
            const accepted = await this.acceptDiff(id, true, true);
            if (!accepted && diff.status === 'pending') {
                // 自动保存失败必须以明确rejected 收敛，否则等待diff 结束的工具Promise 会永久pending。
                await this.finalizeAutoSaveFailure(id, 'Auto-save failed while accepting diff. The diff was rejected to unblock tool execution.');
            }
        };

        const timer = session
            ? session.scheduleAutoSave(delay, runAutoSave)
            : setTimeout(runAutoSave, delay);

        this.autoSaveTimers.set(id, timer);
        if (notify) this.notifyStatusChange();
    }

    private async finalizeAutoSaveFailure(id: string, message: string): Promise<void> {
        const diff = this.pendingDiffs.get(id);
        if (!diff || diff.status !== 'pending') {
            return;
        }

        // 保留 acceptDiff 捕获到的底层保存错误；这里仅补充自动保存收敛语义，避免覆盖真实异常。
        diff.autoSaveError = diff.autoSaveError
            ? `${message} ${diff.autoSaveError}`
            : message;

        const rejected = await this.rejectDiff(id);
        if (rejected) {
            return;
        }

        // rejectDiff 也失败时只释放等待中的工具Promise，不再尝试保存或恢复，避免重复触发VS Code 编辑器竞态。
        this.finalizeRejectedDiff(diff);
    }

    /**
     * 接受 diff（保存修改）
     * @param id diff ID
     * @param closeTab 是否关闭标签页
     * @param isAutoSave 是否为自动保存（自动保存时强制使用AI 内容；手动接受时尽量保留用户编辑）
     */
    public async acceptDiff(id: string, closeTab: boolean = false, isAutoSave: boolean = false): Promise<boolean> {
        const diff = this.pendingDiffs.get(id);
        if (!diff || diff.status !== 'pending') {
            return false;
        }
        try {
            // 在进入全局动作队列前等待共享屏障，避免首个 checkpoint 较慢时占住整条队列，
            // 也保证提前发布状态后到来的自动/手动接受不会绕过 deferred 写锁。
            await this.ensureDiffWriteReady(diff);
        } catch {
            return false;
        }
        return this.runDiffActionSerialized(() => this.acceptDiffUnlocked(id, closeTab, isAutoSave));
    }

    private async acceptDiffUnlocked(id: string, closeTab: boolean = false, isAutoSave: boolean = false): Promise<boolean> {
        const diff = this.pendingDiffs.get(id);
        if (!diff || diff.status !== 'pending' || this.isDiffActionInProgress(id)) {
            return false;
        }

        this.acceptingDiffIds.add(id);
        if (isAutoSave) {
            this.notifyStatusChange();
        }

        try {
            // checkpoint + deferred 写锁共享屏障：即使状态已经提前发布、用户立即点击接受，
            // 也必须等待 createPendingDiff 启动的同一个 Promise，不能重复重入加锁。
            await this.ensureDiffWriteReady(diff);

            if (diff.status !== 'pending') {
                return false;
            }

            const finalContent = this.computeFinalSuggestedContent(id, diff);

            const uri = vscode.Uri.file(diff.absolutePath);
            let doc = vscode.workspace.textDocuments.find(d => sameFsPath(d.uri.fsPath, diff.absolutePath));

            // 如果文档未打开，先打开它
            if (!doc) {
                doc = await vscode.workspace.openTextDocument(uri);
            }

            // await 边界复查：openTextDocument 期间 diff 可能已被 cancelAllPending 等路径
            // finalize（恢复文件 + 标记 rejected/cancelled），继续执行会让 AI 内容在
            // 用户取消后仍被写回磁盘。
            if (diff.status !== 'pending') {
                return false;
            }

            const currentContent = doc.getText();

            // 自动保存：强制保存AI 计算出来的finalContent。
            // 手动接受：如果用户在编辑器中改过内容，则保留当前内容，不覆盖。
            let contentToSave = finalContent;

            if (isAutoSave || currentContent === diff.originalContent) {
                // 覆盖到finalContent（自动保存/ 文档仍是原始内容时）
                if (currentContent !== finalContent) {
                    const edit = new vscode.WorkspaceEdit();
                    const fullRange = new vscode.Range(
                        doc.positionAt(0),
                        doc.positionAt(currentContent.length)
                    );
                    edit.replace(uri, fullRange, finalContent);
                    const applied = await vscode.workspace.applyEdit(edit);
                    if (!applied) {
                        throw new Error(`Failed to stage accepted diff content for ${diff.filePath}`);
                    }
                    // 复查：applyEdit 的 await 间隙内可能已被取消/拒绝，中止后续写盘
                    if (diff.status !== 'pending') {
                        return false;
                    }
                }
                contentToSave = finalContent;
            } else {
                // currentContent != original => 认为用户已经在AI 建议上做了调整（包含手动编辑/拒绝部分块）
                if (currentContent !== finalContent) {
                    diff.userEditedContent = computeUserEditedNewLinesSummary(finalContent, currentContent);
                }
                contentToSave = currentContent;
            }

            const normalizeToLF = (text: string): string => text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

            const revertOpenDocumentToDisk = async (): Promise<void> => {
                try {
                    // 优先用 doc.save() 静默清 dirty（不会弹确认对话框）。
                    // workbench.action.files.revert 在文档 dirty 时会弹出 VSCode 原生
                    // “是否放弃对文件的更改？”确认框，阻塞整个 diff 流程。
                    if (doc.isDirty) {
                        const saved = await doc.save();
                        if (!saved) {
                            // doc.save 失败（比如磁盘在 openTextDocument 和 save 之间被外部改了），
                            // 此时才回退到 revert 命令作为最后手段
                            await vscode.commands.executeCommand('workbench.action.files.revert', doc.uri);
                        }
                    }
                } catch {
                    // ignore
                }
            };

            // 写盘前最终复查：任何 await 间隙都可能触发取消，不能把 AI 内容写回磁盘
            if (diff.status !== 'pending') {
                return false;
            }

            // 读取磁盘内容，用于判断是否需要绕过doc.save（doc.save 在磁盘变更时会触发VSCode 冲突提示）
            let diskContent: string | undefined;
            try {
                diskContent = fs.readFileSync(diff.absolutePath, 'utf8');
            } catch {
                diskContent = undefined;
            }

            const saveNormalized = normalizeToLF(contentToSave);
            const diskNormalized = diskContent !== undefined ? normalizeToLF(diskContent) : undefined;
            const originalNormalized = normalizeToLF(diff.originalContent);

            // 1) 若磁盘内容已经等于要保存的内容：用 doc.save() 静默清 dirty。
            // 不能用 workbench.action.files.revert——文档 dirty 时 revert 会弹出
            // VSCode 原生确认对话框（"是否放弃对文件的更改？"），阻塞 diff 流程。
            // save() 是同步静默的：磁盘内容与内存一致时它只是清掉 dirty 标记，不写磁盘。
            if (diskNormalized !== undefined && diskNormalized === saveNormalized) {
                if (doc.isDirty) {
                    try {
                        await doc.save();
                    } catch {
                        // doc.save 失败时回退到 revert（日志记录但不阻塞）
                        await vscode.commands.executeCommand('workbench.action.files.revert', doc.uri);
                    }
                }
            }
            // 2) 若磁盘内容已不同于diff 创建时的 originalContent：说明中途被外部写入/回滚，绕过doc.save 强制写入后再 revert
            else if (diskNormalized !== undefined && diskNormalized !== originalNormalized) {
                fs.writeFileSync(diff.absolutePath, contentToSave, 'utf8');
                await revertOpenDocumentToDisk();
            }
            // 3) 磁盘仍为 originalContent：走 doc.save 快路径（保留 VSCode 的编码换行等保存策略）
            else {
                // await 边界复查：doc.save 的间隙内可能已被 saveListener/closeListener 终结，
                // 不能在取消/拒绝后继续保存。
                if (diff.status !== 'pending') {
                    return false;
                }
                let saved = false;
                try {
                    saved = await doc.save();
                } catch {
                    saved = false;
                }

                // 复查：doc.save 的 await 间隙可能触发取消，此时 writeFileSync 会把 AI 内容
                // 强写回磁盘（用户取消后内容仍落盘），必须中止。
                if (diff.status !== 'pending') {
                    return false;
                }

                if (!saved) {
                    // 如果 VSCode API 保存失败，尝试直接写入文件
                    fs.writeFileSync(diff.absolutePath, contentToSave, 'utf8');
                    await revertOpenDocumentToDisk();
                }
            }

            this.finalizeAcceptedDiff(diff, { partial: !!diff.userEditedContent || this.hasRejectedBlocks(id) });

            try {
                vscode.window.setStatusBarMessage(`$(check) ${t('tools.file.diffManager.savedShort', { filePath: diff.filePath })}`, 3000);
            } catch (error) {
                console.warn(`[DiffManager] Failed to show accepted status for ${diff.filePath}:`, error);
            }

            if (closeTab) {
                try {
                    await this.closeDiffTab(diff.absolutePath);
                } catch (error) {
                    console.warn(`[DiffManager] Failed to close diff tab for ${diff.filePath}:`, error);
                }
            }

            return true;
        } catch (error) {
            const message = t('tools.file.diffManager.saveFailed', { error: error instanceof Error ? error.message : String(error) });
            if (diff) {
                diff.autoSaveError = message;
            }
            vscode.window.showErrorMessage(message);
            return false;
        } finally {
            this.acceptingDiffIds.delete(id);
        }
    }

    /**
     * 关闭指定文件的diff 标签页
     *
     * preserveFocus 必须为 true：关闭活动的 diff 标签后 VSCode 会激活相邻标签，
     * 不保留焦点时光标会直接跳进新激活的代码编辑器。
     *
     * 但 preserveFocus 只能阻止焦点跳进编辑器，无法阻止 workbench 把焦点
     * 从侧边栏 webview 收走（聊天输入框仍会失焦）。因此关闭前采样
     * 输入框焦点状态，关闭后按需把焦点归还给聊天视图。
     */
    private async closeDiffTab(filePath: string): Promise<void> {
        // 安全网：关 diff tab 前确保底层文档不被 WorkspaceEdit 残留的 dirty 标记
        // 拖累出"是否保存更改？"VSCode 原生确认弹窗。save() 是静默的，不弹窗。
        const doc = vscode.workspace.textDocuments.find(d => sameFsPath(d.uri.fsPath, filePath));
        if (doc && doc.isDirty) {
            try {
                await doc.save();
            } catch {
                // ignore — 接受/拒绝路径已各自处理过保存，这里只是兜底
            }
        }

        let sampledRestoreFocus = false;
        let restoreFocus = false;
        for (const tabGroup of vscode.window.tabGroups.all) {
            for (const tab of tabGroup.tabs) {
                if (tab.input instanceof vscode.TabInputTextDiff) {
                    const diffInput = tab.input as vscode.TabInputTextDiff;
                    if (sameFsPath(diffInput.modified.fsPath, filePath)) {
                        // 采样必须在关闭前：关闭动作本身就是抓焦点的来源；
                        // 同一文件可能存在多个 diff tab（多次编辑产生多个预览），
                        // 全部关闭避免残留——只在首个匹配 tab 关闭前采样一次，
                        // 后续 tab 复用同一结果（此时输入框已失焦，重复采样会误判）。
                        if (!sampledRestoreFocus) {
                            restoreFocus = shouldRestoreChatInputFocus();
                            sampledRestoreFocus = true;
                        }
                        await vscode.window.tabGroups.close(tab, true);
                    }
                }
            }
        }
        if (sampledRestoreFocus) {
            await restoreChatInputFocus(restoreFocus);
        }
    }

    /**
     * 关标签页并删除新建文件残留（所有拒绝/取消路径的统一收敛点）。
     *
     * 为什么不在同步 finalize* 方法里做 unlink：finalize 不负责 I/O，
     * 把删文件逻辑集中在一个异步辅助方法里，避免各取消路径重复实现。
     */
    private async closeDiffTabAndCleanNewFile(id: string, diff: PendingDiff): Promise<void> {
        try {
            await this.closeDiffTab(diff.absolutePath);
        } catch (err) {
            console.warn(`[DiffManager] Failed to close diff tab for ${diff.absolutePath}:`, err);
        }
        if (diff.newFile) {
            try {
                fs.unlinkSync(diff.absolutePath);
            } catch (e) {
                console.warn(`[DiffManager] Failed to remove new file ${diff.filePath}:`, e);
            }
        }
    }

    /**
     * 恢复目标文件缓冲区/磁盘内容为 originalContent（rejectDiffUnlocked 与写盘锁冲突路径的公共实现）。
     *
     * 幂等安全：预览前文档 dirty（diff.userUnsavedContentBeforePreview 已记录）时，buffer 从未被
     * 覆盖过，任何恢复动作都会把用户未保存内容回滚成磁盘原文（H1），必须整体跳过——即使
     * showDiffView 失败（buffer 未污染）或锁冲突发生在 dirty 拒绝预览之后，重复调用也无副作用。
     * （cancelAllPendingUnlocked 保留其自身带 doc.isDirty 守卫的内联实现：取消路径只处理脏文档，
     * 且不做未打开文档的 fs 写回兜底，语义不同，不强制合一。）
     *
     * 失败抛错（不吞）：rejectDiffUnlocked 需要据此把「恢复失败」上报为拒绝失败；锁冲突等
     * 已确定失败的路径由调用方 try/catch 兜底（保持 best-effort 语义，不掩盖主错误）。
     */
    private async restoreOriginalContentBestEffort(diff: PendingDiff): Promise<void> {
        // H1：预览因目标文档 dirty 被拒绝时，buffer 从未被覆盖过，仍是用户未保存版本；
        // 这里任何恢复动作都会把用户未保存内容回滚成磁盘原文，必须整体跳过。
        if (diff.userUnsavedContentBeforePreview !== undefined) {
            return;
        }
        const uri = vscode.Uri.file(diff.absolutePath);
        const doc = vscode.workspace.textDocuments.find(d => sameFsPath(d.uri.fsPath, diff.absolutePath));

        if (doc) {
            const edit = new vscode.WorkspaceEdit();
            const fullRange = new vscode.Range(
                doc.positionAt(0),
                doc.positionAt(doc.getText().length)
            );
            edit.replace(uri, fullRange, diff.originalContent);
            const applied = await vscode.workspace.applyEdit(edit);
            if (!applied) {
                throw new Error(`Failed to restore original content for ${diff.filePath}`);
            }

            // WorkspaceEdit 会再次把文档标脏（即便内容已是原始值）。
            // 必须 save() 清理 dirty——否则 closeDiffTab 关闭 diff tab 后
            // VSCode 发现底层文本文档仍处于 dirty 状态，弹出"是否保存更改？"
            // 原生确认对话框，阻断整个 diff 流程并最终显示"被用户取消"。
            try {
                await doc.save();
            } catch {
                // doc.save 失败时回退到 revert（仅在 save 失败时弹出确认）
                try {
                    await vscode.commands.executeCommand('workbench.action.files.revert', doc.uri);
                } catch {
                    // ignore
                }
            }
        } else {
            // 如果文档没打开，直接写回原始文件内容确保万无一失
            fs.writeFileSync(diff.absolutePath, diff.originalContent, 'utf8');
        }
    }

    /**
     * 拒绝 diff（放弃修改）
     */
    public async rejectDiff(id: string): Promise<boolean> {
        const diff = this.pendingDiffs.get(id);
        if (!diff || diff.status !== 'pending') {
            return false;
        }
        try {
            await this.ensureDiffWriteReady(diff);
        } catch {
            return false;
        }
        return this.runDiffActionSerialized(() => this.rejectDiffUnlocked(id));
    }

    private async rejectDiffUnlocked(id: string): Promise<boolean> {
        const diff = this.pendingDiffs.get(id);
        if (!diff || diff.status !== 'pending' || this.isDiffActionInProgress(id)) {
            return false;
        }

        this.rejectingDiffIds.add(id);

        try {
            // checkpoint + deferred 写锁共享屏障：拒绝恢复原文同样属于写盘，且提前发布状态后
            // 可能在 createPendingDiff 返回前触发，必须复用同一个就绪 Promise。
            await this.ensureDiffWriteReady(diff);

            if (diff.status !== 'pending') {
                return false;
            }

            // 1. 恢复文件内容（H1 跳过判据与幂等语义见 restoreOriginalContentBestEffort；
            //    恢复失败抛错由外层 catch 收敛为"拒绝失败"，与既有行为一致）
            await this.restoreOriginalContentBestEffort(diff);

            // write_file 新建文件被拒绝：关 tab 并删除残留空文件
            if (diff.newFile) {
                await this.closeDiffTabAndCleanNewFile(id, diff);
                this.finalizeRejectedDiff(diff);
                this.rejectingDiffIds.delete(id);
                return true;
            }

            this.finalizeRejectedDiff(diff);

            try {
                await this.closeDiffTab(diff.absolutePath);
            } catch (error) {
                console.warn(`[DiffManager] Failed to close rejected diff tab for ${diff.filePath}:`, error);
            }

            return true;
        } catch (error) {
            console.error('Failed to reject diff:', error);
            return false;
        } finally {
            this.rejectingDiffIds.delete(id);
        }
    }

    /**
     * 接受所有待处理的diff
     */
    public async acceptAll(): Promise<number> {
        let count = 0;
        for (const [id, diff] of this.pendingDiffs.entries()) {
            if (diff.status === 'pending') {
                const success = await this.acceptDiff(id);
                if (success) {
                    count++;
                }
            }
        }
        return count;
    }

    /**
     * 拒绝所有待处理的diff
     */
    public async rejectAll(): Promise<number> {
        let count = 0;
        for (const [id, diff] of this.pendingDiffs.entries()) {
            if (diff.status === 'pending') {
                const success = await this.rejectDiff(id);
                if (success) {
                    count++;
                }
            }
        }
        return count;
    }

    /**
     * 清理资源
     */
    private cleanup(id: string): void {
        const timer = this.autoSaveTimers.get(id);
        if (timer) {
            clearTimeout(timer);
            this.autoSaveTimers.delete(id);
        }
        this.diffSessions.get(id)?.clearAutoSave();
        this.writeReadyPromises.delete(id);

        const diff = this.pendingDiffs.get(id);
        if (diff) {
            delete diff.autoSaveAt;
            delete diff.scheduledAutoSaveDelay;
        }

        this.contentProvider.removeContent(id);
        if (diff) {
            // 未进入/未完成 showDiffView（direct apply、dirty 拒绝、提前取消）时也要清理两侧
            // 预热缓存；Promise 本身可自然落定，Map 不再持有它。
            this.prewarmPromises.delete(this.getPrewarmKey(vscode.Uri.file(diff.absolutePath)));
            this.prewarmPromises.delete(this.getPrewarmKey(this.getOriginalContentUri(diff)));
        }

        // 移除 CodeLens 会话（会自动触发相关 UI 刷新）
        try {
            getDiffCodeLensProvider().removeSession(id);
        } catch (err) {
            console.warn(`[DiffManager] Failed to remove CodeLens session ${id}:`, err);
        }

        const tempDir = path.join(require('os').tmpdir(), 'gemini-diff');
        if (diff) {
            // PERF-CP：终结时释放写盘锁（deferred 模式审阅期间持有）
            if (diff.lockAcquired && diff.lockHolder) {
                fileWriteLockManager.release([diff.absolutePath], diff.lockHolder);
                diff.lockAcquired = false;
            }
            const tempFilePath = path.join(tempDir, `${id}-${path.basename(diff.filePath)}`);
            if (fs.existsSync(tempFilePath)) {
                fs.unlinkSync(tempFilePath);
            }
        }
    }

    /**
     * 获取所有待处理的diff
     */
    public getPendingDiffs(): PendingDiff[] {
        return Array.from(this.pendingDiffs.values()).filter(d => d.status === 'pending');
    }

    /**
     * 检查是否所有diff 都已处理
     */
    public areAllProcessed(): boolean {
        return this.getPendingDiffs().length === 0;
    }

    /**
     * 等待所有diff 被处理
     */
    public waitForAllProcessed(): Promise<void> {
        return new Promise((resolve) => {
            if (this.areAllProcessed()) {
                resolve();
                return;
            }

            const listener: StatusChangeListener = (_pending, allProcessed) => {
                if (allProcessed) {
                    this.removeStatusListener(listener);
                    resolve();
                }
            };

            this.addStatusListener(listener);
        });
    }

    /**
     * 等待指定 pending diff 结算。
     * 统一状态监听、用户中断与 AbortSignal；abort/user 中断都会主动 reject 当前 diff 并清理资源，
     * 避免文件已处理但工具 Promise 仍悬挂。
     */
    public waitForDiffResolution(id: string, abortSignal?: AbortSignal): Promise<DiffResolutionReason> {
        return new Promise<DiffResolutionReason>((resolve) => {
            let resolved = false;
            let abortHandler: (() => void) | undefined;
            let statusListener: StatusChangeListener | undefined;

            const finish = (reason: DiffResolutionReason) => {
                if (resolved) return;
                resolved = true;

                if (statusListener) {
                    this.removeStatusListener(statusListener);
                    statusListener = undefined;
                }

                if (abortHandler && abortSignal) {
                    try {
                        abortSignal.removeEventListener('abort', abortHandler);
                    } catch {
                        // ignore
                    }
                }

                resolve(reason);
            };

            const rejectAndFinish = (reason: Exclude<DiffResolutionReason, 'none'>) => {
                // 等 rejectDiff 落定后再 finish：立即 finish 会让调用方误以为文件已恢复，
                // 而 rejectDiff 走串行队列，可能失败（文件残留修改但报告成功结论）
                this.rejectDiff(id)
                    .catch((error: unknown) => {
                        console.error(`[DiffManager] rejectDiff failed while settling diff ${id}:`, error);
                    })
                    .then(() => finish(reason));
            };

            const checkStatus = () => {
                if (resolved) return;

                // 非消费 peek（不能调 getDiff）：accepted+partial 墓碑的消费点必须是
                // 工具终态 getDiff（await waitForDiffResolution 之后的那次读取）。
                // 若 checkStatus 用 getDiff 读后即删，会抢先消费墓碑，工具最终读取
                // 只得 undefined，FIFO 淘汰场景把"部分接受"误报为"全部接受"（回归）。
                const diff = this.peekDiff(id);

                // 按会话隔离检查中断标记
                if (this.isUserInterrupted(diff?.conversationId)) {
                    rejectAndFinish('user');
                    return;
                }

                if (!diff) {
                    // diff 已被 FIFO 淘汰：查淘汰记录区分"被拒绝"与"正常结算"，
                    // 避免被拒绝的 diff 被淘汰后误报"写入成功"。
                    if (this.evictedRejectedDiffIds.has(id)) {
                        this.evictedRejectedDiffIds.delete(id);
                        finish('rejected');
                        return;
                    }
                    finish('none');
                    return;
                }

                if (diff.status === 'rejected') {
                    finish('rejected');
                    return;
                }

                if (diff.status !== 'pending') {
                    finish('none');
                    return;
                }

                // 仍 pending：保持事件驱动等待，不轮询。旧的 100ms 轮询兜底已删除——
                // 它实际会从首次 checkStatus 起每 100ms 重复轮询（与 statusListener 事件驱动
                // 路径完全重复，是冗余代码而非不可达代码）。删除后安全性由以下不变式保证：
                // - statusListener 恒在首次 checkStatus 之前注册（见下方），
                //   不存在"注册前已结算"的竞态窗口；
                // - 全部结算路径都广播 notifyStatusChange：finalizeAcceptedDiff /
                //   finalizeRejectedDiff 直接调用；finalizeCancelledDiff 的唯一调用方
                //   cancelAllPendingUnlocked 在取消循环后广播（markUserInterrupt 的
                //   所有调用点均紧跟 cancelAllPending）；
                // - 广播发生在 evictOldFinalizedDiffs 之后，等待者 checkStatus 时
                //   getDiff 已能看到墓碑/undefined，走上方淘汰分支正确收敛。
            };

            abortHandler = () => {
                rejectAndFinish('abort');
            };

            if (abortSignal) {
                if (abortSignal.aborted) {
                    abortHandler();
                    return;
                }
                abortSignal.addEventListener('abort', abortHandler, { once: true } as any);
            }

            statusListener = () => {
                checkStatus();
            };
            this.addStatusListener(statusListener);

            // createPendingDiff 可能在autoApplyWithoutDiffView 或外部取消路径中已完成，
            // 所以注册监听后立刻检查一次，避免错过返回前发生的状态变化。
            checkStatus();
        });
    }

    /**
     * 标记用户中断（用户发送了新消息）
     * 这会让所有等待中的工具立即返回
     * @param conversationId 可选：按会话隔离中断，避免跨标签页强杀
     */
    public markUserInterrupt(conversationId?: string): void {
        globalUserInterrupt = true;
        if (conversationId) {
            interruptedConversationIds.add(conversationId);
        }
        // 取消匹配会话的自动保存定时器
        const timersToClear: string[] = [];
        for (const [id, timer] of this.autoSaveTimers.entries()) {
            const diff = this.pendingDiffs.get(id);
            if (!conversationId || diff?.conversationId === conversationId) {
                clearTimeout(timer);
                timersToClear.push(id);
            }
        }
        for (const id of timersToClear) {
            this.autoSaveTimers.delete(id);
        }
    }

    /**
     * 重置用户中断标记
     */
    public resetUserInterrupt(conversationId?: string): void {
        if (conversationId) {
            interruptedConversationIds.delete(conversationId);
            // 当所有会话都已重置时，同步清理全局标记。
            // 没有这个兜底，无 conversationId 的 diff 会被残留的 globalUserInterrupt 误伤。
            if (interruptedConversationIds.size === 0) {
                globalUserInterrupt = false;
            }
        } else {
            globalUserInterrupt = false;
            interruptedConversationIds.clear();
        }
    }

    /**
     * 检查是否被用户中断
     * @param conversationId 可选：按会话隔离检查
     */
    public isUserInterrupted(conversationId?: string): boolean {
        if (!globalUserInterrupt) {
            return false;
        }
        if (conversationId) {
            return interruptedConversationIds.has(conversationId);
        }
        // 未传 conversationId：退化为全局中断判定（向后兼容）。
        // 已知误伤面（有意保留，不改判据）：waitForDiffResolution 对无 conversationId 的
        // diff 传入 undefined，会命中其他会话触发的 per-conversation 中断。但生产链路全部
        // 经 DiffInterruptService 按会话标记，且各流程（orchestrator/editBranch/context/reroll）
        // 的 finally 都调 resetUserInterrupt 兜底清理全局标记，常见路径已被覆盖；
        // 若改为"仅无会话归属的全局中断才命中"，会与 diffManager.test.ts 对 isUserInterrupted()
        // 的既有断言（per-conversation 中断下无参仍返回 true）冲突，且可能让无会话 diff
        // 在中断后悬挂等待，故保留现状并在注释中记录该取舍。
        return true;
    }

    /**
     * 取消所有待处理的diff（标记为已取消）
     * 用于用户发送新消息或删除消息时清理未确认的 diff
     * @param conversationId 可选：只取消该会话的 pending diff
     */
    public async cancelAllPending(conversationId?: string): Promise<{ cancelled: PendingDiff[] }> {
        // 必须走串行队列：auto-save 的 acceptDiff 正在异步执行时（openTextDocument/applyEdit/doc.save
        // 之间的 await 间隙），若 cancelAllPending 并行执行，accept 后续的 doc.save()/writeFileSync
        // 会把用户已取消的 AI 内容写回磁盘。入队后两者串行，竞态消除。
        return this.runDiffActionSerialized(() => this.cancelAllPendingUnlocked(conversationId));
    }

    private async cancelAllPendingUnlocked(conversationId?: string): Promise<{ cancelled: PendingDiff[] }> {
        const cancelled: PendingDiff[] = [];

        const pendingIds = Array.from(this.pendingDiffs.entries())
            .filter(([, d]) => d.status === 'pending')
            .map(([id]) => id);

        for (const id of pendingIds) {
            const diff = this.pendingDiffs.get(id);
            if (!diff || diff.status !== 'pending') {
                continue;
            }

            // 按会话隔离：只取消匹配会话的 pending diff
            if (conversationId && diff.conversationId !== conversationId) {
                continue;
            }

            // 1. 标记为取消（公开 PendingDiff 状态仍映射为rejected，以保持既有 API/前端判断不变）
            this.finalizeCancelledDiff(diff);
            cancelled.push({ ...diff });

            // 2. 关标签页并删除新建文件残留
            await this.closeDiffTabAndCleanNewFile(id, diff);

            // 3. 尝试恢复文件到原始状态
            // H1：预览因目标文档 dirty 被拒绝的 diff，buffer 仍是用户未保存版本，
            // 恢复动作会覆盖用户未保存内容，必须跳过（关闭 diff 标签页不影响用户内容）。
            if (diff.userUnsavedContentBeforePreview === undefined) {
                try {
                    const uri = vscode.Uri.file(diff.absolutePath);
                    const doc = vscode.workspace.textDocuments.find(d => sameFsPath(d.uri.fsPath, diff.absolutePath));
                    if (doc && doc.isDirty) {
                        // 恢复到原始内容
                        const edit = new vscode.WorkspaceEdit();
                        const fullRange = new vscode.Range(
                            doc.positionAt(0),
                            doc.positionAt(doc.getText().length)
                        );
                        edit.replace(uri, fullRange, diff.originalContent);
                        await vscode.workspace.applyEdit(edit);
                        // 必须 save() 清理 dirty——否则 VSCode 弹出"是否保存更改？"对话框
                        try {
                            await doc.save();
                        } catch {
                            // doc.save 失败时回退到 revert
                            try {
                                await vscode.commands.executeCommand('workbench.action.files.revert', doc.uri);
                            } catch {
                                // ignore
                            }
                        }
                    }
                } catch (err) {
                    console.warn(`[DiffManager] Failed to restore file for cancelled diff ${id}:`, err);
                }
            }
        }

        if (cancelled.length > 0) {
            this.notifyStatusChange();
        }

        return { cancelled };
    }

    /**
     * 获取指定 ID 的diff（消费式读取，工具终态专用）
     * 仅工具链路在 await waitForDiffResolution 落定后的最终读取应调用本方法：
     * accepted+partial 墓碑在此消费（delete），避免陈旧 id 持续返回幻影 partial diff。
     */
    public getDiff(id: string): PendingDiff | undefined {
        const diff = this.pendingDiffs.get(id);
        if (diff) return diff;
        // 被淘汰的 accepted+partial 墓碑：还原最小状态，
        // 避免工具链路把"部分接受"误报为"全部接受"。
        // 消费时机 = 工具终态读取（此处 delete）：waitForDiffResolution 内部只用
        // 非消费 peekDiff 检查状态，不会抢先消费墓碑；若在这里提前删除，工具最终
        // getDiff 只得 undefined，partial 会被误报为全部接受（FIFO 淘汰场景）。
        const tombstone = this.evictedAcceptedPartialInfo.get(id);
        if (tombstone) {
            this.evictedAcceptedPartialInfo.delete(id);
            return this.reconstructTombstoneDiff(id, tombstone);
        }
        return undefined;
    }

    /**
     * 非消费式读取（peek）：仅 waitForDiffResolution 内部状态检查使用。
     * 读取墓碑但不删除——工具终态 getDiff 必在 await 之后执行，
     * 若此处消费墓碑，工具最终读取会得到 undefined，
     * 把"部分接受"误报为"全部接受"（FIFO 淘汰场景）。
     */
    private peekDiff(id: string): PendingDiff | undefined {
        const diff = this.pendingDiffs.get(id);
        if (diff) return diff;
        const tombstone = this.evictedAcceptedPartialInfo.get(id);
        if (tombstone) {
            return this.reconstructTombstoneDiff(id, tombstone);
        }
        return undefined;
    }

    private reconstructTombstoneDiff(
        id: string,
        tombstone: { partial: boolean; rejectedBlockIndices?: number[] }
    ): PendingDiff {
        return {
            id,
            filePath: '',
            absolutePath: '',
            originalContent: '',
            newContent: '',
            timestamp: 0,
            status: 'accepted',
            partial: tombstone.partial,
            rejectedBlockIndices: tombstone.rejectedBlockIndices,
        };
    }

    /**
     * 销毁管理器
     */
    public dispose(): void {
        for (const timer of this.autoSaveTimers.values()) {
            clearTimeout(timer);
        }
        this.autoSaveTimers.clear();

        for (const listener of this.saveListeners.values()) {
            listener.dispose();
        }
        this.saveListeners.clear();

        for (const listener of this.willSaveListeners.values()) {
            listener.dispose();
        }
        this.willSaveListeners.clear();

        for (const listener of this.closeListeners.values()) {
            listener.dispose();
        }
        this.closeListeners.clear();

        for (const session of this.diffSessions.values()) {
            session.dispose();
        }
        this.diffSessions.clear();

        this.nonManualSaveFlushed.clear();
        this.prewarmPromises.clear();
        this.writeReadyPromises.clear();

        if (this.providerDisposable) {
            this.providerDisposable.dispose();
        }

        this.statusListeners.clear();

        // M-core：dispose 时清空 pending diff 并释放 deferred 模式持有的写盘锁，
        // 避免单例销毁后残留悬挂 diff 状态与写盘锁（锁的兜底释放依赖进程/扩展卸载，
        // 这里显式收敛，防止同一会话后续重建 DiffManager 时被旧锁阻塞）。
        for (const diff of this.pendingDiffs.values()) {
            if (diff.lockAcquired && diff.lockHolder) {
                fileWriteLockManager.release([diff.absolutePath], diff.lockHolder);
                diff.lockAcquired = false;
            }
        }
        this.pendingDiffs.clear();

        DiffManager.instance = null;
    }
}

/**
 * 原始内容提供者- 用于 diff 视图显示原始文件内容
 */
class OriginalContentProvider implements vscode.TextDocumentContentProvider {
    private contents: Map<string, string> = new Map();
    private onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();

    public onDidChange = this.onDidChangeEmitter.event;

    public setContent(id: string, content: string): void {
        this.contents.set(id, content);
    }

    public removeContent(id: string): void {
        this.contents.delete(id);
    }

    public provideTextDocumentContent(uri: vscode.Uri): string {
        const path = uri.path;
        const parts = path.split('/').filter(p => p.length > 0);
        const id = parts[0];
        return this.contents.get(id) || '';
    }
}

/**
 * 获取 DiffManager 实例
 */
export function getDiffManager(): DiffManager {
    return DiffManager.getInstance();
}