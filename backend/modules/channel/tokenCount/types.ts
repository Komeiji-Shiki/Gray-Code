/**
 * GrayCode - Token 计数结果
 *
 * 由 TokenCountService.ts 拆分而来，作为 tokenCount 子模块的公共类型。
 */

/**
 * Token 计数结果
 */
export interface TokenCountResult {
    /** 是否成功 */
    success: boolean;
    /** 总 token 数 */
    totalTokens?: number;
    /** 错误信息 */
    error?: string;
}
