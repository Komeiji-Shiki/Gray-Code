/**
 * Agent 间消息信箱（A-COMM）
 *
 * 提供「子代理 ↔ 子代理」以及「子代理 → 主模型」的轻量异步消息投递：
 * - 内存存储，不做持久化；run 结束即清理该 run 的 inbox。
 * - 按 (conversationId, runId) 隔离：默认只能发给同一对话下已知的 runId（防冒充/注入）。
 * - threadId + hopDepth 防循环：同一线程回复超过 MAX_HOP_DEPTH 跳后拒绝投递并返回明确错误。
 *
 * 投递时机由 ToolExecutionService 在每次工具调用完成后主动 drain 本 run 的 inbox，
 * 把消息追加到最近一次工具结果之后、与工具结果一起返回给模型（见 injectInboxMessages）。
 */

import { newUuid } from '../id';

/** 主会话（主模型）在信箱中的保留 runId */
export const MAIN_SESSION_RUN_ID = '__main__';

/** 主会话（主模型）可按 targetAgentName 寻址的保留名称 */
export const MAIN_AGENT_NAME = 'main';

/** 同一 thread 允许的最大回复跳数（防循环上限） */
export const MAX_HOP_DEPTH = 5;

/** 用户消息插入主会话 inbox 的文本长度上限（防超长刷屏） */
export const USER_INTERRUPT_MAX_LENGTH = 4000;

/** 同一会话用户消息插入的最短间隔（毫秒，防刷屏） */
export const USER_INTERRUPT_MIN_INTERVAL_MS = 10_000;

/** agent_send_message 单条消息文本长度上限（防失控子代理向主会话注入超大消息） */
export const AGENT_MESSAGE_MAX_LENGTH = 16000;

/** 单个收件方 inbox 允许积压的消息条数上限（防上下文洪泛） */
export const AGENT_INBOX_MAX_MESSAGES = 50;

/** 主会话每次领取的消息条数上限，避免一次构造过大的模型请求。 */
export const MAIN_SESSION_CLAIM_MAX_MESSAGES = 8;

/** 主会话每次领取的正文总字符上限；首条消息即使超长也仍允许单独领取。 */
export const MAIN_SESSION_CLAIM_MAX_CHARACTERS = 64 * 1024;

/** 单会话 threadDepths 允许的最大线程条目数（超过按 FIFO 淘汰最旧条目，防长会话线性增长） */
export const THREAD_DEPTH_MAX_ENTRIES = 512;

/**
 * 一条投递到收件方 inbox 的消息
 */
export type AgentMessageKind = 'agent' | 'user_interrupt' | 'system';

export interface AgentMessage {
    /** 消息唯一 ID */
    id: string;
    /** 线程 ID（同一线程内回复会递增 hopDepth） */
    threadId: string;
    /** 发送方 runId */
    fromRunId: string;
    /** 发送方 agent 名称（已知时填充，便于收件方识别） */
    fromAgentName?: string;
    /** 收件方 runId */
    toRunId: string;
    /** 消息正文 */
    text: string;
    /** 当前线程跳数（1 起，超过 MAX_HOP_DEPTH 拒绝投递） */
    hopDepth: number;
    /** 创建时间戳 */
    createdAt: number;
    /** 消息来源。可选仅用于兼容升级前仍驻留在内存中的消息。 */
    kind?: AgentMessageKind;
}

/** 主模型空闲投递时领取的一批消息；确认前仍由信箱持有。 */
export interface AgentMessageClaim {
    claimId: string;
    conversationId: string;
    runId: string;
    messages: AgentMessage[];
}

/**
 * 升级前的旧内存消息没有 kind：旧版只有用户插话会把 fromAgentName 写成 user，
 * 因此保留这个回退。新消息一律优先采用 kind，名为 user 的普通子 agent 不会再被
 * 误认成用户插话。
 */
function getAgentMessageKind(message: AgentMessage): AgentMessageKind {
    if (message.kind) return message.kind;
    return message.fromAgentName === 'user' ? 'user_interrupt' : 'agent';
}

function isUserInterruptMessage(message: AgentMessage): boolean {
    return getAgentMessageKind(message) === 'user_interrupt';
}

/**
 * 把代理消息转成可直接作为 user content 注入模型的文本。
 * 保留 runId / threadId / hopDepth，收件模型可以据此继续同一线程回复。
 */
export function formatAgentMessagesForModel(messages: AgentMessage[]): string {
    const onlyUserMessages = messages.length > 0 && messages.every(isUserInterruptMessage);
    const title = onlyUserMessages
        ? (messages.length === 1 ? '[User message received]' : '[User messages received]')
        : (messages.length === 1 ? '[Agent message received]' : '[Agent messages received]');
    const sections = messages.map((message, index) => {
        const sender = isUserInterruptMessage(message)
            ? 'User'
            : message.fromAgentName
                ? `${message.fromAgentName} (${message.fromRunId})`
                : message.fromRunId;
        return [
            messages.length > 1 ? `Message ${index + 1}:` : undefined,
            `From: ${sender}`,
            `Thread ID: ${message.threadId}`,
            `Hop depth: ${message.hopDepth}`,
            'Message:',
            message.text
        ].filter((line): line is string => typeof line === 'string').join('\n');
    });
    return `${title}\n\n${sections.join('\n\n---\n\n')}`;
}

