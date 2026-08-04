/**
 * agent.sendMessage 工具
 *
 * 允许一个 agent（子代理或主模型）给同一对话下的另一个 agent 发消息：
 * - 按 targetRunId 寻址：目标必须是同一对话下已知的 runId（防冒充/注入）。
 * - 按 targetAgentName 寻址：必须限定 conversationId；"main" 指主会话（主模型）。
 * - threadId + hopDepth 防循环：同一线程超过 MAX_HOP_DEPTH 跳后拒绝投递。
 *
 * 发送方身份由工具执行层注入（ToolContext.mailboxRunId / mailboxConversationId），
 * 模型无法伪造 fromRunId。
 */

import type { Tool, ToolResult, ToolContext, ToolDeclaration } from '../types';
import { agentMailbox, MAIN_SESSION_RUN_ID, MAX_HOP_DEPTH, type AgentSendMessageResult } from './agentMailbox';

/**
 * 动态获取工具声明
 */
export function getAgentSendMessageToolDeclaration(): ToolDeclaration {
    return {
        name: 'agent.sendMessage',
        category: 'agents',
        description: `Send a message to another agent (sub-agent) or to the main session (the main model) in the current conversation. The message is delivered asynchronously: the recipient sees it appended to its most recent tool result, without waiting for the current stream/turn to end.

**Addressing (choose exactly one):**
- targetRunId: the runId of a sub-agent run that is currently active in this conversation. Only runs known in the current conversation can be addressed (prevents spoofing/injection).
- targetAgentName: the name of a sub-agent that currently has an active run in this conversation. Use "main" to reach the main session (the main model).

**Threading & loop protection:**
- Pass the threadId returned by a previous send to continue that thread. Replies in the same thread increment hopDepth; after ${MAX_HOP_DEPTH} hops the delivery is rejected with a clear error — this prevents agents from looping on each other. To start fresh, omit threadId.

**Usage notes:**
- You are identified automatically; you cannot impersonate another agent.
- Delivery is best-effort: if the recipient has no active tool loop, the message stays in its inbox until its next tool call in this conversation.`,
        parameters: {
            type: 'object',
            properties: {
                targetRunId: {
                    type: 'string',
                    description: 'The runId of the recipient sub-agent run (active in the current conversation). Mutually exclusive with targetAgentName.'
                },
                targetAgentName: {
                    type: 'string',
                    description: 'The name of the recipient sub-agent (active in the current conversation), or "main" for the main session. Mutually exclusive with targetRunId.'
                },
                message: {
                    type: 'string',
                    description: 'The message text to send.'
                },
                threadId: {
                    type: 'string',
                    description: 'Optional thread ID to continue a previous conversation thread (see loop protection above).'
                }
            },
            required: ['message']
        }
    };
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
        return { success: false, error: 'agent.sendMessage requires an active conversation (no conversationId in tool context).' };
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
 * 缓存的工具实例
 */
let cachedTool: Tool | null = null;

/**
 * 创建 agent.sendMessage 工具
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
 * 获取 agent.sendMessage 工具（单例）
 */
export function getAgentSendMessageTool(): Tool {
    if (!cachedTool) {
        cachedTool = createAgentSendMessageTool();
    }
    return cachedTool;
}
