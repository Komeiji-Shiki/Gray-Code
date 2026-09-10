import type { Content } from '../../../conversation/types';
import { cleanFunctionResponseForAPI } from '../../../conversation/helpers';
import { createForegroundWorkTransitionPart } from '../../../conversation/foregroundWorkTransition';

export class MessageTokenEstimator {

    /** 本地估算安全系数：统一按偏大估算，避免低估导致超上下文 */
    protected static readonly LOCAL_ESTIMATE_SAFETY_FACTOR = 1.5;


    /**
     * 本地文本 token 估算（统一按 1.5 安全系数偏大估算）
     */
    protected estimateTextTokensLocal(text: string): number {
        const base = Math.ceil(text.length / 4);
        return this.applyLocalEstimateSafetyFactor(base);
    }


    /** 对本地估算结果应用统一安全系数 */
    protected applyLocalEstimateSafetyFactor(tokens: number): number {
        return Math.max(1, Math.ceil(tokens * MessageTokenEstimator.LOCAL_ESTIMATE_SAFETY_FACTOR));
    }

    
    /** 使用与历史 API 格式化一致的 functionResponse 字段集合进行计数，避免 UI/运行时元数据虚增裁剪预算。 */
    protected cleanMessageForTokenCount(message: Content): Content {
        const foregroundWorkTransitionPart = message.role === 'user'
            ? createForegroundWorkTransitionPart(message.foregroundWorkTransition)
            : undefined;
        const { foregroundWorkTransition, ...rest } = message;
        return {
            ...rest,
            parts: [
                ...(foregroundWorkTransitionPart ? [foregroundWorkTransitionPart] : []),
                ...message.parts,
            ].map(part => {
                if (!part.functionResponse) return part;
                return {
                    ...part,
                    functionResponse: {
                        ...part.functionResponse,
                        response: cleanFunctionResponseForAPI(
                            part.functionResponse.response as Record<string, unknown>
                        ) as Record<string, unknown>
                    }
                };
            })
        };
    }


