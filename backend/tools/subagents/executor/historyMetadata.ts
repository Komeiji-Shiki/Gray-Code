import type { Content } from '../../../modules/conversation/types';

const METADATA_KEY = '__graycodeSubAgentHistory';

export interface SubAgentSummaryCoverage {
    sourceStartIndex: number;
    sourceEndIndex: number;
    summarizedMessageCount: number;
}

export interface SubAgentHistoryMetadata {
    transcriptIndex?: number;
    summaryCoverage?: SubAgentSummaryCoverage;
}

export type TrackedSubAgentContent = Content & {
    [METADATA_KEY]?: SubAgentHistoryMetadata;
};

export function getSubAgentHistoryMetadata(content: Content | undefined): SubAgentHistoryMetadata | undefined {
    if (!content || typeof content !== 'object') return undefined;
    const metadata = (content as TrackedSubAgentContent)[METADATA_KEY];
    return metadata && typeof metadata === 'object' ? metadata : undefined;
}

export function getSubAgentTranscriptIndex(content: Content | undefined): number | undefined {
    const value = getSubAgentHistoryMetadata(content)?.transcriptIndex;
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

export function getSubAgentSummaryCoverage(content: Content | undefined): SubAgentSummaryCoverage | undefined {
    const coverage = getSubAgentHistoryMetadata(content)?.summaryCoverage;
    if (!coverage) return undefined;
    if (!Number.isInteger(coverage.sourceStartIndex) || coverage.sourceStartIndex < 0) return undefined;
    if (!Number.isInteger(coverage.sourceEndIndex) || coverage.sourceEndIndex <= coverage.sourceStartIndex) return undefined;
    return coverage;
}

export function withSubAgentTranscriptIndex(content: Content, transcriptIndex: number | undefined): Content {
    if (typeof transcriptIndex !== 'number' || !Number.isInteger(transcriptIndex) || transcriptIndex < 0) {
        return content;
    }
    const current = getSubAgentHistoryMetadata(content);
    return {
        ...content,
        [METADATA_KEY]: {
            ...current,
            transcriptIndex
        }
    } as TrackedSubAgentContent;
}

export function withSubAgentSummaryCoverage(content: Content, coverage: SubAgentSummaryCoverage | undefined): Content {
    if (!coverage) return content;
    const current = getSubAgentHistoryMetadata(content);
    return {
        ...content,
        [METADATA_KEY]: {
            ...current,
            summaryCoverage: coverage
        }
    } as TrackedSubAgentContent;
}

/**
 * 恢复旧 provider history 时，把 transcript 自身的全局 index 升级为内部映射元数据。
 */
export function ensureSubAgentTranscriptTracking(content: Content): Content {
    if (getSubAgentTranscriptIndex(content) !== undefined) return content;
    return withSubAgentTranscriptIndex(content, typeof content.index === 'number' ? content.index : undefined);
}
