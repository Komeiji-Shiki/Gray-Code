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
 * 从单个错误载体（对象或数组）中提取可读错误信息。
 *
 * 覆盖的形态：
 * - Anthropic 官方：`{ type: 'error', error: { type, message } }`
 * - OpenAI / Gemini 及各类兼容代理：`{ error: { message, code, type } }`
 * - Google 官方错误体数组包装：`{ error: { errors: [{ message, reason }] } }`、
 *   `{ error: [{ message }] }`（官方错误有时可为数组包装）
 * - 简化代理：`{ error: '余额不足' }`
 *
 * 返回 undefined 表示这不是错误信息。只有能提取出**非空文本**才算数：
 * 正常 chunk 上出现的 `error: null` / `error: {}` 不会被误判。
 */
function extractErrorInfo(raw: unknown): StreamErrorInfo | undefined {
    if (typeof raw === 'string') {
        const message = raw.trim();
        return message ? { message } : undefined;
    }

    if (Array.isArray(raw)) {
        // 数组包装错误：逐个元素尝试，取第一个可读信息
        for (const item of raw) {
            const info = extractErrorInfo(item);
            if (info) {
                return info;
            }
        }
        return undefined;
    }

    if (!raw || typeof raw !== 'object') {
        return undefined;
    }

    const record = raw as Record<string, unknown>;

    // 内层包装（Anthropic 的 { error: { type, message } } 及各代理的 { error: {...} }）：
    // 优先提取内层；内层为空时仍尝试外层 message/code，避免错误说明被空 errors 数组遮蔽。
    if (record.error !== undefined && record.error !== null) {
        const nested = extractErrorInfo(record.error);
        if (nested) {
            return nested;
        }
        const outerCode = firstNonEmptyString(record.code, record.status);
        const outerMessage = firstNonEmptyString(
            record.message,
            record.detail,
            record.description,
            outerCode
        );
        return outerMessage ? { message: outerMessage, code: outerCode } : undefined;
    }

    const code = firstNonEmptyString(record.code, record.status, record.type);
    const message = firstNonEmptyString(
        record.message,
        record.detail,
        record.description,
        code
    );

    if (message) {
        return { message, code };
    }

    // Google 官方错误体可能把 message 放在 errors 数组里（{ error: { errors: [...] } }）
    if (Array.isArray(record.errors)) {
        for (const item of record.errors) {
            const info = extractErrorInfo(item);
            if (info) {
                return info;
            }
        }
        // errors 数组存在但没有可读信息（如空数组）：视为无错误，不落入透出分支
        return undefined;
    }

    // 结构不认识但确实带了内容：原样透出，总好过让用户看到「模型返回空内容」。
    // 仅含空字符串/null/空对象的壳不算有效内容，让外层包装有机会回退自己的 message。
    const hasMeaningfulValue = Object.values(record).some(value => {
        if (value === undefined || value === null || value === '') return false;
        if (Array.isArray(value)) return value.length > 0;
        if (typeof value === 'object') return Object.keys(value as object).length > 0;
        return true;
    });
    if (!hasMeaningfulValue) {
        return undefined;
    }
    const serialized = JSON.stringify(record);
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
 * 从流式 chunk 中提取上游错误。
 *
 * 覆盖三种在实际渠道里出现过的形态：
 * - Anthropic 官方：`{ type: 'error', error: { type, message } }`
 * - OpenAI / Gemini 及各类兼容代理：`{ error: { message, code, type } }`
 * - 简化代理：`{ error: '余额不足' }`
 *
 * 另兼容数组包装错误：`{ error: { errors: [{ message }] } }`、`{ error: [{ message }] }`，
 * 以及 chunk 本身是错误数组的情况（官方错误有时可为数组包装）。
 *
 * 返回 undefined 表示这不是错误 chunk。只有能提取出**非空文本**才算数：
 * 正常 chunk 上出现的 `error: null` / `error: {}` 不会被误判。
 */
export function extractStreamError(chunk: unknown): StreamErrorInfo | undefined {
    if (!chunk || typeof chunk !== 'object') {
        return undefined;
    }

    if (Array.isArray(chunk)) {
        // 顶层数组既可能是错误包装，也可能只是正常内容块列表；只有带明确错误特征的
        // 元素才进入错误提取，避免 [{ type: 'text', text: 'hi' }] 被 type 回退误判。
        for (const item of chunk) {
            if (Array.isArray(item)) {
                const nested = extractStreamError(item);
                if (nested) return nested;
                continue;
            }
            if (!item || typeof item !== 'object') continue;
            const record = item as Record<string, unknown>;
            const looksLikeError = record.error !== undefined
                || Array.isArray(record.errors)
                || record.type === 'error';
            if (!looksLikeError) continue;
            const info = extractErrorInfo(item);
            if (info) return info;
        }
        return undefined;
    }

    const record = chunk as Record<string, unknown>;
    const hasErrorPayload = record.error !== undefined && record.error !== null;
    if (!hasErrorPayload && record.type !== 'error') {
        return undefined;
    }

    // 把完整包装交给递归提取：内层为空时仍可回退外层 message/code。
    return extractErrorInfo(record);
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
