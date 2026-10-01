import type { ToolDeclaration } from '../types';
import { MAX_HOP_DEPTH } from '../../core/services/agentMessages';

/** 声明与旧扩展宿主分离，独立平台仅替换与交付方式有关的说明。 */
export function createAgentMessageDeclaration(isZh: boolean, description?: string): ToolDeclaration {
    return {
        name: 'agent_send_message',
        aliases: ['agent.sendMessage'],
        category: 'agents',
        description: description ?? (isZh
            ? `向当前对话中另一个代理（子代理）或主会话（主模型）发送消息。用 targetRunId 或 targetAgentName 二选一指定收件方：收件方必须是当前对话中正在运行的子代理，targetAgentName 填 "main" 则发给主会话。系统会自动识别你的身份，无法冒充其他代理。

消息异步送达，并由进程内邮箱保存到收件方读取为止：仍挂在主回合上的前台子代理给主会话发消息时，会转到后台继续执行，主会话立即开始处理消息；主会话空闲时也会立即处理；其他忙碌的收件方在当前工具执行完后读取；运行中的子代理在每次工具执行后、调用模型前和结束前检查收件箱。不要轮询，也不要重复发送相同内容。`
            : `Send a message to another agent (a sub-agent) or to the main session (the main model) in the current conversation. Choose the recipient with exactly one of targetRunId or targetAgentName: the recipient must be a sub-agent with an active run in this conversation, or targetAgentName "main" for the main session. Your identity is attached automatically, so you cannot impersonate another agent.

Delivery is asynchronous, and the in-process mailbox holds the message until the recipient reads it. When a foreground sub-agent still attached to the main round messages the main session, it continues in the background and the main session handles the message right away. An idle main session also handles it right away. Other busy recipients read it after their current tool finishes, and running sub-agents check their inbox after each tool, before each model call and before finishing. Do not poll or resend the same text.`),
        parameters: {
            type: 'object',
            properties: {
                targetRunId: {
                    type: 'string',
                    description: isZh
                        ? '收件方子代理运行的 runId。'
                        : 'runId of the recipient sub-agent run.'
                },
                targetAgentName: {
                    type: 'string',
                    description: isZh
                        ? '收件方子代理的名称，"main" 表示主会话。'
                        : 'Name of the recipient sub-agent, or "main" for the main session.'
                },
                message: {
                    type: 'string',
                    description: isZh ? '要发送的消息文本。' : 'The message text to send.'
                },
                threadId: {
                    type: 'string',
                    description: isZh
                        ? `可选，之前发送结果中的 threadId，用于在同一线程中回复。同一线程最多 ${MAX_HOP_DEPTH} 跳，超过后发送会被拒绝，以防代理之间互相循环；省略则开始新线程。`
                        : `Optional threadId from an earlier send result, used to reply in the same thread. A thread allows at most ${MAX_HOP_DEPTH} hops; further sends are rejected to stop agents from looping. Omit it to start a new thread.`
                }
            },
            required: ['message']
        }
    };
}
