import type { Content } from '../../../conversation/types';

export type SubAgentSummaryFailureCode =
    | 'EMPTY_HISTORY'
    | 'CONFIG_NOT_FOUND'
    | 'CONFIG_DISABLED'
    | 'NO_FIT_RANGE'
    | 'CONTEXT_OVERFLOW'
    | 'LOW_QUALITY_SUMMARY'
    | 'ABORTED'
    | 'GENERATION_FAILED';

export interface SubAgentSummaryGenerationSuccess {
    success: true;
    summary: Content;
    /** 输入候选前缀中真正被总结模型消费的消息数。 */
    consumedMessageCount: number;
    sourceTokenCount: number;
    summaryTokenCount: number;
    summaryRequestPromptTokens?: number;
    summaryRequestOutputTokens?: number;
}

export interface SubAgentSummaryGenerationFailure {
    success: false;
    code: SubAgentSummaryFailureCode;
    message: string;
}

export type SubAgentSummaryGenerationResult =
    | SubAgentSummaryGenerationSuccess
    | SubAgentSummaryGenerationFailure;
