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

import type { UsageIndex, UsageIndexFreshness, UsageIndexStore } from './usageStats';
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

    async remove(conversationId: string): Promise<void> {
        try {
            await this.vscode.workspace.fs.delete(this.usagePath(conversationId));
        } catch {
            // 索引不存在时忽略（与对话删除语义一致）
        }
    }
}
