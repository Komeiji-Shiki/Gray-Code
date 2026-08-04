/**
 * GrayCode - 上下文总结（Summarize）相关设置类型
 *
 * 从 types.ts 拆分而来：types.ts 通过 `export *` 重导出，旧引用路径保持兼容。
 */

/**
 * 上下文总结配置
 */
export interface SummarizeConfig {
    /**
     * 手动总结提示词
     */
    summarizePrompt: string;

    /**
     * 自动总结提示词
     */
    autoSummarizePrompt: string;
    
    /**
     * 最少保留最近 N 轮不总结（作为 keepRecentTokens 预算的下限保护）
     */
    keepRecentRounds: number;

    /**
     * 总结时保留最近内容的 token 预算
     *
     * 支持绝对 token 数（number 或数字字符串）或相对主对话模型最大上下文的
     * 百分比字符串（如 '25%'）。总结范围按轮边界对齐：从最近一轮往前累计，
     * 超出预算的更早轮次会被纳入总结。
     */
    keepRecentTokens?: number | string;

    /**
     * 是否使用专门的总结模型
     */
    useSeparateModel: boolean;
    
    /**
     * 总结用的渠道 ID
     */
    summarizeChannelId: string;
    
    /**
     * 总结用的模型 ID
     */
    summarizeModelId: string;
    
    [key: string]: unknown;
}

/**
 * 内置默认的总结保留预算（keepRecentTokens 的默认值，单一事实来源）
 *
 * 用户可在总结设置中修改实际生效值；配置缺失或非法时，
 * 后端解析（summarizeRangePlanner）与前端展示都回落到该值。
 */
export const DEFAULT_KEEP_RECENT_TOKENS = '25%';

/**
 * 默认总结配置
 */
export const DEFAULT_SUMMARIZE_CONFIG: SummarizeConfig = {
    summarizePrompt: 'Please summarize the above conversation, keeping key information and context points while removing redundant content.',
    autoSummarizePrompt: `Please summarize the above conversation history and output the following sections, so that the AI can continue completing the unfinished tasks.

## User Requirements
What the user wants to accomplish (overall goal).

## Completed Work
List what has been done in chronological order, including which files were changed and what decisions were made.
File paths, variable names, and configuration values must be preserved exactly, do not generalize.

## Current Progress
What step has been reached, what is currently being done.

## TODO Items
What still needs to be done, listed by priority.

## Important Conventions
Constraints, preferences, and technical requirements raised by the user (e.g., "do not use third-party libraries", "use TypeScript", etc.).

Output content directly without any prefix.`,
    keepRecentRounds: 2,
    keepRecentTokens: DEFAULT_KEEP_RECENT_TOKENS,
    useSeparateModel: false,
    summarizeChannelId: '',
    summarizeModelId: ''
};
