import type { ToolDeclaration } from '../types';
import { MAX_HOP_DEPTH } from '../../core/services/agentMessages';

/** 声明与旧扩展宿主分离，独立平台仅替换与交付方式有关的说明。 */
export function createAgentMessageDeclaration(isZh: boolean, description?: string): ToolDeclaration {
    return {
        name: 'agent_send_message',
        aliases: ['agent.sendMessage'],
        category: 'agents',
        description: description ?? (isZh
            ? `向同一对话中的另一个代理（子代理）或主会话（主模型）发送消息。投递是异步的：仍挂在主回合上的前台子代理给主会话发信时，会转为后台继续执行并立即开启内部消息轮次；其他忙碌收件方会在工具完成边界消费消息；主会话空闲时会立即开始内部消息轮次；活动中的子代理会在下一次模型调用前或完成前消费消息。

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
            : `Send a message to another agent (sub-agent) or to the main session (the main model) in the current conversation. Delivery is asynchronous: when a foreground sub-agent still attached to the main round messages the main session, it is detached to continue in the background and an internal message round starts immediately; other busy recipients consume messages at a tool-completion boundary; an idle main session starts an internal message round immediately; active sub-agents consume messages before their next model call or before completion.

**Addressing (choose exactly one):**
- targetRunId: the runId of a sub-agent run that is currently active in this conversation. Only runs known in the current conversation can be addressed (prevents spoofing/injection).
- targetAgentName: the name of a sub-agent that currently has an active run in this conversation. Use "main" to reach the main session (the main model).

**Threading & loop protection:**
- Pass the threadId returned by a previous send to continue that thread. Replies in the same thread increment hopDepth; after ${MAX_HOP_DEPTH} hops the delivery is rejected with a clear error — this prevents agents from looping on each other. To start fresh, omit threadId.

**Usage notes:**
- You are identified automatically; you cannot impersonate another agent.
- Delivery acknowledgement means the message is durably held by the in-process mailbox until a recipient boundary consumes it.
- Main-session delivery can start an internal round while idle; do not poll or resend the same text.
- Active sub-agents check their inbox after tools, before model calls, and atomically before completion.`),
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
