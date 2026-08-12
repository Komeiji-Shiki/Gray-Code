/**
 * pendingDiff 审阅终态 → 结果对象 的统一解析（发现 04）。
 *
 * write_file / delete_code / insert_code / replacePass / apply_diff 五处曾各自复制
 * 「waitForDiffResolution → 终态判定 → saveGlobalDiff → 组装结果」的流程，且已产生漂移：
 * - wasAccepted 判定不一致（apply_diff 多一层 finalDiff.status 检查）；
 * - pendingDiffId 有的返回有的不返回；
 * - 取消/拒绝文案各自手写，saveGlobalDiff（异步）与 saveGlobalDiffDeferred（同步）混用。
 *
 * 本模块统一：
 * - wasAccepted 语义：终态原因为 'none' 且（finalDiff 不存在或被 FIFO 淘汰重建为 accepted）
 *   才算接受；finalDiff 存在但状态非 accepted 一律不算接受；
 * - pendingDiffId 恒随结果返回；
 * - 拒绝/取消/中断文案由 actionLabel 统一生成；
 * - diff 内容保存按 useDeferredSave 开关统一走 saveGlobalDiff / saveGlobalDiffDeferred。
 */

import type { DiffManager, DiffResolutionReason, PendingDiff } from '../../../core/services/diffManager';
import { getDiffManager } from '../../../core/services/diffManager';
import { getDiffStorageManager } from '../../../modules/conversation';

export type DiffOutcomeKind = 'accepted' | 'rejected' | 'cancelled' | 'autosave-failed';

export interface ResolveDiffOutcomeOptions {
    /** createPendingDiff 返回的 pending diff ID */
    pendingDiffId: string;
    /** 取消信号（透传 waitForDiffResolution） */
    abortSignal?: AbortSignal;
    /** 原始内容（saveGlobalDiff 用） */
    originalContent: string;
    /** 新内容（saveGlobalDiff 用） */
    newContent: string;
    /** 相对路径（saveGlobalDiff 用） */
    filePath: string;
    /** 保存 diff 内容改用同步 deferred API（apply_diff 用）；默认异步 saveGlobalDiff */
    useDeferredSave?: boolean;
    /** 取消/中断文案中的动作主语（如 'Write' / 'Delete' / 'Insert' / 'Diff'）；默认 'Operation' */
    actionLabel?: string;
}

export interface DiffReviewOutcome {
    kind: DiffOutcomeKind;
    /** waitForDiffResolution 的原始终态原因 */
    interruptReason: DiffResolutionReason;
    /** 统一 wasAccepted 语义（见文件头注释） */
    wasAccepted: boolean;
    /** 用户显式拒绝（interruptReason === 'rejected'） */
    wasRejected: boolean;
    /** 被取消/中断（interruptReason === 'abort' / 'user'） */
    wasInterrupted: boolean;
    /** 中断细分（仅 wasInterrupted 时有意义） */
    interruptKind?: 'abort' | 'user';
    finalDiff?: PendingDiff;
    diffContentId?: string;
    autoSaveError?: string;
    pendingDiffId: string;
    /** 统一拒绝文案 */
    rejectedMessage: string;
    /** 统一取消文案（abort） */
    abortMessage: string;
    /** 统一中断文案（user） */
    interruptMessage: string;
}

/**
 * 等待指定 pending diff 结算并统一解析审阅终态。
 *
 * 说明：waitForDiffResolution 本身不消费 FIFO 墓碑；finalDiff 的读取（getDiff）
 * 必须发生在 await 之后（consuming read），本函数内顺序已保证。
 */
export async function resolveDiffOutcome(options: ResolveDiffOutcomeOptions): Promise<DiffReviewOutcome> {
    const diffManager: DiffManager = getDiffManager();
    const interruptReason = await diffManager.waitForDiffResolution(options.pendingDiffId, options.abortSignal);
    const wasRejected = interruptReason === 'rejected';
    const wasInterrupted = interruptReason === 'abort' || interruptReason === 'user';

    const finalDiff = diffManager.getDiff(options.pendingDiffId);
    // 统一 wasAccepted 语义：'rejected'（含被 FIFO 淘汰后留痕的拒绝）一律不算接受；
    // finalDiff 存在但状态非 accepted（autoSave 失败收敛为 rejected 等边缘竞态）也不算接受，
    // 避免被拒绝的 diff 被淘汰后 !finalDiff 误报「写入成功」。
    const wasAccepted = interruptReason === 'none' && (!finalDiff || finalDiff.status === 'accepted');
    const autoSaveError = finalDiff?.autoSaveError;

    const diffStorageManager = getDiffStorageManager();
    let diffContentId: string | undefined;
    if (diffStorageManager) {
        try {
            const diffRef = options.useDeferredSave
                ? diffStorageManager.saveGlobalDiffDeferred({
                    originalContent: options.originalContent,
                    newContent: options.newContent,
                    filePath: options.filePath
                })
                : await diffStorageManager.saveGlobalDiff({
                    originalContent: options.originalContent,
                    newContent: options.newContent,
                    filePath: options.filePath
                });
            diffContentId = diffRef.diffId;
        } catch (e) {
            console.warn('Failed to save diff content to storage:', e);
        }
    }

    let kind: DiffOutcomeKind;
    if (wasRejected) {
        kind = 'rejected';
    } else if (wasInterrupted) {
        kind = 'cancelled';
    } else if (wasAccepted) {
        kind = 'accepted';
    } else {
        // 终态为 'none' 但 finalDiff 存在且状态非 accepted：只会是 autoSave 失败
        // 收敛为 rejected 的路径；有 autoSaveError 时单独归类，否则按拒绝处理。
        kind = autoSaveError ? 'autosave-failed' : 'rejected';
    }

    const actionLabel = options.actionLabel ?? 'Operation';
    return {
        kind,
        interruptReason,
        wasAccepted,
        wasRejected,
        wasInterrupted,
        interruptKind: wasInterrupted ? (interruptReason as 'abort' | 'user') : undefined,
        finalDiff,
        diffContentId,
        autoSaveError,
        pendingDiffId: options.pendingDiffId,
        rejectedMessage: 'Diff was rejected by user',
        abortMessage: `${actionLabel} was cancelled by user`,
        interruptMessage: `${actionLabel} was interrupted by user`
    };
}
