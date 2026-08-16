/**
 * SubAgent 活跃运行控制器。
 *
 * 修改原因：SubAgent Monitor 需要中止、继续和退出仍在等待主窗口工具调用的 run；这些控制语义不能塞进事件总线或 UI 状态里。
 * 修改方式：用独立控制器保存活跃 run 的 AbortController、状态和等待恢复/退出的 Promise 句柄。
 * 修改目的：让“历史快照展示”和“活跃运行控制”分离，扩展重载后不会错误复活已经丢失的主工具 Promise。
 */

import { subAgentRunEventBus } from './runEventBus';
import type { SubAgentRunStatus } from './runEventBus';
import type { IRunController, RunControllerSnapshot, SubAgentRunScope } from '../../core/RunController';

export type SubAgentControlAction = 'pause' | 'resume' | 'exit';

export interface SubAgentRunControlState {
    runId: string;
    agentName?: string;
    status: SubAgentRunStatus;
    active: boolean;
    abortSignal: AbortSignal;
}

interface ActiveRunRecord {
    runId: string;
    agentName?: string;
    /** 嵌套深度（主模型=0，子=1，子子=2），由 executor 注册时携带（F2） */
    depth?: number;
    /** 父 runId（嵌套派发时由 executor 携带；主模型直接派发为 undefined）。用于转后台（detach）后结果回投给发起者。 */
    parentRunId?: string;
    status: SubAgentRunStatus;
    controller: AbortController;
    /** 是否挂父轮 abort 信号（前台 SubAgent=true；后台模式=false，detach 只对前台生效） */
    attachedToParent: boolean;
    /** 已与父 abort 信号解绑（转后台继续运行） */
    detached: boolean;
    /**
     * 等待 run 重新变得可运行（resume）或被终止（exit）的唤醒器。
     *
     * 修改原因：过去拆成 resumeWaiters / exitWaiters 两份，waitUntilRunnable 会同时向两份注册同一个 resolve，
     *          而 resume 只清空 resumeWaiters，于是每次 pause→resume 循环都在 exitWaiters 留下一个僵尸回调。
     * 修改方式：合并为单一唤醒列表——两种事件都表示"等待结束"，退出原因由 record.exitReason 承载，
     *          唤醒器本身从不需要参数（旧 exitWaiters 的 reason 参数本就被调用点忽略）。
     * 修改目的：唤醒器的注册与清空严格一一对应，长时间暂停/继续不再累积回调。
     */
    waiters: Array<() => void>;
    pausedStartedAt?: number;
    inactiveDurationMs: number;
    exitReason?: string;
    /**
     * 是否仍在并发队列中等待席位（未开始执行）。
     *
     * 修改原因（M-tsub）：pause 对排队中 run 若走 abort，会经 runLoop 的 acquire 桥把
     * 并发队列项移出并抛 SubAgentQueueCancelledError，pause 语义退化为取消。
     * 修改方式：executor 注册后、acquire 前 markQueued(true)，acquire 成功后 markStarted(false)；
     *           pause 对 queued=true 的 run 只置 paused 状态、不 abort 控制器。
     * 修改目的：排队中 run 的 pause/resume/exit 语义与运行中 run 一致（exit 才真正取消）。
     */
    queued: boolean;
}

export class SubAgentRunController implements IRunController<SubAgentRunScope> {
    /**
     * 修改原因：WP21 需要让 SubAgent controller 在类型层成为统一 RunController 契约的一员。
     * 修改方式：显式暴露固定的 subagent scopeType，供共享调用方读取。
     * 修改目的：后续共享运行时不必依赖具体类名来判断 controller 作用域。
     */
    readonly scopeType = 'subagent' as const;
    private readonly activeRuns = new Map<string, ActiveRunRecord>();
    /** 父 runId -> 它派生的子 runId 集合（F2 级联清理用） */
    private readonly children = new Map<string, Set<string>>();
    /** runId -> detach 回调（executor 注册；detachFromParent 时同步调用，用于解绑父 abort 信号） */
    private readonly detachListeners = new Map<string, () => void>();
    /**
     * continueFromRunId 续跑的去重预留（M-tsub 边缘）：同一 runId 并发续跑只允许一个在途。
     * 续跑校验是「读-判定」无预留，两个 executor 都能通过终态检查并 resumeRun 同一个快照，
     * 后到者覆盖先到者的 transcript/事件。executor 在续跑校验通过后预留、终态收敛时释放。
     */
    private readonly continuationInFlight = new Set<string>();

