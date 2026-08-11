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
     * 支持绝对 token 数（number 或数字字符串）或相对「本次总结规划范围内活跃历史
     * token 总量」的百分比字符串（如 '50%' = 截断一半、保留另一半）。百分比基数是
     * 当前待总结的活跃历史（上一次总结之后、未被 isSummarized 覆盖的消息），不是主
     * 模型上下文窗口——保证「保留一半」始终是历史的一半，与模型窗口大小无关。
     * 规划器先满足最近轮次保护，再允许在超长工具回合内部选择不拆散
     * functionCall/functionResponse 的 model 边界，避免整轮过度总结。
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

    /**
     * 单个真实用户回合内自动总结的最大尝试次数。
     *
     * 每次尝试都会调用总结模型；次数耗尽后若仍超阈值，本次请求改用不持久化的
     * 细粒度安全裁剪（不直接丢弃整轮用户对话）。默认 2，允许范围 1-5。
     */
    maxAutoSummarizeAttemptsPerTurn: number;

    /**
     * 自动总结单次请求输入占总结模型上下文窗口的比例（0~1）。
     *
     * 待总结内容估算 token 超出该预算时，自动缩小总结范围（保留最近一轮
     * functionCall/functionResponse 工具交互）。默认 0.5（50%）。
     */
    summarizeMaxInputRatio: number;
    
    [key: string]: unknown;
}

/**
 * 内置默认的总结保留预算（keepRecentTokens 的默认值，单一事实来源）
 *
 * 默认「截断一半、保留另一半」：保留最近 50% 的活跃历史，更早的一半纳入总结。
 * 用户可在总结设置中修改实际生效值；配置缺失或非法时，
 * 后端解析（summarizeRangePlanner）与前端展示都回落到该值。
 */
export const DEFAULT_KEEP_RECENT_TOKENS = '50%';

/** 单个真实用户回合内自动总结的最大尝试次数（默认值，单一事实来源） */
export const DEFAULT_MAX_AUTO_SUMMARIZE_ATTEMPTS_PER_TURN = 2;

/** 自动总结单次请求输入占总结模型上下文窗口的比例（默认值，单一事实来源） */
export const DEFAULT_SUMMARIZE_MAX_INPUT_RATIO = 0.5;

/**
 * 收敛自动总结尝试次数：非有限数回落默认值 2，范围钳制到 [1, 5] 整数。
 */
export function clampMaxAutoSummarizeAttempts(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return DEFAULT_MAX_AUTO_SUMMARIZE_ATTEMPTS_PER_TURN;
    }
    return Math.min(5, Math.max(1, Math.floor(value)));
}

/**
 * 收敛总结输入占比：非有限数回落默认值 0.5，范围钳制到 [0.05, 0.95]。
 */
export function clampSummarizeMaxInputRatio(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return DEFAULT_SUMMARIZE_MAX_INPUT_RATIO;
    }
    return Math.min(0.95, Math.max(0.05, value));
}

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
    summarizeModelId: '',
    maxAutoSummarizeAttemptsPerTurn: DEFAULT_MAX_AUTO_SUMMARIZE_ATTEMPTS_PER_TURN,
    summarizeMaxInputRatio: DEFAULT_SUMMARIZE_MAX_INPUT_RATIO
};