/**
 * 发送消息的入参
 */
export interface AgentSendMessageInput {
    /** 会话 ID（必需，会话限定） */
    conversationId: string;
    /** 发送方 runId（主会话为 MAIN_SESSION_RUN_ID） */
    fromRunId: string;
    /** 发送方 agent 名称（可选，用于收件方识别） */
    fromAgentName?: string;
    /** 按 runId 寻址（与 targetAgentName 二选一） */
    targetRunId?: string;
    /** 按 agent 名称寻址（必须限定在 conversationId 内） */
    targetAgentName?: string;
    /** 消息正文 */
    text: string;
    /** 线程 ID（不传则新建线程） */
    threadId?: string;
}

/**
 * 可信后台系统生产者向主会话投递消息的入参。
 *
 * 与 agent_send_message 的边界不同：后台任务结果可能超过 16k，且 run 在终态投递时
 * 已经注销，因此这里不做发送方存活/正文长度/hop 校验。调用者必须是扩展内部受信模块；
 * messageId 由调用者稳定生成，用于在 inbox 与未确认 claim 之间幂等去重。
 */
export interface MainSessionSystemMessageInput {
    conversationId: string;
    messageId: string;
    fromRunId: string;
    fromAgentName?: string;
    text: string;
    threadId?: string;
}

/**
 * 可信后台系统生产者向任意收件方投递消息的入参。
 *
 * 在 MainSessionSystemMessageInput 基础上增加可选 toRunId：缺省或 '__main__' 时投递主会话
 * （与 enqueueMainSessionSystemMessage 语义一致）；指定其他 runId 时要求该 run 必须是
 * 当前会话下仍活跃的已知 run（父子代理发起后台任务后，结果应投递给发起者而非主会话）。
 */
export interface SystemMessageInput extends MainSessionSystemMessageInput {
    /** 收件方 runId；缺省投递主会话。指定时必须为当前会话已知的活跃 run。 */
    toRunId?: string;
}

export type AgentSendMessageResult =
    | {
          success: true;
          data: {
              messageId: string;
              threadId: string;
              toRunId: string;
              hopDepth: number;
          };
      }
    | {
          success: false;
          error: string;
      };

interface KnownRun {
    runId: string;
    agentName?: string;
    registeredAt: number;
}

/**
 * 用户消息插入（U1）的错误码
 */
export type UserInterruptErrorCode =
    | 'INVALID_CONVERSATION'
    | 'EMPTY_TEXT'
    | 'TEXT_TOO_LONG'
    | 'RATE_LIMITED'
    | 'SEND_FAILED';

/**
 * 用户消息插入（U1）的结果
 */
export type UserInterruptResult =
    | {
          success: true;
          data: {
              messageId: string;
              threadId: string;
              toRunId: string;
              hopDepth: number;
          };
      }
    | {
          success: false;
          code: UserInterruptErrorCode;
          error: string;
      };

/**
 * Agent 消息信箱（内存实现）
 */
export class AgentMailbox {
    /** conversationId -> runId -> 消息队列 */
    private inboxes = new Map<string, Map<string, AgentMessage[]>>();
    /** 主模型空闲回流已领取但尚未确认的消息；同一收件方同时只允许一个 claim。 */
    private messageClaims = new Map<string, Map<string, AgentMessageClaim>>();
    /** 正在写入会话历史的 claim；写入期间禁止 release，防止同一批消息被并发重复领取。 */
    private messageClaimDeliveries = new Map<string, Map<string, string>>();
    /** conversationId -> runId -> run 元信息（仅记录「本对话下已知的 run」） */
    private knownRuns = new Map<string, Map<string, KnownRun>>();
    /** conversationId -> threadId -> 最近一次投递的 hopDepth */
    private threadDepths = new Map<string, Map<string, number>>();
    /** conversationId -> 最近一次用户消息插入时间（防刷屏） */
    private lastUserInterruptAt = new Map<string, number>();
    /** 已删除会话的墓碑；用于拒绝后台任务结束后迟到的系统结果。 */
    private deletedConversations = new Set<string>();

    /**
     * 注册一个 run 为「本对话下已知」（子代理 run 启动时调用）。
     * 主会话（MAIN_SESSION_RUN_ID）为隐式已知，无需注册。
     */
    registerRun(conversationId: string | undefined, runId: string | undefined, agentName?: string): void {
        if (!conversationId || !runId) {
            return;
        }
        // 同一 ID 的会话若被上层明确重建并启动新 run，则恢复接收后台结果。
        this.deletedConversations.delete(conversationId);
        if (runId === MAIN_SESSION_RUN_ID) {
            return;
        }
        let convRuns = this.knownRuns.get(conversationId);
        if (!convRuns) {
            convRuns = new Map();
            this.knownRuns.set(conversationId, convRuns);
        }
        convRuns.set(runId, { runId, agentName, registeredAt: Date.now() });
    }

