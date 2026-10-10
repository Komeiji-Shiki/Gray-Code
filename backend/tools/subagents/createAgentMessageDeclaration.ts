import type { ToolDeclaration } from '../types';
import { MAX_HOP_DEPTH } from '../../core/services/agentMessages';

/** 声明与旧扩展宿主分离，独立平台仅替换与交付方式有关的说明。 */
export function createAgentMessageDeclaration(isZh: boolean, description?: string): ToolDeclaration {
    return {
        name: 'agent_send_message',
        aliases: ['agent.sendMessage'],
        category: 'agents',
        description: description ?? (isZh
            ? `向当前对话中正在运行的子代理或主会话发送消息。targetRunId 与 targetAgentName 二选一，targetAgentName="main" 表示主会话；发送者身份自动附带。

消息异步保存至收件方读取。前台子代理联系主会话后转入后台，主会话立即处理；空闲主会话也立即处理，其他忙碌代理在工具结束后或下次模型调用前读取。不要轮询或重复发送。`
            : `Send a message to an active sub-agent or the main session in this conversation. Use exactly one of targetRunId or targetAgentName; targetAgentName="main" selects the main session. Sender identity is attached automatically.

Messages are held until read. A foreground sub-agent messaging the main session moves to the background and the main session handles it immediately; an idle main session also handles it immediately. Other busy agents read after their tool finishes or before their next model call. Do not poll or resend.`),
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
