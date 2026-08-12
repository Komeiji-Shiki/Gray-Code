/**
 * agent_message 接管窗口标记（A-COMM 后台结果回流竞态防护）。
 *
 * 后台结果领取（claim）成功后、内部回流流启动前存在几毫秒到几十毫秒的接管窗口：
 * 窗口内 isStreaming / isWaitingForResponse 仍残留旧流状态，用户此时发送消息会被
 * sendMessageFlow 的忙时判定误投为「用户插话」（U1）——插话随后被内部回流流在
 * 工具边界 drain 消费，用户消息既不落历史、内容又被模型处理一次，用户重发后
 * 同一内容被重复处理/写入。
 *
 * 本模块提供跨 store 的窗口标记：backgroundTaskStore 在 claim 成功后置位、
 * 内部流启动或本次调度放弃后清除；sendMessageFlow 与 InputArea 据此让窗口内的
 * 用户消息走排队（正常回合）而非插话投递。
 *
 * 模块级可变状态：与 interruptNotices 同模式（迁移保留单例，测试与运行期共享）。
 */
let pendingConversationId: string | null = null

/** claim 领取成功后置位：本会话即将被内部回流流接管。 */
export function markAgentMessageRoundPending(conversationId: string): void {
    pendingConversationId = conversationId
}

/** 内部流启动 / 本次调度放弃后清除（幂等；仅当标记仍属于该会话时清除）。 */
export function clearAgentMessageRoundPending(conversationId: string): void {
    if (pendingConversationId === conversationId) {
        pendingConversationId = null
    }
}

/** 当前是否处于该会话的接管窗口（用户消息应走排队，而不是忙时插话投递）。 */
export function isAgentMessageRoundPending(conversationId: string | null | undefined): boolean {
    return typeof conversationId === 'string'
        && conversationId.length > 0
        && pendingConversationId === conversationId
}
