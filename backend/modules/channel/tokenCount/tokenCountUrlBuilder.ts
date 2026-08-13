/**
 * GrayCode - Token 计数端点 URL 构造
 *
 * 由 TokenCountService.ts 拆分而来：把 OpenAI Responses / Anthropic 的
 * count_tokens 端点规整逻辑抽为纯函数（token 计数职责的一部分）。
 */

/**
 * 构建 OpenAI Responses input_tokens 端点
 *
 * 兼容以下输入：
 * - https://api.openai.com/v1
 * - https://api.openai.com/v1/responses
 * - https://api.openai.com/v1/responses/input_tokens
 */
export function buildOpenAIResponsesCountUrl(rawUrl: string): string {
    const normalizedUrl = rawUrl.trim().replace(/\/+$/, '');

    if (/\/responses\/input_tokens$/i.test(normalizedUrl)) {
        return normalizedUrl;
    }

    if (/\/v1\/responses$/i.test(normalizedUrl) || /\/responses$/i.test(normalizedUrl)) {
        return `${normalizedUrl}/input_tokens`;
    }

    if (/\/v1$/i.test(normalizedUrl)) {
        return `${normalizedUrl}/responses/input_tokens`;
    }

    return `${normalizedUrl}/v1/responses/input_tokens`;
}

/**
 * 构建 Anthropic count_tokens 端点
 */
export function buildAnthropicCountUrl(rawUrl?: string): string {
    if (!rawUrl) {
        return 'https://api.anthropic.com/v1/messages/count_tokens';
    }

    let normalizedUrl = rawUrl.trim().replace(/\/+$/, '');
    // 先去掉旧端点后缀（/complete），再规整 /v1/models → /v1。
    // 顺序不能反：若先处理 /v1/models，baseUrl 为 .../v1/models/complete 时
    // 会残留 /complete 后缀，最终拼出 .../v1/models/v1/messages/count_tokens 的畸形 URL。
    // （/v1/complete 结尾的地址会被 /complete 规则覆盖，无需单独处理。）
    normalizedUrl = normalizedUrl
        .replace(/\/complete$/i, '')
        .replace(/\/v1\/models$/i, '/v1');

    if (/\/v1\/messages\/count_tokens$/i.test(normalizedUrl) || /\/messages\/count_tokens$/i.test(normalizedUrl)) {
        return normalizedUrl;
    }
    if (/\/v1\/messages$/i.test(normalizedUrl) || /\/messages$/i.test(normalizedUrl)) {
        return `${normalizedUrl}/count_tokens`;
    }
    return /\/v1$/i.test(normalizedUrl) ? `${normalizedUrl}/messages/count_tokens` : `${normalizedUrl}/v1/messages/count_tokens`;
}