    /**
     * 注销一个 run（run 结束/取消时调用）：清除已知记录与该 run 的 inbox。
     */
    unregisterRun(conversationId: string | undefined, runId: string | undefined): void {
        if (!conversationId || !runId) {
            return;
        }
        // 修改原因：会话下最后一个 run 注销后，knownRuns 留下空的会话 Map 项（长会话残留）。
        // 修改方式：注销后该会话已无任何已知 run 时，一并删除会话条目（主会话为隐式已知，
        //          不占用 knownRuns 条目，不受影响）。
        const convRuns = this.knownRuns.get(conversationId);
        convRuns?.delete(runId);
        if (convRuns && convRuns.size === 0) {
            this.knownRuns.delete(conversationId);
        }
        this.inboxes.get(conversationId)?.delete(runId);
        // 收尾 claim 语义：run 结束（无论正常/异常）时，若该 run 仍有未确认消费的
        // 已领取消息（closeRunIfInboxEmpty drain 后挂的 claim，调用方注入完成前 run
        // 终止），放回收件箱保留投递机会，避免“先删后注入、注入失败消息永久丢失”；
        // 正常收尾路径已在再次 closeRunIfInboxEmpty 时确认（acknowledge）删除，不会走到这里。
        // 注（已接受的行为）：恢复后的消息驻留在「已注销 run」的 inbox 中——run 已从
        // knownRuns 删除，正常情况下无人再消费该 inbox。保留而非清理是有意为之：
        // run 重新注册（同一 runId 重启/重试）时消息仍可投递；驻留量受「收尾时 drain
        // 出的消息数」上界约束，且对话删除时由 clearConversation 一并清理。
        const pendingClaim = this.messageClaims.get(conversationId)?.get(runId);
        if (pendingClaim) {
            this.endMessageClaimDelivery(conversationId, runId, pendingClaim.claimId);
            this.messageClaims.get(conversationId)!.delete(runId);
            if (this.messageClaims.get(conversationId)!.size === 0) {
                this.messageClaims.delete(conversationId);
            }
            let convInbox = this.inboxes.get(conversationId);
            if (!convInbox) {
                convInbox = new Map();
                this.inboxes.set(conversationId, convInbox);
            }
            const current = convInbox.get(runId) ?? [];
            convInbox.set(runId, [...pendingClaim.messages, ...current]);
        }
        // 修改原因：lastUserInterruptAt 只增不删，长会话中残留旧时间戳。
        // 修改方式：本会话已无任何已知 run（且无残留 inbox）时一并清理防刷屏时间戳，
        //          下一轮用户打断从全新状态开始。
        const remainingRuns = this.knownRuns.get(conversationId);
        const convInbox = this.inboxes.get(conversationId);
        if ((!remainingRuns || remainingRuns.size === 0) && (!convInbox || convInbox.size === 0)) {
            this.lastUserInterruptAt.delete(conversationId);
        }
    }

    /**
     * 正常完成边界的原子关闭：若收件箱已有消息则返回消息并保持 run 可寻址；
     * 只有收件箱为空时才注销。sendMessage 与本方法都同步执行，因此不会出现
     * “检查为空后又接受一封信、随后 unregister 删除”的竞态。
     *
     * 收尾路径复用 claim 语义：drain 出的消息先挂 claim（副本仍由信箱持有），
     * 调用方注入成功并再次进入收尾检查时确认（acknowledge）删除；run 异常结束且
     * 未确认时由 unregisterRun 把消息放回收件箱，避免“先删后注入、注入失败消息永久丢失”。
     */
    closeRunIfInboxEmpty(
        conversationId: string | undefined,
        runId: string | undefined
    ): { closed: true; messages: [] } | { closed: false; messages: AgentMessage[] } {
        if (!conversationId || !runId) {
            return { closed: true, messages: [] };
        }
        // 调用方再次进入收尾检查 = 上一批已领取的消息已处理完毕（注入成功或
        // run 即将结束），确认删除对应 claim，避免 unregisterRun 误恢复已注入消息。
        this.confirmRunClaim(conversationId, runId);
        const messages = this.drainMessages(conversationId, runId);
        if (messages.length > 0) {
            // drain 后挂 claim：消息副本由信箱持有，注入失败（run 异常终止）时
            // unregisterRun 可恢复，消息不因“先删后注入”而永久丢失。
            this.holdRunClaim(conversationId, runId, messages);
            return { closed: false, messages };
        }
        this.unregisterRun(conversationId, runId);
        return { closed: true, messages: [] };
    }

    /** 确认该 run 已领取的消息已处理完毕并删除对应 claim（幂等）。 */
    private confirmRunClaim(conversationId: string, runId: string): void {
        const convClaims = this.messageClaims.get(conversationId);
        if (!convClaims) return;
        const claim = convClaims.get(runId);
        if (!claim) return;
        this.endMessageClaimDelivery(conversationId, runId, claim.claimId);
        convClaims.delete(runId);
        if (convClaims.size === 0) {
            this.messageClaims.delete(conversationId);
        }
    }

    /** 把已 drain 的消息挂到该 run 的 claim（副本由信箱持有，可恢复）。 */
    private holdRunClaim(conversationId: string, runId: string, messages: AgentMessage[]): void {
        const previousClaim = this.messageClaims.get(conversationId)?.get(runId);
        if (previousClaim) {
            this.endMessageClaimDelivery(conversationId, runId, previousClaim.claimId);
        }
        let convClaims = this.messageClaims.get(conversationId);
        if (!convClaims) {
            convClaims = new Map();
            this.messageClaims.set(conversationId, convClaims);
        }
        convClaims.set(runId, {
            claimId: newUuid(),
            conversationId,
            runId,
            messages
        });
    }

