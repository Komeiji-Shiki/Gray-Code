import { ChannelError, ErrorType } from '../types';
import { t } from '../../../i18n';

/** 归一化后的上游流式错误 */
export interface StreamErrorInfo {
    message: string;
    code?: string;
}

const MAX_RAW_ERROR_LENGTH = 500;

function firstNonEmptyString(...candidates: unknown[]): string | undefined {
    for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.trim()) {
            return candidate.trim();
        }
        if (typeof candidate === 'number') {
            return String(candidate);
        }
    }
    return undefined;
}

/**
 * 从流式 chunk 中提取上游错误。
 *
 * 覆盖三种在实际渠道里出现过的形态：
 * - Anthropic 官方：`{ type: 'error', error: { type, message } }`
 * - OpenAI / Gemini 及各类兼容代理：`{ error: { message, code, type } }`
 * - 简化代理：`{ error: '余额不足' }`
 *
 * 返回 undefined 表示这不是错误 chunk。只有能提取出**非空文本**才算数：
 * 正常 chunk 上出现的 `error: null` / `error: {}` 不会被误判。
 */
export function extractStreamError(chunk: unknown): StreamErrorInfo | undefined {
    if (!chunk || typeof chunk !== 'object') {
        return undefined;
    }

    const record = chunk as Record<string, unknown>;
    const raw = record.error ?? (record.type === 'error' ? record : undefined);

    if (raw === undefined || raw === null) {
        return undefined;
    }

    if (typeof raw === 'string') {
        const message = raw.trim();
        return message ? { message } : undefined;
    }

    if (typeof raw !== 'object') {
        return undefined;
    }

    const errorRecord = raw as Record<string, unknown>;
    // Anthropic 的错误体是 { type: 'error', error: { type, message } }，真正的描述在内层
    const inner = (errorRecord.error && typeof errorRecord.error === 'object')
        ? errorRecord.error as Record<string, unknown>
        : errorRecord;

    const code = firstNonEmptyString(inner.code, inner.status, inner.type);
    const message = firstNonEmptyString(
        inner.message,
        inner.detail,
        inner.description,
        code
    );

    if (message) {
        return { message, code };
    }

    // 结构不认识但确实带了内容：原样透出，总好过让用户看到「模型返回空内容」
    const serialized = JSON.stringify(raw);
    if (!serialized || serialized === '{}' || serialized === '[]') {
        return undefined;
    }
    return {
        message: serialized.length > MAX_RAW_ERROR_LENGTH
            ? `${serialized.slice(0, MAX_RAW_ERROR_LENGTH)}…`
            : serialized
    };
}

/**
 * 识别流式 chunk 里内联的上游错误并抛出 ChannelError。
 *
 * 各家 provider 都会在 HTTP 200 的 SSE 流里内联错误（Anthropic 的 `event: error`、
 * OpenAI 兼容代理的 `{"error": {...}}`）。formatter 不认这些 chunk 就会解析出空 parts，
 * 累加器什么都没累加，最后落到界面上是一句「模型返回空内容」——而上游其实已经说明了原因。
 */
export function throwIfStreamError(chunk: unknown, provider: string): void {
    const error = extractStreamError(chunk);
    if (!error) {
        return;
    }

    throw new ChannelError(
        ErrorType.API_ERROR,
        t('modules.channel.formatters.streamError', { provider, message: error.message }),
        chunk
    );
}
