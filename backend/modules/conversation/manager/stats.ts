/**
 * 对话统计纯函数（拆分自 ConversationManager.ts 的 computeStatsFrom）。
 *
 * 不依赖 this：输入历史数组，输出 ConversationStats；由 getStats / getStatsFrom
 * 直接 import 使用（HIS-03/HIS-04：同一迭代内避免重复 loadHistory）。
 * 注意：本文件内容按原文件缩进保留（纯移动，不重排）。
 */

import type { Content, ConversationHistory, ConversationStats } from '../types';
import { estimatePartialMessageTokens } from '../usageStats';

/**
 * 从已加载内容计算统计（HIS-03/HIS-04）：同一迭代内避免重复 loadHistory。
 */
export function computeStatsFrom(rawHistory: ReadonlyArray<Content>): ConversationStats {
    const history = rawHistory as ConversationHistory;
    
    let userMessages = 0;
    let modelMessages = 0;
    let systemMessages = 0;
    let functionCalls = 0;
    let hasThoughtSignatures = false;
    let hasThoughts = false;
    let hasFileData = false;
    let hasInlineData = false;
    let inlineDataSize = 0;
    const multimedia = {
        images: 0,
        audio: 0,
        video: 0,
        documents: 0
    };
    
    // Token 统计
    let totalThoughtsTokens = 0;
    let totalCandidatesTokens = 0;
    let messagesWithThoughtsTokens = 0;
    let messagesWithCandidatesTokens = 0;

    for (const message of history) {
        if (message.role === 'user') {
            userMessages++;
        } else if (message.role === 'system') {
            // system 角色单独统计，不计入 modelMessages（避免模型消息数虚高）
            systemMessages++;
        } else {
            modelMessages++;
        }
        
        // 统计 token（优先使用 usageMetadata，向后兼容旧格式）
        let thoughtsTokens = message.usageMetadata?.thoughtsTokenCount ?? message.thoughtsTokenCount;
        let candidatesTokens = message.usageMetadata?.candidatesTokenCount ?? message.candidatesTokenCount;

        // 中断/取消流的 usageMetadata 是半截数据：回退到文本长度估算，避免严重少计
        if (message.usageMetadataPartial) {
            const estimated = estimatePartialMessageTokens(message);
            if (estimated) {
                thoughtsTokens = estimated.thoughts;
                candidatesTokens = estimated.candidates;
            }
        }
        
        if (thoughtsTokens !== undefined) {
            totalThoughtsTokens += thoughtsTokens;
            messagesWithThoughtsTokens++;
        }
        if (candidatesTokens !== undefined) {
            totalCandidatesTokens += candidatesTokens;
            messagesWithCandidatesTokens++;
        }

        for (const part of message.parts ?? []) {
            // 函数调用
            if (part.functionCall) {
                functionCalls++;
            }
            
            // 检查思考签名
            if (part.thoughtSignatures) {
                hasThoughtSignatures = true;
            }
            
            // 检查思考内容
            if (part.thought === true) {
                hasThoughts = true;
            }
            
            // 检查文件数据
            if (part.fileData) {
                hasFileData = true;
            }
            
            // 检查内嵌数据
            if (part.inlineData) {
                hasInlineData = true;
                
                // 计算 Base64 数据大小（约为原始数据的 4/3）
                // 旧版本或手动编辑的历史可能缺 data/mimeType，判空避免整个统计崩溃
                const inlineData = part.inlineData;
                const base64Length = typeof inlineData.data === 'string' ? inlineData.data.length : 0;
                inlineDataSize += Math.ceil((base64Length * 3) / 4);
                
                // 统计多模态类型
                const mimeType = inlineData.mimeType;
                if (typeof mimeType === 'string') {
                    if (mimeType.startsWith('image/')) {
                        multimedia.images++;
                    } else if (mimeType.startsWith('audio/')) {
                        multimedia.audio++;
                    } else if (mimeType.startsWith('video/')) {
                        multimedia.video++;
                    } else if (mimeType === 'application/pdf' || mimeType === 'text/plain') {
                        multimedia.documents++;
                    }
                }
            }
        }
    }

    return {
        totalMessages: history.length,
        userMessages,
        modelMessages,
        systemMessages,
        functionCalls,
        hasThoughtSignatures,
        hasThoughts,
        hasFileData,
        hasInlineData,
        inlineDataSize,
        multimedia,
        tokens: {
            totalThoughtsTokens,
            totalCandidatesTokens,
            totalTokens: totalThoughtsTokens + totalCandidatesTokens,
            messagesWithThoughtsTokens,
            messagesWithCandidatesTokens
        }
    };
}