    /**
     * 判断 runId 是否为当前会话下已知的收件方（主会话隐式已知）。
     */
    isKnownRun(conversationId: string, runId: string): boolean {
        if (runId === MAIN_SESSION_RUN_ID) {
            return true;
        }
        return this.knownRuns.get(conversationId)?.has(runId) === true;
    }

    /**
     * 获取 run 对应的 agent 名称（主会话返回 MAIN_AGENT_NAME；未知 run 返回 undefined）。
     */
    getAgentName(conversationId: string, runId: string): string | undefined {
        if (runId === MAIN_SESSION_RUN_ID) {
            return MAIN_AGENT_NAME;
        }
        return this.knownRuns.get(conversationId)?.get(runId)?.agentName;
    }

    /**
     * 获取当前会话下已知的 run 列表（含注册顺序，用于按 agent 名寻址时选择最近者）。
     */
    getKnownRuns(conversationId: string): KnownRun[] {
        return Array.from(this.knownRuns.get(conversationId)?.values() ?? []);
    }

    /**
     * 由可信后台系统生产者把完整结果放入主会话 claim/ack 通道。
     *
     * 稳定 messageId 同时在待领取 inbox 和已领取未确认 claim 中查重：Webview 切换、
     * taskEvent 重放或终态兜底重复结算都只会产生一封消息。消息只有在主会话输入成功
     * 写入历史后才由 acknowledgeMessageClaim 删除，因此“流已启动”不再等同于“已交付”。
     */
    enqueueMainSessionSystemMessage(input: MainSessionSystemMessageInput): AgentSendMessageResult {
        return this.enqueueSystemMessage({ ...input, toRunId: MAIN_SESSION_RUN_ID });
    }

    /**
     * 由可信后台系统生产者把完整结果放入指定收件方的 claim/ack（主会话）或 inbox（子代理）通道。
     *
     * 与 enqueueMainSessionSystemMessage 的边界一致：后台任务结果可能超过 16k，且 run 在终态
     * 投递时已经注销，因此这里不做发送方存活/正文长度/hop 校验。调用方必须是扩展内部受信模块；
     * messageId 由调用者稳定生成，用于在 inbox 与未确认 claim 之间幂等去重。
     *
     * toRunId 缺省投递主会话（与旧 enqueueMainSessionSystemMessage 完全一致）；指定其他 runId 时
     * 校验该 run 必须仍是当前会话已知的活跃 run——父子代理可能已经结束，投递给已注销 run 的消息
     * 无人消费，应在源头拒绝并让调用方回退（如投递主会话）。
     */
    enqueueSystemMessage(input: SystemMessageInput): AgentSendMessageResult {
        const conversationId = input.conversationId?.trim?.() ?? '';
        if (!conversationId) {
            return { success: false, error: 'System message delivery requires a conversationId.' };
        }
        if (this.deletedConversations.has(conversationId)) {
            return { success: false, error: 'System message delivery rejected because the conversation was deleted.' };
        }
        const messageId = input.messageId?.trim?.() ?? '';
        if (!messageId) {
            return { success: false, error: 'System message delivery requires a stable messageId.' };
        }
        const fromRunId = input.fromRunId?.trim?.() ?? '';
        if (!fromRunId) {
            return { success: false, error: 'System message delivery requires a fromRunId.' };
        }
        const messageText = input.text?.trim?.() ?? '';
        if (!messageText) {
            return { success: false, error: 'System message delivery requires non-empty text.' };
        }

        const toRunId = input.toRunId?.trim?.() || MAIN_SESSION_RUN_ID;
        // 主会话隐式已知；指定 run 必须仍活跃，否则拒绝并让调用方回退投递目标
        if (toRunId !== MAIN_SESSION_RUN_ID && !this.isKnownRun(conversationId, toRunId)) {
            return {
                success: false,
                error: `System message delivery rejected: run "${toRunId}" is not a known run in this conversation.`
            };
        }

        const pending = this.inboxes.get(conversationId)?.get(toRunId) ?? [];
        const claimed = this.messageClaims.get(conversationId)?.get(toRunId)?.messages ?? [];
        const existing = [...pending, ...claimed].find(message => message.id === messageId);
        if (existing) {
            return {
                success: true,
                data: {
                    messageId: existing.id,
                    threadId: existing.threadId,
                    toRunId: existing.toRunId,
                    hopDepth: existing.hopDepth
                }
            };
        }

        const threadId = input.threadId?.trim?.() || messageId;
        const message: AgentMessage = {
            id: messageId,
            threadId,
            fromRunId,
            ...(input.fromAgentName ? { fromAgentName: input.fromAgentName } : {}),
            toRunId,
            text: messageText,
            hopDepth: 1,
            createdAt: Date.now(),
            kind: 'system'
        };

        let convInbox = this.inboxes.get(conversationId);
        if (!convInbox) {
            convInbox = new Map();
            this.inboxes.set(conversationId, convInbox);
        }
        const runInbox = convInbox.get(toRunId) ?? [];
        runInbox.push(message);
        convInbox.set(toRunId, runInbox);

        return {
            success: true,
            data: {
                messageId,
                threadId,
                toRunId,
                hopDepth: 1
            }
        };
    }

