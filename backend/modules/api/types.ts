/**
 * LimCode - 前后端通信 API 类型定义
 *
 * 定义 Extension 和 Webview UI 之间的消息协议
 */

import type {
    ChatRequestData,
    ChatSuccessData,
    ChatErrorData,
    ChatStreamChunkData,
    ChatStreamCompleteData,
    ChatStreamErrorData,
    RetryRequestData,
    EditAndRetryRequestData,
    DeleteToMessageRequestData,
    DeleteToMessageSuccessData,
    DeleteToMessageErrorData
} from './chat/types';

// ==================== 请求消息 ====================

/**
 * 对话请求（非流式）
 */
export interface ChatRequest {
    type: 'chat';
    data: ChatRequestData;
}

/**
 * 对话请求（流式）
 */
export interface ChatStreamRequest {
    type: 'chatStream';
    data: ChatRequestData;
}

/**
 * 重试请求（非流式）
 */
export interface RetryRequest {
    type: 'retry';
    data: RetryRequestData;
}

/**
 * 重试请求（流式）
 */
export interface RetryStreamRequest {
    type: 'retryStream';
    data: RetryRequestData;
}

/**
 * 编辑并重试请求（非流式）
 */
export interface EditAndRetryRequest {
    type: 'editAndRetry';
    data: EditAndRetryRequestData;
}

/**
 * 编辑并重试请求（流式）
 */
export interface EditAndRetryStreamRequest {
    type: 'editAndRetryStream';
    data: EditAndRetryRequestData;
}

/**
 * 删除到指定消息请求
 */
export interface DeleteToMessageRequest {
    type: 'deleteToMessage';
    data: DeleteToMessageRequestData;
}

/**
 * 所有请求类型的联合
 */
export type APIRequest =
    | ChatRequest
    | ChatStreamRequest
    | RetryRequest
    | RetryStreamRequest
    | EditAndRetryRequest
    | EditAndRetryStreamRequest
    | DeleteToMessageRequest;

// ==================== 响应消息 ====================

/**
 * 对话响应（成功）
 */
export interface ChatSuccessResponse {
    type: 'chatResponse';
    data: ChatSuccessData;
}

/**
 * 对话响应（失败）
 */
export interface ChatErrorResponse {
    type: 'chatResponse';
    data: ChatErrorData;
}

/**
 * 对话响应（非流式）
 */
export type ChatResponse = ChatSuccessResponse | ChatErrorResponse;

/**
 * 流式响应块
 */
export interface ChatStreamChunkResponse {
    type: 'chatStreamChunk';
    data: ChatStreamChunkData;
}

/**
 * 流式完成通知
 */
export interface ChatStreamCompleteResponse {
    type: 'chatStreamComplete';
    data: ChatStreamCompleteData;
}

/**
 * 流式错误响应
 */
export interface ChatStreamErrorResponse {
    type: 'chatStreamError';
    data: ChatStreamErrorData;
}

/**
 * 删除消息响应（成功）
 */
export interface DeleteToMessageSuccessResponse {
    type: 'deleteToMessageResponse';
    data: DeleteToMessageSuccessData;
}

/**
 * 删除消息响应（失败）
 */
export interface DeleteToMessageErrorResponse {
    type: 'deleteToMessageResponse';
    data: DeleteToMessageErrorData;
}

/**
 * 删除消息响应
 */
export type DeleteToMessageResponse = DeleteToMessageSuccessResponse | DeleteToMessageErrorResponse;

/**
 * 所有响应类型的联合
 */
export type APIResponse =
    | ChatResponse
    | ChatStreamChunkResponse
    | ChatStreamCompleteResponse
    | ChatStreamErrorResponse
    | DeleteToMessageResponse;

// ==================== 错误代码 ====================

/**
 * API 错误代码
 */
export enum APIErrorCode {
    /** 对话不存在 */
    CONVERSATION_NOT_FOUND = 'CONVERSATION_NOT_FOUND',
    
    /** 配置不存在 */
    CONFIG_NOT_FOUND = 'CONFIG_NOT_FOUND',
    
    /** 配置已禁用 */
    CONFIG_DISABLED = 'CONFIG_DISABLED',
    
    /** 网络错误 */
    NETWORK_ERROR = 'NETWORK_ERROR',
    
    /** API 调用失败 */
    API_ERROR = 'API_ERROR',
    
    /** 响应解析失败 */
    PARSE_ERROR = 'PARSE_ERROR',
    
    /** 请求超时 */
    TIMEOUT_ERROR = 'TIMEOUT_ERROR',
    
    /** 未知错误 */
    UNKNOWN_ERROR = 'UNKNOWN_ERROR'
}

/**
 * API 错误类
 */
export class APIError extends Error {
    constructor(
        public code: APIErrorCode,
        message: string,
        public details?: unknown
    ) {
        super(message);
        this.name = 'APIError';
    }
}