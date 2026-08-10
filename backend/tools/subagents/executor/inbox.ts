/**
 * 子代理历史中的 agentInbox 保持字节稳定。
 *
 * mailbox 的 drain/claim 已保证每封信只进入历史一次。消息一旦随工具结果发送给模型，
 * 后续请求应像普通用户消息一样继续保留它：其后的模型输出表明信件已经处理，不会被
 * 误认为新投递；同时，历史前缀不被改写，provider 的 KV/prompt cache 可以继续命中。
 */

import type { Content } from '../../../modules/conversation/types';

/**
 * 兼容旧调用点的请求历史归一化入口。
 *
 * 旧实现会删除较早 functionResponse 中的 agentInbox，导致相邻请求在已经发送过的位置
 * 出现字节差异、缓存前缀从该点失配。现在保持原数组与所有消息对象不变。
 */
export function stripReplayedAgentInboxForModel(history: Content[]): Content[] {
    return history;
}
