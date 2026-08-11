/**
 * SubAgent 并发信号量
 *
 * 修改原因：多个 subagents 调用过去只能串行执行，超出 maxConcurrentAgents 的调用会被直接拒绝。
 * 修改方式：提供全局 FIFO 信号量，执行前 acquire、结束后 release；容量每次动态读取设置，超限时排队等待。
 * 修改目的：让 maxConcurrentAgents 语义变为"同时运行的子代理数量上限"，超出的调用排队而不是被拒绝。
 */

import { getGlobalSettingsManager } from '../../core/settingsContext';

/**
 * 排队等待期间被取消时抛出的错误。
 *
 * executor 捕获后应把 run 标记为 cancelled，而不是 failed。
 */
export class SubAgentQueueCancelledError extends Error {
    constructor(runId: string) {
        super(`SubAgent run "${runId}" was cancelled while waiting in the concurrency queue.`);
        this.name = 'SubAgentQueueCancelledError';
    }
}

/**
 * 排队等待超时抛出的错误。
 *
 * 修改原因：前方 run 长期占用席位时，排队者会无限等待，run 与事件总线状态悬挂。
 * 修改方式：超过排队时限 reject 该等待者，移出队列并清理监听。
 * 修改目的：排队等待有界；executor 会把它作为明确的席位获取失败处理（非取消语义）。
 */
export class SubAgentQueueTimeoutError extends Error {
    constructor(runId: string) {
        super(`SubAgent run "${runId}" timed out after 60s waiting in the concurrency queue.`);
        this.name = 'SubAgentQueueTimeoutError';
    }
}

/** 排队等待席位的最大时限（60 秒）。 */
export const SUB_AGENT_QUEUE_TIMEOUT_MS = 60 * 1000;

interface QueueEntry {
    runId: string;
    resolve: () => void;
    reject: (error: Error) => void;
    /** 解除 abort 监听等清理动作 */
    cleanup: () => void;
}

/**
 * SubAgent 全局并发信号量。
 *
 * - 容量每次准入判断时动态读取（用户中途修改 maxConcurrentAgents 立即生效）；
 * - -1 表示无限制；非法值（非有限数字或 0）按无限制处理，避免配置错误导致永久排队；
 * - FIFO 排队；排队中响应 abortSignal，取消时移出队列并抛出 SubAgentQueueCancelledError；
 * - release 幂等，释放后按最新容量唤醒尽可能多的等待者。
 */
export class SubAgentConcurrencyLimiter {
    private readonly running = new Set<string>();
    private readonly queue: QueueEntry[] = [];

    /**
     * @param capacityProvider 测试注入用的容量来源；缺省时读取全局 SettingsManager。
     */
    constructor(private readonly capacityProvider?: () => number | undefined) {}

    /**
     * 获取当前容量。
     *
     * 返回 -1 表示无限制。
     */
    private getCapacity(): number {
        const raw = this.capacityProvider
            ? this.capacityProvider()
            : getGlobalSettingsManager()?.getSubAgentsConfig()?.maxConcurrentAgents;
        if (typeof raw !== 'number' || !Number.isFinite(raw)) {
            // 未配置按默认 3
            return 3;
        }
        if (raw === 0) {
            // 0 表示“禁止并发”，按串行（容量 1）处理，而不是无限制
            return 1;
        }
        return raw < 0 ? -1 : Math.floor(raw);
    }

    private hasFreeSlot(): boolean {
        const capacity = this.getCapacity();
        return capacity === -1 || this.running.size < capacity;
    }

