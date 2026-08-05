/**
 * 用量索引的文件系统实现（FileUsageIndexStore）
 *
 * 存储位置：{baseDir}/conversations/{conversationId}.usage.json
 *（与 legacy 历史 {conversationId}.json、元数据 {conversationId}.meta.json 同级）
 *
 * 并发模型（HIS-08 高项修复）：
 * - 所有写路径（appendUsage / appendUsageMessages / write / remove）按 conversationId
 *   进入 per-conversation 串行队列，read-modify-write 整体原子化，防止：
 *   1. 并行子代理归集互相覆盖（ToolExecutionService 并行执行多个 subagent，
 *      各自 reportUsageToMainConversation → appendUsageMessages，同一 usage.json 同时读改写）；
 *   2. 主会话 updateUsageIndex / updateUsageIndexAppend 与子代理归集并发互相覆盖；
 *   3. 统计侧重建（usageStats 读历史→写回）与子代理归集并发互相覆盖。
 * - 全量重建写回（write）在队列内重新读取当前落盘索引，合并其中尚未包含的
 *   subagent 条目（按条目键去重）：即使调用方在队列外读到的旧索引已过期，
 *   期间到达的子代理归集也不会被重建覆盖丢失。
 * - read 不排队：统计侧读索引/判新鲜度允许看到写前旧状态（mtime 机制兜底），
 *   队列内操作复用同一 read，不会死锁。
 *
 * 写入原子性：先写同目录临时文件 {id}.usage.json.tmp，再 rename 覆盖（与 meta.json
 * 保存模式一致）。崩溃/被杀进程时线上文件要么是完整旧版要么是完整新版，不会截断；
 * read 只读线上路径，临时文件不可见；写入失败时清理 tmp 并向上抛（调用方静默降级）。
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
import { assertSafeStorageId, withHangTimeout } from './storage';
import type { ConversationBranchGraph } from './branch/types';
import { isBranchGraphShape } from './branch/types';

/**
 * 用量索引条目的去重键（用于重建写回时合并并发到达的 subagent 条目）。
 *
 * subagent 条目由 executor 归集生成：timestamp + modelVersion + 各 token 字段完全相同
 * 即视为同一条（同一毫秒内产生完全一致 token 计数的概率可忽略，误合并风险低于
 * 重复计数的代价）。
 */
function usageMessageKey(m: UsageIndexMessage): string {
    return JSON.stringify([
        m.source ?? 'main',
        m.timestamp ?? 0,
        m.modelVersion ?? '',
        m.prompt,
        m.candidates,
        m.thoughts,
        m.cacheCreation,
        m.cacheRead
    ]);
}

export class FileUsageIndexStore implements UsageIndexStore {
    /** per-conversation 写串行队列（只存 settled 尾链，任务完成后自清理） */
    private writeQueues = new Map<string, Promise<unknown>>();

    /** 用量索引写任务挂起超时（R2 1.2）：任务长时间不结束视为挂起，超时后按失败处理、队列继续前进 */
    private static readonly USAGE_INDEX_WRITE_HANG_TIMEOUT_MS = 60000;

    constructor(
        private vscode: any, // VS Code API（duck-typed，便于测试注入 fake）
        private baseDir: string // 数据存储目录 URI 字符串（与 FileSystemStorageAdapter 同源）
    ) {}

    private usagePath(conversationId: string): any {
        assertSafeStorageId(conversationId, 'conversation id');
        return this.vscode.Uri.joinPath(
            this.vscode.Uri.parse(this.baseDir),
            'conversations',
            `${conversationId}.usage.json`
        );
    }

    private usageTmpPath(conversationId: string): any {
        assertSafeStorageId(conversationId, 'conversation id');
        return this.vscode.Uri.joinPath(
            this.vscode.Uri.parse(this.baseDir),
            'conversations',
            `${conversationId}.usage.json.tmp`
        );
    }

    private legacyHistoryPath(conversationId: string): any {
        assertSafeStorageId(conversationId, 'conversation id');
        return this.vscode.Uri.joinPath(
            this.vscode.Uri.parse(this.baseDir),
            'conversations',
            `${conversationId}.json`
        );
    }

    private segmentedIndexPath(conversationId: string): any {
        assertSafeStorageId(conversationId, 'conversation id');
        return this.vscode.Uri.joinPath(
            this.vscode.Uri.parse(this.baseDir),
            'conversations',
            conversationId,
            'history.index.json'
        );
    }

