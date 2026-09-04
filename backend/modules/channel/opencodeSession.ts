/**
 * OpenCode Go 会话标头兼容。
 *
 * OpenCode Go 需要每个会话在所有推理请求中携带稳定的
 * `x-opencode-session`。这里以对话/渠道标识的 SHA-256 摘要构造 UUID
 * 形态的值，不发送原始本地标识。
 */

import { createHash } from 'node:crypto';
import type { ChannelConfig } from '../config';
import type { GenerateRequest, HttpRequestOptions } from './types';

export const OPENCODE_SESSION_HEADER = 'x-opencode-session';

/**
 * 根据请求所属的稳定域构造一个 UUID v5 形态的标识。
 *
 * 正常聊天和子代理均提供 conversationId，因而每个会话/运行拥有独立且可复用的
 * 标识。无会话 ID 的内部推理请求退回到渠道 ID，既不遗漏请求头，也不会泄露原始
 * 本地 ID；该退回域只影响没有可归属对话的内部请求。
 */
export function buildOpenCodeSessionId(
    request: Pick<GenerateRequest, 'configId' | 'conversationId'>
): string {
    const conversationId = request.conversationId?.trim();
    const domain = conversationId
        ? `conversation:${conversationId}`
        : `channel:${request.configId}`;
    const digest = createHash('sha256')
        .update(`graycode-opencode-session:${domain}`, 'utf8')
        .digest('hex');

    // UUID 的 version/variant 位按 RFC 4122 编码。摘要来源是 SHA-256，
    // 但使用 v5 形态能满足上游对“稳定 UUID”的格式预期。
    const variantNibble = ((Number.parseInt(digest[16], 16) & 0x3) | 0x8).toString(16);
    return [
        digest.slice(0, 8),
        digest.slice(8, 12),
        `5${digest.slice(13, 16)}`,
        `${variantNibble}${digest.slice(17, 20)}`,
        digest.slice(20, 32)
    ].join('-');
}

/**
 * 在统一请求出口为开启兼容项的渠道附加会话标头。
 *
 * 删除大小写不同的同名自定义头后再写入，避免 HTTP 客户端看到重复字段，且确保
 * 开关启用时的实际值确实是按当前会话生成的稳定 ID。
 */
export function applyOpenCodeSessionHeader(
    requestOptions: HttpRequestOptions,
    request: Pick<GenerateRequest, 'configId' | 'conversationId'>,
    config: Pick<ChannelConfig, 'openCodeSessionEnabled'>
): HttpRequestOptions {
    if (config.openCodeSessionEnabled !== true) {
        return requestOptions;
    }

    const headers = Object.fromEntries(
        Object.entries(requestOptions.headers)
            .filter(([name]) => name.toLowerCase() !== OPENCODE_SESSION_HEADER)
    );

    return {
        ...requestOptions,
        headers: {
            ...headers,
            [OPENCODE_SESSION_HEADER]: buildOpenCodeSessionId(request)
        }
    };
}
