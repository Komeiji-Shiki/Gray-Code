import type { Content, ConversationHistory } from '../types';
import type { IStorageAdapter } from '../storage';
import { ConversationTranscriptRepository, type ITranscriptRepository } from '../TranscriptRepository';
import { buildConversationUsageIndex, type UsageIndexMessage, type UsageIndexStore } from '../usageStats';
import { getGlobalBranchService } from '../branch/BranchService';
import { isActiveEmptyPlaceholder } from '../branch/BranchGraph';
import { Logger } from '../../../core/logger';

import { ensureNodeId } from './nodeId';

const log = Logger.get('ConversationManager');

interface ConversationPersistenceServiceContext {
    storage: IStorageAdapter;
    usageIndexStore?: UsageIndexStore;
    loadHistory(conversationId: string, workspaceUri?: string): Promise<ConversationHistory>;
    assertNotDeleted(conversationId: string): void;
    invalidateCaches(conversationId: string): void;
    readTailContent(conversationId: string): Promise<Content | null>;
    withGraphSyncQueue(conversationId: string, task: () => Promise<void>): Promise<void>;
    withConversationWriteLock<T>(conversationId: string, task: () => Promise<T>): Promise<T>;
}

export class ConversationPersistenceService {
    constructor(private readonly ctx: ConversationPersistenceServiceContext) {}