    /** 分支图 sidecar 路径（TREE-08 读取侧合并用；与 BranchGraphRepository 同布局） */
    private branchesPath(conversationId: string): any {
        assertSafeStorageId(conversationId, 'conversation id');
        return this.vscode.Uri.joinPath(
            this.vscode.Uri.parse(this.baseDir),
            'conversations',
            conversationId,
            'branches.json'
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

    /**
     * 读取分支图 sidecar（TREE-08：用量统计读取侧合并非活跃候选消耗）。
     *
     * - 文件不存在 → null（线性模式，无分支消耗可合并）；
     * - JSON 解析失败 / 结构不符（version < 1 或 nodes 非对象）→ null（损坏降级，
     *   与 BranchGraphRepository.load 的降级语义一致：统计按主历史，不因分支图损坏阻塞）；
     *   R8b-L3：表层 shape 校验复用 branch/types.ts 的共享实现 isBranchGraphShape
     *   （与 BranchGraphRepository.load 同一判定，消除双实现）；
     * - 语义损坏（环 / 悬空指针等）由 usageStats.extractBranchUsageMessages 在合并时兜底
     *   （活跃路径解析失败即放弃合并）。
     * 只读，不进入会话写队列。
     */
    async readBranchGraph(conversationId: string): Promise<ConversationBranchGraph | null> {
        try {
            const content = await this.vscode.workspace.fs.readFile(this.branchesPath(conversationId));
            const text = Buffer.from(content).toString('utf8');
            const parsed = JSON.parse(text);
            if (!isBranchGraphShape(parsed)) {
                return null;
            }
            return parsed as ConversationBranchGraph;
        } catch {
            return null;
        }
    }

    /**
     * 把写操作串行化到该会话的队列尾；返回与队列中该操作对应的 Promise。
     * 前一个操作失败不影响后续操作执行（previous.then(task, task) 两个分支都跑 task）。
     * 挂起超时（R2 1.2）：复用 storage.ts 的 withHangTimeout 模式，任务超过 60s 未结束
     * 视为挂起，按失败处理并让链继续前进（防止卡死的 fs 调用永久阻塞该会话后续写入）。
     */
    private enqueueWrite<T>(conversationId: string, task: () => Promise<T>): Promise<T> {
        const previous = this.writeQueues.get(conversationId) ?? Promise.resolve();
        const run = () => withHangTimeout(
            task(),
            `usageIndexWrite(${conversationId})`,
            FileUsageIndexStore.USAGE_INDEX_WRITE_HANG_TIMEOUT_MS
        );
        const current = previous.then(run, run);
        const tail = current.then(() => undefined, () => undefined);
        this.writeQueues.set(conversationId, tail);
        void tail.then(() => {
            if (this.writeQueues.get(conversationId) === tail) {
                this.writeQueues.delete(conversationId);
            }
        });
        return current;
    }

    /** 全量重建写回（走会话级串行队列，与 appendUsage* / remove 互斥） */
    async write(conversationId: string, index: UsageIndex): Promise<void> {
        await this.enqueueWrite(conversationId, () => this.writeLocked(conversationId, index));
    }

    /**
     * 队列内全量重建（R2 1.1）：把「读当前盘面索引 → build(previous) → 合并盘面 subagent
     * 条目 → 原子落盘」整体放入会话级串行队列执行，返回落盘后的索引。
     *
     * 背景：调用方（ConversationManager.updateUsageIndex / usageStats 重建）此前在队列外
     * 读历史/读旧索引后构造全量重建再 write，期间并发到达的 main 条目（appendUsage）或
     * subagent 条目（appendUsageMessages）会被重建静默覆盖丢失。本方法把调用方的读旧索引
     * 移入队列内（build 回调收到的是队列内最新盘面），并让 build 基于最新数据构造；
     * 写回前再做一次 subagent 按键去重合并兜底，保证并发落盘的 main/subagent 条目不丢。
     */
    async rebuild(conversationId: string, build: (previous: UsageIndex | null) => Promise<UsageIndex> | UsageIndex): Promise<UsageIndex> {
        return await this.enqueueWrite(conversationId, async () => {
            const previous = await this.read(conversationId);
            let next = await build(previous);
            // 队列内兜底合并：build 未合并的盘面 subagent 条目按条目键去重补回（正常路径无额外条目）
            next = await this.mergeSubagentEntries(conversationId, next);
            await this.writeFileAtomic(conversationId, next);
            return next;
        });
    }

    /** 队列内执行：合并并发到达的 subagent 条目后原子落盘（见类注释并发模型） */
    private async writeLocked(conversationId: string, index: UsageIndex): Promise<void> {
        const merged = await this.mergeSubagentEntries(conversationId, index);
        await this.writeFileAtomic(conversationId, merged);
    }

    /**
     * 把当前落盘索引中尚未包含的 subagent 条目合并进待写索引。
     *
     * 调用方（ConversationManager.updateUsageIndex / usageStats 重建）在队列外
     * read 旧索引做 subagent 合并，若期间有子代理归集写入，其读到的旧索引已过期；
     * 这里在队列内重新读当前盘面，按条目键去重后补回，保证重建不丢并发归集条目。
     */
    private async mergeSubagentEntries(conversationId: string, incoming: UsageIndex): Promise<UsageIndex> {
        const current = await this.read(conversationId);
        if (!current || !Array.isArray(current.messages)) {
            return incoming;
        }
        const subagent = current.messages.filter(m => m.source === 'subagent');
        if (subagent.length === 0) {
            return incoming;
        }
        const keys = new Set(incoming.messages.map(usageMessageKey));
        const missing = subagent.filter(m => !keys.has(usageMessageKey(m)));
        if (missing.length === 0) {
            return incoming;
        }
        return {
            ...incoming,
            messages: [...incoming.messages, ...missing],
            updatedAt: Date.now()
        };
    }

    /** tmp + rename 原子提交（与 meta.json 保存模式一致）；失败时清理 tmp 并向上抛 */
    private async writeFileAtomic(conversationId: string, index: UsageIndex): Promise<void> {
        const tmpUri = this.usageTmpPath(conversationId);
        const content = Buffer.from(JSON.stringify(index), 'utf8');
        try {
            await this.vscode.workspace.fs.writeFile(tmpUri, content);
            await this.renameOverwrite(tmpUri, this.usagePath(conversationId));
        } catch (error) {
            // 写入失败：清理临时文件，不留垃圾；原 usage.json 保持完好（rename 未发生）
            try {
                await this.vscode.workspace.fs.delete(tmpUri);
            } catch {
                // 忽略清理失败
            }
            throw error;
        }
    }

    /** 原子覆盖：优先 overwrite rename（无窗口）；平台不支持时回退“删旧 + rename”（写写已由队列串行化） */
    private async renameOverwrite(src: any, dest: any): Promise<void> {
        try {
            await this.vscode.workspace.fs.rename(src, dest, { overwrite: true });
        } catch {
            try {
                await this.vscode.workspace.fs.delete(dest);
            } catch {
                // 目标不存在，忽略
            }
            await this.vscode.workspace.fs.rename(src, dest, { overwrite: true });
        }
    }

    /**
     * 增量维护用量索引（HIS-08）：普通追加助手消息时只增加对应条目，不重建整个索引。
     *
     * - 索引缺失/损坏：返回 false，调用方回退全量重建（freshness 机制保留为兜底）；
     * - 仅追加 user/functionResponse 消息（无 token 条目）：不写盘，直接返回 true；
     * - 追加 model 消息：读索引 → 追加条目 → 整体写回（单文件，规模与消息数线性）。
     *
     * 删除/编辑/回档/分支切换等结构性变更仍走全量重建（ConversationManager.updateUsageIndex），
     * 本方法只服务“普通追加”路径。读写整体在会话级串行队列内执行。
     */
    async appendUsage(conversationId: string, appended: Content[]): Promise<boolean> {
        return this.enqueueWrite(conversationId, () => this.appendUsageLocked(conversationId, appended));
    }

    private async appendUsageLocked(conversationId: string, appended: Content[]): Promise<boolean> {
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
            const entry: UsageIndexMessage = {
                timestamp: (typeof ts === 'number' && Number.isFinite(ts) && ts > 0) ? ts : undefined,
                modelVersion: (message.modelVersion || '').trim(),
                ...tokens
            };
            // TREE-08：主历史条目记录稳定 id，供分支合并去重（旧消息无 id 时省略）
            if (typeof message.id === 'string' && message.id.length > 0) {
                entry.id = message.id;
            }
            added.push(entry);
        }

        if (added.length === 0) {
            // 没有需要更新的用量条目（仅追加 user/functionResponse 消息）：不重复写盘
            return true;
        }

        existing.messages.push(...added);
        existing.updatedAt = Date.now();
        await this.writeFileAtomic(conversationId, existing);
        return true;
    }

    /**
     * 追加已提取好的用量索引条目（子代理归集用，不入对话历史）。
     *
     * 与 appendUsage 的区别：输入已是 UsageIndexMessage（通常带 source='subagent'），
     * 不做 Content 提取，原样追加；索引缺失/损坏时返回 false，调用方回退读改写。
     * 读写整体在会话级串行队列内执行（并行子代理归集不再互相覆盖）。
     */
    async appendUsageMessages(conversationId: string, messages: UsageIndexMessage[]): Promise<boolean> {
        return this.enqueueWrite(conversationId, () => this.appendUsageMessagesLocked(conversationId, messages));
    }

    private async appendUsageMessagesLocked(conversationId: string, messages: UsageIndexMessage[]): Promise<boolean> {
        if (messages.length === 0) {
            return true;
        }
        const existing = await this.read(conversationId);
        if (!existing) {
            return false;
        }
        existing.messages.push(...messages);
        existing.updatedAt = Date.now();
        await this.writeFileAtomic(conversationId, existing);
        return true;
    }

    /** 删除索引（走同一串行队列，避免与在途追加交错） */
    async remove(conversationId: string): Promise<void> {
        await this.enqueueWrite(conversationId, async () => {
            try {
                await this.vscode.workspace.fs.delete(this.usagePath(conversationId));
            } catch {
                // 索引不存在时忽略（与对话删除语义一致）
            }
        });
    }
}
