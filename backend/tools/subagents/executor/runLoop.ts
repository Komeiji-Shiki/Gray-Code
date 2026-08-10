/**
 * 子代理默认执行器的 run 生命周期（创建/排队/迭代/流式/工具并行/终态收敛）。
 *
 * 拆分说明：从 executor.ts 迁出（纯移动，逻辑一字未改）。工具解析/执行、错误重试、
 * 上下文裁剪、prompt 组装等辅助已拆至 ./executor/ 下的对应模块。
 */

import type {
    SubAgentConfig,
    SubAgentRequest,
    SubAgentResult,
    SubAgentToolCall,
    SubAgentExecutor,
    SubAgentExecutorContext,
    SubAgentExecutorFactory
} from '../types';
import { StreamResponseProcessor, isAsyncGenerator } from '../../../modules/api/chat/handlers';
import { ToolCallParserService } from '../../../modules/api/chat/services/ToolCallParserService';
import type { Content, ContentPart } from '../../../modules/conversation/types';
import type { GenerateRequest } from '../../../modules/channel/types';
import { subAgentRunEventBus } from '../runEventBus';
import type { SubAgentRunStatus } from '../runEventBus';
import { subAgentRunController } from '../runController';
import { subAgentConcurrencyLimiter, SubAgentQueueCancelledError } from '../concurrencyLimiter';
import { fileWriteLockManager } from '../../../core/fileWriteLockManager';
import { agentMailbox } from '../agentMailbox';
import { markAiActive } from '../../../modules/activity';
import { SUBAGENT_NESTING_PROMPT_NOTICE, SUBAGENT_TOOL_DISCIPLINE_NOTICE } from './prompts';
import { stripReplayedAgentInboxForModel } from './inbox';
import { trimSubAgentHistoryForContext } from './contextTrim';
import { resolveSubAgentAvailableTools } from './context';
import { clearRunAllowedTools, setRunAllowedTools } from './capability';
import { executeToolCall } from './executeToolCall';
import { extractTextContent, reportUsageToMainConversation } from './response';
import {
    isContextLengthError,
    isQuotaOrRateLimitError,
    isSubAgentRetryableLlmError,
    SUBAGENT_LLM_CALL_RETRY_MAX
} from './retry';
import { waitWithAbort } from './abort';
import type { ToolExecutionOutcome } from './types';

/**
 * 创建默认子代理执行器
 */
