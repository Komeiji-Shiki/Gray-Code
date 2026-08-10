import {
    fileWriteLockManager,
    type LockHolder
} from '../../core/fileWriteLockManager';

export type CheckpointOperation = 'create' | 'restore' | 'merge' | 'delete';

/** runExclusive 可选参数（CP-LOCK-2） */
export interface CheckpointRunExclusiveOptions {
    /**
     * 是否需要获取全局文件写锁（默认 true）。
     * 预览/只读计算类操作传 false：只取工作区级互斥，不阻塞主会话与 SubAgent 的写工具。
     */
    needFileLock?: boolean;
}

/** CP-LOCK-1: 排队等待工作区锁期间被取消时 reject 的错误消息（与文件写锁取消同语义） */
export const CHECKPOINT_LOCK_CANCELLED_MESSAGE = 'Checkpoint operation was cancelled';
/** CP-LOCK-4: pending 队列容量上限——超限时拒绝新请求（fail-fast），防止异常调用风暴下无界排队 */
const MAX_PENDING_OPERATIONS = 100;

interface PendingOperation {
    workspaceIds: string[];
    operation: CheckpointOperation;
    ownerId: string;
    resolve: (release: () => void) => void;
}

/** 可重入锁记录：同一 owner 嵌套调用时复用已持有的 workspace 锁 */
interface ActiveOwnerRecord {
    workspaceIds: string[];
    depth: number;
}

/**
 * 存档操作的工作区级互斥器。
 *
 * 内部锁允许互不相交的多根工作区并行；获取内部锁后，再获取全局文件根锁，
 * 从而等待主会话与 SubAgent 已经开始的写工具结束，并阻止新的写工具进入。
 *
 * 可重入：同一 ownerId 在持有相同 workspaceIds 集合期间再次调用 runExclusive
 * 时直接放行（不排队），配合 FileWriteLockManager 的同 holder 计数重入，
 * 允许 createCheckpoint → cleanupOldCheckpoints → deleteCheckpoint 这类嵌套链路。
 */
export class CheckpointOperationLockManager {
    private readonly activeWorkspaceIds = new Set<string>();
    private readonly pending: PendingOperation[] = [];
    private readonly activeOwners = new Map<string, ActiveOwnerRecord>();

    async runExclusive<T>(
        workspaceIds: readonly string[],
        operation: CheckpointOperation,
        ownerId: string,
        task: () => Promise<T>,
        abortSignal?: AbortSignal,
        options?: CheckpointRunExclusiveOptions
    ): Promise<T> {
        const normalizedIds = [...new Set(workspaceIds)].sort();
        if (normalizedIds.length === 0) {
            throw new Error('Checkpoint operation requires at least one workspace root');
        }

        // CP-LOCK-2: 预览/只读计算默认仍取全局文件写锁；needFileLock=false 时跳过文件锁，
        // 只保留工作区级互斥（仍与同工作区的其他存档操作互斥，但不阻塞写工具）。
        const needFileLock = options?.needFileLock !== false;

        // 可重入：同一 owner 已持有工作区集合的超集时，跳过排队直接进入（嵌套调用）。
        // 文件写锁按同 holder 计数重入，嵌套 acquire/release 对称、不会死锁。
        const existing = this.activeOwners.get(ownerId);
        if (existing) {
            if (!normalizedIds.every(id => existing.workspaceIds.includes(id))) {
                // CP-LOCK-3: 同 owner 请求超出已持有集合的嵌套调用会进入队列等待自己 → 死锁。
                // fail-fast：直接抛错，而不是挂起在 pending 队列中。
                throw new Error(
                    `Checkpoint lock re-entry deadlock: owner ${ownerId} already holds ` +
                    `[${existing.workspaceIds.join(', ')}] but requested [${normalizedIds.join(', ')}]`
                );
            }
            const record = existing;
            record.depth += 1;
            try {
                return needFileLock
                    ? await this.runWithFileLock(operation, ownerId, task, abortSignal)
                    : await task();
            } finally {
                record.depth -= 1;
                if (record.depth <= 0) {
                    this.activeOwners.delete(ownerId);
                }
            }
        }

        // 非嵌套（不同 owner 或请求集合超出已持有范围）：正常排队互斥。
        // 同 owner 的超集请求已在上面 fail-fast（CP-LOCK-3）。

        const releaseWorkspaceLock = await this.acquireWorkspaceLock(normalizedIds, operation, ownerId, abortSignal);
        this.activeOwners.set(ownerId, { workspaceIds: normalizedIds, depth: 1 });
        try {
            return needFileLock
                ? await this.runWithFileLock(operation, ownerId, task, abortSignal)
                : await task();
        } finally {
            this.activeOwners.delete(ownerId);
            releaseWorkspaceLock();
        }
    }