    register(runId: string, agentName?: string, depth?: number, attachedToParent = true, parentRunId?: string): AbortSignal {
        // 修改原因：每次 SubAgent run 需要一个可由 Monitor 独立中止的控制信号，不能复用主聊天的 AbortController。
        // 修改方式：注册活跃 run 时创建专属 AbortController，并把 run 标记为 running。
        // 修改目的：后续 pause/exit 可以只影响该 SubAgent run，不直接让主窗口其他流式请求中止。
        // F2：同时记录嵌套深度，供子 agent 派发时读取父深度做超限校验与 Monitor 元数据。
        // 转后台（detach）：attachedToParent 标记该 run 是否挂父轮 abort 信号（前台 true / 后台 false），
        // detachFromParent 只对挂父信号的 run 生效——用户发新消息时前台 SubAgent 转后台继续，不被旧流 abort 连带杀掉。
        // parentRunId：嵌套 run 转后台后，完成结果可据此投递给发起者（与显式 background 嵌套同语义）。
        const existing = this.activeRuns.get(runId);
        if (existing) {
            if (depth !== undefined) existing.depth = depth;
            if (parentRunId !== undefined) existing.parentRunId = parentRunId;
            return existing.controller.signal;
        }
        const record: ActiveRunRecord = {
            runId,
            agentName,
            depth,
            parentRunId,
            status: 'running',
            controller: new AbortController(),
            attachedToParent,
            detached: false,
            waiters: [],
            inactiveDurationMs: 0,
            // 默认视为已开始执行（非排队）：pause 保持 abort 语义；executor 进入并发队列前
            // 显式 markQueued 切换为「排队中」，acquire 成功后 markStarted 恢复。
            queued: false
        };
        this.activeRuns.set(runId, record);
        return record.controller.signal;
    }

    /**
     * 标记 run 处于并发队列等待（executor 注册后、acquire 并发信号量之前调用）。
     *
     * 修改原因（M-tsub）：排队中 run 被 pause 时不应 abort 控制器——abort 会经 runLoop 的
     * acquire 桥把队列项移出并抛 SubAgentQueueCancelledError，pause 退化为取消。
     * 修改方式：queued=true 期间 pause 只置 paused 状态、不 abort；run 保持队列项挂起，
     *           resume 后继续排队，exit 才真正中止并取消队列项。
     */
    markQueued(runId: string): void {
        const record = this.activeRuns.get(runId);
        if (record) {
            record.queued = true;
        }
    }

    /** 标记 run 已取得并发席位、开始执行（executor acquire 成功后调用）；此后 pause 恢复 abort 语义。 */
    markStarted(runId: string): void {
        const record = this.activeRuns.get(runId);
        if (record) {
            record.queued = false;
        }
    }

    /**
     * 预留一次 continueFromRunId 续跑（并发去重）：已有续跑在途时返回 false，调用方拒绝该次续跑。
     *
     * 修改原因（M-tsub 边缘）：subagents.ts 的 resolveContinuationIdentity 与 executor 的续跑校验
     * 都是「读-判定」无预留，同一 runId 被并发续跑两次时两个 executor 都能通过终态检查，后到者
     * 覆盖先到者正在写入的 transcript。
     * 修改方式：executor 在续跑校验通过后、resumeRun 前调用本方法做原子 check-and-set（同步无
     *           await 间隙，不存在双写窗口）；run 终态收敛时由 releaseContinuation 释放。
     */
    tryReserveContinuation(runId: string): boolean {
        if (this.continuationInFlight.has(runId)) {
            return false;
        }
        this.continuationInFlight.add(runId);
        return true;
    }

