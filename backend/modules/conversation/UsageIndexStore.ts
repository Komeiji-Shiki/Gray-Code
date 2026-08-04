/**
 * 用量索引的文件系统实现（FileUsageIndexStore）
 *
 * 存储位置：{baseDir}/conversations/{conversationId}.usage.json
 *（与 legacy 历史 {conversationId}.json、元数据 {conversationId}.meta.json 同级）
 *
 * 新鲜度判定：对比历史入口与索引文件的 mtime。
 * - 历史入口取 legacy 单文件 {id}.json 与 segmented {id}/history.index.json 中
 *   mtime 较大者（写入分段历史时 index.json 会同步更新）；
 * - 历史 mtime 新于索引 mtime ⇒ stale（消息被编辑/删除/回滚/导入等任何写路径都会
 *   留下历史 mtime 更新，无需逐一追踪写入口）；
 * - 索引缺失 ⇒ missing。
 *
 * 写入失败不向上抛（调用方静默降级），统计侧会按 stale/missing 重建兜底。
 */

import type { Content } from './types';
import type { UsageIndex, UsageIndexFreshness, UsageIndexMessage, UsageIndexStore } from './usageStats';
import { extractMessageTokens } from './usageStats';
import { assertSafeId } from '../../core/idValidation';

export class FileUsageIndexStore implements UsageIndexStore {
    constructor(
        private vscode: any, // VS Code API（duck-typed，便于测试注入 fake）
        private baseDir: string // 数据存储目录 URI 字符串（与 FileSystemStorageAdapter 同源）
    ) {}

    private usagePath(conversationId: string): any {
        assertSafeId(conversationId, 'conversationId');
        return this.vscode.Uri.joinPath(
            this.vscode.Uri.parse(this.baseDir),
            'conversations',
            `${conversationId}.usage.json`
        );
    }

    private legacyHistoryPath(conversationId: string): any {
        assertSafeId(conversationId, 'conversationId');
        return this.vscode.Uri.joinPath(
            this.vscode.Uri.parse(this.baseDir),
            'conversations',
            `${conversationId}.json`
        );
    }

    private segmentedIndexPath(conversationId: string): any {
        assertSafeId(conversationId, 'conversationId');
        return this.vscode.Uri.joinPath(
            this.vscode.Uri.parse(this.baseDir),
            'conversations',
            conversationId,
            'history.index.json'
        );
    }

    private async statMtime(uri: any): Promise<number | null> {
        try {
            const stat = await this.vscode.workspace.fs.stat(uri);
            return typeof stat?.mtime === 'number' ? stat.mtime : null;
        } catch {
            return null;
        }
    }

    /** 历史入口（legacy 或 segmented index）中较新的 mtime；都不存在返回 null */
    private async getHistoryMtime(conversationId: string): Promise<number | null> {
        const [legacy, segmented] = await Promise.all([
            this.statMtime(this.legacyHistoryPath(conversationId)),
            this.statMtime(this.segmentedIndexPath(conversationId))
        ]);
        const max = Math.max(legacy ?? 0, segmented ?? 0);
        return max > 0 ? max : null;
    }

    async getFreshness(conversationId: string): Promise<UsageIndexFreshness> {
        const [historyMtime, indexMtime] = await Promise.all([
            this.getHistoryMtime(conversationId),
            this.statMtime(this.usagePath(conversationId))
        ]);
        if (indexMtime === null) return 'missing';
        if (historyMtime === null) return 'stale'; // 历史缺失但索引残留（异常态，重建会走 skipped）
        return historyMtime > indexMtime ? 'stale' : 'fresh';
    }

    async read(conversationId: string): Promise<UsageIndex | null> {
        try {
            const content = await this.vscode.workspace.fs.readFile(this.usagePath(conversationId));
            const text = Buffer.from(content).toString('utf8');
            const parsed = JSON.parse(text);
            if (parsed?.version !== 1 || !Array.isArray(parsed?.messages)) {
                return null;
            }
            return parsed as UsageIndex;
        } catch {
            return null;
        }
    }

    async write(conversationId: string, index: UsageIndex): Promise<void> {
        await this.vscode.workspace.fs.writeFile(
            this.usagePath(conversationId),
            Buffer.from(JSON.stringify(index), 'utf8')
        );
    }

    /**
     * 增量维护用量索引（HIS-08）：普通追加助手消息时只增加对应条目，不重建整个索引。
     *
     * - 索引缺失/损坏：返回 false，调用方回退全量重建（freshness 机制保留为兜底）；
     * - 仅追加 user/functionResponse 消息（无 token 条目）：不写盘，直接返回 true；
     * - 追加 model 消息：读索引 → 追加条目 → 整体写回（单文件，规模与消息数线性）。
     *
     * 删除/编辑/回档/分支切换等结构性变更仍走全量重建（ConversationManager.updateUsageIndex），
     * 本方法只服务“普通追加”路径。
     */
    async appendUsage(conversationId: string, appended: Content[]): Promise<boolean> {
        const existing = await this.read(conversationId);
        if (!existing) {
            // 索引缺失或损坏：调用方回退全量重建
            return false;
        }

        const added: UsageIndexMessage[] = [];
        for (const message of appended) {
            if (message.role !== 'model') continue;
            const tokens = extractMessageTokens(message);
            if (!tokens) continue;
            const ts = message.timestamp;
            added.push({
                timestamp: (typeof ts === 'number' && Number.isFinite(ts) && ts > 0) ? ts : undefined,
                modelVersion: (message.modelVersion || '').trim(),
                ...tokens
            });
        }

        if (added.length === 0) {
            // 没有需要更新的用量条目（仅追加 user/functionResponse 消息）：不重复写盘
            return true;
        }

        existing.messages.push(...added);
        existing.updatedAt = Date.now();
        await this.write(conversationId, existing);
        return true;
    }

    /**
     * 追加已提取好的用量索引条目（子代理归集用，不入对话历史）。
     *
     * 与 appendUsage 的区别：输入已是 UsageIndexMessage（通常带 source='subagent'），
     * 不做 Content 提取，原样追加；索引缺失/损坏时返回 false，调用方回退读改写。
     */
    async appendUsageMessages(conversationId: string, messages: UsageIndexMessage[]): Promise<boolean> {
        if (messages.length === 0) {
            return true;
        }
        const existing = await this.read(conversationId);
        if (!existing) {
            return false;
        }
        existing.messages.push(...messages);
        existing.updatedAt = Date.now();
        await this.write(conversationId, existing);
        return true;
    }

    async remove(conversationId: string): Promise<void> {
        try {
            await this.vscode.workspace.fs.delete(this.usagePath(conversationId));
        } catch {
            // 索引不存在时忽略（与对话删除语义一致）
        }
    }
}