    /** 获取全局文件根锁后执行任务（同 holder 可重入，计数对称） */
    private async runWithFileLock<T>(
        operation: CheckpointOperation,
        ownerId: string,
        task: () => Promise<T>,
        abortSignal?: AbortSignal
    ): Promise<T> {
        const holder: LockHolder = {
            kind: 'checkpoint',
            id: ownerId,
            label: `checkpoint ${operation}`
        };
        await fileWriteLockManager.acquire([''], holder, abortSignal);
        try {
            return await task();
        } finally {
            fileWriteLockManager.release([''], holder);
        }
    }

    private acquireWorkspaceLock(
        workspaceIds: string[],
        operation: CheckpointOperation,
        ownerId: string,
        abortSignal?: AbortSignal
    ): Promise<() => void> {
        return new Promise((resolve, reject) => {
            const pendingItem: PendingOperation = { workspaceIds, operation, ownerId, resolve };

            // CP-LOCK-1: 取消信号作用于排队等待——abort 时把 pending 项移出队列并 reject，
            // 而不是等到锁授予后在任务内才失败（排队等待时间无上限）。
            if (abortSignal?.aborted) {
                reject(new Error(CHECKPOINT_LOCK_CANCELLED_MESSAGE));
                return;
            }
            // CP-LOCK-4: 队列容量上限——超过上限拒绝新请求（fail-fast），
            // 异常调用风暴不会让 pending 无界增长（可重入/嵌套调用不经过此排队，不受影响）
            if (this.pending.length >= MAX_PENDING_OPERATIONS) {
                reject(new Error('Checkpoint operation queue is full'));
                return;
            }
            const onAbort = (): void => {
                const index = this.pending.indexOf(pendingItem);
                if (index >= 0) {
                    this.pending.splice(index, 1);
                }
                reject(new Error(CHECKPOINT_LOCK_CANCELLED_MESSAGE));
            };
            if (abortSignal) {
                abortSignal.addEventListener('abort', onAbort, { once: true });
            }
            // 被授予锁时移除 abort 监听，避免授予后 abort 对已 resolve 的 Promise 二次 reject
            pendingItem.resolve = (release: () => void) => {
                abortSignal?.removeEventListener('abort', onAbort);
                resolve(release);
            };

            this.pending.push(pendingItem);
            this.drain();
        });
    }

    private drain(): void {
        for (let index = 0; index < this.pending.length;) {
            const candidate = this.pending[index];
            if (candidate.workspaceIds.some(id => this.activeWorkspaceIds.has(id))) {
                index += 1;
                continue;
            }

            this.pending.splice(index, 1);
            for (const id of candidate.workspaceIds) {
                this.activeWorkspaceIds.add(id);
            }

            let released = false;
            candidate.resolve(() => {
                if (released) return;
                released = true;
                for (const id of candidate.workspaceIds) {
                    this.activeWorkspaceIds.delete(id);
                }
                this.drain();
            });
        }
    }

    getActiveWorkspaceCount(): number {
        return this.activeWorkspaceIds.size;
    }

    getPendingOperationCount(): number {
        return this.pending.length;
    }
}

export const checkpointOperationLockManager = new CheckpointOperationLockManager();