    /** 释放续跑预留（executor 终态收敛时调用，幂等）。 */
    releaseContinuation(runId: string): void {
        this.continuationInFlight.delete(runId);
    }

    /**
     * 读取 run 的嵌套深度（未注册或未记录时返回 undefined）。
     *
     * 修改原因（F2）：子 agent 派发子子 agent 时，需要从父 run 的 run 上下文读取深度并 +1。
     * 修改方式：从活跃 run 记录直接读取，不新增独立状态源。
     */
    getDepth(runId: string): number | undefined {
        return this.activeRuns.get(runId)?.depth;
    }

    /** 读取 run 的父 runId（嵌套派发时存在；主模型直接派发/未注册时返回 undefined）。 */
    getParentRunId(runId: string): string | undefined {
        return this.activeRuns.get(runId)?.parentRunId;
    }

    /**
     * 登记父子关系：parentRunId 派生了一个子 run childRunId。
     *
     * 修改原因（F2）：父 run 结束时需要级联退出仍存活（含排队/后台）的子 run，
     * 避免父级结束后留下孤儿 run 继续运行或占用并发席位。
     */
    registerChild(parentRunId: string, childRunId: string): void {
        let set = this.children.get(parentRunId);
        if (!set) {
            set = new Set();
            this.children.set(parentRunId, set);
        }
        set.add(childRunId);
    }

    /**
     * 解除父子关系：子 run 结束时把自己从父 run 的派生列表里摘除（幂等）。
     */
    unregisterChild(parentRunId: string, childRunId: string): void {
        const set = this.children.get(parentRunId);
        if (!set) return;
        set.delete(childRunId);
        if (set.size === 0) {
            this.children.delete(parentRunId);
        }
    }

    /** 读取某 run 当前仍登记在册的子 runId 列表（快照，不修改内部状态）。 */
    getChildren(parentRunId: string): string[] {
        return Array.from(this.children.get(parentRunId) ?? []);
    }

    /**
     * 级联退出：父 run 结束时调用，把其派生的全部子 run 置为 cancelled 并中止。
     *
     * 修改原因（F2）：父 run 被取消/超时/正常结束时，仍存活的后台子 run 或排队中的子 run
     * 必须一并终止，否则会脱离父级约束继续运行。
     * 修改方式：清空父子关系表后逐个调用 exit（幂等，子 run 未注册/已结束时为 no-op）。
     */
    cascadeExitChildren(parentRunId: string, reason?: string): string[] {
        const childRunIds = this.getChildren(parentRunId);
        this.children.delete(parentRunId);
        for (const childRunId of childRunIds) {
            this.exit(childRunId, reason || 'Parent sub-agent run ended; nested sub-agent runs were cancelled.');
        }
        return childRunIds;
    }

    /**
     * 唤醒所有等待该 run 变得可运行或终止的调用方。
     *
     * 一次性取出并清空，保证同一个 waiter 不会被重复持有。
     */
    private notifyWaiters(record: ActiveRunRecord): void {
        const waiters = record.waiters.splice(0);
        for (const resolve of waiters) resolve();
    }

    unregister(runId: string): void {
        // 修改原因：完成、失败或取消后的 run 不再能影响主工具 Promise，必须从活跃控制表移除。
        // 修改方式：删除 activeRuns 中对应记录，但保留 runEventBus 的持久快照。
        // 修改目的：Monitor 可以继续查看历史 run，同时不会显示会影响主工具的控制按钮。
        this.activeRuns.delete(runId);
        this.detachListeners.delete(runId);
    }

    isActive(runId: string): boolean {
        return this.activeRuns.has(runId);
    }

    getState(runId: string): SubAgentRunControlState | undefined {
        const record = this.activeRuns.get(runId);
        if (!record) return undefined;
        return {
            runId: record.runId,
            agentName: record.agentName,
            status: record.status,
            active: true,
            abortSignal: record.controller.signal
        };
    }

    getActiveRunIds(): string[] {
        return Array.from(this.activeRuns.keys());
    }

