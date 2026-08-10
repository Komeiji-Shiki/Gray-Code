/**
 * 可重试错误判定（模块化重构第六批收敛）。
 *
 * 收敛前：ChannelManager.isRetryableError（ChannelError.type 白名单）与
 * backend/tools/subagents/executor/retry.ts 的 isSubAgentRetryableLlmError
 * （注释自证"与 ChannelManager 同口径"）各自实现同一判定。ErrorType 共 8 个成员，
 * 两者口径互为补集、判定结果一致，统一收口于本文件。
 *
 * 前端注意：frontend/src/stores/chat/messageActions/retryFlows.ts 的
 * RETRYABLE_ERROR_CODES 与后端同名集合受 tsconfig 跨端限制无法共享代码，
 * 仅以注释"与 backend/core/errors.ts 同步维护"保持同步。
 */

import { ErrorType } from './errorTypes';

/** 可重试的 ChannelError.type 白名单（以 ChannelManager 原判定为基准，勿随意增减） */
export const RETRYABLE_ERROR_TYPES: ReadonlySet<ErrorType> = new Set([
    ErrorType.API_ERROR,
    ErrorType.NETWORK_ERROR,
    ErrorType.TIMEOUT_ERROR,
    ErrorType.EMPTY_RESPONSE_ERROR
]);

/**
 * 按 ChannelError.type 判定是否可重试。
 *
 * CANCELLED_ERROR（用户取消）/ CONFIG_ERROR / PARSE_ERROR / VALIDATION_ERROR
 * 不在白名单内，均不可重试。
 */
export function isRetryableError(type: ErrorType): boolean {
    return RETRYABLE_ERROR_TYPES.has(type);
}
