/**
 * 子代理发给子模型的 history 剥离已投递的 agentInbox（防重放）。
 *
 * 拆分说明：从 executor.ts 迁出（纯移动，逻辑一字未改）。
 */

import type { Content, ContentPart } from '../../../modules/conversation/types';

/**
 * H1-4：子代理发给子模型的 history 剥离已投递的 agentInbox，防重放。
 *
 * 背景：子代理本地 history 直进 formatter（不经 formatHistoryForAPI），工具结果里的
 * agentInbox（本 run 信箱已 drain 的消息）会被原样发给子模型。同 run 后续迭代与
 * continueFromRunId 续跑都会重放这些已投递消息（prompt 膨胀、模型可能重复响应）。
 *
 * 语义（与主路径 formatHistoryForAPI「当轮保留、跨轮剥离」对齐）：只保留**最后一条**
 * 消息中尚未投递过的 agentInbox——工具结果入 history 后第一次发给子模型的请求即是投递；
 * 更早条目中的 agentInbox 一律剥离。只做浅拷贝（functionResponse.response 内其余字段
 * 原样引用），不改写持久化 transcript。
 */
export function stripReplayedAgentInboxForModel(history: Content[]): Content[] {
    const lastIndex = history.length - 1;
    let changed = false;
    const stripped = history.map((message, index) => {
        if (index === lastIndex || !message.parts?.some(part => part.functionResponse)) {
            return message;
        }
        const newParts: ContentPart[] = [];
        let partsChanged = false;
        for (const part of message.parts) {
            if (!part.functionResponse) {
                newParts.push(part);
                continue;
            }
            const response = part.functionResponse.response;
            if (!response || typeof response !== 'object' || Array.isArray(response)) {
                newParts.push(part);
                continue;
            }
            const cleaned = { ...(response as Record<string, unknown>) };
            delete cleaned.agentInbox;
            if (cleaned.data && typeof cleaned.data === 'object' && !Array.isArray(cleaned.data)) {
                cleaned.data = { ...(cleaned.data as Record<string, unknown>) };
                delete (cleaned.data as Record<string, unknown>).agentInbox;
            }
            newParts.push({
                ...part,
                functionResponse: {
                    ...part.functionResponse,
                    response: cleaned
                }
            });
            partsChanged = true;
        }
        if (!partsChanged) {
            return message;
        }
        changed = true;
        return { ...message, parts: newParts };
    });
    return changed ? stripped : history;
}