    /**
     * 获取一个执行席位。
     *
     * 有空位时立即返回；满员时按 FIFO 排队等待，直到有席位释放或被取消。
     */
    async acquire(runId: string, abortSignal?: AbortSignal): Promise<void> {
        if (abortSignal?.aborted) {
            throw new SubAgentQueueCancelledError(runId);
        }
        // 防御性重入：同一 run 不应二次 acquire，若发生则直接视为已持有
        if (this.running.has(runId)) {
            return;
        }
        // 修改原因：容量可能在排队期间被调大，若 onCapacityChanged 未及时触发，
        //          队列头仍被旧容量卡住，直到有运行中的 run 释放才补位，形成长尾延迟。
        // 修改方式：acquire 入口先按最新容量 drainQueue 补位（FIFO 保持：排队者优先），
        //          随后有空位才直接分配，避免新请求跳过队列。
        this.drainQueue();
        if (this.hasFreeSlot()) {
            this.running.add(runId);
            return;
        }

        return new Promise<void>((resolve, reject) => {
            // push 之前再次检查：信号可能在进入 acquire 后、到达此处前已中止，
            // 此时直接拒绝，避免把条目加入队列
            if (abortSignal?.aborted) {
                reject(new SubAgentQueueCancelledError(runId));
                return;
            }

            let timeoutId: ReturnType<typeof setTimeout> | undefined;
            const entry: QueueEntry = {
                runId,
                resolve,
                reject,
                cleanup: () => {
                    if (timeoutId) {
                        clearTimeout(timeoutId);
                        timeoutId = undefined;
                    }
                    if (abortSignal) {
                        abortSignal.removeEventListener('abort', onAbort);
                    }
                }
            };
            // 修改原因：前方 run 长期占用席位时排队者无限等待，占用队列与事件总线状态。
            // 修改方式：入队即启动 60 秒兜底定时器，超时移出队列并以 SubAgentQueueTimeoutError 拒绝。
            // 修改目的：排队等待有界；cleanup（取消/获准/超时）时一并清除定时器，不残留。
            timeoutId = setTimeout(() => {
                const index = this.queue.indexOf(entry);
                if (index >= 0) {
                    this.queue.splice(index, 1);
                }
                entry.cleanup();
                reject(new SubAgentQueueTimeoutError(runId));
            }, SUB_AGENT_QUEUE_TIMEOUT_MS);
            const onAbort = () => {
                const index = this.queue.indexOf(entry);
                if (index >= 0) {
                    this.queue.splice(index, 1);
                }
                entry.cleanup();
                reject(new SubAgentQueueCancelledError(runId));
            };
            if (abortSignal) {
                abortSignal.addEventListener('abort', onAbort, { once: true });
            }
            this.queue.push(entry);

            // push 之后再次检查：监听器挂载与 push 之间信号可能已中止，
            // 若不处理，条目会永久残留在队列中（直到 release 才被意外唤醒）
            if (abortSignal?.aborted) {
                const index = this.queue.indexOf(entry);
                if (index >= 0) {
                    this.queue.splice(index, 1);
                }
                entry.cleanup();
                reject(new SubAgentQueueCancelledError(runId));
                return;
            }
        });
    }

    /**
     * 释放席位并唤醒等待者。重复释放是安全的空操作。
     */
    release(runId: string): void {
        if (!this.running.delete(runId)) {
            return;
        }
        this.drainQueue();
    }

    /**
     * 按最新容量唤醒尽可能多的队首等待者。
     *
     * 容量可能在等待期间被调大，因此每次释放都循环补位而不是只唤醒一个。
     */
    private drainQueue(): void {
        while (this.queue.length > 0 && this.hasFreeSlot()) {
            const next = this.queue.shift()!;
            next.cleanup();
            this.running.add(next.runId);
            next.resolve();
        }
    }

    /**
     * 容量配置变更后重新评估排队者。
     *
     * 修改原因：drainQueue 过去只在 release 时触发，用户中途把 maxConcurrentAgents 调大后，
     *          已排队的 run 仍要一直等到某个运行中的 run 结束才会被唤醒，"立即生效"的语义并不成立。
     * 修改方式：提供显式的容量变更入口，由设置更新处调用，按最新容量批量补位。
     * 修改目的：调大并发上限后排队中的子代理立刻开始执行。
     */
    onCapacityChanged(): void {
        this.drainQueue();
    }

    getRunningCount(): number {
        return this.running.size;
    }

    getQueueLength(): number {
        return this.queue.length;
    }
}

/**
 * 全局单例：跨会话、跨窗口统一限流。
 */
export const subAgentConcurrencyLimiter = new SubAgentConcurrencyLimiter();