    /**
     * 投递一条消息。
     *
     * 权限规则：
     * - 必须携带 conversationId（会话限定）。
     * - 发送方必须是本对话下已知的 run（或主会话）。
     * - 按 targetRunId 寻址时，目标必须是本对话下已知的 run（或主会话）。
     * - 按 targetAgentName 寻址时，名称必须在 conversationId 内解析到已知 run（或主会话）。
     *
     * 防循环规则：同一 threadId 的回复跳数递增，超过 MAX_HOP_DEPTH 时拒绝投递并返回明确错误。
     */
    sendMessage(input: AgentSendMessageInput): AgentSendMessageResult {
        const conversationId = input.conversationId;
        if (!conversationId) {
            return { success: false, error: 'agent_send_message requires a conversationId (session-scoped addressing).' };
        }
        const text = input.text?.trim?.() ?? '';
        if (!text) {
            return { success: false, error: 'agent_send_message requires a non-empty message.' };
        }
        if (text.length > AGENT_MESSAGE_MAX_LENGTH) {
            return {
                success: false,
                error: `agent_send_message text exceeds the ${AGENT_MESSAGE_MAX_LENGTH}-character limit. `
                    + 'Split the message into smaller parts.'
            };
        }
        if (!input.fromRunId) {
            return { success: false, error: 'agent_send_message requires a known sender runId (fromRunId missing).' };
        }
        // 发送方校验：主会话隐式已知；子代理必须已在本对话注册
        if (input.fromRunId !== MAIN_SESSION_RUN_ID && !this.isKnownRun(conversationId, input.fromRunId)) {
            return { success: false, error: `Sender run "${input.fromRunId}" is not a known run in this conversation.` };
        }

        // 解析收件方
        let toRunId: string | undefined;
        if (typeof input.targetRunId === 'string' && input.targetRunId.trim()) {
            const target = input.targetRunId.trim();
            if (!this.isKnownRun(conversationId, target)) {
                return {
                    success: false,
                    error: `Unknown targetRunId "${target}". Messages can only be sent to runs known in the same conversation (or the main session).`
                };
            }
            toRunId = target;
        } else if (typeof input.targetAgentName === 'string' && input.targetAgentName.trim()) {
            const name = input.targetAgentName.trim();
            if (name === MAIN_AGENT_NAME) {
                toRunId = MAIN_SESSION_RUN_ID;
            } else {
                const matches = this.getKnownRuns(conversationId).filter(r => r.agentName === name);
                if (matches.length === 0) {
                    return {
                        success: false,
                        error: `No active run of agent "${name}" in this conversation. Use targetRunId to address a specific run, or "main" to reach the main session.`
                    };
                }
                // 同名多 run（并行）时投给最近注册的那个
                toRunId = matches[matches.length - 1].runId;
            }
        } else {
            return { success: false, error: 'agent_send_message requires either targetRunId or targetAgentName.' };
        }

        // threadId + hopDepth 防循环
        const threadId = input.threadId?.trim?.() || newUuid();

        // 收件箱容量检查放在 hop 递增之前（L-tsub 修复）：邮箱满被拒是收件方背压（尚未
        // 消费），不是线程互回循环，不应消耗 hop 深度。旧实现在 hop 递增后才检查容量，
        // inbox 满的丢弃尝试也会把线程深度往前推，收件方消费稍慢就会让线程提前撞上
        // MAX_HOP_DEPTH 被误判为死循环。这里只读不建——被拒时不会留下空 inbox 条目。
        const claimedCount = this.messageClaims.get(conversationId)?.get(toRunId)?.messages.length ?? 0;
        if ((this.inboxes.get(conversationId)?.get(toRunId)?.length ?? 0) + claimedCount >= AGENT_INBOX_MAX_MESSAGES) {
            return {
                success: false,
                error: `agent_send_message target inbox is full (max ${AGENT_INBOX_MAX_MESSAGES} pending messages). `
                    + 'Wait for the recipient to consume earlier messages before sending more.'
            };
        }

        // 修改原因：旧实现把「读取 prevDepth」与「写回 hopDepth」拆在投递校验两端，
        //          读-写窗口若被 await/提前返回路径拆散，并发互回可能双写同一深度绕过
        //          MAX_HOP_DEPTH；且 threadDepths 按 (conversationId, threadId) 只增不删，
        //          长会话线程越多残留越多。
        // 修改方式：递增收敛到 incrementThreadDepth（同一同步块内读-增-写，原子递增）；
        //          超过上限拒绝后保留该线程的深度记录（不再删除）——若在拒绝时删除，
        //          重试方会从 1 重新计数，同一条线程的互回循环实际可以无限延续，
        //          MAX_HOP_DEPTH 被绕过（M-tsub 修复）。记录量由 incrementThreadDepth 内的
        //          THREAD_DEPTH_MAX_ENTRIES FIFO 兜底，不会无限增长。
        const hopDepth = this.incrementThreadDepth(conversationId, threadId);
        if (hopDepth > MAX_HOP_DEPTH) {
            return {
                success: false,
                error: `Thread "${threadId}" exceeded the maximum hop depth (${MAX_HOP_DEPTH}). `
                    + `This usually means agents are replying to each other in a loop. Start a new thread (omit threadId) or stop replying.`
            };
        }

        const message: AgentMessage = {
            id: newUuid(),
            threadId,
            fromRunId: input.fromRunId,
            ...(input.fromAgentName ? { fromAgentName: input.fromAgentName } : {}),
            toRunId,
            text,
            hopDepth,
            createdAt: Date.now(),
            kind: 'agent'
        };

        let convInbox = this.inboxes.get(conversationId);
        if (!convInbox) {
            convInbox = new Map();
            this.inboxes.set(conversationId, convInbox);
        }
        let runInbox = convInbox.get(toRunId);
        if (!runInbox) {
            runInbox = [];
            convInbox.set(toRunId, runInbox);
        }
        runInbox.push(message);

        return {
            success: true,
            data: {
                messageId: message.id,
                threadId,
                toRunId,
                hopDepth
            }
        };
    }