    /**
     * 估算一条消息的 token 数
     *
     * 遍历消息的所有 parts，根据类型进行估算：
     * - text: 每 4 个字符约 1 token
     * - inlineData: 使用 estimateMultimodalTokens
     * - functionCall: JSON 序列化后每 4 字符约 1 token
     * - functionResponse: JSON 序列化后每 4 字符约 1 token
     *
     * @param message 消息
     * @returns 估算的 token 数
     */
    estimateMessageTokens(message: Content): number {
        let tokens = 0;

        const foregroundWorkTransitionPart = message.role === 'user'
            ? createForegroundWorkTransitionPart(message.foregroundWorkTransition)
            : undefined;
        const parts = foregroundWorkTransitionPart
            ? [foregroundWorkTransitionPart, ...message.parts]
            : message.parts;

        for (const part of parts) {
            if (part.text) {
                tokens += Math.ceil(part.text.length / 4);
            }
            if (part.inlineData) {
                tokens += this.estimateMultimodalTokens(part.inlineData);
            }
            if (part.functionCall) {
                // functionCall.args 可选（流式累加器/解析器可能产出仅含 name/index/partialArgs
                // 的调用壳）：undefined 时 JSON.stringify 返回 undefined，.length 会抛 TypeError。
                const argsStr = JSON.stringify(part.functionCall.args ?? {});
                tokens += Math.ceil((part.functionCall.name.length + argsStr.length) / 4);
            }
            if (part.functionResponse) {
                const cleanedResponse = cleanFunctionResponseForAPI(
                    part.functionResponse.response as Record<string, unknown>
                );
                // cleanFunctionResponseForAPI 对 undefined response 原样返回 undefined（不抛错），
                // 但 JSON.stringify(undefined) === undefined，.length 同样会抛 TypeError；空对象兜底。
                const responseStr = JSON.stringify(cleanedResponse ?? {});
                tokens += Math.ceil((part.functionResponse.name.length + responseStr.length) / 4);
                // 如果有 parts（多模态数据）
                if (part.functionResponse.parts) {
                    for (const responsePart of part.functionResponse.parts) {
                        if (responsePart.inlineData) {
                            tokens += this.estimateMultimodalTokens(responsePart.inlineData);
                        }
                    }
                }
            }
            // 思考签名（thoughtSignatures）随请求原样回传，同样占用输入 token：
            // 按各格式签名文本长度估算（与 text 同口径：每 4 字符约 1 token）
            if (part.thoughtSignatures) {
                for (const signature of Object.values(part.thoughtSignatures)) {
                    if (typeof signature === 'string' && signature.length > 0) {
                        tokens += Math.ceil(signature.length / 4);
                    }
                }
            }
        }
        
        // 最小返回 1 token
        return this.applyLocalEstimateSafetyFactor(Math.max(1, tokens));
    }

    
    /**
     * 估算多媒体数据的 token 数
     *
     * 根据 mimeType 使用不同的估算策略：
     * - 图片: 固定 500 tokens（Gemini 实际 258-1032）
     * - 音频: 32 tokens/秒，按 base64 大小估算时长
     * - 视频: 295 tokens/秒（263 图像 + 32 音频），按 base64 大小估算时长
     * - 文档(PDF): 约 500 tokens/页，按 base64 大小估算页数
     * - 其他: 使用保守估算 1000 tokens
     *
     * @param inlineData 多媒体数据
     * @returns 估算的 token 数
     */
    estimateMultimodalTokens(inlineData: { mimeType: string; data: string }): number {
        const mimeType = inlineData.mimeType.toLowerCase();
        
        // 计算原始数据大小（base64 解码后约为原长度的 3/4）
        const base64Length = inlineData.data.length;
        const estimatedBytes = Math.floor(base64Length * 0.75);
        
        // 图片类型
        if (mimeType.startsWith('image/')) {
            // Gemini: 258-1032 tokens
            // OpenAI: 85-1105 tokens
            // Anthropic: 最大 1600 tokens
            // 使用中间值 500 tokens
            return 500;
        }
        
        // 音频类型
        if (mimeType.startsWith('audio/')) {
            // Gemini: 32 tokens/秒
            // 估算音频时长：
            // - MP3: 约 16 kbps = 2 KB/秒
            // - WAV: 约 176 kbps = 22 KB/秒
            // - 使用平均值 10 KB/秒
            const estimatedDurationSeconds = estimatedBytes / (10 * 1024);
            const audioTokens = Math.ceil(estimatedDurationSeconds * 32);
            // 设置合理的上下限
            return Math.max(100, Math.min(audioTokens, 50000));
        }
        
        // 视频类型
        if (mimeType.startsWith('video/')) {
            // Gemini: 263 tokens/秒 (视频帧) + 32 tokens/秒 (音频) = 295 tokens/秒
            // 估算视频时长：
            // - 压缩视频约 1 MB/分钟 = 17 KB/秒
            const estimatedDurationSeconds = estimatedBytes / (17 * 1024);
            const videoTokens = Math.ceil(estimatedDurationSeconds * 295);
            // 设置合理的上下限
            return Math.max(500, Math.min(videoTokens, 200000));
        }
        
        // 文档类型 (PDF, DOCX 等)
        if (mimeType === 'application/pdf' ||
            mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
            mimeType === 'application/msword') {
            // Gemini: 每页约 215-695 tokens
            // 估算页数：平均每页 PDF 约 50-100 KB
            const estimatedPages = Math.max(1, Math.ceil(estimatedBytes / (75 * 1024)));
            const docTokens = estimatedPages * 500;  // 每页 500 tokens
            return Math.max(500, Math.min(docTokens, 100000));
        }
        
        // 电子表格
        if (mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
            mimeType === 'application/vnd.ms-excel' ||
            mimeType === 'text/csv') {
            // 按数据大小估算，每 KB 约 100 tokens
            const spreadsheetTokens = Math.ceil(estimatedBytes / 1024) * 100;
            return Math.max(200, Math.min(spreadsheetTokens, 50000));
        }
        
        // 纯文本
        if (mimeType.startsWith('text/')) {
            // 文本：每 4 个字符约 1 token
            return Math.ceil(estimatedBytes / 4);
        }
        
        // 其他类型：使用保守估算
        // 无法确定类型时，使用较大的固定值
        return 1000;
    }
}
