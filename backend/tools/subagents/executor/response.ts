/**
 * 子代理 AI 响应的文本提取与主会话用量归集。
 *
 * 拆分说明：从 executor.ts 迁出（纯移动，逻辑一字未改）。
 */

import { extractMessageTokens, type UsageIndexMessage } from '../../../modules/conversation/usageStats';
import type { Content } from '../../../modules/conversation/types';
import type { SubAgentExecutorContext } from '../types';

/**
 * 提取 AI 响应的文本内容（排除思考内容）
 * 
 * 支持标准化的 GenerateResponse 格式
 */
export function extractTextContent(response: any): string {
    // 标准化格式: response.content.parts
    if (response?.content?.parts) {
        const textParts = response.content.parts
            // 过滤掉思考内容（thought: true）和非文本内容
            .filter((part: any) => part.text && !part.thought)
            .map((part: any) => part.text);
        if (textParts.length > 0) {
            return textParts.join('\n');
        }
    }
    
    // Gemini 原始格式
    if (response?.candidates?.[0]?.content?.parts) {
        const textParts = response.candidates[0].content.parts
            .filter((part: any) => part.text && !part.thought)
            .map((part: any) => part.text);
        return textParts.join('\n');
    }
    
    // OpenAI 格式
    if (response?.choices?.[0]?.message?.content) {
        return response.choices[0].message.content;
    }
    
    // Anthropic 格式
    if (response?.content && Array.isArray(response.content)) {
        const textBlocks = response.content
            .filter((block: any) => block.type === 'text')
            .map((block: any) => block.text);
        return textBlocks.join('\n');
    }
    
    return '';
}

/**
 * 把本轮 LLM 调用的 usageMetadata 转换为 UsageIndexMessage（source='subagent'），
 * 归集到发起它的主会话用量索引。
 *
 * 修改原因：子代理消耗的 token 此前不进入任何用量统计，UsagePage 看不到子代理开销。
 * 修改方式：从 response.content.usageMetadata 提取 token（复用主链路 extractMessageTokens
 *           同一套语义），经上下文注入的 usageIndexAppend 追加到主会话索引；
 *           无主会话归属或未注入回调时跳过（不写索引）。
 * 修改目的：主会话用量统计包含其派发的所有子代理消耗，且可通过 source 细分。
 */
export async function reportUsageToMainConversation(
    response: any,
    conversationId: string | undefined,
    usageIndexAppend: SubAgentExecutorContext['usageIndexAppend']
): Promise<void> {
    if (!conversationId) {
        // 子代理无主会话归属是测试、自定义 executor 与独立运行的正常情况，静默跳过归集。
        return;
    }
    if (typeof usageIndexAppend !== 'function') return;
    const usage = response?.content?.usageMetadata as Content['usageMetadata'] | undefined;
    if (!usage) return;
    const tokens = extractMessageTokens({ role: 'model', parts: [], usageMetadata: usage } as Content);
    if (!tokens) return;
    const entry: UsageIndexMessage = {
        timestamp: Date.now(),
        modelVersion: (response?.content?.modelVersion || '').trim(),
        ...tokens,
        source: 'subagent'
    };
    try {
        await usageIndexAppend(conversationId, [entry]);
    } catch (e) {
        // 归集失败不打断子代理主流程
        console.debug(`[SubAgent] Failed to attribute usage to conversation ${conversationId}: ${e instanceof Error ? e.message : String(e)}`);
    }
}