    /**
     * 原子递增某线程的 hopDepth（读取-递增-写回在同一同步块内完成）。
     *
     * 修改原因：sendMessage 内旧实现把「读取 prevDepth」与「写回 hopDepth」拆在两处，
     * 若两者之间出现 await 或提前返回路径，并发互回可能双写同一深度绕过 MAX_HOP_DEPTH；
     * 收敛到本方法后递增与写回必然成对发生，深度与已投递/尝试消息数保持一致。
     */
    private incrementThreadDepth(conversationId: string, threadId: string): number {
        let convDepths = this.threadDepths.get(conversationId);
        if (!convDepths) {
            convDepths = new Map();
            this.threadDepths.set(conversationId, convDepths);
        }
        // 有界：单会话线程深度记录超过上限时按 FIFO 淘汰最旧条目（Map 迭代序 = 插入序）。
        // 超限被拒的线程保留记录（同线程后续投递持续被拒，防循环不被绕过），长会话中
        // 线程会无限累积，由本 FIFO 上限兜底；被淘汰后该线程深度归零重新计——仅放宽
        // 防循环上限，512 个活跃线程才会触发，实际互回链远低于此。
        if (convDepths.size >= THREAD_DEPTH_MAX_ENTRIES && !convDepths.has(threadId)) {
            const oldestKey = convDepths.keys().next().value as string | undefined;
            if (oldestKey !== undefined) {
                convDepths.delete(oldestKey);
            }
        }
        const nextDepth = (convDepths.get(threadId) ?? 0) + 1;
        convDepths.set(threadId, nextDepth);
        return nextDepth;
    }

    /**
     * 用户消息插入主会话收件箱（U1：主会话工具循环/流式进行中快速感知用户输入）。
     *
     * - 发送方固定为主会话（MAIN_SESSION_RUN_ID），kind 明确标记为 user_interrupt；
     * - 收件方固定为主会话（MAIN_SESSION_RUN_ID），由 ToolExecutionService 注入点在最近一次
     *   工具调用完成后 drain 并随工具结果返回给主模型；
     * - 每次插入自动新建线程（不传 threadId → hopDepth=1），不存在 agent 互回循环负担；
     * - 频率限制：同一会话 USER_INTERRUPT_MIN_INTERVAL_MS 内最多 1 条（防刷屏）；
     * - 长度限制：USER_INTERRUPT_MAX_LENGTH。
     *
     * 会话是否存在由调用方（webview handler）负责校验——信箱本身不感知持久化会话。
     */
    sendUserMessageToMain(conversationId: string | undefined, text: string | undefined): UserInterruptResult {
        const convId = conversationId?.trim?.() ?? '';
        if (!convId) {
            return {
                success: false,
                code: 'INVALID_CONVERSATION',
                error: 'A conversationId is required to deliver a user message.'
            };
        }

        const content = text?.trim?.() ?? '';
        if (!content) {
            return {
                success: false,
                code: 'EMPTY_TEXT',
                error: 'User message text must not be empty.'
            };
        }
        if (content.length > USER_INTERRUPT_MAX_LENGTH) {
            return {
                success: false,
                code: 'TEXT_TOO_LONG',
                error: `User message exceeds the ${USER_INTERRUPT_MAX_LENGTH}-character limit.`
            };
        }

        const now = Date.now();
        const lastAt = this.lastUserInterruptAt.get(convId) ?? 0;
        if (now - lastAt < USER_INTERRUPT_MIN_INTERVAL_MS) {
            const waitMs = USER_INTERRUPT_MIN_INTERVAL_MS - (now - lastAt);
            return {
                success: false,
                code: 'RATE_LIMITED',
                error: `User messages can be inserted at most once every ${USER_INTERRUPT_MIN_INTERVAL_MS / 1000}s `
                    + `per conversation (wait ~${Math.ceil(waitMs / 1000)}s more).`
            };
        }

        const result = this.sendMessage({
            conversationId: convId,
            fromRunId: MAIN_SESSION_RUN_ID,
            fromAgentName: 'user',
            targetRunId: MAIN_SESSION_RUN_ID,
            text: content
        });
        if (!result.success) {
            return { success: false, code: 'SEND_FAILED', error: result.error };
        }

        // sendMessage 统一创建普通代理消息；这里在同一同步调用中把刚创建的消息改为
        // 用户插话。按稳定 messageId 查找，避免再依赖可与 agent 名称冲突的字符串哨兵。
        const inserted = this.inboxes.get(convId)?.get(MAIN_SESSION_RUN_ID)
            ?.find(message => message.id === result.data.messageId);
        if (!inserted) {
            return {
                success: false,
                code: 'SEND_FAILED',
                error: 'User message could not be located after delivery.'
            };
        }
        inserted.kind = 'user_interrupt';

        this.lastUserInterruptAt.set(convId, now);
        return { success: true, data: result.data };
    }

