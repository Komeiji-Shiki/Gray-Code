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

import { randomUUID } from 'crypto';

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

/**
 * 一条投递到收件方 inbox 的消息
 */
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
    /** conversationId -> runId -> run 元信息（仅记录「本对话下已知的 run」） */
    private knownRuns = new Map<string, Map<string, KnownRun>>();
    /** conversationId -> threadId -> 最近一次投递的 hopDepth */
    private threadDepths = new Map<string, Map<string, number>>();
    /** conversationId -> 最近一次用户消息插入时间（防刷屏） */
    private lastUserInterruptAt = new Map<string, number>();

    /**
     * 注册一个 run 为「本对话下已知」（子代理 run 启动时调用）。
     * 主会话（MAIN_SESSION_RUN_ID）为隐式已知，无需注册。
     */
    registerRun(conversationId: string | undefined, runId: string | undefined, agentName?: string): void {
        if (!conversationId || !runId) {
            return;
        }
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
        this.knownRuns.get(conversationId)?.delete(runId);
        this.inboxes.get(conversationId)?.delete(runId);
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
            return { success: false, error: 'agent.sendMessage requires a conversationId (session-scoped addressing).' };
        }
        const text = input.text?.trim?.() ?? '';
        if (!text) {
            return { success: false, error: 'agent.sendMessage requires a non-empty message.' };
        }
        if (!input.fromRunId) {
            return { success: false, error: 'agent.sendMessage requires a known sender runId (fromRunId missing).' };
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
            return { success: false, error: 'agent.sendMessage requires either targetRunId or targetAgentName.' };
        }

        // threadId + hopDepth 防循环
        const threadId = input.threadId?.trim?.() || randomUUID();
        const prevDepth = this.threadDepths.get(conversationId)?.get(threadId) ?? 0;
        const hopDepth = prevDepth + 1;
        if (hopDepth > MAX_HOP_DEPTH) {
            return {
                success: false,
                error: `Thread "${threadId}" exceeded the maximum hop depth (${MAX_HOP_DEPTH}). `
                    + `This usually means agents are replying to each other in a loop. Start a new thread (omit threadId) or stop replying.`
            };
        }

        const message: AgentMessage = {
            id: randomUUID(),
            threadId,
            fromRunId: input.fromRunId,
            ...(input.fromAgentName ? { fromAgentName: input.fromAgentName } : {}),
            toRunId,
            text,
            hopDepth,
            createdAt: Date.now()
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

        let convDepths = this.threadDepths.get(conversationId);
        if (!convDepths) {
            convDepths = new Map();
            this.threadDepths.set(conversationId, convDepths);
        }
        convDepths.set(threadId, hopDepth);

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
     * 用户消息插入主会话收件箱（U1：主会话工具循环/流式进行中快速感知用户输入）。
     *
     * - 发送方固定为主会话（MAIN_SESSION_RUN_ID），fromAgentName 固定为 'user'（收件方识别）；
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

        this.lastUserInterruptAt.set(convId, now);
        return { success: true, data: result.data };
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
        convInbox.delete(runId);
        return runInbox;
    }

    /**
     * 查看（不消费）指定 run 的消息，供测试/调试使用。
     */
    peekMessages(conversationId: string, runId: string): AgentMessage[] {
        return [...(this.inboxes.get(conversationId)?.get(runId) ?? [])];
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
        return count;
    }

    /**
     * MED-3：清空主会话（MAIN_SESSION_RUN_ID）在指定会话下的信箱。
     *
     * 轮次边界清理：主会话 run（一次工具循环回合）结束后，未消费的 agent→main / 用户打断
     * 消息若不清空，会在下一回合被当作“当轮消息”过期投递。由 ConversationManager 在检测到
     * 新的真实 user 消息（新回合开始）时调用；子代理 inbox 由各自的 unregisterRun 负责，
     * 不受影响。
     */
    clearMainSessionInbox(conversationId: string): void {
        if (!conversationId) {
            return;
        }
        this.inboxes.get(conversationId)?.delete(MAIN_SESSION_RUN_ID);
    }

    /**
     * 清理某个会话的全部信箱状态（对话删除时调用）。
     */
    clearConversation(conversationId: string): void {
        this.inboxes.delete(conversationId);
        this.knownRuns.delete(conversationId);
        this.threadDepths.delete(conversationId);
        this.lastUserInterruptAt.delete(conversationId);
    }

    /**
     * 清空全部信箱状态（仅供测试）。
     */
    clearAll(): void {
        this.inboxes.clear();
        this.knownRuns.clear();
        this.threadDepths.clear();
        this.lastUserInterruptAt.clear();
    }
}

/** 全局信箱单例 */
export const agentMailbox = new AgentMailbox();
