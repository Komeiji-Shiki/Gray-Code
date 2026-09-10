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
export function getAgentMessageKind(message: AgentMessage): AgentMessageKind {
    if (message.kind) return message.kind;
    return message.fromAgentName === 'user' ? 'user_interrupt' : 'agent';
}

export function isUserInterruptMessage(message: AgentMessage): boolean {
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


export interface AgentMessageHost {
    knownRuns: Array<{ runId: string; agentName?: string }>;
    pendingCount: (runId: string) => number;
    nextHopDepth: (threadId: string) => number;
}

/** 共享寻址、容量与防循环规则；保存和领取消息由各宿主负责。 */
export function prepareAgentMessage(input: AgentSendMessageInput, host: AgentMessageHost):
    (Extract<AgentSendMessageResult, { success: true }> & { message: AgentMessage }) | Extract<AgentSendMessageResult, { success: false }> {
    const known = (runId: string) => runId === MAIN_SESSION_RUN_ID || host.knownRuns.some(run => run.runId === runId);
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
    if (input.fromRunId !== MAIN_SESSION_RUN_ID && !known(input.fromRunId)) {
        return { success: false, error: `Sender run "${input.fromRunId}" is not a known run in this conversation.` };
    }

    // 解析收件方
    let toRunId: string | undefined;
    if (typeof input.targetRunId === 'string' && input.targetRunId.trim()) {
        const target = input.targetRunId.trim();
        if (!known(target)) {
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
            const matches = host.knownRuns.filter(r => r.agentName === name);
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
    if (host.pendingCount(toRunId) >= AGENT_INBOX_MAX_MESSAGES) {
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
    const hopDepth = host.nextHopDepth(threadId);
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


    return { success: true, message, data: { messageId: message.id, threadId, toRunId, hopDepth } };
}

/** FIFO 上限及被拒线程的深度保留沿用原信箱语义。 */
export function incrementAgentThreadDepth(depths: Map<string, number>, threadId: string): number {
    if (depths.size >= THREAD_DEPTH_MAX_ENTRIES && !depths.has(threadId)) {
        const oldest = depths.keys().next().value;
        if (oldest !== undefined) depths.delete(oldest);
    }
    const next = (depths.get(threadId) ?? 0) + 1;
    depths.set(threadId, next);
    return next;
}
