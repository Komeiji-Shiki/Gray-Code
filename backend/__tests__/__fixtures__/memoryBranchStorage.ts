import { randomUUID } from 'node:crypto';
import { invalidateBranchGraphCache } from '../../modules/conversation/branch/branchGraphCache';
import type { BranchGraphReadResult, BranchStorage } from '../../modules/conversation/branch/branchStorage';
import type { BranchRetentionConfig, ConversationBranchGraph } from '../../modules/conversation/branch/types';

/** 仅实现业务测试需要的存储端口，异常读取由用例注入，不复制旧文件格式。 */
export class MemoryBranchStorage implements BranchStorage {
    private readonly namespace = `memory:${randomUUID()}`;
    private readonly results = new Map<string, BranchGraphReadResult>();
    private retentionConfig: { retentionDays?: number } = {};
    readonly backups: Array<{
        path: string;
        conversationId: string;
        reason: string;
        graph: ConversationBranchGraph;
    }> = [];

    getBranchesFilePath(conversationId: string): string {
        // 缓存键包含实例身份，避免不同用例的同名会话共享快照。
        return `${this.namespace}/${conversationId}/branches.json`;
    }

    async listConversationIds(): Promise<string[]> {
        return [...this.results.keys()];
    }

    async loadBranchRetentionConfig(): Promise<{ retentionDays?: number }> {
        return { ...this.retentionConfig };
    }

    async saveBranchRetentionConfig(config: BranchRetentionConfig): Promise<void> {
        this.retentionConfig = { ...config };
    }

    async load(conversationId: string): Promise<BranchGraphReadResult> {
        return structuredClone(this.results.get(conversationId) ?? { graph: null });
    }

    async save(conversationId: string, graph: ConversationBranchGraph): Promise<void> {
        this.setReadResult(conversationId, { graph });
    }

    setReadResult(conversationId: string, result: BranchGraphReadResult): void {
        this.results.set(conversationId, structuredClone(result));
        invalidateBranchGraphCache(conversationId);
    }

    async exists(conversationId: string): Promise<boolean> {
        return this.results.has(conversationId);
    }

    async backup(conversationId: string, reason = 'backup'): Promise<string | null> {
        const graph = (await this.load(conversationId)).graph;
        if (!graph) return null;
        const backupPath = `${this.getBranchesFilePath(conversationId)}.backup-${reason}-${this.backups.length}`;
        this.backups.push({ path: backupPath, conversationId, reason, graph });
        return backupPath;
    }

    async deleteConversation(conversationId: string): Promise<void> {
        this.results.delete(conversationId);
        invalidateBranchGraphCache(conversationId);
    }
}