    getTranscriptRepository(conversationId: string, workspaceUri?: string): ITranscriptRepository {
        // 修改原因：主聊天 transcript 需要一个统一的仓储入口，供当前适配和后续协作者复用。
        // 修改方式：把 ConversationManager 既有的“缺失历史时自动建会话”读取语义，与底层 saveHistory 持久化语义一起绑定到仓储委托。
        // 修改目的：外部协作者不再直接接触 storage.loadHistory/saveHistory，也不会复制主聊天特有的初始化规则。
        return new ConversationTranscriptRepository(
            {
                loadContents: async () => await this.ctx.loadHistory(conversationId, workspaceUri),
                saveContents: async (contents) => {
                    this.ctx.assertNotDeleted(conversationId);
                    await this.ctx.storage.saveHistory(conversationId, contents);
                    // 存储层 saveHistory 会刷新 updatedAt：失效元数据缓存，否则对话列表排序读到陈旧时间戳；
                    // 结构性变更（删除/插入/拒绝工具调用等）替换了历史内容，节点 ID 反查缓存一并失效
                    // （BCP-01：nodeIdCache 存的是旧数组引用，不失效会在 300ms TTL 窗口内返回陈旧节点 id）
                    this.ctx.invalidateCaches(conversationId);
                    await this.updateUsageIndex(conversationId, contents);
                    // PERF：返回落盘形态。存储适配器（FileSystem/Memory/VSCode）对消息内容只做
                    // JSON 往返序列化，不补 timestamp/index 等字段（与 append 委托不同），
                    // 传入数组即真实落盘形态；仓储 saveAndReload 据此跳过“写后全量回读 + 深拷贝”，
                    // 把每次结构性变更（删除/插入/拒绝工具调用等）从 读→写→读 3 次全量 IO 降为 读→写 2 次。
                    return contents;
                },
                // HIS-01/HIS-02：普通追加直通 append-only 尾段写入（不再读全量→push→全量写回）
                // BR-01：委托调用发生在仓储互斥执行器（会话写锁）内，在这里读取尾消息 id、
                //       为追加内容补齐稳定 id + 线性 parentId（同一批内依次链接），
                //       保证并发追加时 parentId 也指向真实的上一消息。
                appendContents: async (contents) => {
                    this.ctx.assertNotDeleted(conversationId);
                    const tail = await this.ctx.readTailContent(conversationId);
                    let previous = tail;
                    const withNodeIds = contents.map((content) => {
                        const next = ensureNodeId(content, previous);
                        previous = next;
                        return next;
                    });
                    if (this.ctx.storage.appendHistory) {
                        await this.ctx.storage.appendHistory(conversationId, withNodeIds);
                    } else {
                        // 无 append-only 存储（测试 fake 等）：回退全量读改写，语义不变
                        const history = await this.ctx.loadHistory(conversationId);
                        history.push(...withNodeIds);
                        await this.ctx.storage.saveHistory(conversationId, history);
                    }
                    // append-only/回退都会刷新 updatedAt：失效元数据缓存，避免对话列表排序读到陈旧时间戳；
                    // 追加后历史尾部变化，节点 ID 反查缓存一并失效（BCP-01）
                    this.ctx.invalidateCaches(conversationId);
                    await this.updateUsageIndexAppend(conversationId, withNodeIds);

                    // TREE-05：主历史追加成功后，把新消息增量并入分支图。
                    // 仅当会话已有分支图、且图活跃尾不是「空占位候选」时执行——reroll/编辑分支的
                    // 流式窗口期活跃尾是空占位节点（内容由 finishReroll 回填），此时跳过，
                    // 避免与 finishReroll 的重命名/回填冲突（重复节点 id）；正常继续对话
                    // （活跃尾有内容，如候选已生成完毕）才增量并入，实现「切回候选后继续对话不破坏图」。
                    // appendHistoryToGraph 内部自行取会话写锁（BR-07），而此处已处于写锁内（不可重入），
                    // 因此不能 await——通过 promise 链排在当前写锁任务之后串行执行；失败仅告警，
                    // 不阻断主流程（主历史为唯一真源，图同步失败由下次读图/写图的自校验兜底）。
                    if (withNodeIds.length > 0) {
                        const branchService = getGlobalBranchService();
                        if (branchService) {
                            // 图同步任务进会话级串行队列：两次快速连续 append 的同步不得并发
                            // （并发会读到同一份旧图、后发起的可能先拿锁，图活跃路径顺序与主历史相反）。
                            void this.ctx
                                .withGraphSyncQueue(conversationId, async () => {
                                    try {
                                        const loaded = await branchService.getBranchGraph(conversationId);
                                        const graph = loaded.graph;
                                        if (!graph) {
                                            return; // 线性对话未建图：不强制建
                                        }
                                        const tail = graph.activeTailNodeId ? graph.nodes[graph.activeTailNodeId] : undefined;
                                        if (isActiveEmptyPlaceholder(tail)) {
                                            return; // 流式占位候选：跳过，由 finishReroll 回填
                                        }
                                        if (tail && (tail.parts?.length ?? 0) === 0 && (tail.kind === 'reroll' || tail.kind === 'edit')) {
                                            // 超龄空占位（进程崩溃/被杀遗留，isActiveEmptyPlaceholder 判定为已死亡）：
                                            // 先以主历史收敛图（占位移出活跃路径），再增量并入新消息。
                                            // 不收敛直接 append 会把新消息挂到死占位下，冻结依旧。
                                            await branchService.syncMainHistoryAfterStructuralMutation(conversationId, 'branch_finished');
                                        }
                                        await branchService.appendHistoryToGraph(conversationId, withNodeIds);
                                    } catch (error) {
                                        log.warn('branch_append_sync_failed', {
                                            conversationId,
                                            error: (error as Error)?.message ?? String(error),
                                        });
                                    }
                                })
                                .catch((error: unknown) => {
                                    // withGraphSyncQueue 的挂起超时（withHangTimeout）会让返回的 current 在
                                    // 60s 后 reject；fire-and-forget 任务必须挂 rejection 处理，否则成为
                                    // unhandled rejection。任务体本身的失败已在上方 catch 记录，这里只兜超时。
                                    log.warn('branch_append_sync_hang_timeout', {
                                        conversationId,
                                        error: (error as Error)?.message ?? String(error),
                                    });
                                });
                        }
                    }
                },
            },
            (fn) => this.ctx.withConversationWriteLock(conversationId, fn),
        );
    }

