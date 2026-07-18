/**
 * 用量统计类型
 *
 * 与后端 backend/modules/conversation/usageStats.ts 的聚合结果结构保持一致。
 * 修改后端结构时请同步更新此文件。
 */

/** 单个维度桶的 token 计数 */
export interface UsageBucket {
  /** 输入 token（各次请求 promptTokenCount 之和） */
  promptTokens: number
  /** 输出 token */
  candidatesTokens: number
  /** 思考 token */
  thoughtsTokens: number
  /** 合计（prompt + candidates + thoughts） */
  totalTokens: number
  /** 参与统计的 model 消息数 */
  modelMessages: number
}

export interface ConversationUsage extends UsageBucket {
  conversationId: string
  title: string
  /** 最后更新时间（毫秒） */
  updatedAt: number
}

export interface ModelUsage extends UsageBucket {
  /** 模型标识（modelVersion），未记录时为 'unknown' */
  modelVersion: string
}

export interface DailyUsage extends UsageBucket {
  /** 本地日期，格式 YYYY-MM-DD */
  date: string
}

export interface UsageStatsResult {
  totals: UsageBucket & {
    /** 参与统计的对话数 */
    conversations: number
    /** 读取失败被跳过的对话数 */
    skippedConversations: number
  }
  byConversation: ConversationUsage[]
  byModel: ModelUsage[]
  byDay: DailyUsage[]
  /** 统计生成时间（毫秒） */
  generatedAt: number
}

/** 用量统计查询参数（毫秒时间戳，含端点） */
export interface UsageStatsQuery {
  startTime?: number
  endTime?: number
}

/** 时间范围快捷选项 */
export type UsageTimeRange = 'all' | 'today' | '7d' | '30d'

/**
 * 单个模型的单价（美元 / 每百万 token）
 *
 * 思考 token 按输出单价计费。两项均为 0 时视为未配置。
 */
export interface ModelPricing {
  input: number
  output: number
}

/** 模型单价表，key 为 modelVersion */
export type UsagePricingMap = Record<string, ModelPricing>
