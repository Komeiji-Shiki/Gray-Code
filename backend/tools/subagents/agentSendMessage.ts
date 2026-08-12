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

import type { Tool, ToolResult, ToolContext, ToolDeclaration } from '../types';
import { TaskManager } from '../taskManager';
import { agentMailbox, MAIN_SESSION_RUN_ID, MAX_HOP_DEPTH, type AgentSendMessageResult } from '../../core/services/agentMailbox';
import { getActualLanguage } from '../../i18n';
import { resolveLocalizationLanguage } from '../localization/types';

/**
 * 动态获取工具声明
 */
export function getAgentSendMessageToolDeclaration(): ToolDeclaration {
    // 模型声明语言：zh-CN → 中文，en/ja → 英文（ja 本阶段映射到英文说明）
    const isZh = resolveLocalizationLanguage(getActualLanguage()) === 'zh-CN';
    return {
        name: 'agent_send_message',
        aliases: ['agent.sendMessage'],
        category: 'agents',
        description: isZh
            ? `向同一对话中的另一个代理（子代理）或主会话（主模型）发送消息。投递是异步的：如果接收方正在运行工具，消息会在该工具完成后插入；如果主会话空闲，会立即开始内部消息轮次；活动中的子代理会在下一次模型调用前或完成前消费消息。

**寻址（二选一）：**
- targetRunId：当前对话中活动的子代理运行的 runId。只能寻址当前对话中已知的 runId（防止伪造/注入）。
- targetAgentName：当前对话中活动的子代理名称。使用 "main" 到达主会话（主模型）。

**线程与循环保护：**
- 传入上一次发送返回的 threadId 以继续该线程。同一线程中的回复会使 hopDepth 递增；超过 ${MAX_HOP_DEPTH} 跳后投递会被拒绝并返回明确错误——这可以防止代理互相循环。要重新开始，请省略 threadId。

**使用说明：**
- 你的身份自动识别；你无法冒充其他代理。
- 投递确认表示消息由进程内邮箱可靠持有，直到某个接收方边界消费它。
- 主会话投递可以在空闲时启动内部轮次；不要轮询或重复发送相同文本。
- 活动中的子代理在工具之后、模型调用之前以及完成前原子地检查其收件箱。`
            : `Send a message to another agent (sub-agent) or to the main session (the main model) in the current conversation. Delivery is asynchronous: if the recipient is running a tool, the message is inserted after that tool completes; if the main session is idle, it starts an internal message round immediately; an active sub-agent consumes the message before its next model call or before it can finish.

**Addressing (choose exactly one):**
- targetRunId: the runId of a sub-agent run that is currently active in this conversation. Only runs known in the current conversation can be addressed (prevents spoofing/injection).
- targetAgentName: the name of a sub-agent that currently has an active run in this conversation. Use "main" to reach the main session (the main model).

**Threading & loop protection:**
- Pass the threadId returned by a previous send to continue that thread. Replies in the same thread increment hopDepth; after ${MAX_HOP_DEPTH} hops the delivery is rejected with a clear error — this prevents agents from looping on each other. To start fresh, omit threadId.

**Usage notes:**
- You are identified automatically; you cannot impersonate another agent.
- Delivery acknowledgement means the message is durably held by the in-process mailbox until a recipient boundary consumes it.
- Main-session delivery can start an internal round while idle; do not poll or resend the same text.
- Active sub-agents check their inbox after tools, before model calls, and atomically before completion.`,
        parameters: {
            type: 'object',
            properties: {
                targetRunId: {
                    type: 'string',
                    description: isZh
                        ? '接收方子代理运行的 runId（当前对话中活动）。与 targetAgentName 互斥。'
                        : 'The runId of the recipient sub-agent run (active in the current conversation). Mutually exclusive with targetAgentName.'
                },
                targetAgentName: {
                    type: 'string',
                    description: isZh
                        ? '接收方子代理的名称（当前对话中活动），或 "main" 表示主会话。与 targetRunId 互斥。'
                        : 'The name of the recipient sub-agent (active in the current conversation), or "main" for the main session. Mutually exclusive with targetRunId.'
                },
                message: {
                    type: 'string',
                    description: isZh ? '要发送的消息文本。' : 'The message text to send.'
                },
                threadId: {
                    type: 'string',
                    description: isZh
                        ? '可选的线程 ID，用于继续之前的对话线程（见上方循环保护说明）。'
                        : 'Optional thread ID to continue a previous conversation thread (see loop protection above).'
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

    // 主模型没有常驻执行循环：入队后发轻量通知，让前端沿用后台消息的
    // “工具动作边界或空闲立即开启内部回合”调度；正文仍由 mailbox claim 接口领取。
    if (result.data.toRunId === MAIN_SESSION_RUN_ID) {
        TaskManager.emitEvent({
            taskId: `agentmsg:${result.data.messageId}`,
            taskType: 'agent_message',
            type: 'progress',
            data: {
                conversationId: mailboxConversationId,
                messageId: result.data.messageId
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