    /**
     * 主模型空闲回流分批领取待处理的代理/系统消息（用户忙时插话由工具边界处理）。
     *
     * 领取后消息暂时离开 inbox，避免与活跃工具循环重复消费；只有 acknowledge 后才真正删除。
     * 同一会话已有未确认 claim 时原样返回，Webview 重载或发送重试不会丢消息。
     */
    claimMainSessionAgentMessages(conversationId: string): AgentMessageClaim | undefined {
        if (!conversationId) return undefined;

        const existing = this.messageClaims.get(conversationId)?.get(MAIN_SESSION_RUN_ID);
        if (existing) {
            return {
                ...existing,
                messages: [...existing.messages]
            };
        }

        const convInbox = this.inboxes.get(conversationId);
        const runInbox = convInbox?.get(MAIN_SESSION_RUN_ID);
        if (!runInbox?.length) return undefined;

        const messages: AgentMessage[] = [];
        const remaining: AgentMessage[] = [];
        let claimedCharacters = 0;
        let claimLimitReached = false;
        for (const message of runInbox) {
            if (isUserInterruptMessage(message)) {
                remaining.push(message);
                continue;
            }

            const exceedsCount = messages.length >= MAIN_SESSION_CLAIM_MAX_MESSAGES;
            const exceedsCharacters = messages.length > 0
                && claimedCharacters + message.text.length > MAIN_SESSION_CLAIM_MAX_CHARACTERS;
            if (claimLimitReached || exceedsCount || exceedsCharacters) {
                claimLimitReached = true;
                remaining.push(message);
                continue;
            }

            // 至少领取一条：单条系统结果可能超过字符上限，但不能因此永久卡在队首。
            messages.push(message);
            claimedCharacters += message.text.length;
        }
        if (messages.length === 0) return undefined;

        if (remaining.length > 0) {
            convInbox!.set(MAIN_SESSION_RUN_ID, remaining);
        } else {
            convInbox!.delete(MAIN_SESSION_RUN_ID);
        }
        if (convInbox!.size === 0) {
            this.inboxes.delete(conversationId);
        }

        const claim: AgentMessageClaim = {
            claimId: newUuid(),
            conversationId,
            runId: MAIN_SESSION_RUN_ID,
            messages
        };
        let convClaims = this.messageClaims.get(conversationId);
        if (!convClaims) {
            convClaims = new Map();
            this.messageClaims.set(conversationId, convClaims);
        }
        convClaims.set(MAIN_SESSION_RUN_ID, claim);
        return { ...claim, messages: [...messages] };
    }

    /** 读取未确认 claim 的快照；调用方不能修改内部队列。 */
    getMessageClaim(conversationId: string, runId: string, claimId: string): AgentMessageClaim | undefined {
        const claim = this.messageClaims.get(conversationId)?.get(runId);
        if (!claim || claim.claimId !== claimId) return undefined;
        return { ...claim, messages: [...claim.messages] };
    }

    /** 判断指定 claim 是否仍有效（内部消息回合落库前校验，防重复消费）。 */
    hasMessageClaim(conversationId: string, runId: string, claimId: string): boolean {
        return this.messageClaims.get(conversationId)?.get(runId)?.claimId === claimId;
    }

    /**
     * 标记 claim 已开始写入会话历史。同一 claim 同时只允许一个写入者；返回 false 表示
     * claim 已失效或已有写入正在进行。
     */
    beginMessageClaimDelivery(conversationId: string, runId: string, claimId: string): boolean {
        if (!this.hasMessageClaim(conversationId, runId, claimId)) return false;

        let convDeliveries = this.messageClaimDeliveries.get(conversationId);
        if (!convDeliveries) {
            convDeliveries = new Map();
            this.messageClaimDeliveries.set(conversationId, convDeliveries);
        }
        if (convDeliveries.has(runId)) return false;
        convDeliveries.set(runId, claimId);
        return true;
    }

    /**
     * 取消/结束一次尚未确认的写入尝试。只解除“正在写入”状态，claim 仍保持已领取，
     * 调用方随后可以重试写入或显式 release。
     */
    endMessageClaimDelivery(conversationId: string, runId: string, claimId: string): boolean {
        const convDeliveries = this.messageClaimDeliveries.get(conversationId);
        if (convDeliveries?.get(runId) !== claimId) return false;
        convDeliveries.delete(runId);
        if (convDeliveries.size === 0) this.messageClaimDeliveries.delete(conversationId);
        return true;
    }

    /** 确认空闲回流已经成功落库，永久删除对应 claim。 */
    acknowledgeMessageClaim(conversationId: string, runId: string, claimId: string): boolean {
        const convClaims = this.messageClaims.get(conversationId);
        const claim = convClaims?.get(runId);
        if (!claim || claim.claimId !== claimId) return false;
        this.endMessageClaimDelivery(conversationId, runId, claimId);
        convClaims!.delete(runId);
        if (convClaims!.size === 0) this.messageClaims.delete(conversationId);
        return true;
    }

