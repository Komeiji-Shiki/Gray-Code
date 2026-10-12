/**
 * GrayCode - 上下文总结（Summarize）相关设置类型
 *
 * 从 types.ts 拆分而来：types.ts 通过 `export *` 重导出，旧引用路径保持兼容。
 */

/**
 * 上下文总结配置
 */
export interface SummarizeConfig {
    /** 常规总结或持久笔记换窗口；旧配置继续使用常规总结。 */
    method?: import('../../../../shared/contextManagement').ContextManagementMethod;
    /** 普通会话在预算内保留首条与最新一条、或全部用户原文；不足时优先最新输入，Bot 不使用。 */
    userMessageRetention?: import('../../../../shared/contextManagement').ContextUserMessageRetention;
    /** 自动压缩的可选绝对 token 上限；0 或省略时沿用渠道阈值。 */
    autoSummarizeTokenLimit?: number;
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
     * 仅普通总结使用；笔记换窗口不调用总结模型。次数耗尽后按当前输入预算裁剪请求。
     * 默认 2，允许范围 1-5。
     */
    maxAutoSummarizeAttemptsPerTurn: number;

    /**
     * 自动普通总结超出硬输入预算时，单次处理范围占可用历史输入预算的比例（0~1）。
     *
     * 正常能放下的总结继续使用完整上下文；超限时扣除固定前缀与总结指令后缩小范围，
     * 工具调用与结果保持配对。默认 0.5（50%），笔记换窗口不使用。
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
    method: 'summary',
    userMessageRetention: 'first',
    // 内容结构由总结请求固定追加的交接要求提供；这里只说明用途，用户可以改写来补充侧重点。
    summarizePrompt: 'Summarize the conversation above so the work can continue from the summary alone.',
    autoSummarizePrompt: 'The conversation is approaching the context limit. Summarize it so the unfinished task can continue from the summary alone.',
    keepRecentRounds: 2,
    keepRecentTokens: DEFAULT_KEEP_RECENT_TOKENS,
    useSeparateModel: false,
    summarizeChannelId: '',
    summarizeModelId: '',
    maxAutoSummarizeAttemptsPerTurn: DEFAULT_MAX_AUTO_SUMMARIZE_ATTEMPTS_PER_TURN,
    summarizeMaxInputRatio: DEFAULT_SUMMARIZE_MAX_INPUT_RATIO
};
