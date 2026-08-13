/**
 * 回合识别 / 阈值计算 / 总结消息定位（纯函数模块，从 ContextTrimService 抽离）。
 *
 * 这些函数不依赖任何服务实例，供 ContextTrimService 与 SummarizeService 复用：
 * - identifyConversationRounds：按真实用户输入切分对话回合
 * - calculateContextThreshold：解析阈值配置（数值 / 百分比 / 非法兜底）
 * - findLastSummaryIndex：定位历史中最后一个总结消息
 */

import type { Content } from '../../../../conversation/types';
import { isRealUserMessage } from '../../../../conversation/helpers';
import type { ConversationRound } from '../../utils';

/**
 * 识别对话回合
 *
 * 回合定义：
 * - 从一个非函数响应的用户消息开始
 * - 到下一个非函数响应的用户消息之前结束
 * - 每个回合记录该回合内最后一个助手消息的 totalTokenCount
 */
export function identifyConversationRounds(history: Content[]): ConversationRound[] {
    const rounds: ConversationRound[] = [];
    let currentRoundStart = -1;
    let currentRoundTokenCount: number | undefined;

    for (let i = 0; i < history.length; i++) {
        const message = history[i];

        if (isRealUserMessage(message)) {
            // 只有真实用户输入才开始新回合。后台任务回执是旧任务的异步延续，
            // 若把它当新回合，超大工具回合会在裁剪时被整体丢弃。
            if (currentRoundStart !== -1) {
                // 保存上一个回合
                rounds.push({
                    startIndex: currentRoundStart,
                    endIndex: i,
                    tokenCount: currentRoundTokenCount
                });
            }
            // 开始新回合
            currentRoundStart = i;
            currentRoundTokenCount = undefined;
        } else if (message.role === 'model') {
            // 记录助手消息的 token 数
            if (message.usageMetadata?.totalTokenCount !== undefined) {
                currentRoundTokenCount = message.usageMetadata.totalTokenCount;
            }
        }
    }

    // 保存最后一个回合
    if (currentRoundStart !== -1) {
        rounds.push({
            startIndex: currentRoundStart,
            endIndex: history.length,
            tokenCount: currentRoundTokenCount
        });
    }

    return rounds;
}

/**
 * 计算上下文阈值
 *
 * 支持两种格式：
 * - 数值：直接使用
 * - 百分比字符串：如 "80%"，计算最大上下文的百分比
 */
export function calculateContextThreshold(
    threshold: number | string,
    maxContextTokens: number,
    fallbackRatio = 0.8
): number {
    if (typeof threshold === 'number') {
        return threshold;
    }

    // 百分比格式，如 "80%"
    if (threshold.endsWith('%')) {
        const percent = parseFloat(threshold.replace('%', ''));
        if (!isNaN(percent) && percent >= 0 && percent <= 100) {
            return Math.floor(maxContextTokens * percent / 100);
        }
    }

    // 非法值：回退到 fallbackRatio * maxContextTokens
    return Math.floor(maxContextTokens * fallbackRatio);
}

/**
 * 查找历史中最后一个总结消息的索引
 */
export function findLastSummaryIndex(history: Content[]): number {
    for (let i = history.length - 1; i >= 0; i--) {
        if (history[i].isSummary) {
            return i;
        }
    }
    return -1;
}