    /** 等待一组 run 从活跃控制表注销；超时后返回，避免无响应工具永久阻塞删除。 */
    async waitForInactive(runIds: readonly string[], timeoutMs = 6000): Promise<void> {
        const deadline = Date.now() + Math.max(0, timeoutMs);
        while (runIds.some(runId => this.activeRuns.has(runId))) {
            const remaining = deadline - Date.now();
            if (remaining <= 0) return;
            await new Promise(resolve => setTimeout(resolve, Math.min(25, remaining)));
        }
    }

    /**
     * 修改原因：IRunController 需要统一暴露 controller 的 scope 类型。
     * 修改方式：返回固定的 subagent 字面量，不引入额外状态源。
     * 修改目的：共享调用方可以通过统一接口识别该 controller 管理的是 SubAgent run。
     */
    getScopeType(): 'subagent' {
        return this.scopeType;
    }

    /**
     * 修改原因：统一接口要求把匿名 runId 显式包装成 RunScope 数据。
     * 修改方式：根据当前活跃记录补齐 agentName，可选保留未来 parentConversationId 扩展位。
     * 修改目的：scope 成为接口能力本身，而不是由调用点写 if/else 猜测来源。
     */
    getScope(runId: string): SubAgentRunScope {
        const record = this.activeRuns.get(runId);
        return {
            type: 'subagent',
            runId,
            agentName: record?.agentName
        };
    }

    /**
     * 修改原因：IRunController 需要统一的活跃 ID 读取入口。
     * 修改方式：复用现有 getActiveRunIds 结果，不改变活跃 run 的判定逻辑。
     * 修改目的：后续共享运行时代码不需要知道 SubAgent controller 的旧命名。
     */
    listActiveIds(): string[] {
        return this.getActiveRunIds();
    }

    /**
     * 修改原因：WP21 共享契约需要最小只读快照，而现有 getState 仍需继续服务既有 executor / handler。
     * 修改方式：在保留 getState 原签名的前提下，新增 getSnapshot 作为统一接口读面。
     * 修改目的：适配共享抽象，同时不触碰 Monitor pause / exit / historical-run 的既有 UX 语义。
     */
    getSnapshot(runId: string): RunControllerSnapshot<SubAgentRunScope> | undefined {
        const state = this.getState(runId);
        if (!state) {
            return undefined;
        }

        return {
            scope: this.getScope(runId),
            active: state.active,
            status: state.status,
            abortSignal: state.abortSignal,
            exitReason: this.getExitReason(runId),
            capabilities: {
                pause: true,
                resume: true,
                exit: true
            }
        };
    }

    pause(runId: string): boolean {
        const record = this.activeRuns.get(runId);
        if (!record || record.status !== 'running') return false;

        // 修改原因：Monitor 的“中止”只暂停当前 SubAgent 内部推理，不能让主窗口 subagents 工具立即失败。
        // 修改方式：把状态置为 paused 并 abort 当前控制器；executor 捕获取消后根据控制器状态等待 resume 或 exit。
        // 修改目的：中止当前 API/工具等待，同时保留主工具调用的挂起语义。
        // M-tsub：排队中（queued=true，未开始执行）的 run 不 abort 控制器——否则 abort 会经
        //         runLoop 的 acquire 桥把并发队列项移出并抛 SubAgentQueueCancelledError，pause 退化为
        //         取消。排队中 pause 只置 paused 状态，run 保持队列项挂起，resume 后继续排队等待席位；
        //         exit 才真正 abort 并取消队列项（见 markQueued 的修改说明）。
        record.status = 'paused';
        record.pausedStartedAt = Date.now();
        if (!record.queued) {
            record.controller.abort();
        }
        subAgentRunEventBus.emit({
            runId,
            agentName: record.agentName,
            type: 'run_paused',
            payload: { reason: 'User paused SubAgent run from Monitor' }
        });
        return true;
    }