    /**
     * 对话落盘后同步维护用量索引（消息级 token 明细，供统计页免全量扫描）。
     *
     * 失败静默降级：索引写失败不影响对话保存主流程，统计侧会按 mtime 判定
     * stale/missing 并重建兜底。空历史不写索引（createConversation 的初始化落盘）。
     */
    async updateUsageIndex(conversationId: string, history: ConversationHistory): Promise<void> {
        if (!this.ctx.usageIndexStore || history.length === 0) return;
        try {
            if (typeof this.ctx.usageIndexStore.rebuild === 'function') {
                // R2 1.1：把「读旧索引 + 重建 + 合并 subagent + 写回」整体移入 store 会话级
                // 写队列。调用方此前在队列外读旧索引，期间并发到达的子代理归集条目会被重建
                // 覆盖；rebuild 回调收到的是队列内最新盘面，subagent 条目按需合并保留。
                // history 是本次刚落盘的最新历史（会话写锁内串行），main 条目直接由它重建。
                await this.ctx.usageIndexStore.rebuild(conversationId, (previous) => {
                    const rebuilt = buildConversationUsageIndex(conversationId, history);
                    if (previous && Array.isArray(previous.messages)) {
                        const subagentEntries = previous.messages.filter((m) => m.source === 'subagent');
                        if (subagentEntries.length > 0) {
                            rebuilt.messages.push(...subagentEntries);
                        }
                    }
                    return rebuilt;
                });
                return;
            }
            // 无 rebuild 的 store（内存实现等）：保留原有读改写兜底
            const rebuilt = buildConversationUsageIndex(conversationId, history);
            const previous = await this.ctx.usageIndexStore.read(conversationId);
            if (previous && Array.isArray(previous.messages)) {
                const subagentEntries = previous.messages.filter((m) => m.source === 'subagent');
                if (subagentEntries.length > 0) {
                    rebuilt.messages.push(...subagentEntries);
                }
            }
            await this.ctx.usageIndexStore.write(conversationId, rebuilt);
        } catch {
            // 静默降级：统计侧重建兜底
        }
    }

    /**
     * 增量维护用量索引（HIS-08）：普通追加助手消息只更新对应用量条目；
     * 仅追加 user/functionResponse 时不重复写盘。增量不可用（索引缺失/损坏）
     * 时回退全量重建；删除/编辑/回档/分支切换仍走全量重建（updateUsageIndex）。
     */
    async updateUsageIndexAppend(conversationId: string, appended: ConversationHistory): Promise<void> {
        if (!this.ctx.usageIndexStore) return;
        try {
            if (typeof this.ctx.usageIndexStore.appendUsage === 'function') {
                const ok = await this.ctx.usageIndexStore.appendUsage(conversationId, appended);
                if (ok) return;
            }
            // 增量不可用/失败 → 全量重建兜底（现有 freshness 机制保留为兜底）
            const history = await this.ctx.loadHistory(conversationId);
            await this.updateUsageIndex(conversationId, history);
        } catch {
            // 静默降级：统计侧按 mtime 判定 stale 并重建
        }
    }

    /**
     * 追加子代理用量索引条目（不入主对话历史，只更新用量索引）。
     *
     * 修改原因：子代理消耗的 token 需要归集到发起它的主会话用量统计，
     *          但子代理的运行明细（run transcript）不写主历史。
     * 修改方式：优先使用 UsageIndexStore.appendUsageMessages 增量追加；
     *          增量不可用（索引缺失/损坏）时回退读改写（不做全量重建，避免丢条目）；
     *          写失败静默降级，统计侧按 mtime 判定 stale/missing 重建兜底。
     */
    async appendUsageIndexMessages(conversationId: string, messages: UsageIndexMessage[]): Promise<void> {
        if (!this.ctx.usageIndexStore || messages.length === 0) return;
        try {
            if (typeof this.ctx.usageIndexStore.appendUsageMessages === 'function') {
                const ok = await this.ctx.usageIndexStore.appendUsageMessages(conversationId, messages);
                if (ok) return;
            }
            // 增量不可用/索引缺失：读改写追加，保留既有条目（含已存在的 subagent 条目）
            const existing = await this.ctx.usageIndexStore.read(conversationId);
            if (existing && Array.isArray(existing.messages)) {
                existing.messages.push(...messages);
                existing.updatedAt = Date.now();
                await this.ctx.usageIndexStore.write(conversationId, existing);
            }
        } catch {
            // 静默降级：统计侧重建兜底
        }
    }
}
