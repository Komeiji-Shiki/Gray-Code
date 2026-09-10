/**
 * agent_send_message 工具
 *
 * 允许一个 agent（子代理或主模型）给同一对话下的另一个 agent 发消息：
 * - 按 targetRunId 寻址：目标必须是同一对话下已知的 runId（防冒充/注入）。
 * - 按 targetAgentName 寻址：必须限定 conversationId；"main" 指主会话（主模型）。
 * - threadId + hopDepth 防循环：同一线程超过 MAX_HOP_DEPTH 跳后拒绝投递。
 *
 * 发送方身份由工具执行层注入（ToolContext.mailboxRunId / mailboxConversationId），
 * 模型无法伪造 fromRunId。
 */

import type { Tool, ToolResult, ToolContext, ToolDeclaration, ConversationStore } from '../types';
import { TaskManager } from '../taskManager';
import { createAgentMessageDeclaration } from './createAgentMessageDeclaration';
import { agentMailbox, MAIN_SESSION_RUN_ID, type AgentSendMessageResult } from '../../core/services/agentMailbox';
import type { AgentMessageCardInfo, Content } from '../../modules/conversation/types';
import { getActualLanguage } from '../../i18n';
import { resolveLocalizationLanguage } from '../localization/types';
import { subAgentRunController } from './runController';

/**
 * 动态获取工具声明
 */
export function getAgentSendMessageToolDeclaration(): ToolDeclaration {
    // 模型声明语言：zh-CN → 中文，en/ja → 英文（ja 本阶段映射到英文说明）
    const isZh = resolveLocalizationLanguage(getActualLanguage()) === 'zh-CN';
    return createAgentMessageDeclaration(isZh);
}

/**
 * 工具处理器
 */
export async function agentSendMessageHandler(args: Record<string, any>, context?: ToolContext): Promise<ToolResult> {
    // 会话限定：优先使用执行层注入的 mailbox 会话（子代理路径 conversationId 不注入到工具上下文）
    const mailboxConversationId = typeof context?.mailboxConversationId === 'string' && context.mailboxConversationId.trim()
        ? context.mailboxConversationId.trim()
        : (typeof context?.conversationId === 'string' && context.conversationId.trim()
            ? context.conversationId.trim()
            : undefined);
    if (!mailboxConversationId) {
        return { success: false, error: 'agent_send_message requires an active conversation (no conversationId in tool context).' };
    }

    // 发送方身份由执行层注入，模型无法伪造
    const fromRunId = typeof context?.mailboxRunId === 'string' && context.mailboxRunId.trim()
        ? context.mailboxRunId.trim()
        : MAIN_SESSION_RUN_ID;
    const fromAgentName = agentMailbox.getAgentName(mailboxConversationId, fromRunId);

    const text = typeof args.message === 'string' ? args.message.trim() : '';
    const targetRunId = typeof args.targetRunId === 'string' && args.targetRunId.trim()
        ? args.targetRunId.trim()
        : undefined;
    const targetAgentName = typeof args.targetAgentName === 'string' && args.targetAgentName.trim()
        ? args.targetAgentName.trim()
        : undefined;
    const threadId = typeof args.threadId === 'string' && args.threadId.trim()
        ? args.threadId.trim()
        : undefined;

    const result: AgentSendMessageResult = agentMailbox.sendMessage({
        conversationId: mailboxConversationId,
        fromRunId,
        ...(fromAgentName ? { fromAgentName } : {}),
        targetRunId,
        targetAgentName,
        text,
        threadId
    });

    if (!result.success) {
        return { success: false, error: result.error };
    }

    if (result.data.toRunId === MAIN_SESSION_RUN_ID) {
        // 主模型没有常驻执行循环：入队后发轻量通知，让前端沿用后台消息的
        // “工具动作边界或空闲立即开启内部回合”调度；正文仍由 mailbox claim 接口领取。
        // 只有仍挂在父回合上的前台子代理需要打断主回合的硬等待；后台/已 detach
        // 子代理保持工具完成边界注入语义，不能中断主模型正在执行的其它工具。
        const interruptMainRound = fromRunId !== MAIN_SESSION_RUN_ID
            && subAgentRunController.isAttachedToParent(fromRunId);
        TaskManager.emitEvent({
            taskId: `agentmsg:${result.data.messageId}`,
            taskType: 'agent_message',
            type: 'progress',
            data: {
                conversationId: mailboxConversationId,
                messageId: result.data.messageId,
                toRunId: MAIN_SESSION_RUN_ID,
                interruptMainRound
            }
        });
    } else {
        // agent 间消息（主模型 ↔ 子代理、子代理 ↔ 子代理）：写入主会话历史作为
        // 展示卡片（parts 为空 → formatHistoryForAPI 整体过滤，不发给模型），
        // 事件携带完整卡片数据供前端实时插入“收件方”附近。
        const toAgentName = agentMailbox.getAgentName(mailboxConversationId, result.data.toRunId);
        const card: AgentMessageCardInfo = {
            messageId: result.data.messageId,
            fromRunId,
            ...(fromAgentName ? { fromAgentName } : {}),
            toRunId: result.data.toRunId,
            ...(toAgentName ? { toAgentName } : {}),
            threadId: result.data.threadId,
            hopDepth: result.data.hopDepth,
            text,
            createdAt: Date.now()
        };
        let insertion: { position?: number; persisted: boolean } = { persisted: false };
        try {
            insertion = await insertAgentMessageCardIntoHistory(context, mailboxConversationId, card);
        } catch (error) {
            // mailbox 投递已经成功；即使持久层持续失败，也必须发送未持久化卡片事件，
            // 让当前窗口可见，而不是把展示消息彻底吞掉。
            console.warn('[agent_send_message] Failed to persist agent message card after retries:', error);
        }
        TaskManager.emitEvent({
            taskId: `agentmsg:${result.data.messageId}`,
            taskType: 'agent_message',
            type: 'progress',
            data: {
                conversationId: mailboxConversationId,
                messageId: result.data.messageId,
                toRunId: result.data.toRunId,
                card,
                persisted: insertion.persisted,
                ...(typeof insertion.position === 'number' ? { insertPosition: insertion.position } : {})
            }
        });
    }

    return {
        success: true,
        data: {
            messageId: result.data.messageId,
            threadId: result.data.threadId,
            toRunId: result.data.toRunId,
            hopDepth: result.data.hopDepth
        }
    };
}