    markAwaitingMonitorAction(runId: string, reason: string): boolean {
        const record = this.activeRuns.get(runId);
        if (!record) return false;

        // 修改原因：自动重试耗尽且配置为等待用户处理时，run 不是 failed，而是等待 Monitor 决策。
        // 修改方式：显式进入 awaiting_monitor_action 状态，并广播给 Monitor。
        // 修改目的：主窗口工具继续等待，用户可以在 Monitor 中选择重试或退出。
        record.status = 'awaiting_monitor_action';
        record.pausedStartedAt = Date.now();
        subAgentRunEventBus.emit({
            runId,
            agentName: record.agentName,
            type: 'run_awaiting_monitor_action',
            payload: { reason }
        });
        return true;
    }

    resume(runId: string): boolean {
        const record = this.activeRuns.get(runId);
        if (!record) return false;
        if (record.status !== 'paused' && record.status !== 'awaiting_monitor_action') return false;

        // 修改原因：暂停时旧 AbortController 可能已经被 abort（运行中 run 的 pause 会 abort），
        //          继续执行必须使用新的 signal。
        // 修改方式：仅在旧控制器已被 abort 时重建；排队中 run 的 pause 不 abort 控制器
        //          （见 pause 的 queued 分支），此时继续沿用旧控制器——executor 的 acquire
        //          桥在 acquire 前一次性读取 runControlSignal 并挂在旧控制器上，若这里无条件
        //          重建，resume 后再 exit 中止的是新控制器，acquire 桥收不到 abort，已退出的
        //          排队项仍会取得席位开始执行（M-tsub 修复）。
        // 修改目的：从暂停/等待位置继续同一个 runId，而不是创建新的 SubAgent run；排队中
        //          resume 后的 exit 语义与运行中一致。
        if (record.controller.signal.aborted) {
            record.controller = new AbortController();
        }
        if (record.pausedStartedAt) {
            record.inactiveDurationMs += Date.now() - record.pausedStartedAt;
            record.pausedStartedAt = undefined;
        }
        record.status = 'running';
        this.notifyWaiters(record);
        subAgentRunEventBus.emit({
            runId,
            agentName: record.agentName,
            type: 'run_resumed',
            payload: { reason: 'User resumed SubAgent run from Monitor' }
        });
        return true;
    }

    /**
     * 修改原因：共享接口需要一个统一的终止型 cancel 入口，而 SubAgent 现有终止语义由 exit 承担。
     * 修改方式：cancel 直接委托给现有 exit，实现“终止并让主工具失败”的既有行为。
     * 修改目的：让统一接口在 subagent scope 下复用既有正确语义，而不是新发明一套并行取消路径。
     */
    cancel(runId: string, reason?: string): boolean {
        return this.exit(runId, reason);
    }

    exit(runId: string, reason = '用户主动终止 SubAgent 执行'): boolean {
        const record = this.activeRuns.get(runId);
        if (!record) return false;

        // 修改原因：“退出 SubAgent 执行”必须让主窗口对应 subagents 工具失败，并尽力中止当前工具/API。
        // 修改方式：记录退出原因、abort 当前控制器、唤醒等待中的 executor，并将 run 标记为 cancelled。
        // 修改目的：区别于 pause 的非失败语义，确保用户主动退出会返回明确失败原因。
        record.status = 'cancelled';
        record.exitReason = reason;
        record.controller.abort();
        this.notifyWaiters(record);
        subAgentRunEventBus.emit({
            runId,
            agentName: record.agentName,
            type: 'run_cancelled',
            payload: { reason }
        });
        return true;
    }

