import {
    fileWriteLockManager,
    type LockHolder
} from '../../core/fileWriteLockManager';

export type CheckpointOperation = 'create' | 'restore' | 'merge' | 'delete';

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
        abortSignal?: AbortSignal
    ): Promise<T> {
        const normalizedIds = [...new Set(workspaceIds)].sort();
        if (normalizedIds.length === 0) {
            throw new Error('Checkpoint operation requires at least one workspace root');
        }

        // 可重入：同一 owner 已持有工作区集合的超集时，跳过排队直接进入（嵌套调用）。
        // 文件写锁按同 holder 计数重入，嵌套 acquire/release 对称、不会死锁。
        const existing = this.activeOwners.get(ownerId);
        if (existing && normalizedIds.every(id => existing.workspaceIds.includes(id))) {
            const record = existing;
            record.depth += 1;
            try {
                return await this.runWithFileLock(operation, ownerId, task, abortSignal);
            } finally {
                record.depth -= 1;
                if (record.depth <= 0) {
                    this.activeOwners.delete(ownerId);
                }
            }
        }

        // 非嵌套（不同 owner 或请求集合超出已持有范围）：正常排队互斥。
        // 注意：调用方不得在持锁任务内等待一个请求了更大工作区集合的嵌套操作，
        // 否则会等待自己（全局文件根锁 + FIFO 语义下即使工作区不相交也会串行）。

        const releaseWorkspaceLock = await this.acquireWorkspaceLock(normalizedIds, operation, ownerId);
        this.activeOwners.set(ownerId, { workspaceIds: normalizedIds, depth: 1 });
        try {
            return await this.runWithFileLock(operation, ownerId, task, abortSignal);
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
        ownerId: string
    ): Promise<() => void> {
        return new Promise(resolve => {
            this.pending.push({ workspaceIds, operation, ownerId, resolve });
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
