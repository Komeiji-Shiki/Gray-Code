/**
 * SubAgent provider 上下文压缩的持久诊断记录。
 *
 * 该类型同时供扩展宿主、持久化层与 Monitor Webview 使用，字段只保存计数、状态和
 * transcript 边界，不保存总结正文或工具结果。
 */
export type SubAgentContextCompactionStatus = 'running' | 'completed' | 'failed' | 'fallback';

export type SubAgentContextCompactionStrategy = 'summary' | 'hard_fallback';

export interface SubAgentContextCompactionRecord {
    /** run 内稳定 ID。 */
    id: string;
    /** run 内单调序号。 */
    sequence: number;
    /** 同一次请求前自动总结的尝试序号（从 1 开始）。 */
    attempt: number;
    status: SubAgentContextCompactionStatus;
    strategy: SubAgentContextCompactionStrategy;
    startedAt: number;
    completedAt?: number;

    /** 触发前完整请求（系统提示词 + 工具声明 + provider history）的本地估算。 */
    estimatedTokensBefore: number;
    /** 当前渠道配置解析出的自动总结软阈值。 */
    thresholdTokens: number;
    /** 模型元数据明确声明时的输入硬上限；未知时不填写。 */
    hardLimitTokens?: number;
    /** 触发前最近一次普通模型请求由 provider 实报的 prompt token。 */
    previousProviderPromptTokens?: number;

    /** 压缩后完整请求的本地估算。 */
    estimatedTokensAfter?: number;
    /** 压缩后第一次普通模型请求由 provider 实报的 prompt token。 */
    providerPromptTokensAfter?: number;
    /** 总结模型请求由 provider 实报的 prompt token。 */
    summaryRequestTokens?: number;
    /** 总结模型输出由 provider 实报或本地估算的 token。 */
    summaryOutputTokens?: number;

    /** 本次新纳入总结/硬裁剪的 provider history 消息数。 */
    summarizedMessageCount?: number;
    /** 压缩后 provider history 的消息数。 */
    retainedMessageCount?: number;

    /** Monitor transcript 中被总结原文的半开区间 [sourceStartIndex, sourceEndIndex)。 */
    sourceStartIndex?: number;
    sourceEndIndex?: number;
    /** Monitor 在此消息前显示当前 provider 上下文的截断标记。 */
    boundaryContentIndex?: number;

    errorCode?: string;
    errorMessage?: string;
}