    async waitUntilRunnable(runId: string): Promise<'running' | 'cancelled' | 'inactive'> {
        const record = this.activeRuns.get(runId);
        if (!record) return 'inactive';
        if (record.status === 'running') return 'running';
        if (record.status === 'cancelled') return 'cancelled';

        // 修改原因：executor 在 pause 或 awaiting_monitor_action 时需要挂起主工具 Promise，而不是返回失败。
        // 修改方式：等待 resume/exit 事件；resume 返回 running，exit 返回 cancelled。
        // 修改目的：让 Monitor 顶部控制按钮可以决定同一个 run 的后续命运。
        // 修改原因（竞态）：「检查状态」与「注册 waiter」之间存在窗口——exit/resume 可能
        //           在两次检查之间完成，notifyWaiters 已用旧（空）列表结算，随后才 push 的
        //           waiter 永远不被唤醒，主工具 Promise 悬挂。
        // 修改方式：push 之后在同一同步块内复查 record.status；已 cancelled 时移出 waiter
        //           并直接结算，不再依赖后续事件唤醒。
        return new Promise<'running' | 'cancelled' | 'inactive'>((resolve) => {
            const waiter = () => {
                const latest = this.activeRuns.get(runId);
                resolve(latest ? (latest.status === 'cancelled' ? 'cancelled' : 'running') : 'inactive');
            };
            record.waiters.push(waiter);
            if (record.status === 'cancelled') {
                const index = record.waiters.indexOf(waiter);
                if (index >= 0) {
                    record.waiters.splice(index, 1);
                }
                resolve('cancelled');
                return;
            }
        });
    }

    /** 当前 run 是否仍挂在父回合上（前台且尚未 detach）。 */
    isAttachedToParent(runId: string): boolean {
        const record = this.activeRuns.get(runId);
        return record?.attachedToParent === true && record.detached !== true;
    }

    /**
     * 判断 run 是否已与父 abort 信号解绑（转后台）。
     */
    isDetached(runId: string): boolean {
        return this.activeRuns.get(runId)?.detached === true;
    }

    /**
     * 注册 detach 回调（executor 在 run 启动时注册，unregister 时自动清理）。
     */
    registerDetachListener(runId: string, listener: () => void): void {
        this.detachListeners.set(runId, listener);
    }

    /**
     * 移除 detach 回调。
     */
    unregisterDetachListener(runId: string): void {
        this.detachListeners.delete(runId);
    }

    /**
     * 把前台 SubAgent run 转为后台继续运行（解除与父 abort 信号的绑定）。
     *
     * 修改原因：前台 SubAgent 的 abort 信号挂在主会话工具循环上，用户发新消息时
     * 旧流被 abort 会连带杀掉还在干活的 SubAgent；应当转后台继续（与 background:true 语义一致）。
     * 修改方式：标记 detached 并同步调用 executor 注册的解绑回调（移除父信号监听），
     * 后续 executor 创建的组合信号不再包含父 abort 信号；同时广播 run_detached 事件。
     * 修改目的：detach 后旧流取消不再影响该 run，run 继续执行至完成并正常进入终态。
     * 仅对 attachedToParent（前台）的活跃 run 生效；后台 run 与已 detach 的 run 返回 false。
     */
    detachFromParent(runId: string, reason = '用户发送了新消息，前台子代理已转为后台继续运行'): boolean {
        const record = this.activeRuns.get(runId);
        if (!record || !record.attachedToParent || record.detached) return false;
        record.detached = true;
        const listener = this.detachListeners.get(runId);
        if (listener) {
            try {
                listener();
            } catch (err) {
                console.warn(`[SubAgentRunController] detach listener for ${runId} threw:`, err);
            }
        }
        subAgentRunEventBus.emit({
            runId,
            agentName: record.agentName,
            type: 'run_detached',
            payload: { reason }
        });
        return true;
    }

    getAbortSignal(runId: string): AbortSignal | undefined {
        return this.activeRuns.get(runId)?.controller.signal;
    }

    getExitReason(runId: string): string | undefined {
        return this.activeRuns.get(runId)?.exitReason;
    }

    getInactiveDurationMs(runId: string): number {
        const record = this.activeRuns.get(runId);
        if (!record) return 0;
        // 修改原因：暂停和等待 Monitor 操作的时间不应计入 SubAgent maxRuntime。
        // 修改方式：记录历史 inactiveDurationMs，并在当前仍暂停/等待时加上从 pausedStartedAt 到现在的时长。
        // 修改目的：用户查看 Monitor 或等待手动决策时不会让主工具莫名超时失败。
        const currentPaused = record.pausedStartedAt ? Date.now() - record.pausedStartedAt : 0;
        return record.inactiveDurationMs + currentPaused;
    }
}

export const subAgentRunController = new SubAgentRunController();
