/**
 * 发送历史组装辅助（纯函数模块，从 ContextTrimService 抽离）。
 *
 * - prependFirstUserMessage：首条真实用户消息永远发送（任务锚点）
 * - normalizeFallbackHistoryStart：fallback 裁剪后若以 model 开头，前置临时 user 占位，
 *   保证 provider 的角色顺序合法。
 */

import type { Content } from '../../../../conversation/types';
import { isRealUserMessage } from '../../../../conversation/helpers';

/**
 * 首条用户消息永远发送（任务锚点）。
 *
 * 逻辑截断语义下，发送历史从最后一个总结消息 / 裁剪点开始，首条用户消息通常不在其中；
 * 主人的原始任务指令是长期锚点，总结文本永远不如原话清楚，必须原样拼到请求历史最前
 * （与保留用户输入档案并存，轻微冗余换取原话完整）。
 *
 * @param fullHistory 过滤 isSummarized 后的完整历史
 * @param history 已构建的发送历史
 * @param startIndex 发送切片起点（过滤后历史索引）；<= 0 时首条用户消息必然已在切片内
 */
export function prependFirstUserMessage(fullHistory: Content[], history: Content[], startIndex: number): Content[] {
    // 从 0 开始发送：首条用户消息必然已在切片内，无需处理
    if (startIndex <= 0) {
        return history;
    }
    const firstUserIndex = fullHistory.findIndex(message => isRealUserMessage(message));
    if (firstUserIndex < 0) {
        return history;
    }
    const firstUser = fullHistory[firstUserIndex];
    // 首条用户消息已在切片内（异常数据：历史以 system 等开头且首条下标 >= startIndex）→ 不重复前置
    if (firstUserIndex >= startIndex) {
        return history;
    }
    // 防御：有稳定 id 时按 id 判重（历史以 system 开头时上述下标判断已覆盖，此处仅兜底）
    if (firstUser.id !== undefined && history.some(message => message.id === firstUser.id)) {
        return history;
    }
    return [firstUser, ...history];
}

/**
 * 请求级细粒度裁剪的公共出口：把切点后的历史补成合法的角色顺序（model 开头时前置临时 user 占位）。
 */
export function normalizeFallbackHistoryStart(history: Content[]): Content[] {
    return history[0]?.role === 'model'
        ? [{
            role: 'user' as const,
            parts: [{ text: '[Earlier context was temporarily omitted after summarization failed.]' }],
            isSummary: true
        }, ...history]
        : history;
}
