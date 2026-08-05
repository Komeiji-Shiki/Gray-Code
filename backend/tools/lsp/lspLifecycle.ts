/**
 * LSP 生命周期保护共享模块
 *
 * 统一封装 LSP 请求的超时、中止与瞬时重试逻辑，供
 * get_symbols / goto_definition / find_references 等 LSP 工具复用。
 *
 * 设计要点：
 * - 超时/中止不重试：provider 仍挂起时重复发起同一个 LSP 请求只会堆积无谓请求；
 * - 仅瞬时 reject 重试一次（LSP_MAX_ATTEMPTS = 2）；
 * - listener 与 timer 一律清理，避免信号监听器与定时器泄漏；
 * - 已中止的 signal 在入口处立即拒绝，不发起任何请求。
 */

import * as vscode from 'vscode';

/** 单次 LSP 请求的超时时间 */
export const LSP_TIMEOUT_MS = 20_000;
/** 瞬时失败后的重试等待间隔 */
export const LSP_RETRY_DELAY_MS = 300;
/** 最大尝试次数（含首次），即瞬时失败最多重试一次 */
export const LSP_MAX_ATTEMPTS = 2;

/** LSP 请求超时错误 */
export class LspRequestTimeoutError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'LspRequestTimeoutError';
    }
}

/** LSP 请求中止错误 */
export class LspRequestAbortedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'LspRequestAbortedError';
    }
}

/**
 * 等待指定时长，期间可被中止。
 *
 * 已中止的 signal 立即拒绝；等待期间中止同样立即拒绝。
 * 无论以何种方式结束，都会清理 timer 并摘除 abort listener。
 */
export function waitWithAbort(delayMs: number, abortSignal?: AbortSignal): Promise<void> {
    if (abortSignal?.aborted) {
        return Promise.reject(new LspRequestAbortedError('LSP request was aborted'));
    }
    return new Promise<void>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (error?: Error) => {
            clearTimeout(timer);
            abortSignal?.removeEventListener('abort', onAbort);
            if (error) {
                reject(error);
            } else {
                resolve();
            }
        };
        const onAbort = () => finish(new LspRequestAbortedError('LSP request was aborted'));
        timer = setTimeout(() => finish(), delayMs);
        abortSignal?.addEventListener('abort', onAbort, { once: true });
    });
}

/**
 * 给一个 LSP 请求（Thenable）附加超时与中止保护。
 *
 * - 已中止的 signal 立即以 LspRequestAbortedError 拒绝；
 * - 超过 timeoutMs 未完成以 LspRequestTimeoutError 拒绝；
 * - 挂起期间中止以 LspRequestAbortedError 拒绝；
 * - 无论以何种方式结束，都会清理 timer 并摘除 abort listener；
 * - 请求自身 reject 时原样透传。
 */
export function withTimeoutAndAbort<T>(
    request: Thenable<T>,
    timeoutMs: number,
    abortSignal?: AbortSignal
): Promise<T> {
    if (abortSignal?.aborted) {
        return Promise.reject(new LspRequestAbortedError('LSP request was aborted'));
    }

    return new Promise<T>((resolve, reject) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (action: () => void) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            abortSignal?.removeEventListener('abort', onAbort);
            action();
        };
        const onAbort = () => finish(() => reject(new LspRequestAbortedError('LSP request was aborted')));
        timer = setTimeout(() => finish(() => reject(
            new LspRequestTimeoutError(`LSP request timed out after ${timeoutMs}ms`)
        )), timeoutMs);
        abortSignal?.addEventListener('abort', onAbort, { once: true });
        Promise.resolve(request).then(
            value => finish(() => resolve(value)),
            error => finish(() => reject(error))
        );
    });
}

/**
 * 打开文档以激活对应语言服务（带超时/中止保护）。
 *
 * 未在编辑器中打开的大型 TypeScript 文件尤其需要先打开文档，
 * execute*Provider 才能返回结果。
 * 已中止的 signal 直接拒绝，不发起 openTextDocument 调用。
 */
export async function openDocumentWithGuard(
    uri: vscode.Uri,
    abortSignal?: AbortSignal
): Promise<void> {
    if (abortSignal?.aborted) {
        throw new LspRequestAbortedError('LSP request was aborted');
    }
    await withTimeoutAndAbort(
        vscode.workspace.openTextDocument(uri),
        LSP_TIMEOUT_MS,
        abortSignal
    );
}

/** executeLspCommandWithRetry 的可选参数 */
export interface LspCommandRetryOptions {
    /** 单次请求超时时间，默认 LSP_TIMEOUT_MS */
    timeoutMs?: number;
    /** 取消信号，默认无 */
    abortSignal?: AbortSignal;
    /** 最大尝试次数（含首次），默认 LSP_MAX_ATTEMPTS */
    maxAttempts?: number;
    /** 瞬时失败重试等待间隔，默认 LSP_RETRY_DELAY_MS */
    retryDelayMs?: number;
}

/**
 * 执行 LSP provider 命令，带超时/中止保护与瞬时失败重试。
 *
 * - 已中止的 signal 直接拒绝，不发起请求；
 * - 超时/中止不重试：provider 仍挂起时重复发起请求只会堆积；
 * - 仅瞬时 reject 重试一次（默认 LSP_MAX_ATTEMPTS = 2）；
 * - 重试等待可被中止打断。
 */
export async function executeLspCommandWithRetry<T>(
    command: string,
    args: unknown[],
    options: LspCommandRetryOptions = {}
): Promise<T> {
    const {
        timeoutMs = LSP_TIMEOUT_MS,
        abortSignal,
        maxAttempts = LSP_MAX_ATTEMPTS,
        retryDelayMs = LSP_RETRY_DELAY_MS
    } = options;

    if (abortSignal?.aborted) {
        throw new LspRequestAbortedError('LSP request was aborted');
    }

    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await withTimeoutAndAbort(
                vscode.commands.executeCommand<T>(command, ...args),
                timeoutMs,
                abortSignal
            );
        } catch (error) {
            lastError = error;
            // 超时/中止不重试；仅对瞬时拒绝重试一次。
            if (
                attempt >= maxAttempts ||
                error instanceof LspRequestTimeoutError ||
                error instanceof LspRequestAbortedError
            ) {
                break;
            }
            await waitWithAbort(retryDelayMs, abortSignal);
        }
    }
    throw lastError;
}
