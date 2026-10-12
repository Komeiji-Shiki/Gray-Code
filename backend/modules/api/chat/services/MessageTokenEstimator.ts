import type { Content, ContentPart } from '../../../conversation/types';
import { cleanFunctionResponseForAPI } from '../../../conversation/helpers';
import { createForegroundWorkTransitionPart } from '../../../conversation/foregroundWorkTransition';
import { countJsonTokens, countTextTokens, describeTextTokenizer, type TokenizerOptions } from '../../../../../packages/core/src/tokenizer';
import { estimateImageTokens, type ImageTokenInput } from './imageTokenEstimator';

interface CachedPartCount {
    text?: string;
    inlineData?: ContentPart['inlineData'];
    functionCall?: ContentPart['functionCall'];
    functionResponse?: ContentPart['functionResponse'];
    thoughtSignatures?: ContentPart['thoughtSignatures'];
    redactedThinking?: string;
    reasoning?: ContentPart['openaiResponsesReasoning'];
    fileData?: ContentPart['fileData'];
    tokens: number;
}

const partCounts = new WeakMap<ContentPart, Map<string, CachedPartCount>>();

export class MessageTokenEstimator {
    constructor(protected readonly tokenizerOptions: TokenizerOptions = {}) {}

    /** 此值是本地 tokenizer 的输入预算，不与供应方 usage 或计费结果混用。 */
    protected estimateTextTokensLocal(text: string, options = this.tokenizerOptions): number {
        return countTextTokens(text, options);
    }

    protected cleanMessageForTokenCount(message: Content): Content {
        const transition = message.role === 'user' ? createForegroundWorkTransitionPart(message.foregroundWorkTransition) : undefined;
        const { foregroundWorkTransition, ...rest } = message;
        return { ...rest, parts: [...(transition ? [transition] : []), ...message.parts].map(part => {
            if (!part.functionResponse) return part;
            return { ...part, functionResponse: { ...part.functionResponse, response: this.cleanResponse(part.functionResponse.response) } };
        }) };
    }

    /** 正文按 part 对象缓存，历史投影即使重建消息数组也不会再次编码完整工具结果。 */
    estimateMessageTokens(message: Content, options = this.tokenizerOptions): number {
        options = { ...this.tokenizerOptions, ...options };
        let tokens = 0;
        const transition = message.role === 'user' ? createForegroundWorkTransitionPart(message.foregroundWorkTransition) : undefined;
        if (transition) tokens += this.estimatePartTokens(transition, options);
        for (const part of message.parts) tokens += this.estimatePartTokens(part, options);
        return Math.max(1, tokens);
    }

    private cleanResponse(response: Record<string, unknown> | undefined): Record<string, unknown> {
        return cleanFunctionResponseForAPI(response) ?? {};
    }

    private estimatePartTokens(part: ContentPart, options: TokenizerOptions): number {
        const key = [describeTextTokenizer(options).encoding, options.channelType, options.model, options.imageDetail, options.mediaResolution].join(':');
        const counts = partCounts.get(part);
        const cached = counts?.get(key);
        if (cached && cached.text === part.text && cached.inlineData === part.inlineData && cached.functionCall === part.functionCall &&
            cached.functionResponse === part.functionResponse && cached.thoughtSignatures === part.thoughtSignatures &&
            cached.redactedThinking === part.redactedThinking && cached.reasoning === part.openaiResponsesReasoning && cached.fileData === part.fileData) {
            return cached.tokens;
        }

        let tokens = countTextTokens(part.text ?? '', options);
        if (part.inlineData) tokens += this.estimateMultimodalTokens(part.inlineData, options);
        if (part.fileData) {
            // 远程文件没有本地尺寸；这里只能使用媒体基准，不能把 URL 长度当文件内容。
            tokens += this.estimateMultimodalTokens({ ...part.fileData, data: '' }, options);
        }
        if (part.functionCall) {
            tokens += countTextTokens(part.functionCall.name, options) + countJsonTokens(part.functionCall.args ?? {}, options);
        }
        if (part.functionResponse) {
            tokens += countTextTokens(part.functionResponse.name, options) + countJsonTokens(this.cleanResponse(part.functionResponse.response), options);
            for (const nested of part.functionResponse.parts ?? []) tokens += this.estimatePartTokens(nested, options);
        }
        if (part.thoughtSignatures) {
            // 只计目标渠道实际回传的签名，避免把同一思考的多个协议副本叠加。
            const channel = options.channelType === 'gemini-interactions' ? 'gemini' : options.channelType;
            const signatures = channel ? [part.thoughtSignatures[channel]] : Object.values(part.thoughtSignatures);
            for (const signature of signatures) tokens += countTextTokens(signature ?? '', options);
        }
        tokens += countTextTokens(part.redactedThinking ?? '', options);
        if (part.openaiResponsesReasoning && options.channelType === 'openai-responses') {
            // reasoning 的 summary/content 是可见原文；与 text 相同的单一文本不重复累计。
            for (const item of [...part.openaiResponsesReasoning.summary ?? [], ...part.openaiResponsesReasoning.content ?? []]) {
                if (item.text !== part.text) tokens += countTextTokens(item.text, options);
            }
        }
        const entry: CachedPartCount = {
            text: part.text, inlineData: part.inlineData, functionCall: part.functionCall, functionResponse: part.functionResponse,
            thoughtSignatures: part.thoughtSignatures, redactedThinking: part.redactedThinking,
            reasoning: part.openaiResponsesReasoning, fileData: part.fileData, tokens
        };
        if (counts) counts.set(key, entry);
        else partCounts.set(part, new Map([[key, entry]]));
        return tokens;
    }

    /** 图片按尺寸与模型规则；其余媒体沿用容量基准，文本附件实际解码后分词。 */
    estimateMultimodalTokens(inlineData: ImageTokenInput, options = this.tokenizerOptions): number {
        const mimeType = inlineData.mimeType.toLowerCase();
        if (mimeType.startsWith('image/')) return estimateImageTokens(inlineData, options).tokens;
        if (mimeType.startsWith('text/') || mimeType === 'application/json') {
            return countTextTokens(Buffer.from(inlineData.data, 'base64').toString('utf8'), options);
        }
        const estimatedBytes = Math.floor(inlineData.data.length * 0.75);
        if (mimeType.startsWith('audio/')) return Math.max(100, Math.min(Math.ceil(estimatedBytes / (10 * 1024) * 32), 50000));
        if (mimeType.startsWith('video/')) return Math.max(500, Math.min(Math.ceil(estimatedBytes / (17 * 1024) * 295), 200000));
        if (mimeType === 'application/pdf' || mimeType === 'application/msword' ||
            mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
            return Math.max(500, Math.min(Math.ceil(estimatedBytes / (75 * 1024)) * 500, 100000));
        }
        if (mimeType === 'application/vnd.ms-excel' || mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
            return Math.max(200, Math.min(Math.ceil(estimatedBytes / 1024) * 100, 50000));
        }
        return 1000;
    }
}
