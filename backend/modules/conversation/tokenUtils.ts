/**
 * GrayCode - Token 工具函数
 * 
 * 提供处理消息 token 计数的工具函数
 */

import type { Content, ContentPart } from './types';

/**
 * 设置消息的 token 计数
 * 
 * @param message 消息对象
 * @param thoughtsTokenCount 思考部分 token 数
 * @param candidatesTokenCount 候选输出 token 数
 * @returns 更新后的消息
 * 
 * @example
 * ```typescript
 * const message = {
 *     role: 'model',
 *     parts: [{ text: 'Hello!' }]
 * };
 * 
 * const updated = setMessageTokens(message, 150, 10);
 * // updated.thoughtsTokenCount = 150
 * // updated.candidatesTokenCount = 10
 * ```
 */
export function setMessageTokens(
    message: Content,
    thoughtsTokenCount?: number,
    candidatesTokenCount?: number
): Content {
    const updated = { ...message };
    
    if (thoughtsTokenCount !== undefined) {
        updated.thoughtsTokenCount = thoughtsTokenCount;
    }
    
    if (candidatesTokenCount !== undefined) {
        updated.candidatesTokenCount = candidatesTokenCount;
    }
    
    return updated;
}


/**
 * 创建带 token 计数的消息
 * 
 * @param role 消息角色
 * @param parts 消息内容部分
 * @param thoughtsTokenCount 思考 token 数（可选）
 * @param candidatesTokenCount 候选 token 数（可选）
 * @returns Content 消息对象
 * 
 * @example
 * ```typescript
 * const message = createMessageWithTokens(
 *     'model',
 *     [{ text: 'Hello!' }],
 *     150,  // 思考用了 150 tokens
 *     10    // 输出用了 10 tokens
 * );
 * ```
 */
export function createMessageWithTokens(
    role: 'user' | 'model',
    parts: ContentPart[],
    thoughtsTokenCount?: number,
    candidatesTokenCount?: number
): Content {
    const message: Content = {
        role,
        parts
    };
    
    if (thoughtsTokenCount !== undefined) {
        message.thoughtsTokenCount = thoughtsTokenCount;
    }
    
    if (candidatesTokenCount !== undefined) {
        message.candidatesTokenCount = candidatesTokenCount;
    }
    
    return message;
}

/**
 * 获取消息的总 token 数
 * 
 * @param message 消息对象
 * @returns 总 token 数（思考 + 候选）
 */
export function getTotalTokens(message: Content): number {
    let total = 0;
    
    if (message.thoughtsTokenCount !== undefined) {
        total += message.thoughtsTokenCount;
    }
    
    if (message.candidatesTokenCount !== undefined) {
        total += message.candidatesTokenCount;
    }
    
    return total;
}

/**
 * 检查消息是否有 token 计数记录
 * 
 * @param message 消息对象
 * @returns 是否有任何 token 计数
 */
export function hasTokenCounts(message: Content): boolean {
    return message.thoughtsTokenCount !== undefined ||
           message.candidatesTokenCount !== undefined;
}

/**
 * 计算对话历史的总 token 数
 * 
 * @param history 对话历史
 * @returns Token 统计对象
 */
export function calculateHistoryTokens(history: Content[]): {
    totalThoughtsTokens: number;
    totalCandidatesTokens: number;
    totalTokens: number;
    messagesWithTokens: number;
} {
    let totalThoughtsTokens = 0;
    let totalCandidatesTokens = 0;
    let messagesWithTokens = 0;
    
    for (const message of history) {
        if (hasTokenCounts(message)) {
            messagesWithTokens++;
        }
        
        if (message.thoughtsTokenCount !== undefined) {
            totalThoughtsTokens += message.thoughtsTokenCount;
        }
        
        if (message.candidatesTokenCount !== undefined) {
            totalCandidatesTokens += message.candidatesTokenCount;
        }
    }
    
    return {
        totalThoughtsTokens,
        totalCandidatesTokens,
        totalTokens: totalThoughtsTokens + totalCandidatesTokens,
        messagesWithTokens
    };
}

/**
 * 批量设置历史记录的 token 计数
 * 
 * @param history 对话历史
 * @param tokenCounts token 计数数组（与历史数组一一对应）
 * @returns 更新后的历史记录
 * 
 * @example
 * ```typescript
 * const history = [
 *     { role: 'user', parts: [{ text: 'Q1' }] },
 *     { role: 'model', parts: [{ text: 'A1' }] }
 * ];
 * 
 * const updated = batchSetTokenCounts(history, [
 *     { candidatesTokenCount: 5 },
 *     { thoughtsTokenCount: 100, candidatesTokenCount: 15 }
 * ]);
 * ```
 */
export function batchSetTokenCounts(
    history: Content[],
    tokenCounts: Array<{
        thoughtsTokenCount?: number;
        candidatesTokenCount?: number;
    }>
): Content[] {
    if (history.length !== tokenCounts.length) {
        throw new Error('History and tokenCounts arrays must have the same length');
    }
    
    return history.map((message, index) => {
        const counts = tokenCounts[index];
        return setMessageTokens(
            message,
            counts.thoughtsTokenCount,
            counts.candidatesTokenCount
        );
    });
}

/**
 * 获取消息的 token 效率（输出 token / 总 token）
 * 
 * @param message 消息对象
 * @returns Token 效率（0-1 之间），如果没有 token 记录返回 null
 * 
 * @example
 * ```typescript
 * const message = {
 *     role: 'model',
 *     parts: [{ text: 'Hello!' }],
 *     thoughtsTokenCount: 150,
 *     candidatesTokenCount: 10
 * };
 * 
 * const efficiency = getTokenEfficiency(message);
 * // efficiency = 10 / (150 + 10) = 0.0625 (6.25%)
 * ```
 */
export function getTokenEfficiency(message: Content): number | null {
    const total = getTotalTokens(message);
    
    if (total === 0 || message.candidatesTokenCount === undefined) {
        return null;
    }
    
    return message.candidatesTokenCount / total;
}

/**
 * 格式化 token 数量为易读字符串
 * 
 * @param tokenCount token 数量
 * @returns 格式化后的字符串
 * 
 * @example
 * ```typescript
 * formatTokenCount(1500);      // "1.5K"
 * formatTokenCount(1500000);   // "1.5M"
 * formatTokenCount(150);       // "150"
 * ```
 */
export function formatTokenCount(tokenCount: number): string {
    if (tokenCount >= 1000000) {
        return `${(tokenCount / 1000000).toFixed(1)}M`;
    }
    if (tokenCount >= 1000) {
        return `${(tokenCount / 1000).toFixed(1)}K`;
    }
    return tokenCount.toString();
}