    /** 发送失败时把 claim 放回收件箱头部，保持原始消息顺序。 */
    releaseMessageClaim(conversationId: string, runId: string, claimId: string): boolean {
        const convClaims = this.messageClaims.get(conversationId);
        const claim = convClaims?.get(runId);
        if (!claim || claim.claimId !== claimId) return false;
        // 写入者已经过最终校验后，另一条页面生命周期不能再把同一 claim 放回队列；
        // 否则写入成功与 release 交错会造成下一次重复领取。
        if (this.messageClaimDeliveries.get(conversationId)?.get(runId) === claimId) return false;

        convClaims!.delete(runId);
        if (convClaims!.size === 0) this.messageClaims.delete(conversationId);

        let convInbox = this.inboxes.get(conversationId);
        if (!convInbox) {
            convInbox = new Map();
            this.inboxes.set(conversationId, convInbox);
        }
        const current = convInbox.get(runId) ?? [];
        convInbox.set(runId, [...claim.messages, ...current]);
        return true;
    }

    /**
     * 取走（drain）指定 run 在指定会话下的全部消息并清空队列。
     *
     * 由工具执行注入点在每次工具调用完成后调用；每条消息只会被取出一次。
     */
    drainMessages(conversationId: string, runId: string): AgentMessage[] {
        const convInbox = this.inboxes.get(conversationId);
        if (!convInbox) {
            return [];
        }
        const runInbox = convInbox.get(runId);
        if (!runInbox || runInbox.length === 0) {
            return [];
        }

        // TaskManager 写入的后台完成结果必须只走“领取 → 写入会话记录 → 确认”链路。
        // 主模型的工具边界若把 system 消息与普通 agent 消息一起 drain，会在工具结果真正
        // 落盘前就从队列删除；随后流取消/写盘失败便永久丢失，破坏可靠交付承诺。
        // 子 agent 的普通通信保持原有 drain 语义；仅主会话保留可信系统结果等待 claim。
        const retained = runId === MAIN_SESSION_RUN_ID
            ? runInbox.filter(message => getAgentMessageKind(message) === 'system')
            : [];
        const drained = retained.length > 0
            ? runInbox.filter(message => getAgentMessageKind(message) !== 'system')
            : runInbox;

        if (retained.length > 0) {
            convInbox.set(runId, retained);
        } else {
            convInbox.delete(runId);
            if (convInbox.size === 0) this.inboxes.delete(conversationId);
        }
        return drained;
    }

    /**
     * 查看（不消费）指定 run 的消息，供测试/调试使用。
     */
    peekMessages(conversationId: string, runId: string): AgentMessage[] {
        return [...(this.inboxes.get(conversationId)?.get(runId) ?? [])];
    }

    /** 返回当前有待处理 main-session 代理消息/claim 的会话 ID。 */
    getMainSessionAgentMessageConversationIds(): string[] {
        const ids = new Set<string>();
        for (const [conversationId, convInbox] of this.inboxes) {
            if (convInbox.get(MAIN_SESSION_RUN_ID)?.some(message => !isUserInterruptMessage(message))) {
                ids.add(conversationId);
            }
        }
        for (const [conversationId, convClaims] of this.messageClaims) {
            if (convClaims.get(MAIN_SESSION_RUN_ID)?.messages.length) {
                ids.add(conversationId);
            }
        }
        return [...ids];
    }

    /**
     * 当前 inbox 中的消息总数（供测试/监控使用）。
     */
    getPendingMessageCount(): number {
        let count = 0;
        for (const convInbox of this.inboxes.values()) {
            for (const runInbox of convInbox.values()) {
                count += runInbox.length;
            }
        }
        for (const convClaims of this.messageClaims.values()) {
            for (const claim of convClaims.values()) {
                count += claim.messages.length;
            }
        }
        return count;
    }

    /**
     * 新真实用户回合开始时重置回合频率状态，但保留主会话信箱尚未投递的消息。
     * 代理消息会由工具边界或空闲 claim/ack 唯一消费；用户打断（U1）若发生在回合
     * 最后一次工具调用之后，既不 drain 也不 claim——旧实现在这里被静默丢弃，用户
     * 插话永久丢失。保留后由下一次工具边界 drain 注入（与回合内插话同路径）；
     * 频率限制（USER_INTERRUPT_MIN_INTERVAL_MS）防刷屏，对话删除时 clearConversation 清理。
     */
    clearMainSessionInbox(conversationId: string): void {
        if (!conversationId) return;
        // 不再删除 main inbox 中的任何消息（agent→main 与用户打断均保留投递），
        // 仅清理防刷屏时间戳，让新回合的打断从全新频率状态开始。
        this.lastUserInterruptAt.delete(conversationId);
    }

    /**
     * 清理某个会话的全部信箱状态（对话删除时调用）。
     */
    clearConversation(conversationId: string): void {
        this.inboxes.delete(conversationId);
        this.messageClaims.delete(conversationId);
        this.messageClaimDeliveries.delete(conversationId);
        this.knownRuns.delete(conversationId);
        this.threadDepths.delete(conversationId);
        this.lastUserInterruptAt.delete(conversationId);
        this.deletedConversations.add(conversationId);
    }

    /**
     * 清空全部信箱状态（仅供测试）。
     */
    clearAll(): void {
        this.inboxes.clear();
        this.messageClaims.clear();
        this.messageClaimDeliveries.clear();
        this.knownRuns.clear();
        this.threadDepths.clear();
        this.lastUserInterruptAt.clear();
        this.deletedConversations.clear();
    }
}

/** 全局信箱单例 */
export const agentMailbox = new AgentMailbox();