/**
 * 归一化工具调用 ID 为 runId 后缀（与 subagents 工具 runId 推导口径一致：
 * subagent_run_{normalizeToolIdForRunId(toolId)}）。
 */
function normalizeToolIdForRunId(toolId: string): string {
    return toolId.trim().replace(/[^A-Za-z0-9_-]/g, '_');
}

/**
 * 在会话历史中定位「收件方子代理」的锚点，返回卡片插入位置：
 * 1. 从后往前找携带该 runId 的 subagents 工具结果（functionResponse.response.runId / data.runId）；
 * 2. 其次找可推导出该 runId 的 subagents 工具调用（functionCall.id 归一化后匹配）；
 * 3. 都找不到（run 已不在当前窗口/历史异常）时追加到历史末尾。
 */
export function resolveAgentCardInsertPosition(history: readonly Content[], toRunId: string): number {
    const length = Array.isArray(history) ? history.length : 0;
    if (length === 0) return 0;

    for (let i = length - 1; i >= 0; i--) {
        const parts = history[i]?.parts;
        if (!Array.isArray(parts)) continue;
        for (const part of parts) {
            const response = part.functionResponse?.response;
            if (!response || typeof response !== 'object' || Array.isArray(response)) continue;
            const runId = (response as { runId?: unknown }).runId
                ?? (response as { data?: { runId?: unknown } }).data?.runId;
            if (typeof runId === 'string' && runId === toRunId) {
                return i + 1;
            }
        }
    }

    if (toRunId.startsWith('subagent_run_')) {
        const expectedToolId = toRunId.slice('subagent_run_'.length);
        for (let i = length - 1; i >= 0; i--) {
            const parts = history[i]?.parts;
            if (!Array.isArray(parts)) continue;
            for (const part of parts) {
                const call = part.functionCall;
                if (!call || call.name !== 'subagents') continue;
                if (typeof call.id === 'string' && normalizeToolIdForRunId(call.id) === expectedToolId) {
                    return i + 1;
                }
            }
        }
    }

    return length;
}

/**
 * 把 agent 间消息卡片写入主会话历史。
 *
 * 依赖 ToolContext.conversationStore（运行时为 ConversationManager，工具执行层统一注入）；
 * 未注入（测试/降级路径）时返回 undefined，调用方跳过插入但不影响投递。
 */
async function insertAgentMessageCardIntoHistory(
    context: ToolContext | undefined,
    conversationId: string,
    card: AgentMessageCardInfo
): Promise<{ position?: number; persisted: boolean }> {
    const store = context?.conversationStore as (ConversationStore & {
        getHistory?: (conversationId: string) => Promise<Readonly<Content[]>>;
        insertContent?: (conversationId: string, position: number, content: Content) => Promise<void>;
        insertContentAtResolvedPosition?: (
            conversationId: string,
            content: Content,
            resolvePosition: (history: ReadonlyArray<Content>) => number
        ) => Promise<number>;
    }) | undefined;
    const content: Content = {
        role: 'user',
        parts: [],
        source: 'agent_message',
        agentMessage: card,
        timestamp: card.createdAt
    };

    if (store?.insertContentAtResolvedPosition) {
        let lastError: unknown;
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                const position = await store.insertContentAtResolvedPosition(
                    conversationId,
                    content,
                    history => resolveAgentCardInsertPosition(history as Readonly<Content[]>, card.toRunId)
                );
                return { position, persisted: true };
            } catch (error) {
                lastError = error;
                if (attempt < 2) {
                    await new Promise(resolve => setTimeout(resolve, 20 * (attempt + 1)));
                }
            }
        }

        // 计算本地展示位置；该位置只用于未持久化卡片，不会推进后端索引。
        if (store.getHistory) {
            try {
                const history = await store.getHistory(conversationId);
                return {
                    position: resolveAgentCardInsertPosition(history as Readonly<Content[]>, card.toRunId),
                    persisted: false
                };
            } catch {
                // 下方抛出原始持久化错误，handler 仍会发送无位置的本地尾插事件。
            }
        }
        throw lastError;
    }

    // 非运行时测试/降级存储：旧接口仍可完成持久化；真实 ConversationManager 总是走上方锁内接口。
    if (store?.getHistory && store.insertContent) {
        const history = await store.getHistory(conversationId);
        const position = resolveAgentCardInsertPosition(history as Readonly<Content[]>, card.toRunId);
        await store.insertContent(conversationId, position, content);
        return { position, persisted: true };
    }

    return { persisted: false };
}

/**
 * 缓存的工具实例
 */
let cachedTool: Tool | null = null;

/**
 * 创建 agent_send_message 工具
 */
export function createAgentSendMessageTool(): Tool {
    const tool: Tool = {
        get declaration() {
            return getAgentSendMessageToolDeclaration();
        },
        handler: agentSendMessageHandler
    };
    return tool;
}

/**
 * 获取 agent_send_message 工具（单例）
 */
export function getAgentSendMessageTool(): Tool {
    if (!cachedTool) {
        cachedTool = createAgentSendMessageTool();
    }
    return cachedTool;
}
