/**
 * 子代理 LLM 调用错误识别与 run 级兜底重试判定。
 *
 * 拆分说明：从 executor.ts 迁出（纯移动，逻辑一字未改）。retryable 错误码判定逐字保留。
 */

import { ChannelError, ErrorType } from '../../../modules/channel/types';

/**
 * 识别「上下文超限」类错误。
 *
 * 子代理没有接主链路的 ContextTrimService，历史上只增不减会撞上模型上下文上限。
 * 现在发送前有请求级防御性裁剪（trimSubAgentHistoryForContext），但识别错误仍是
 * 兜底防线（模型/上游措辞不同，裁剪不可能覆盖全部场景）。各家 provider 措辞不同
 * 但都认得出来。不做识别的话，用户只能看到一句原样透传的 `AI call failed: ...`，
 * 既不知道是撞了上下文，也不知道该去调哪个配置。
 */
export function isContextLengthError(error: unknown): boolean {
    const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
    return message.includes('context length')
        || message.includes('context_length')
        || message.includes('maximum context')
        || message.includes('context window')
        || message.includes('too many tokens')
        || message.includes('prompt is too long')
        || message.includes('reduce the length of the messages');
}

/**
 * 子代理 LLM 调用失败后的 run 级兜底重试次数。
 *
 * ChannelManager.generate 内部已按渠道配置自动重试（默认 3 次 × 3s）；
 * 这是第二层兜底：对可重试错误（429/5xx/网络/超时/空响应）再退避重试，
 * 避免子代理因瞬时配额/限流直接失败退出（用户无感知）。
 */
export const SUBAGENT_LLM_CALL_RETRY_MAX = 2;

/**
 * 判断 LLM 调用错误是否值得 run 级重试（与 ChannelManager.isRetryableError 同口径）。
 */
export function isSubAgentRetryableLlmError(error: unknown): boolean {
    if (error instanceof ChannelError) {
        if (error.type === ErrorType.CANCELLED_ERROR
            || error.type === ErrorType.PARSE_ERROR
            || error.type === ErrorType.VALIDATION_ERROR
            || error.type === ErrorType.CONFIG_ERROR) {
            return false;
        }
        // API_ERROR / NETWORK_ERROR / TIMEOUT_ERROR / EMPTY_RESPONSE_ERROR 可重试
        return true;
    }
    // 非 ChannelError：上下文超限/认证/参数类不重试，其余（网络层异常等）重试
    if (isContextLengthError(error)) return false;
    const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
    if (message.includes('unauthorized')
        || message.includes('invalid api key')
        || message.includes('authentication')
        || message.includes('auth failed')
        || message.includes('invalid request')
        || message.includes('bad request')
        || message.includes('not found')
        || message.includes('400')) {
        return false;
    }
    return true;
}

/**
 * 429 类配额/限流错误：恢复需要更长时间，使用更长的退避间隔。
 */
export function isQuotaOrRateLimitError(error: unknown): boolean {
    const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
    return message.includes('429')
        || message.includes('rate limit')
        || message.includes('quota')
        || message.includes('too many requests')
        || message.includes('insufficient_quota')
        || message.includes('resource_exhausted');
}
