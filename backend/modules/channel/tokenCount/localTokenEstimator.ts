/**
 * GrayCode - 本地 token 估算
 *
 * 由 TokenCountService.ts 拆分而来：把本地估算逻辑（约 4 字符 = 1 token，
 * 乘以 1.5 安全系数偏大估算）抽为纯函数。
 */

import { cleanContentForAPI } from '../../conversation';
import type { Content } from '../../conversation';
import { serializeToolResultForLLM } from '../formatters/toolResponseFormatter';
import type { TokenCountResult } from './types';

/**
 * 本地估算 token 数
 * 约 4 个字符 = 1 个 token，并乘以 1.5 安全系数偏大估算
 */
export function estimateLocalTokens(contents: Content[]): TokenCountResult {
    const SAFETY_FACTOR = 1.5;
    let totalChars = 0;

    for (const content of contents) {
        const cleaned = cleanContentForAPI(content);
        for (const part of cleaned.parts) {
            if ('text' in part && part.text) {
                totalChars += part.text.length;
            } else if (part.functionResponse) {
                // 工具结果文本计入本地估算（与 API 计数口径一致，避免 tool 消息被整体漏计）
                const serialized = serializeToolResultForLLM(
                    part.functionResponse.name,
                    part.functionResponse.response as Record<string, unknown>
                );
                totalChars += serialized.length;
            } else if (part.functionCall) {
                // 工具调用参数计入本地估算（参数 JSON 是发送给模型的真实输入）
                totalChars += JSON.stringify(part.functionCall.args).length;
            }
        }
    }

    return {
        success: true,
        totalTokens: Math.ceil(Math.ceil(totalChars / 4) * SAFETY_FACTOR)
    };
}
