import type { BranchRetentionConfig, ConversationBranchGraph } from './types';

/** 分支服务依赖存储能力，旧扩展的文件系统实现不属于平台运行时。 */
export interface BranchGraphReadResult {
    graph: ConversationBranchGraph | null;
    errorCode?: 'BRANCH_STORAGE_CORRUPT';
    errorMessage?: string;
}

export interface BranchStorage {
    getBranchesFilePath(conversationId: string): string;
    listConversationIds(): Promise<string[]>;
    loadBranchRetentionConfig(): Promise<{ retentionDays?: number }>;
    saveBranchRetentionConfig(config: BranchRetentionConfig): Promise<void>;
    load(conversationId: string): Promise<BranchGraphReadResult>;
    save(conversationId: string, graph: ConversationBranchGraph): Promise<void>;
    backup(conversationId: string, reason?: string): Promise<string | null>;
    deleteConversation(conversationId: string): Promise<void>;
}
