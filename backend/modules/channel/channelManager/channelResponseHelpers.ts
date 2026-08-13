/**
 * GrayCode 渠道响应内容判定工具函数
 *
 * 从 ChannelManager 抽离的纯函数层：上游错误消息提取、内容空判定、
 * 流式缓冲上限校验、带限读取非流式响应体。流式与非流式两条路径共用同一口径。
 */

import { t } from '../../../i18n';
import { ChannelError, ErrorType } from '../types';
import type { StreamChunk } from '../types';
import type { Content } from '../../conversation';

/**
 * 从上游 API 的非 2xx 响应体中提取人类可读的错误消息。
 *
 * 支持格式：
 * - Anthropic:         { error: { message: "..." } }
 * - OpenAI/OpenRouter: { error: { message: "...", code: 429, metadata: {...} } }
 * - 简化 JSON:         { message: "..." } / { error: "..." }
 * - 纯文本:            直接返回文本
 */
export function extractUpstreamErrorMessage(body: unknown): string | undefined {
    if (!body || typeof body !== 'object') {
        if (typeof body === 'string' && body.trim()) return body.trim();
        return undefined;
    }
    const obj = body as Record<string, any>;
    // Anthropic/OpenAI/OpenRouter 的 { error: { message: "..." } }
    if (obj.error && typeof obj.error === 'object' && typeof obj.error.message === 'string') {
        return obj.error.message.trim();
    }
    // { error: "..." }
    if (typeof obj.error === 'string') {
        return obj.error.trim();
    }
    // { message: "..." }
    if (typeof obj.message === 'string') {
        return obj.message.trim();
    }
    return undefined;
}

/**
 * 判断单个 part 是否携带内容（文本/思考/工具调用/多模态附件）。
 * 流式与非流式两条路径共用同一口径，避免判定规则分叉。
 */
export function partHasContent(part: any): boolean {
    return (part.text && part.text.length > 0)
        || !!part.functionCall
        || !!part.inlineData
        || !!part.fileData;
}

/**
 * 判断模型响应内容是否为空（无文本/思考/工具调用/附件）。
 * HTTP 成功但内容全空 = 上游/代理抽风返回的无效响应，应触发自动重试。
 */
export function isResponseContentEmpty(content: Content | undefined): boolean {
    if (!content || !Array.isArray(content.parts) || content.parts.length === 0) return true;
    return content.parts.every(part => !partHasContent(part));
}

/**
 * 判断流式 chunk 的增量是否携带内容（文本/思考/工具调用/多模态附件）。
 *
 * 修改原因（SEC）：多模态流（Gemini inlineData/fileData）过去只查 text/functionCall，
 * 连接中断时已有图片/文件数据的流被误判为「空响应」→ 整条流从头重播，附件重复、重复计费。
 * 修改方式：与非流式 isResponseContentEmpty 同一口径（共用 partHasContent），
 * 把 inlineData/fileData 纳入内容判定。
 */
export function streamChunkHasContent(chunk: StreamChunk): boolean {
    return chunk.delta.some(part => partHasContent(part));
}

/**
 * 流式原始缓冲大小上限（字符）。
 *
 * 仅当「解析无进展」时生效（见两处调用点）：正常解析路径缓冲只保留未解析尾部（KB 级），
 * 不会触发；无法识别的上游垃圾数据（非 SSE/JSON，parseStreamBuffer 整段保留为 remaining）
 * 逐轮累积时触发终止，防止 Extension Host 内存耗尽。
 * 阈值 64MB：合法巨型单事件（多模态 base64 附件、大工具载荷）按事件全长累积，
 * 64MB 覆盖所有主流 provider 的单事件上限，同时把垃圾累积的内存占用封顶在可控范围。
 */
export const MAX_STREAM_BUFFER_LENGTH = 64 * 1024 * 1024;

/** 缓冲超限即按「上游数据无法解析」报错终止流（PARSE_ERROR 不可重试，避免无意义重试） */
export function assertStreamBufferWithinLimit(buffer: string): void {
    if (buffer.length > MAX_STREAM_BUFFER_LENGTH) {
        throw new ChannelError(
            ErrorType.PARSE_ERROR,
            t('modules.channel.errors.streamBufferOverflow'),
            { bufferLength: buffer.length, maxBufferLength: MAX_STREAM_BUFFER_LENGTH }
        );
    }
}

/**
 * 带上限读取非流式响应体文本：Content-Length 预检 + 流式累积截断。
 *
 * 修复：executeRequest 此前整包 await response.text()，上游异常返回巨型 body（数百 MB
 * HTML 错误页等）时内存耗尽 / 超 V8 字符串上限直接 RangeError 崩溃；现在超限即终止
 * 并报 PARSE_ERROR（不可重试，避免无意义重试）。
 */
export async function readBodyTextWithLimit(response: Response, limit: number): Promise<string> {
    const contentLengthHeader = response.headers.get('content-length');
    if (contentLengthHeader) {
        const contentLength = Number(contentLengthHeader);
        if (Number.isFinite(contentLength) && contentLength > limit) {
            // 预检超限：先取消响应体（避免连接悬挂、body 数据继续流入），再报 PARSE_ERROR
            await response.body?.cancel().catch(() => undefined);
            throw new ChannelError(
                ErrorType.PARSE_ERROR,
                t('modules.channel.errors.streamBufferOverflow'),
                { bufferLength: contentLength, maxBufferLength: limit }
            );
        }
    }
    if (!response.body) {
        // 无流式体（极少见）：退化为整包读取后检查上限
        const text = await response.text();
        if (text.length > limit) {
            throw new ChannelError(
                ErrorType.PARSE_ERROR,
                t('modules.channel.errors.streamBufferOverflow'),
                { bufferLength: text.length, maxBufferLength: limit }
            );
        }
        return text;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let result = '';
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            result += decoder.decode(value, { stream: true });
            if (result.length > limit) {
                // 终止读取并取消剩余数据，避免连接悬挂
                await reader.cancel().catch(() => undefined);
                throw new ChannelError(
                    ErrorType.PARSE_ERROR,
                    t('modules.channel.errors.streamBufferOverflow'),
                    { bufferLength: result.length, maxBufferLength: limit }
                );
            }
        }
        result += decoder.decode();
    } finally {
        reader.releaseLock();
    }
    return result;
}