export function createDefaultExecutor(
    config: SubAgentConfig,
    context: SubAgentExecutorContext
): SubAgentExecutor {
    return async (request: SubAgentRequest, abortSignal?: AbortSignal): Promise<SubAgentResult> => {
        const toolCalls: SubAgentToolCall[] = [];
        let steps = 0;
        let modelVersion: string | undefined;
        // 修改原因：主聊天卡片和 Monitor 需要用稳定 ID 关联同一次 SubAgent 运行，但 pending 阶段前端还拿不到最终 ToolResult。
        // 修改方式：优先使用 handler 根据主工具调用 id 预分配的 runId；没有外部 runId 时才回退为本地随机 runId。
        // 修改目的：让 pending、完成态和历史态的 Open details 都能定位同一次运行，同时兼容非主聊天入口。
        const requestedRunId = typeof request.runId === 'string' && request.runId.trim() ? request.runId.trim() : undefined;
        // 预分配的 runId 可能撞上同一 toolId 上一次仍在运行的 run，交给事件总线判重
        // 修改原因：续跑必须复用旧 runId——run 记录、transcript、provider 缓存域三位一体；
        //          用新 runId 会在 Monitor 里出现第二条记录，续跑退化为「新 run 前置旧 transcript」。
        // 修改方式：continueFromRunId 存在时直接沿用旧 runId（快照存在性已由上方续跑校验保证），
        //          普通新 run 仍走 allocateRunId 判重。
        const runId = request.continueFromRunId
            ? request.continueFromRunId
            : subAgentRunEventBus.allocateRunId(
                requestedRunId || `subagent_run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
            );

        // F2：嵌套深度——由派发方（subagents handler）按“父深度 + 1”计算后随 request 传入；
        // 缺省按 0（主模型直接派发）处理。深度用于：超限校验已在 handler 完成，这里负责
        // 写入 run 元数据（run_created payload + runController 记录）供 Monitor 展示，
        // 并随工具执行上下文透传给下一层 subagents 工具调用。
        const depth = Number.isInteger(request.depth) && (request.depth ?? 0) >= 0
            ? Math.floor(request.depth!)
            : 0;

        // 修改原因：子代理对话延续——允许新子代理继承旧 run 的完整 transcript，实现跨调用的对话接力。
        // 修改方式：从 runEventBus 读取旧 run 的 contents 作为 baseContents；校验旧 run 已处于终态。
        // 修改目的：主模型可通过 continueFromRunId 参数指定延续目标，避免每次从零开始。
        const terminalStatuses: SubAgentRunStatus[] = ['completed', 'failed', 'cancelled', 'interrupted'];
        // F-06/F-09：每次调用的动态会话上下文优先于创建 executor 时的静态 context。
        // 修改原因：接续必须限定在同一个主对话内，且重载/内存淘汰后要从当前对话的
        // 持久化元数据恢复 run 快照；这些信息属于每次工具调用，不能固定在 Registry 缓存。
        const currentConversationId = request.conversationId ?? context.conversationId;
        const currentConversationStore = request.conversationStore ?? context.conversationStore;
        const currentPromptModeSnapshot = request.promptModeSnapshot ?? context.promptModeSnapshot;

        let baseContents: Content[] = [];
        if (request.continueFromRunId) {
            // F-09：先查内存快照；未命中且当前调用可提供对话 store 时，
            // 只加载当前对话的持久化快照（不扫描其他对话，避免 runId 跨对话碰撞）。
            let oldSnapshot = subAgentRunEventBus.getSnapshot(request.continueFromRunId);
            if (!oldSnapshot && currentConversationId && currentConversationStore) {
                await subAgentRunEventBus.loadConversationSnapshots(currentConversationId, currentConversationStore);
                oldSnapshot = subAgentRunEventBus.getSnapshot(request.continueFromRunId);
            }
            if (oldSnapshot?.transcriptLoaded === false) {
                oldSnapshot = await subAgentRunEventBus.loadRunTranscript(request.continueFromRunId);
            }
            if (!oldSnapshot) {
                return {
                    success: false,
                    runId,
                    error: `Cannot continue from run "${request.continueFromRunId}": run not found. It may have been cleared or never existed.`
                };
            }
            // F-06：会话归属校验——旧 run 已绑定 conversationId 且与当前不一致时拒绝，
            // 防止跨对话泄漏 transcript（错误信息不包含旧对话 ID 或任何内容）。
            if (oldSnapshot.conversationId && currentConversationId && oldSnapshot.conversationId !== currentConversationId) {
                return {
                    success: false,
                    runId,
                    error: `Cannot continue from run "${request.continueFromRunId}": the run belongs to a different conversation.`
                };
            }
            if (!terminalStatuses.includes(oldSnapshot.status)) {
                return {
                    success: false,
                    runId,
                    error: `Cannot continue from run "${request.continueFromRunId}": the run is still ${oldSnapshot.status}. Only terminal runs (completed / failed / cancelled) can be continued.`
                };
            }
            // 修改原因：续跑必须以「旧 run 最后一次实际发送给 provider 的 history」为前缀，
            //         而不是 Monitor 展示用的 contents——contents 首条是 # SubAgent Invocation 卡片，
            //         从未发给模型；以 contents 续跑会让请求前缀从第 0 条就与旧 run 不同，
            //         provider 前缀缓存（DeepSeek KVCache / Anthropic user_id 域）必然 miss。
            // 修改方式：优先取 oldSnapshot.lastSentHistory（深拷贝，保证与旧 run 实际发送逐条一致）；
            //          旧记录缺该字段时降级为从 contents 过滤掉含 '# SubAgent Invocation' 的
            //          初始卡片消息，其余保留（至少不再把卡片发给模型）。
            // 修改目的：continueFromRunId 续跑能命中旧 run 的 provider 前缀缓存，不浪费首轮 token。
            if (Array.isArray(oldSnapshot.lastSentHistory)) {
                baseContents = JSON.parse(JSON.stringify(oldSnapshot.lastSentHistory)) as Content[];
            } else {
                baseContents = JSON.parse(JSON.stringify(
                    (oldSnapshot.contents || []).filter(
                        content => !(content.parts || []).some(
                            part => typeof part.text === 'string' && part.text.includes('# SubAgent Invocation')
                        )
                    )
                )) as Content[];
            }
        }

        const initialPromptContent: Content = {
            role: 'user',
            parts: [{
                text: [
                    '# SubAgent Invocation',
                    '',
                    '## Agent System Prompt',
                    config.systemPrompt || '(empty)',
                    '',
                    request.context ? '## Context' : '',
                    request.context || '',
                    request.context ? '' : '',
                    '## User Prompt',
                    request.prompt
                ].filter(Boolean).join('\n')
            }],
            isUserInput: true,
            timestamp: Date.now()
        } as Content;
        if (request.continueFromRunId) {
            // 续跑：复用旧快照继续（保留 contents/events/lastSentHistory，不重建 run），
            // 只追加本次的 Invocation 卡片；run_resumed 由 resumeRun 广播，Monitor 记录唯一。
            subAgentRunEventBus.resumeRun(runId, config.name, {
                depth
            }, {
                conversationId: currentConversationId,
                conversationStore: currentConversationStore,
                initialContents: [initialPromptContent]
            });
        } else {
            subAgentRunEventBus.createRun(runId, config.name, {
                agentType: request.agentType,
                prompt: request.prompt,
                context: request.context,
                // F2：深度随 run_created payload 暴露，Monitor 可按需展示嵌套层级。
                depth
            }, {
                conversationId: currentConversationId,
                conversationStore: currentConversationStore,
                initialContents: [...baseContents, initialPromptContent]
            });
        }
        // 修改原因：Monitor 顶部控制按钮只能控制仍在等待主窗口工具结果的活跃 run。
        // 修改方式：默认 executor 创建 run 后立即注册到 SubAgentRunController，完成/失败时在 finally 中注销。
        // 修改目的：让 Monitor 可以区分“可中止/退出”的活跃 run 和只能查看的历史 run。
        // F2：注册时携带嵌套深度；若本 run 由另一个子 agent 派生，同时登记父子关系，
        // 供父 run 结束时级联清理（见最外层 finally 的 cascadeExitChildren）。
        subAgentRunController.register(runId, config.name, depth, !request.background);
        if (request.parentRunId) {
            subAgentRunController.registerChild(request.parentRunId, runId);
        }

        // 转后台（detach）：用户发新消息时 StreamAbortManager 会把该会话前台 SubAgent 转为后台
        // （subAgentRunController.detachFromParent），本回调同步解绑父 abort 信号，run 继续执行；
        // 后续 createOperationSignal 不再组合父信号。后台模式（background:true）不注册——
        // 其 abort 信号本就独立于父轮，detach 不应影响 TaskManager 取消能力。
        let detachedFromParent = false;
        // 修改原因：工具调用改为并行执行后，同一时刻可能存在多个进行中的操作（并行工具调用），
        //          单槽位句柄只记录最后一个：detach 时只能摘除最后创建的 handle 的父 abort
        //          监听，其余并行工具残留父监听，旧流 abort 仍会中止已转后台 run 的在飞工具。
        // 修改方式：改为句柄数组——createOperationSignal 每次 push，release 时按句柄摘除，
        //          detach 回调遍历数组逐个 detachParent。
        // 修改目的：转后台（detach）语义对并行工具调用同样正确。
        let currentOperationHandles: Array<{ detachParent: () => void }> = [];
        // 转后台（detach）后父 abort 信号对 run 不再有约束力——所有取消检查必须经由
        // 本 helper 读取父信号（detached 后视为无父信号），否则 detach 后旧流 abort
        // 仍会在下一轮迭代/工具执行前杀死 run（R7c E1）。
        const parentAbort = (): AbortSignal | undefined => (detachedFromParent ? undefined : abortSignal);
        // acquire 桥的父信号部分与 run 控制信号部分分开管理（R7c E3）：detach 只摘父信号，
        // 保留 run 控制信号——排队中已转后台的 run 仍能被 Monitor pause/exit 唤醒。
        let releaseParentAcquireListener: (() => void) | undefined;
        if (!request.background) {
            subAgentRunController.registerDetachListener(runId, () => {
                detachedFromParent = true;
                try {
                    for (const handle of currentOperationHandles) {
                        handle.detachParent();
                    }
                    releaseParentAcquireListener?.();
                    // 父 abort 还会通过超时桥接器（onParentAbort → timeoutController.abort）传播，
                    // 必须一并摘除，否则 detach 后旧流 abort 仍会中止当前操作。
                    releaseParentAbortBridge?.();
                    releaseParentAbortBridge = undefined;
                } catch (err) {
                    console.warn(`[SubAgentExecutor] Failed to detach run ${runId} from parent signal:`, err);
                }
            });
        }

        // 修改原因：多个 SubAgent 并行派发时需要全局并发上限，超出的 run 必须排队而不是被拒绝。
        // 修改方式：createRun 后先 emit run_queued 进入排队状态，acquire 全局信号量成功后 emit run_started 恢复 running。
        // 修改目的：Monitor 能显示排队中；计时起点在 acquire 之后，排队时间不计入 maxRuntime。
        subAgentRunEventBus.emit({
            runId,
            agentName: config.name,
            type: 'run_queued',
            payload: {
                runningCount: subAgentConcurrencyLimiter.getRunningCount(),
                queueLength: subAgentConcurrencyLimiter.getQueueLength()
            }
        });
        // F2：排队等待席位时除了父 abortSignal，还要监听本 run 自己的控制信号——
        // 这样父 run 级联退出（cascadeExitChildren → exit(childRunId)）能唤醒排队中的子 run，
        // 而不是让它一直等到有席位释放。
        let acquireSignal: AbortSignal | undefined = abortSignal;
        let releaseAcquireSignal: (() => void) | undefined;
        const runControlSignal = subAgentRunController.getAbortSignal(runId);
        if (runControlSignal) {
            const acquireController = new AbortController();
            const onAcquireAbort = () => acquireController.abort();
            if (abortSignal && !detachedFromParent) {
                abortSignal.addEventListener('abort', onAcquireAbort, { once: true });
            }
            runControlSignal.addEventListener('abort', onAcquireAbort, { once: true });
            acquireSignal = acquireController.signal;
            releaseParentAcquireListener = () => {
                if (abortSignal) {
                    abortSignal.removeEventListener('abort', onAcquireAbort);
                }
            };
            const releaseRunControlAcquireListener = () => {
                runControlSignal.removeEventListener('abort', onAcquireAbort);
            };
            releaseAcquireSignal = () => {
                releaseParentAcquireListener?.();
                releaseRunControlAcquireListener();
            };
        }
        /**
         * SubAgent run 的唯一终态出口。
         *
         * 修改原因：超时、超迭代、AI 调用失败等早退路径过去既不发终态事件也不带 runId，
         *          导致 Monitor 里这些 run 永远停留在 running，主聊天卡片也无法定位运行详情。
         * 修改方式：所有返回路径统一经过本函数补齐 runId，并在事件总线尚未进入终态时补发对应终态事件。
         * 修改目的：run 状态机只有一个收敛点，新增早退分支不会再遗漏状态广播。
         */
        const finalizeRun = (result: SubAgentResult): SubAgentResult => {
            const finalized: SubAgentResult = { ...result, runId };
            const snapshot = subAgentRunEventBus.getSnapshot(runId);
            if (!snapshot || !terminalStatuses.includes(snapshot.status)) {
                subAgentRunEventBus.emit({
                    runId,
                    agentName: config.name,
                    type: finalized.cancelled
                        ? 'run_cancelled'
                        : (finalized.success ? 'run_completed' : 'run_failed'),
                    payload: {
                        response: finalized.response,
                        error: finalized.error,
                        steps: finalized.steps,
                        modelVersion: finalized.modelVersion
                    }
                });
            }
            return finalized;
        };

        try {
            // 嵌套死锁防护（容量=1）：maxConcurrentAgents=1 时父 run 持有唯一席位等待子 run，
            // 子 run 又必须等父 run 释放席位——互相等待直到父 run 超时（默认 30 分钟）。
            // 子 run 必然由父 run 执行期间派生（父 run 必已持席位），因此容量=1 且存在
            // 父 run 时排队必然死锁，直接拒绝并给出明确错误，替代长时间挂起。
            // 注意：容量的权威口径在 SubAgentConcurrencyLimiter.getCapacity（含测试注入的
            // capacityProvider）；此处按同一归一化规则从 settingsManager 读取，生产环境两者
            // 指向同一全局 SettingsManager 单例。更完整的修复应下沉到 limiter（感知父链，
            // 覆盖容量>1 的兄弟节点死锁），此处仅覆盖最简单的容量=1 场景。
            if (request.parentRunId) {
                const rawCapacity = context.settingsManager?.getSubAgentsConfig?.()?.maxConcurrentAgents;
                const capacity = (typeof rawCapacity !== 'number' || !Number.isFinite(rawCapacity) || rawCapacity === 0)
                    ? (rawCapacity === 0 ? -1 : 3)
                    : (rawCapacity < 0 ? -1 : Math.floor(rawCapacity));
                if (capacity === 1) {
                    throw new Error(
                        'Nested sub-agent rejected: maxConcurrentAgents=1 would deadlock ' +
                        '(the parent run holds the only slot while waiting for this run). ' +
                        'Raise maxConcurrentAgents or avoid nested sub-agent calls.'
                    );
                }
            }
            await subAgentConcurrencyLimiter.acquire(runId, acquireSignal);
        } catch (queueError) {
            subAgentRunController.unregister(runId);
            // F2：排队被取消的早退路径也要从父 run 的派生列表里摘除，避免残留孤儿登记
            if (request.parentRunId) {
                subAgentRunController.unregisterChild(request.parentRunId, runId);
            }
            const message = queueError instanceof SubAgentQueueCancelledError
                ? 'User cancelled the sub-agent while it was waiting in the concurrency queue.'
                : `SubAgent failed to acquire a concurrency slot: ${queueError instanceof Error ? queueError.message : String(queueError)}`;
            const finalized = finalizeRun({
                success: false,
                error: message,
                cancelled: true
            });
            await subAgentRunEventBus.flushRun(runId);
            return finalized;
        } finally {
            releaseAcquireSignal?.();
            releaseAcquireSignal = undefined;
        }
        subAgentRunEventBus.emit({
            runId,
            agentName: config.name,
            type: 'run_started'
        });

        // A-COMM：run 真正启动后注册为「本对话下已知」，agent_send_message 才能按 runId/名称寻址到它；
        // 排队被取消/接续校验失败等未真正启动的早退路径不会留下“已知 run”残留；
        // run 结束/取消时在最外层 finally 中注销并清理 inbox。
        agentMailbox.registerRun(currentConversationId, runId, config.name);

        // 修改原因：子代理设置界面新增「默认迭代次数」全局配置，未单独配置的 agent 应继承该默认值。
        // 修改方式：优先取 per-agent maxIterations，其次取全局 defaultMaxIterations，最后回退 50。
        const maxIterations = config.maxIterations
            ?? context.settingsManager?.getSubAgentsConfig?.()?.defaultMaxIterations
            ?? 50;
        const maxRuntime = config.maxRuntime ?? 1800; // 默认 30 分钟
        const startTime = Date.now();
        const getActiveElapsedMs = (): number => Math.max(0, Date.now() - startTime - subAgentRunController.getInactiveDurationMs(runId));
        
        // 创建超时控制器
        let timeoutController: AbortController | null = null;
        let timeoutId: ReturnType<typeof setInterval> | undefined;
        /**
         * 摘除挂在父 abortSignal 上的超时桥接监听器。
         *
         * 修改原因：父信号（主会话 AbortController）生命周期远长于单个 run，一轮对话里派发 N 个子代理
         *          就会在同一个信号上永久累积 N 个监听器，触发 MaxListenersExceededWarning 且长期驻留内存。
         * 修改方式：保留 handler 引用，run 退出时在最外层 finally 统一摘除。
         * 修改目的：桥接监听器的生命周期与它服务的那次 run 严格对齐。
         */
        let releaseParentAbortBridge: (() => void) | undefined;

        // 检查是否超时的辅助函数
        const checkTimeout = (): { exceeded: boolean; elapsed: number } => {
            const elapsed = Math.floor(getActiveElapsedMs() / 1000);
            if (maxRuntime > 0 && elapsed >= maxRuntime) {
                return { exceeded: true, elapsed };
            }
            return { exceeded: false, elapsed };
        };

        if (maxRuntime > 0) {
            timeoutController = new AbortController();
            // 修改原因：Monitor 暂停和等待用户操作的时间不应计入 maxRuntime，固定 setTimeout 会误把暂停时间算入运行时间。
            // 修改方式：用短间隔轮询 checkTimeout，checkTimeout 会扣除 runController 记录的 inactiveDurationMs。
            // 修改目的：用户暂停查看 Monitor 或等待手动决策时，SubAgent 不会因为真实墙钟时间流逝而超时失败。
            timeoutId = setInterval(() => {
                if (checkTimeout().exceeded) {
                    timeoutController?.abort();
                }
            }, 500);
            if (abortSignal && !detachedFromParent) {
                const onParentAbort = () => {
                    if (timeoutId) {
                        clearInterval(timeoutId);
                        timeoutId = undefined;
                    }
                    timeoutController?.abort();
                };
                abortSignal.addEventListener('abort', onParentAbort, { once: true });
                releaseParentAbortBridge = () => abortSignal.removeEventListener('abort', onParentAbort);
            }
        }

        /**
         * 单次操作（一次 LLM 调用或一次工具调用）的组合中止信号句柄。
         *
         * 修改原因：旧实现每轮迭代都把 abort 监听器永久挂在父 abortSignal 和 run 控制器信号上，
         *          一个 20 轮带工具的 run 会累积上百个监听器，触发 MaxListenersExceededWarning 并长期驻留内存。
         * 修改方式：返回 release 句柄，由调用方在操作结束后摘除监听器。
         * 修改目的：组合信号的生命周期与它服务的那次操作严格对齐。
         */
        interface OperationSignalHandle {
            signal: AbortSignal | undefined;
            release: () => void;
            /** 只解绑父 abort 信号的监听（转后台 detach 用），超时与 controller 信号保持绑定 */
            detachParent: () => void;
        }

        const createOperationSignal = (): OperationSignalHandle => {
            // 转后台（detach）后不再组合父 abort 信号：detachedFromParent 由 detach 回调置位，
            // 新建的组合信号只响应超时与 controller 信号，旧流 abort 不再影响本 run。
            const signals = [detachedFromParent ? undefined : abortSignal, timeoutController?.signal, subAgentRunController.getAbortSignal(runId)]
                .filter((signal): signal is AbortSignal => !!signal);
            if (signals.length === 0) {
                // 无任何信号可组合：不注册句柄（其他并行操作的在飞句柄保留在数组中，不受影响）
                return { signal: undefined, release: () => undefined, detachParent: () => undefined };
            }
            const controller = new AbortController();
            const abort = () => controller.abort();
            const attached: AbortSignal[] = [];
            let parentSignal: AbortSignal | undefined;
            for (const signal of signals) {
                if (signal.aborted) {
                    controller.abort();
                    break;
                }
                signal.addEventListener('abort', abort, { once: true });
                attached.push(signal);
                if (signal === abortSignal) parentSignal = signal;
            }
            const handle: OperationSignalHandle = {
                signal: controller.signal,
                release: () => {
                    for (const signal of attached) {
                        signal.removeEventListener('abort', abort);
                    }
                    attached.length = 0;
                    const handleIdx = currentOperationHandles.indexOf(handle);
                    if (handleIdx >= 0) currentOperationHandles.splice(handleIdx, 1);
                },
                detachParent: () => {
                    if (parentSignal && attached.includes(parentSignal)) {
                        parentSignal.removeEventListener('abort', abort);
                        const idx = attached.indexOf(parentSignal);
                        if (idx >= 0) attached.splice(idx, 1);
                        parentSignal = undefined;
                    }
                }
            };
            currentOperationHandles.push(handle);
            return handle;
        };

        let lastResponse: string = '';

        const buildCancelledResult = (error: string): SubAgentResult => finalizeRun({
            success: false,
            response: lastResponse,
            modelVersion,
            steps,
            runId,
            toolCalls,
            error,
            cancelled: true
        });

        const waitForControlIfNeeded = async (): Promise<SubAgentResult | null> => {
            const state = subAgentRunController.getState(runId);
            if (!state) return null;
            if (state.status === 'cancelled') {
                return buildCancelledResult(subAgentRunController.getExitReason(runId) || '用户主动终止 SubAgent 执行');
            }
            if (state.status === 'paused' || state.status === 'awaiting_monitor_action') {
                const status = await subAgentRunController.waitUntilRunnable(runId);
                if (status === 'cancelled') {
                    return buildCancelledResult(subAgentRunController.getExitReason(runId) || '用户主动终止 SubAgent 执行');
                }
            }
            return null;
        };

        const isControlInterruption = (): boolean => {
            const state = subAgentRunController.getState(runId);
            return !!state && (state.status === 'paused' || state.status === 'awaiting_monitor_action' || state.status === 'cancelled');
        };
        
        // 检查是否超出迭代次数的辅助函数
        const checkIterations = (): boolean => {
            if (maxIterations === -1) return false; // -1 表示无限制
            return steps >= maxIterations;
        };

        const resolveFailureModeAfterRetries = (): 'fail_parent_tool' | 'wait_for_monitor_action' => {
            // 修改原因：旧 SubAgent 配置可能没有 failureModeAfterRetries，但运行时必须有明确策略。
            // 修改方式：优先使用单个 SubAgent 覆盖值，其次使用全局 SubAgents 默认值，最后回退到 fail_parent_tool。
            // 修改目的：满足“运行时补齐，不主动写回”的兼容策略。
            const own = config.failureModeAfterRetries;
            if (own === 'wait_for_monitor_action' || own === 'fail_parent_tool') return own;
            const global = context.settingsManager?.getSubAgentsConfig?.()?.failureModeAfterRetries;
            return global === 'wait_for_monitor_action' ? 'wait_for_monitor_action' : 'fail_parent_tool';
        };
        
        try {
            // 检查是否取消（detach 后父信号不再约束——转后台的 run 不应在此被旧流 abort 终止）
            if (parentAbort()?.aborted || timeoutController?.signal.aborted) {
                return finalizeRun({
                    success: false,
                    error: 'Cancelled before execution',
                    cancelled: true
                });
            }
            
            if (!context.configManager) {
                throw new Error('SubAgent shared parser/stream path requires configManager in executor context.');
            }
            const channelConfig = await context.configManager.getConfig(config.channel.channelId);
            if (!channelConfig) {
                throw new Error(`SubAgent channel config not found: ${config.channel.channelId}`);
            }
            const toolMode = channelConfig.toolMode || 'function_call';
            const providerType = channelConfig.type || 'custom';
            const toolCallParser = new ToolCallParserService();

            // 获取可用工具（提示词模式快照使用本次调用的动态值）
            const availableTools = await resolveSubAgentAvailableTools(config, {
                ...context,
                promptModeSnapshot: currentPromptModeSnapshot
            });

            // H-1（R4 复查）：嵌套派发时继承父 run 的工具限制——
            // 子 run 最终可用工具 = 自身配置解析结果 ∩ 父 run 可用工具
            // （白名单取交集 / 黑名单取并集在「先按自身配置解析、再取交集」的口径下等价）。
            // inheritedToolFilter 仅由框架注入（subagents handler 从父 run 复制），模型不可控。
            let effectiveTools = availableTools;
            if (request.inheritedToolFilter) {
                const inheritedSet = new Set(request.inheritedToolFilter);
                effectiveTools = availableTools.filter(decl => inheritedSet.has(decl.name));
            }
            
            // 构建允许的工具名称集合，用于执行时的防御性校验（空集 = 无任何可用工具，拒绝一切调用）
            const allowedToolNames = new Set(effectiveTools.map(t => t.name));
            // H-1：把本 run 的最终可用工具按 runId 注册，供内层 subagents 工具派发时继承
            // （run 结束时在最外层 finally 清理）。
            setRunAllowedTools(runId, allowedToolNames);
            
            // 构建系统提示词
            // F2：当本次 run 的工具集实际包含 subagents 工具时，追加中文嵌套说明，
            // 引导模型只在确实需要独立复查或主模型明确指示时才派生子子 agent。
            // L-9（R4 复查）：config.systemPrompt 可能为 undefined，拼接前兜底为空串。
            // 工具纪律一句话提示无条件追加；详细约束由用户自定义 systemPrompt 补充。
            const systemPrompt = `${config.systemPrompt ?? ''}${SUBAGENT_TOOL_DISCIPLINE_NOTICE}${allowedToolNames.has('subagents') ? SUBAGENT_NESTING_PROMPT_NOTICE : ''}`;
            
            // 构建用户提示词
            let userPrompt = request.prompt;
            if (request.context) {
                userPrompt = `Context:\n${request.context}\n\nTask:\n${request.prompt}`;
            }
            
            // 构建对话历史（Content 格式）
            // 修改原因：子代理延续——当 continueFromRunId 指定时，将旧 run 的完整 transcript 前置。
            // 修改方式：展开 baseContents 到 history 数组头部，新 user prompt 追加在末尾。
            // 修改目的：新子代理可以直接看到旧子代理完成了什么，实现跨调用接力。
            const history: Content[] = [
                ...baseContents,
                { role: 'user', parts: [{ text: userPrompt }] }
            ];
            
            // 工具迭代循环
            // 本轮 LLM 调用的 run 级兜底重试计数（ChannelManager 内部重试之外的第二层；
            // 失败重试时累计，成功时重置——见下方 catch 与 reportUsage 后的重置点）
            let llmCallRetryCount = 0;

            while (true) {
                const controlWaitResult = await waitForControlIfNeeded();
                if (controlWaitResult) {
                    return controlWaitResult;
                }

                // 检查是否取消或超时（detach 后父信号不再约束，转后台的 run 继续执行）
                if (parentAbort()?.aborted || timeoutController?.signal.aborted) {
                    const timeoutCheck = checkTimeout();
                    const isTimeout = timeoutCheck.exceeded;
                    return finalizeRun({
                        success: false,
                        response: lastResponse,
                        modelVersion,
                        steps,
                        toolCalls,
                        error: isTimeout
                            ? `Exceeded maximum runtime (${maxRuntime}s). Elapsed: ${timeoutCheck.elapsed}s`
                            : 'Cancelled during execution',
                        cancelled: !isTimeout
                    });
                }

                // 检查超时
                const timeoutCheck = checkTimeout();
                if (timeoutCheck.exceeded) {
                    return finalizeRun({
                        success: false,
                        response: lastResponse,
                        modelVersion,
                        steps,
                        toolCalls,
                        error: `Exceeded maximum runtime (${maxRuntime}s). Elapsed: ${timeoutCheck.elapsed}s`
                    });
                }

                // 检查迭代次数
                if (checkIterations()) {
                    return finalizeRun({
                        success: false,
                        response: lastResponse,
                        modelVersion,
                        steps,
                        toolCalls,
                        error: `Exceeded maximum iterations (${maxIterations})`
                    });
                }
                
                steps++;
                
                // 调用 AI
                const operation = createOperationSignal();
                const operationSignal = operation.signal;
                let retryFailedInThisCall = false;
                // H1-4：剥离已投递的 agentInbox（只保留最后一条未投递消息的），
                // 防止同 run 后续迭代 / continueFromRunId 续跑重放已 drain 的信箱消息。
                // 剥离结果就是本轮实际发送给 provider 的请求历史，随后立即记录到事件总线
                // （lastSentHistory），供 continueFromRunId 续跑精确复用前缀（见 baseContents 选取逻辑）。
                const sentHistory = stripReplayedAgentInboxForModel(history);
                // 修改原因（SEC）：子代理 history 只增不减，长任务会撞上模型上下文上限直接失败。
                // 修改方式：发送前做请求级上下文裁剪（保留首条任务消息与末尾配对，超长字符串截断），
                //         裁剪结果即为本轮实际发送内容；updateLastSentHistory 同步记录裁剪结果，
                //         保证 continueFromRunId 续跑前缀与实际发送历史一致。
                // 修改目的：子代理长任务在撞上限前自动收敛上下文，不再直接失败。
                const trimmedHistory = trimSubAgentHistoryForContext(sentHistory, channelConfig);
                const generateRequest: GenerateRequest = {
                    configId: config.channel.channelId,
                    history: trimmedHistory,
                    dynamicSystemPrompt: systemPrompt,
                    abortSignal: operationSignal,
                    // H-1：toolOverrides 使用继承过滤后的 effectiveTools（子 run 不向模型暴露
                    // 父 run 不允许的工具），与 allowedToolNames 防御性校验口径一致。
                    // 修改原因（M-6 加固）：空工具集过去被转成 undefined，ChannelManager 会把
                    // undefined 当作「未指定覆盖」回退成渠道全量工具声明——模型反复调用不可用工具
                    // 形成失败循环。空数组为真值，能穿透 ChannelManager 并让 formatter 不注入任何
                    // 工具（formatter 只在 tools.length > 0 时声明），与 allowedToolNames 空集语义一致。
                    toolOverrides: effectiveTools,
                    suppressRetryNotification: true,
                    // 修改原因：DeepSeek KVCache 按 user_id 隔离、Anthropic metadata.user_id 区分运行域都依赖请求携带稳定标识。
                    // 修改方式：SubAgent 用 runId 作为 conversationId，每个 run 拥有独立缓存域（formatter 会哈希，不泄露原始 ID）。
                    // 修改目的：主会话与各 SubAgent、SubAgent 彼此之间的 provider 侧缓存互不污染。
                    // 修改原因：continueFromRunId 续跑时若仍用新 runId 作 conversationId，user_id 按它哈希
                    //          会让续跑落入新缓存域、前缀缓存必 miss。
                    // 修改方式：续跑时 conversationId 直接沿用旧 run 的 runId（request.continueFromRunId），
                    //          user_id 哈希输入与旧 run 完全一致，缓存域天然相同；普通新 run 仍用新 runId。
                    // 修改目的：模型调用 subagents 工具时只需传 continueFromRunId（参数与旧调用一致），
                    //          系统即自动复用旧 run 的 provider 侧缓存域（DeepSeek user_id / Anthropic user_id），无需额外字段。
                    conversationId: request.continueFromRunId || runId,
                    retryStatusCallback: (status) => {
                        if (status.type === 'retryFailed') {
                            retryFailedInThisCall = true;
                        }
                        // 修改原因：SubAgent 内部自动重试状态不能进入主窗口 retryStatus，但用户需要在 Monitor 里看到。
                        // 修改方式：通过 GenerateRequest.retryStatusCallback 把 ChannelManager 的 retrying/retrySuccess/retryFailed 事件路由到 SubAgent runEventBus。
                        // 修改目的：继续复用 Provider 自动重试配置，同时让 Monitor 成为内部重试状态的唯一展示位置。
                        subAgentRunEventBus.emit({
                            runId,
                            agentName: config.name,
                            type: status.type || 'run_updated',
                            payload: status
                        });
                    },
                    // 修改原因：SubAgent 解析 XML/JSON prompt tool mode 时必须和主请求使用同一份模式快照。
                    // 修改方式：把父请求解析好的 promptModeSnapshot 继续传给 ChannelManager。
                    // 修改目的：避免 SubAgent 工具声明和工具调用解析在不同 prompt mode 下再次分叉。
                    promptModeSnapshot: currentPromptModeSnapshot
                };
                // 立即记录本轮实际发送给 provider 的 history：续跑时以此为前缀才能命中旧 run 的 provider 缓存
                subAgentRunEventBus.updateLastSentHistory(runId, trimmedHistory);

                // 如果指定了模型，设置模型覆盖
                if (config.channel.modelId) {
                    generateRequest.modelOverride = config.channel.modelId;
                }
                
                let response: any;
                try {
                    const result = await context.channelManager.generate(generateRequest);
                    const requestStartTime = Date.now();
                    const streamProcessor = new StreamResponseProcessor({
                        requestStartTime,
                        providerType,
                        toolMode,
                        abortSignal: operationSignal,
                        conversationId: runId
                    });
                    
                    if (isAsyncGenerator(result)) {
                        // 修改原因：SubAgent 不应直接 new StreamAccumulator，否则主窗口流式解析升级时 Monitor 不会同步升级。
                        // 修改方式：复用 StreamResponseProcessor，并把处理后的 chunk 原样通过事件总线转给 Monitor。
                        // 修改目的：SubAgent Monitor 与主窗口共享流式解析、contentSnapshot 和取消语义。
                        for await (const chunkData of streamProcessor.processStream(result as AsyncGenerator<any>)) {
                            // 子代理正在生成：视为用户在场（主人在 Monitor/主窗口查看）
                            markAiActive();
                            if (operationSignal?.aborted || checkTimeout().exceeded) {
                                break;
                            }
                            subAgentRunEventBus.emit({
                                runId,
                                agentName: config.name,
                                type: 'llm_delta',
                                payload: chunkData.chunk
                            });
                        }
                        if (operationSignal?.aborted && isControlInterruption()) {
                            // 修改原因：暂停/退出会中止当前 LLM 流，旧逻辑会继续把 partial content 当作成功响应并可能发 run_completed。
                            // 修改方式：流循环结束后立即检查 run control state，交给 waitForControlIfNeeded 处理 pause/resume/exit 语义。
                            // 修改目的：SubAgent pause 不让主工具失败，exit 才按用户意图让主工具失败，避免 partial stream 被误判完成。
                            const controlResult = await waitForControlIfNeeded();
                            if (controlResult) return controlResult;
                            continue;
                        }
                        if (parentAbort()?.aborted || timeoutController?.signal.aborted || checkTimeout().exceeded) {
                            // 修改原因：流式循环因超时/父取消 abort 中断后，partial response 过去仍被
                            //          当作本轮模型输出解析工具调用（可能执行半截工具调用）、写入 history
                            //          与 transcript，超时边界下产生半截工具调用记录。
                            // 修改方式：控制中断（pause/exit/awaiting_monitor_action）已由上方分支处理；
                            //          此处识别「超时或父取消」直接丢弃 partial response 并走终态，
                            //          只有完整流才继续进入下方的工具解析/转录路径。
                            // 修改目的：超时/取消边界下不再产生半截工具调用与转录残留。
                            const timeoutCheck = checkTimeout();
                            const isTimeout = timeoutCheck.exceeded;
                            return finalizeRun({
                                success: false,
                                response: lastResponse,
                                modelVersion,
                                steps,
                                toolCalls,
                                error: isTimeout
                                    ? `Exceeded maximum runtime (${maxRuntime}s). Elapsed: ${timeoutCheck.elapsed}s`
                                    : 'Cancelled during execution',
                                cancelled: !isTimeout
                            });
                        }
                        response = {
                            content: streamProcessor.getContent()
                        };
                    } else {
                        const processed = streamProcessor.processNonStream(result as any);
                        response = {
                            ...(result as any),
                            content: processed.content
                        };
                        subAgentRunEventBus.emit({
                            runId,
                            agentName: config.name,
                            type: 'llm_delta',
                            payload: processed.chunkData.chunk
                        });
                    }
                    // 修改原因：本轮模型输出过去被写入 transcript 三次（流结束一次、裸 content_snapshot 一次、解析后再一次），
                    //          每次都递增 contentRevision、广播事件、入队全量落盘，并让 Monitor 前端强制重拉一次窗口。
                    // 修改方式：删除这里的早写与裸事件，统一由下方"prompt 模式工具调用解析完成后"的唯一写入口落盘。
                    // 修改目的：每轮只产生一次 transcript 修订，且写入的是工具调用已还原为 functionCall 的权威版本。
                } catch (e) {
                    // 检查是否是超时导致的错误
                    const timeoutCheck = checkTimeout();
                    if (timeoutCheck.exceeded) {
                        return finalizeRun({
                            success: false,
                            response: lastResponse,
                            modelVersion,
                            steps,
                            toolCalls,
                            error: `Exceeded maximum runtime (${maxRuntime}s). Elapsed: ${timeoutCheck.elapsed}s`
                        });
                    }
                    if (operationSignal?.aborted && isControlInterruption()) {
                        const controlResult = await waitForControlIfNeeded();
                        if (controlResult) return controlResult;
                        continue;
                    }

                    // run 级兜底重试：ChannelManager 内部重试耗尽后，对可重试错误
                    // （429/5xx/网络/超时/空响应）再退避重试，避免子代理因瞬时配额/限流
                    // 直接失败退出。重试不增加 steps（同一轮重新调用 LLM），退避间隔对
                    // 429 类配额错误更长（配额恢复需要时间）。重试状态发到事件总线，
                    // Monitor 可见"自动重试中"。
                    if (llmCallRetryCount < SUBAGENT_LLM_CALL_RETRY_MAX && isSubAgentRetryableLlmError(e)) {
                        llmCallRetryCount++;
                        const retryFailureMessage = e instanceof Error ? e.message : String(e);
                        const isQuota = isQuotaOrRateLimitError(e);
                        const baseDelayMs = isQuota
                            ? (llmCallRetryCount === 1 ? 15000 : 45000)
                            : (llmCallRetryCount === 1 ? 10000 : 30000);
                        // 修改原因：多个子代理同时触发 429 重试时会以相同间隔同步退避，
                        //          恢复后再次同时请求，形成同步波峰反复触发限流。
                        // 修改方式：退避间隔加 ±30% 随机抖动（0.7~1.3 倍），错开各 run 的重试时刻。
                        const jitterRatio = 0.7 + Math.random() * 0.6;
                        const delayMs = Math.round(baseDelayMs * jitterRatio);
                        subAgentRunEventBus.emit({
                            runId,
                            agentName: config.name,
                            type: 'run_updated',
                            payload: {
                                status: 'running',
                                note: `LLM call failed (${retryFailureMessage}); auto-retrying in ${Math.round(delayMs / 1000)}s (attempt ${llmCallRetryCount}/${SUBAGENT_LLM_CALL_RETRY_MAX})`
                            }
                        });
                        const waited = await waitWithAbort(delayMs, timeoutController?.signal);
                        if (!waited || parentAbort()?.aborted || timeoutController?.signal.aborted) {
                            const timeoutCheckAfter = checkTimeout();
                            if (timeoutCheckAfter.exceeded) {
                                return finalizeRun({
                                    success: false,
                                    response: lastResponse,
                                    modelVersion,
                                    steps,
                                    toolCalls,
                                    error: `Exceeded maximum runtime (${maxRuntime}s). Elapsed: ${timeoutCheckAfter.elapsed}s`
                                });
                            }
                            return finalizeRun({
                                success: false,
                                response: lastResponse,
                                modelVersion,
                                steps,
                                toolCalls,
                                error: 'Cancelled during LLM retry wait',
                                cancelled: true
                            });
                        }
                        continue;
                    }

                    if (retryFailedInThisCall && resolveFailureModeAfterRetries() === 'wait_for_monitor_action') {
                        const reason = e instanceof Error ? e.message : String(e);
                        subAgentRunController.markAwaitingMonitorAction(runId, reason);
                        const controlResult = await waitForControlIfNeeded();
                        if (controlResult) return controlResult;
                        continue;
                    }

                    const failureMessage = e instanceof Error ? e.message : String(e);
                    const retryNote = llmCallRetryCount > 0
                        ? ` (auto-retried ${llmCallRetryCount} time(s) before giving up)`
                        : '';
                    return finalizeRun({
                        success: false,
                        response: lastResponse,
                        modelVersion,
                        steps,
                        toolCalls,
                        error: isContextLengthError(e)
                            ? `SubAgent ran out of context after ${steps} tool iteration(s) (${history.length} messages accumulated). `
                            + `Requests are trimmed before sending, but the working set still exceeds the model limit: `
                            + `lower this agent's maxIterations, narrow the task, `
                            + `avoid tools that return very large results, or split the work across several sub-agent calls. `
                            + `Original error: ${failureMessage}`
                            : `AI call failed${retryNote}: ${failureMessage}`
                    });
                } finally {
                    // 本轮 LLM 调用结束，摘除组合信号挂在父信号上的 abort 监听器
                    operation.release();
                }

                // 修改原因：子代理的 token 消耗此前不进入主会话用量统计，UsagePage 看不到子代理开销。
                // 修改方式：每轮 generate 成功后从响应 content 提取 usageMetadata，归集到主会话用量索引；
                //          无主会话归属或未注入归集回调时跳过（见 reportUsageToMainConversation）。
                // 修改目的：用量统计页能汇总展示子代理消耗（source='subagent'），且不影响主会话历史。
                await reportUsageToMainConversation(response, currentConversationId, context.usageIndexAppend);
                // 本轮 LLM 调用成功：重置 run 级重试计数（下一次失败重新从 0 累计）
                llmCallRetryCount = 0;
                
                // 修改原因：SubAgent 过去自己解析各 provider 的工具调用，主流程支持 XML/JSON prompt tool mode 后容易漏同步。
                // 修改方式：统一把标准 Content 交给 ToolCallParserService 转换和提取 functionCall。
                // 修改目的：所有工具调用解析能力只维护一个入口。
                if (response?.content) {
                    toolCallParser.convertPromptModeToolCallsToFunctionCalls(response.content, toolMode);
                    toolCallParser.ensureFunctionCallIds(response.content);
                }
                const currentToolCalls = response?.content
                    ? toolCallParser.extractFunctionCalls(response.content, toolMode)
                    : [];
                const textContent = extractTextContent(response);

                // 修改原因：xml/json prompt tool mode 下模型可能在发出工具调用后继续输出文本——
                // 此时工具结果尚未返回，工具调用之后的文本没有依据，属于幻觉尾巴
                // （实测：模型在 read_file 前先编出整页不存在的台词内容）。
                // 修改方式：仅忽略"第一个工具调用 part 之后"的非 thought 文本；工具调用之前的
                //          分析/计划文本完整保留（模型基于用户消息与既有工具结果的分析是有效推理），
                //          工具照常执行，后续轮次基于真实工具结果作答；
                //          幻觉的源头约束由提示词纪律承担（SUBAGENT_TOOL_DISCIPLINE_NOTICE）。
                // 修改目的：只裁真正无依据的输出尾巴，保留模型的分析过程。
                const hasPriorToolResult = history.some(
                    msg => msg.role === 'user' && (msg.parts || []).some(p => (p as any).functionResponse)
                );
                if (textContent && currentToolCalls.length > 0 && toolMode !== 'function_call') {
                    const parts = (response as any)?.content?.parts;
                    if (Array.isArray(parts)) {
                        let seenToolCall = false;
                        (response as any).content.parts = parts.filter((p: any) => {
                            if (p.functionCall) {
                                seenToolCall = true;
                                return true;
                            }
                            // 第一个工具调用之后的非 thought 文本：无工具结果支撑，忽略
                            if (p.text && !p.thought && seenToolCall) return false;
                            return true;
                        });
                    }
                }

                // 记录子代理实际运行的模型版本（优先 content.modelVersion，其次 response.model）
                const mvCandidate =
                    (response as any)?.content?.modelVersion
                    || (response as any)?.modelVersion
                    || (response as any)?.model;
                if (typeof mvCandidate === 'string' && mvCandidate.trim()) {
                    modelVersion = mvCandidate.trim();
                }
                
                // 修改原因：xml/json prompt 模式下模型可能在发起工具调用后继续输出文本——
                // 工具结果尚未返回，这段文本是模型基于文件名与提示词编造的幻觉内容。
                // 旧逻辑无条件把 textContent 写入 lastResponse，一旦后续轮次遇到空响应
                // （上游返回空内容 / 超时 / API 失败），finalizeRun 会把这份幻觉文本
                // 作为 partialResponse 返回给主模型（实测：主模型因此读到全部编造的
                // 台词内容，误判页面内容）。
                // 修改方式：无工具调用轮（代理即将完成、文本才是最终答案）以及
                //          已有工具结果后的中间分析轮（基于真实结果，非幻觉）才更新
                //          lastResponse；首个工具结果之前的"文本+工具调用"轮不更新。
                //          且 lastResponse 使用剥离幻觉尾巴后的文本（cleanedTextContent），
                //          与写入 history 的口径一致。
                // 修改目的：失败/空响应时 partialResponse 不再携带幻觉预生成，
                //          主模型只会看到空内容、上一次真正完成的回答或真实中间分析。
                const cleanedTextContent = extractTextContent(response);
                if (cleanedTextContent && (currentToolCalls.length === 0 || hasPriorToolResult)) {
                    lastResponse = cleanedTextContent;
                }
                
                // 将 AI 响应完整添加到历史（保留思维链）
                if (response?.content) {
                    // 修改原因：主链路对 assistant 历史始终回传思维链（openai formatter 永远携带 reasoning_content，
                    //          anthropic formatter 会把 thought/signature 重建为 thinking block）；旧实现在这里过滤 thought，
                    //          导致 SubAgent 的 DeepSeek 思维链断裂、缓存前缀错乱，Anthropic extended thinking + tool_use 直接报错。
                    // 修改方式：history 保留完整 parts（含 thought/signature/redactedThinking），与主会话请求语义对齐。
                    // 修改目的：SubAgent 的思维链回传与缓存行为和主窗口完全一致。
                    subAgentRunEventBus.updateLastModelContent(runId, response.content);
                    const responseParts = response.content.parts || [];
                    if (responseParts.length > 0) {
                        history.push({
                            role: 'model',
                            parts: responseParts
                        });
                    }
                }
                
                // 如果没有工具调用，说明代理已完成任务
                if (currentToolCalls.length === 0) {
                    return finalizeRun({
                        success: true,
                        response: lastResponse,
                        modelVersion,
                        steps,
                        runId,
                        toolCalls
                    });
                }
                
                // 执行工具调用
                const toolResultParts: ContentPart[] = [];

                // 修改原因：主会话 ToolExecutionService 已把同一响应中的多个工具调用收集为
                //          「可并行段」并用 Promise.all 并行执行（信号量负责限流与排队）；
                //          子代理 executor 这里仍是逐个 await 严格串行——即使
                //          maxConcurrentAgents=-1，嵌套派生的多个子代理也 1 个 1 个跑，
                //          与主会话并行语义不一致（实现遗漏，非刻意设计）。
                // 修改方式：每个 call 的执行块映射为独立 Promise：块内「超时/取消预检」保持同步
                //          （map 阶段按原序同步执行——任一 call 未通过预检时，其后的 call
                //          同样同步返回早退标记、不会启动工具，与旧串行实现的早退净效果一致），
                //          executeToolCall 由 Promise.all 并行执行，结果按原 call 顺序回填
                //          toolCalls / toolResultParts（history push 顺序稳定）。
                // 修改目的：嵌套子代理并行度与主会话一致；单工具调用场景行为完全不变。
                const toolExecutionOutcomes = await Promise.all(
                    currentToolCalls.map(async (call): Promise<ToolExecutionOutcome> => {

                        // 执行工具前检查超时（同步预检：map 阶段按原序同步执行完毕，
                        // 未通过预检的 call 返回早退标记，不创建组合信号、不执行工具）
                        const timeoutCheck = checkTimeout();
                        if (timeoutCheck.exceeded || parentAbort()?.aborted || timeoutController?.signal.aborted) {
                            return { earlyExit: true as const, timeoutCheck };
                        }

                        // 组合信号在早退检查之后创建，避免为不会执行的工具调用注册监听器
                        const toolOperation = createOperationSignal();
                        const toolStartTime = Date.now();
                        try {
                            const result = await executeToolCall(
                                call.name,
                                call.args,
                                { ...context, promptModeSnapshot: currentPromptModeSnapshot },
                                toolOperation.signal,
                                allowedToolNames,
                                config,
                                call.id,
                                runId,
                                config.name,
                                // A-COMM：子代理信箱会话使用本次调用的动态主会话 ID
                                currentConversationId,
                                // F2：把本 run 的嵌套深度随工具上下文透传，供内层 subagents 工具做深度校验
                                depth
                            );
                            return { earlyExit: false as const, call, result, duration: Date.now() - toolStartTime };
                        } finally {
                            toolOperation.release();
                        }
                    })
                );

                // 按原 call 顺序回填结果（toolCalls / toolResultParts 顺序与模型调用顺序一致，
                // 保证 history push 顺序稳定）；早退标记不产生结果。
                let firstEarlyExit: { timeoutCheck: { exceeded: boolean; elapsed: number } } | undefined;

                for (const outcome of toolExecutionOutcomes) {
                    if (outcome.earlyExit) {
                        if (!firstEarlyExit) firstEarlyExit = outcome;
                        continue;
                    }
                    const { call, result, duration } = outcome;

                    toolCalls.push({
                        tool: call.name,
                        args: call.args,
                        result: result.result,
                        success: result.success,
                        duration
                    });

                    if (result.responseParts && result.responseParts.length > 0) {
                        // 修改原因：主 ToolExecutionService 已经负责构造包含多模态 parts 的 functionResponse，SubAgent 不应再手写简化结果。
                        // 修改方式：优先写入 ToolExecutionService 返回的 responseParts，并在 prompt 模式下带上 multimodalAttachments。
                        // 修改目的：确保图片/PDF/MCP 多模态结果在 SubAgent 内部能按主流程同样的格式回传给子模型。
                        if (result.multimodalAttachments && result.multimodalAttachments.length > 0) {
                            toolResultParts.push(...result.multimodalAttachments);
                        }
                        toolResultParts.push(...result.responseParts);
                    } else {
                        // 回退路径只用于旧上下文缺少 ToolExecutionService 的情况，保留原始 id 以满足 Anthropic/Responses 配对要求。
                        toolResultParts.push({
                            functionResponse: {
                                name: call.name,
                                response: {
                                    success: result.success,
                                    result: result.result,
                                    error: result.error
                                },
                                id: call.id
                            }
                        });
                    }
                }

                // 任一 call 未通过预检（超时/取消在工具执行前触发）：整体早退。已完成执行的
                // call 结果已按原序回填（与旧串行实现「先执行、再在下一 call 的预检处 return」
                // 的净效果一致）；此处不再 push history——旧实现同样在预检 return 处跳过
                // history push。早退信息取首个早退标记的快照，与旧实现预检时刻的状态一致。
                if (firstEarlyExit) {
                    return finalizeRun({
                        success: false,
                        response: lastResponse,
                        modelVersion,
                        steps,
                        toolCalls,
                        error: `Exceeded maximum runtime (${maxRuntime}s). Elapsed: ${firstEarlyExit.timeoutCheck.elapsed}s`,
                        cancelled: !firstEarlyExit.timeoutCheck.exceeded
                    });
                }
                
                // 将工具结果添加到历史（作为 user 消息）
                const functionResponseContent = {
                    role: 'user' as const,
                    parts: toolResultParts,
                    isFunctionResponse: true,
                    timestamp: Date.now()
                } as Content;
                history.push({
                    role: 'user',
                    parts: toolResultParts
                });
                // 修改原因：SubAgent 工具结果写入也要经过统一 transcript 仓储接口，避免继续新增“只属于事件总线旧 API”的写路径。
                // 修改方式：通过 runEventBus 暴露的 getTranscriptRepository().appendContent 写入 functionResponse content。
                // 修改目的：让主聊天与 SubAgent 的 transcript append 语义完全对齐，同时不改变 event bus 的广播和持久化效果。
                await subAgentRunEventBus.getTranscriptRepository(runId).appendContent(functionResponseContent);
            }
            
        } catch (e) {
            // 检查是否是超时导致的错误
            const timeoutCheck = checkTimeout();
            const error = timeoutCheck.exceeded
                ? `Exceeded maximum runtime (${maxRuntime}s). Elapsed: ${timeoutCheck.elapsed}s`
                : (e instanceof Error ? e.message : String(e));
            return finalizeRun({
                success: false,
                response: lastResponse,
                modelVersion,
                steps,
                runId,
                toolCalls,
                error
            });
        } finally {
            // 修改原因：超时轮询定时器过去只在父 abortSignal 触发时才清理，正常完成的 run 会永久泄漏一个 500ms 定时器。
            // 修改方式：在最外层 finally 无条件清理，覆盖成功、失败、取消和异常所有退出路径。
            // 修改目的：run 结束后不再有后台定时器持续调用 checkTimeout 并反复 abort 已废弃的控制器。
            if (timeoutId) {
                clearInterval(timeoutId);
                timeoutId = undefined;
            }
            releaseParentAbortBridge?.();
            releaseParentAbortBridge = undefined;
            // 修改原因：run 完成、失败或取消后不能继续显示为可控制的活跃执行，也不能继续占用并发席位。
            // 修改方式：executor 最外层 finally 注销 runController 活跃记录并释放全局信号量席位（release 幂等）。
            // 修改目的：避免历史 run 卡死并发队列或展示会影响主工具的控制按钮。
            // F2：级联清理——本 run 结束时退出其派生的所有子 run（含排队/后台），防止孤儿 run 继续运行；
            // 同时把自己从父 run 的派生列表里摘除（父 run 已结束时会由它的 cascadeExitChildren 清空，这里幂等）。
            subAgentRunController.cascadeExitChildren(
                runId,
                'Parent sub-agent run ended; nested sub-agent runs were cancelled.'
            );
            subAgentRunController.unregister(runId);
            if (request.parentRunId) {
                subAgentRunController.unregisterChild(request.parentRunId, runId);
            }
            subAgentConcurrencyLimiter.release(runId);
            // H-1：run 结束时清理本 run 在 runAllowedToolsRegistry 中的工具限制登记，
            // 避免内存残留；嵌套子 run 在派发时已把父限制复制进自己的 request，不受影响。
            clearRunAllowedTools(runId);
            // A-COMM：run 结束/取消时注销信箱已知记录并清理该 run 的 inbox，避免内存残留与误投递。
            agentMailbox.unregisterRun(currentConversationId, runId);
            // 修改原因：run 异常退出时可能残留未释放的文件写锁（正常路径已在工具执行 finally 中释放）。
            // 修改方式：按 runId 兜底清理该 run 持有的全部锁。
            // 修改目的：避免锁泄漏导致其他 agent 永久无法修改相关文件。
            fileWriteLockManager.releaseAllByHolder(runId);
            // 终态事件必须在工具 Promise 返回主流程前落盘；否则扩展重载会把已完成 run 误判为 interrupted。
            await subAgentRunEventBus.flushRun(runId);
        }
    };
}

/**
 * 默认执行器工厂
 */
export const defaultExecutorFactory: SubAgentExecutorFactory = createDefaultExecutor;
