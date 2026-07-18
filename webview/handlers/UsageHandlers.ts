/**
 * 用量统计消息处理器
 *
 * 提供按对话/按模型/按天聚合的 token 用量数据，
 * 数据完全来自已落盘的对话历史（usageMetadata），无需额外打点。
 */

import type { MessageHandler } from '../types';
import { aggregateUsageStats } from '../../backend/modules/conversation/usageStats';

/**
 * 获取用量统计（可选时间范围：startTime / endTime，毫秒时间戳，含端点）
 */
export const getUsageStats: MessageHandler = async (data, requestId, ctx) => {
  try {
    const startTime = typeof data?.startTime === 'number' && Number.isFinite(data.startTime) ? data.startTime : undefined;
    const endTime = typeof data?.endTime === 'number' && Number.isFinite(data.endTime) ? data.endTime : undefined;
    const stats = await aggregateUsageStats(ctx.conversationManager, { startTime, endTime });
    ctx.sendResponse(requestId, stats);
  } catch (error: any) {
    ctx.sendError(requestId, 'GET_USAGE_STATS_ERROR', error?.message || 'Failed to aggregate usage stats');
  }
};

/**
 * 注册用量统计处理器
 */
export function registerUsageHandlers(registry: Map<string, MessageHandler>): void {
  registry.set('usage.getStats', getUsageStats);
}
