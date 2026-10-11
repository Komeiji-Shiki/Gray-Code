/**
 * GrayCode - 对话历史管理器
 *
 * 核心职责:
 * - 管理 Gemini 格式的对话历史
 * - 提供类型安全的操作 API
 * - 维护对话元数据
 * - 支持持久化存储
 *
 * 存储格式:
 * - 历史: 完整的 Gemini Content[] 数组
 * - 元数据: 对话标题、创建时间等
 * - 快照: 历史的时间点副本
 */

import { t } from '../../i18n';
import {
    ConversationHistory,
    ConversationMetadata,
    Content,
    ContentPart,
    MessagePosition,
    MessageFilter,
    HistorySnapshot,
    ConversationStats,
    CONVERSATION_CONTEXT_TRIM_STATE_KEY
} from './types';
import type { ConversationStorageLocation, IStorageAdapter, SubAgentTranscriptData } from './storage';
import { withHangTimeout } from './storageWriteQueues';
import { isRealUserMessage } from './helpers';
import { ConversationTranscriptRepository, type ITranscriptRepository } from './TranscriptRepository';
import { deleteLogicalMessage, truncateFrom, repairFunctionCallPairsAfterDelete, repairParentChainAfterDelete, repairParentChainAfterInsert, restoreSummarizedRange } from './TranscriptMutation';
import { buildConversationUsageIndex, type UsageIndexMessage, type UsageIndexStore } from './usageStats';
import { getGlobalBranchService } from './branch/BranchService';
import { isActiveEmptyPlaceholder } from './branch/BranchGraph';
import { agentMailbox } from '../../core/services/agentMailbox';
import { Logger } from '../../core/logger';
import { ConversationQueryService } from './manager/query';
import { ConversationToolCallService } from './manager/toolCalls';
import { ConversationMetadataService } from './manager/metadata';
import { ConversationNodeIdService } from './manager/nodeIdService';
import { ConversationLifecycleService } from './manager/lifecycle';
import { rewriteHistoryFromBranchGraph as rewriteHistoryFromBranchGraphImpl, type BranchRewriteContext } from './manager/branchRewrite';
import { formatHistoryForAPI } from './manager/historyFormatting';
import { computeStatsFrom } from './manager/stats';
import { cloneJson } from './manager/metadataUtils';
import { ensureNodeId, needsNodeIdMigration } from './manager/nodeId';
import { shouldInvalidateContextManagementStateForUpdate } from './manager/utils';
import type { BranchHistoryRewriteResult, ConversationSummary, CreateBranchConversationResult, GetHistoryOptions } from './manager/types';

const log = Logger.get('ConversationManager');

/** 会话写锁任务挂起超时（与 usage 队列 60s / 分段历史 60s 对齐；元数据链 30s 更短因小文件） */
const CONVERSATION_WRITE_LOCK_HANG_TIMEOUT_MS = 60000;
/** 分支图同步队列任务挂起超时：图同步任务内部会再取会话写锁（顺序获取），阈值与会话写锁对齐 */
const GRAPH_SYNC_QUEUE_HANG_TIMEOUT_MS = 60000;
export type {
    MultimodalCapability,
    GetHistoryOptions,
    CreateBranchConversationResult,
    BranchHistoryRewriteResult,
    ConversationSummary
} from './manager/types';

export { deterministicNodeId } from './manager/nodeId';

/**
 * deleteToMessage 的乐观并发校验失败。
 *
 * 调用方可以在锁外做一次快速预检，但最终的 message id 校验必须与截断共用
 * TranscriptRepository.mutateContents 的会话写锁；否则预检后的 await 会留下索引漂移窗口。
 */
export class ConversationMessageChangedError extends Error {
    readonly code = 'MESSAGE_CHANGED' as const;

    constructor(
        readonly expectedMessageId: string,
        readonly actualMessageId: string | undefined
    ) {
        super(`Conversation message changed: expected ${expectedMessageId}, got ${actualMessageId ?? '<missing>'}`);
        this.name = 'ConversationMessageChangedError';
    }
}

/** deleteToMessage 在同一写锁快照中捕获的删除区间信息。 */
export interface DeleteToMessageCapture {
    deletedMessageIds: string[];
}




/**
 * 对话管理器
 *
 * 特点:
 * - 完整支持 Gemini 格式的所有特性
 * - 自动维护元数据
 * - 支持思考签名、函数调用等高级特性
 * - 可直接将历史发送给 Gemini API
 * - 元数据轻量读（getMetadataLight）带 LRU 内存缓存：所有写路径统一失效/回填，
 *   对话列表分页（每页 30 条）与用量统计/检查点查询的逐对话读取不再重复走磁盘
 */
export class ConversationManager {
    private readonly metadata: ConversationMetadataService;
    private readonly nodeIds: ConversationNodeIdService;
    private readonly lifecycle: ConversationLifecycleService;

    constructor(private storage: IStorageAdapter, private readonly usageIndexStore?: UsageIndexStore) {
        this.metadata = new ConversationMetadataService(storage);
        this.nodeIds = new ConversationNodeIdService({
            storage,
            withConversationWriteLock: (conversationId, task) => this.withConversationWriteLock(conversationId, task),
            assertNotDeleted: conversationId => this.lifecycle.assertNotDeleted(conversationId),
            invalidateCaches: conversationId => this.invalidateCaches(conversationId),
            updateUsageIndex: (conversationId, history) => this.updateUsageIndex(conversationId, history),
            loadHistory: conversationId => this.loadHistory(conversationId),
        });
        this.lifecycle = new ConversationLifecycleService({
            storage,
            usageIndexStore,
            metadata: this.metadata,
            nodeIds: this.nodeIds,
            withConversationWriteLock: (conversationId, task) => this.withConversationWriteLock(conversationId, task),
            withGraphSyncQueue: (conversationId, task) => this.withGraphSyncQueue(conversationId, task),
            loadHistory: conversationId => this.loadHistory(conversationId),
            updateUsageIndex: (conversationId, history) => this.updateUsageIndex(conversationId, history),
            invalidateCaches: conversationId => this.invalidateCaches(conversationId),
            getTranscriptRepository: conversationId => this.getTranscriptRepository(conversationId),
            getFirstMessageId: conversationId => this.getFirstMessageId(conversationId),
            invalidateContextManagementState: (conversationId, reason) => this.invalidateContextManagementState(conversationId, reason),
        });
        this.query = new ConversationQueryService({
            storage,
            loadHistory: (conversationId, workspaceUri, preloaded) => this.loadHistory(conversationId, workspaceUri, preloaded),
            isDeleted: conversationId => this.lifecycle.isDeleted(conversationId),
            ensureHistoryNodeIds: conversationId => this.ensureHistoryNodeIds(conversationId),
            mutateHistoryForDisplay: (conversationId, mutator, workspaceUri) => {
                const mutate = this.storage.mutateHistoryIfIdle?.bind(this.storage);
                if (!mutate) return this.getTranscriptRepository(conversationId, workspaceUri).mutateContents(mutator);
                return this.withConversationWriteLock(conversationId, async () => {
                    this.lifecycle.assertNotDeleted(conversationId);
                    const history = await mutate(conversationId, mutator);
                    this.invalidateCaches(conversationId);
                    await this.updateUsageIndex(conversationId, history);
                    return history;
                });
            },
        });
        this.toolCalls = new ConversationToolCallService(this);
    }

    /** 会话所有缓存统一失效（元数据/节点 ID 反查）；结构性变更后必须调用 */
    private invalidateCaches(conversationId: string): void {
        this.metadata.invalidateCache(conversationId);
        this.nodeIds.invalidateCache(conversationId);
    }

    /** 供测试/诊断清理元数据缓存 */
    clearMetadataCache(): void {
        this.metadata.clearCache();
        this.nodeIds.clearCache();
    }

    /**
     * 同一会话的 read-modify-write 串行队列（历史 mutate、自定义元数据等）。
     * 无内存缓存、直接文件读改写：并发时后写覆盖先写，真实执行成功的工具结果
     * 会被"用户拒绝"占位覆盖，或两个并发 checkpoint 元数据互相覆盖整个 custom 对象。
     */
    private readonly conversationWriteQueues = new Map<string, Promise<void>>();

    private async withConversationWriteLock<T>(conversationId: string, task: () => Promise<T>): Promise<T> {
        const previous = this.conversationWriteQueues.get(conversationId) ?? Promise.resolve();
        const start = previous.catch(() => undefined);
        // 队列链尾挂在底层任务（underlying）上：挂起超时（R5b-2.1）只让调用方 fail-fast，
        // 链不前进——超时后旧任务仍在读写同一会话的历史/元数据文件，新任务并发启动会
        // 互相覆盖（真实执行成功的工具结果被拒绝占位覆盖、checkpoint 元数据整体覆盖丢失）。
        // 挂起超时从任务真正启动时开始计时（排队等待时间不计入）。
        const underlying = start.then(() => task());
        const current = start.then(() =>
            withHangTimeout(underlying, `conversationWriteLock(${conversationId})`, CONVERSATION_WRITE_LOCK_HANG_TIMEOUT_MS)
        );
        const tail = underlying.then(() => undefined, () => undefined);
        this.conversationWriteQueues.set(conversationId, tail);
        void tail.then(() => {
            if (this.conversationWriteQueues.get(conversationId) === tail) {
                this.conversationWriteQueues.delete(conversationId);
            }
        });
        return current;
    }

    /**
     * 同一会话的分支图同步任务串行队列（BR-07 补充）。
     *
     * appendContents 每次追加后启动的「锁外读图 → 锁内 appendHistoryToGraph」异步同步
     * 若不串行：两次快速连续追加会产生两个并发 IIFE，都读到同一份旧图，后发起的可能
     * 先拿锁，图活跃路径顺序与主历史相反（rewriteHistoryFromBranchGraph 会用错误顺序
     * 重建主历史）。与 conversationWriteQueues 同模式：任务链式排队、先到先执行；
     * 单个任务失败仅告警（主历史为唯一真源），不阻断后续任务。
     */
    private readonly graphSyncQueues = new Map<string, Promise<void>>();

    private async withGraphSyncQueue(conversationId: string, task: () => Promise<void>): Promise<void> {
        const previous = this.graphSyncQueues.get(conversationId) ?? Promise.resolve();
        const start = previous.catch(() => undefined);
        // 队列链尾挂在底层任务（underlying）上（tail = underlying.then(...)，见下）：
        // 挂起超时仅使当前调用方 fail-fast（withHangTimeout 包装的是 current 而非 tail）——
        // 对真正永不 settle 的底层任务，链不前进、后续任务无限排队（有意取舍，与写锁
        // R5b-2.1 一致：超时后旧图同步任务仍在读写同一会话的 sidecar，让新任务跳过它
        // 并发启动会互相覆盖/挂错尾）；对慢而最终完成的健康任务，链正常前进、Map 条目
        // 正常回收。挂起超时从任务真正启动时开始计时（排队等待时间不计入），仅使当前
        // 调用方抛错（调用方各自 try/catch 告警）。
        const underlying = start.then(() => task());
        const current = start.then(() =>
            withHangTimeout(underlying, `graphSyncQueue(${conversationId})`, GRAPH_SYNC_QUEUE_HANG_TIMEOUT_MS)
        );
        const tail = underlying.then(() => undefined, () => undefined);
        this.graphSyncQueues.set(conversationId, tail);
        void tail.then(() => {
            if (this.graphSyncQueues.get(conversationId) === tail) {
                this.graphSyncQueues.delete(conversationId);
            }
        });
        await current;
    }

    /**
     * transcript 发生结构性变更后，把现有分支图按当前主历史重新对齐。
     *
     * 调用方通常在 TranscriptRepository.mutateContents 的 onPersisted 回调中同步调用本方法：
     * 方法本身会立即把任务接到 graphSyncQueues 队尾并返回 Promise，从而在会话写锁释放前
     * 预留顺序；真正的分支图更新稍后再顺序获取会话锁，不会发生锁重入。
     */
    queueBranchGraphStructuralSync(
        conversationId: string,
        reason: 'tool_calls_rejected'
    ): Promise<void> {
        const branchService = getGlobalBranchService();
        if (!branchService) {
            return Promise.resolve();
        }
        return this.withGraphSyncQueue(conversationId, async () => {
            await branchService.syncMainHistoryAfterStructuralMutation(conversationId, reason);
        });
    }

    /**
     * BR-07：公共会话写锁包装（供 BranchService 等外部模块把分支图读写放进会话写锁）。
     *
     * 锁序（从内到外，持内层锁时严禁获取外层锁，防止死锁）：
     *   1. 会话写锁（本队列）——历史 mutate / 分支图读改写的最小互斥单元；
     *   2. 存档操作锁（checkpointOperationLockManager.runExclusive，工作区级 + 可重入）；
     *   3. 文件写锁（FileWriteLockManager.acquire）。
     * 跨层操作必须从外层向内层获取；分支图写入与主历史写入共用同一把会话锁（BR-07），
     * 保证崩溃后 sidecar 与主历史不会因交错写而长期不一致。
     */
    async runExclusive<T>(conversationId: string, task: () => Promise<T>): Promise<T> {
        return await this.withConversationWriteLock(conversationId, task);
    }

    /**
     * 修改原因：上下文裁剪状态是由 transcript 结构推导出的派生状态，删除/插入/回档后继续复用旧 trimState 会造成上下文异常缺失。
     * 修改方式：在 ConversationManager 暴露统一失效入口，由所有结构性历史变更调用；普通追加和 token 计数更新不触发。
     * 修改目的：让上下文管理状态跟随 transcript 结构变化重新计算，而不是依赖各个 Webview handler 手动清理。
     */
    async invalidateContextManagementState(conversationId: string, reason: string): Promise<void> {
        // 修改原因：失效上下文状态是高频历史变更路径的一部分，不能为了调试在正常运行时持续 console.log。
        // 修改方式：保留 reason 参数作为调用点自说明和未来日志扩展点，但当前只统一清理 metadata。
        // 修改目的：实现统一失效机制，同时遵守热路径日志收敛规则，避免长会话删除/回档时制造额外输出。
        void reason;
        await this.setCustomMetadata(conversationId, CONVERSATION_CONTEXT_TRIM_STATE_KEY, null);
    }


    /** 只读查询委托：消息读取/分页/配对规范化（实现见 manager/query.ts） */
    private readonly query: ConversationQueryService;

    /** 工具调用拒绝/结算委托（实现见 manager/toolCalls.ts） */
    private readonly toolCalls: ConversationToolCallService;

    /** 分支图→主历史重写的上下文绑定（实现见 manager/branchRewrite.ts） */
    private get branchRewriteContext(): BranchRewriteContext {
        return {
            storage: this.storage,
            ensureHistoryNodeIds: conversationId => this.ensureHistoryNodeIds(conversationId),
            runExclusive: (conversationId, task) => this.runExclusive(conversationId, task),
            getMessagesRaw: conversationId => this.getMessagesRaw(conversationId),
            assertNotDeleted: conversationId => this.lifecycle.assertNotDeleted(conversationId),
            invalidateContextManagementState: (conversationId, reason) => this.invalidateContextManagementState(conversationId, reason),
            invalidateCaches: conversationId => this.invalidateCaches(conversationId),
            updateUsageIndex: (conversationId, history) => this.updateUsageIndex(conversationId, history),
        };
    }

    getTranscriptRepository(conversationId: string, workspaceUri?: string): ITranscriptRepository {
        // 修改原因：主聊天 transcript 需要一个统一的仓储入口，供当前适配和后续协作者复用。
        // 修改方式：把 ConversationManager 既有的“缺失历史时自动建会话”读取语义，与底层 saveHistory 持久化语义一起绑定到仓储委托。
        // 修改目的：外部协作者不再直接接触 storage.loadHistory/saveHistory，也不会复制主聊天特有的初始化规则。
        return new ConversationTranscriptRepository({
            loadContents: async () => await this.loadHistory(conversationId, workspaceUri),
            saveContents: async contents => {
                this.lifecycle.assertNotDeleted(conversationId);
                await this.storage.saveHistory(conversationId, contents);
                // 存储层 saveHistory 会刷新 updatedAt：失效元数据缓存，否则对话列表排序读到陈旧时间戳；
                // 结构性变更（删除/插入/拒绝工具调用等）替换了历史内容，节点 ID 反查缓存一并失效
                // （BCP-01：nodeIdCache 存的是旧数组引用，不失效会在 300ms TTL 窗口内返回陈旧节点 id）
                this.invalidateCaches(conversationId);
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
            appendContents: async contents => {
                this.lifecycle.assertNotDeleted(conversationId);
                const tail = await this.readTailContent(conversationId);
                let previous = tail;
                const withNodeIds = contents.map(content => {
                    const next = ensureNodeId(content, previous);
                    previous = next;
                    return next;
                });
                if (this.storage.appendHistory) {
                    await this.storage.appendHistory(conversationId, withNodeIds);
                } else {
                    // 无 append-only 存储（测试 fake 等）：回退全量读改写，语义不变
                    const history = await this.loadHistory(conversationId);
                    history.push(...withNodeIds);
                    await this.storage.saveHistory(conversationId, history);
                }
                // append-only/回退都会刷新 updatedAt：失效元数据缓存，避免对话列表排序读到陈旧时间戳；
                // 追加后历史尾部变化，节点 ID 反查缓存一并失效（BCP-01）
                this.invalidateCaches(conversationId);
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
                        void this.withGraphSyncQueue(conversationId, async () => {
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
                                if (tail && (tail.parts?.length ?? 0) === 0
                                    && (tail.kind === 'reroll' || tail.kind === 'edit')) {
                                    // 超龄空占位（进程崩溃/被杀遗留，isActiveEmptyPlaceholder 判定为已死亡）：
                                    // 先以主历史收敛图（占位移出活跃路径），再增量并入新消息。
                                    // 不收敛直接 append 会把新消息挂到死占位下，冻结依旧。
                                    await branchService.syncMainHistoryAfterStructuralMutation(
                                        conversationId,
                                        'branch_finished'
                                    );
                                }
                                await branchService.appendHistoryToGraph(conversationId, withNodeIds);
                            } catch (error) {
                                log.warn('branch_append_sync_failed', {
                                    conversationId,
                                    error: (error as Error)?.message ?? String(error),
                                });
                            }
                        }).catch((error: unknown) => {
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
            }
        }, fn => this.withConversationWriteLock(conversationId, fn));
    }

    /**
     * 对话落盘后同步维护用量索引（消息级 token 明细，供统计页免全量扫描）。
     *
     * 失败静默降级：索引写失败不影响对话保存主流程，统计侧会按 mtime 判定
     * stale/missing 并重建兜底。空历史不写索引（createConversation 的初始化落盘）。
     */
    private async updateUsageIndex(conversationId: string, history: ConversationHistory): Promise<void> {
        if (!this.usageIndexStore || history.length === 0) return;
        try {
            if (typeof this.usageIndexStore.rebuild === 'function') {
                // R2 1.1：把「读旧索引 + 重建 + 合并 subagent + 写回」整体移入 store 会话级
                // 写队列。调用方此前在队列外读旧索引，期间并发到达的子代理归集条目会被重建
                // 覆盖；rebuild 回调收到的是队列内最新盘面，subagent 条目按需合并保留。
                // history 是本次刚落盘的最新历史（会话写锁内串行），main 条目直接由它重建。
                await this.usageIndexStore.rebuild(conversationId, (previous) => {
                    const rebuilt = buildConversationUsageIndex(conversationId, history);
                    if (previous && Array.isArray(previous.messages)) {
                        const subagentEntries = previous.messages.filter(m => m.source === 'subagent');
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
            const previous = await this.usageIndexStore.read(conversationId);
            if (previous && Array.isArray(previous.messages)) {
                const subagentEntries = previous.messages.filter(m => m.source === 'subagent');
                if (subagentEntries.length > 0) {
                    rebuilt.messages.push(...subagentEntries);
                }
            }
            await this.usageIndexStore.write(conversationId, rebuilt);
        } catch {
            // 静默降级：统计侧重建兜底
        }
    }

    /**
     * 增量维护用量索引（HIS-08）：普通追加助手消息只更新对应用量条目；
     * 仅追加 user/functionResponse 时不重复写盘。增量不可用（索引缺失/损坏）
     * 时回退全量重建；删除/编辑/回档/分支切换仍走全量重建（updateUsageIndex）。
     */
    private async updateUsageIndexAppend(conversationId: string, appended: ConversationHistory): Promise<void> {
        if (!this.usageIndexStore) return;
        try {
            if (typeof this.usageIndexStore.appendUsage === 'function') {
                const ok = await this.usageIndexStore.appendUsage(conversationId, appended);
                if (ok) return;
            }
            // 增量不可用/失败 → 全量重建兜底（现有 freshness 机制保留为兜底）
            const history = await this.loadHistory(conversationId);
            await this.updateUsageIndex(conversationId, history);
        } catch {
            // 静默降级：统计侧按 mtime 判定 stale 并重建
        }
    }

    /** 供用量统计等外部模块获取索引存储（未配置时为 undefined，统计回退全量扫描） */
    getUsageIndexStore(): UsageIndexStore | undefined {
        return this.usageIndexStore;
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
        if (!this.usageIndexStore || messages.length === 0) return;
        try {
            if (typeof this.usageIndexStore.appendUsageMessages === 'function') {
                const ok = await this.usageIndexStore.appendUsageMessages(conversationId, messages);
                if (ok) return;
            }
            // 增量不可用/索引缺失：读改写追加，保留既有条目（含已存在的 subagent 条目）
            const existing = await this.usageIndexStore.read(conversationId);
            if (existing && Array.isArray(existing.messages)) {
                existing.messages.push(...messages);
                existing.updatedAt = Date.now();
                await this.usageIndexStore.write(conversationId, existing);
            }
        } catch {
            // 静默降级：统计侧重建兜底
        }
    }

    async getConversationStorageLocation(conversationId: string): Promise<ConversationStorageLocation | null> {
        // 修改原因：webview handler 需要打开对话存储位置，但 ConversationManager 外部不应知道具体存储布局。
        // 修改方式：通过 IStorageAdapter 的可选窄接口委托给文件系统存储实现；非文件存储返回 null。
        // 修改目的：保持路径规则单一来源，避免后续 segmented/legacy 存储格式升级时遗漏历史 reveal 功能。
        if (!this.storage.getConversationStorageLocation) {
            return null;
        }
        return await this.storage.getConversationStorageLocation(conversationId);
    }


    // ==================== BR-01/BR-02：稳定消息节点 ID ====================




    /** 轻量读取尾消息（只读最后一段，供 append 路径补 parentId；写锁内调用） */
    private async readTailContent(conversationId: string): Promise<Content | null> {
        const page = await this.storage.loadHistoryPage(conversationId, { limit: 1 });
        const messages = page.value?.messages;
        if (messages && messages.length > 0) {
            return messages[messages.length - 1] ?? null;
        }
        return null;
    }

    /**
     * 轻量读取首条消息 id（清空/恢复空快照的分支图同步锚点；只读首段，避免全量历史深拷贝）。
     * 会话不存在/不可读时回退仓储读取（保留按需自动创建语义），仅取首条 id。
     */
    private async getFirstMessageId(conversationId: string): Promise<string | null> {
        const page = await this.storage.loadHistoryPage(conversationId, { offset: 0, limit: 1 });
        const messages = page.value?.messages;
        if (messages && messages.length > 0) {
            const first = messages[0];
            return typeof first?.id === 'string' && first.id.length > 0 ? first.id : null;
        }
        if (!page.value) {
            const contents = await this.getTranscriptRepository(conversationId).getContents();
            const first = contents[0];
            return typeof first?.id === 'string' && first.id.length > 0 ? first.id : null;
        }
        return null;
    }

    async ensureHistoryNodeIds(conversationId: string): Promise<boolean> {
        return await this.nodeIds.ensureHistoryNodeIds(conversationId);
    }





    /**
     * TREE-06：切换后主历史重写——从分支图活跃路径重建主历史（实现见 manager/branchRewrite.ts）。
     *
     * 锁边界（BR-07 / M-3 强约束）与异常语义（BranchError）与拆分前一致。
     */
    async rewriteHistoryFromBranchGraph(conversationId: string): Promise<BranchHistoryRewriteResult> {
        return await rewriteHistoryFromBranchGraphImpl(this.branchRewriteContext, conversationId);
    }

    async createConversation(conversationId: string, title?: string, workspaceUri?: string): Promise<void> {
        return await this.lifecycle.createConversation(conversationId, title, workspaceUri);
    }

    async createBranchConversation(
        sourceConversationId: string,
        branchAtIndex: number,
        options: { conversationId?: string; title?: string; workspaceUri?: string } = {}
    ): Promise<CreateBranchConversationResult> {
        return await this.lifecycle.createBranchConversation(sourceConversationId, branchAtIndex, options);
    }

    async deleteConversation(conversationId: string): Promise<void> {
        return await this.lifecycle.deleteConversation(conversationId);
    }

    /**
     * 列出所有对话
     */
    async listConversations(): Promise<string[]> {
        return await this.storage.listConversations();
    }

    /**
     * 加载对话历史（直接从存储读取）
     *
     * @param workspaceUri 可选工作区 URI：仅当历史不存在、按需自动创建会话时使用，
     *                     把该 URI 一并写入新会话元数据（H4 记忆隔离——自动创建的会话
     *                     若不绑定 workspaceUri，记忆工具执行时会回退全局，造成跨工作区污染）。
     *                     默认 undefined 保持向后兼容；webview 读取入口可传入当前工作区 URI。
     */
    private async loadHistory(conversationId: string, workspaceUri?: string, preloaded?: ConversationHistory): Promise<ConversationHistory> {
        if (this.lifecycle.isDeleted(conversationId)) {
            // 已删除会话：读路径不再自动重建（防止删除后读操作把会话“复活”为空历史）
            return [];
        }
        // 调用方刚完整读取过且未修改的历史（只可能来自存在的会话），直接复用。
        if (preloaded) return preloaded;
        const result = await this.storage.loadHistoryWithStatus(conversationId);
        if (result.value) {
            return result.value;
        }
        if (!result.errorCode || result.errorCode === 'not_found') {
            // 按需自动创建：把可选 workspaceUri 传给 createConversation，
            // 避免自动创建的会话未绑定工作区导致记忆工具回退全局（H4）。
            await this.createConversation(conversationId, undefined, workspaceUri);
            return [];
        }
        throw new Error(
            `Failed to load conversation history (${result.errorCode}) for ${conversationId}: ${result.errorMessage || 'Unknown error'}`
        );
    }

    /**
     * 获取对话历史的只读副本
     */
    async getHistory(conversationId: string): Promise<Readonly<ConversationHistory>> {
        const history = await this.loadHistory(conversationId);
        if (needsNodeIdMigration(history)) {
            // BR-02：读取入口惰性触发补 ID（显式触发，不做启动全扫）；迁移幂等，二次读取不再触发。
            await this.ensureHistoryNodeIds(conversationId);
            return JSON.parse(JSON.stringify(await this.loadHistory(conversationId)));
        }
        return JSON.parse(JSON.stringify(history));
    }

    /**
     * 获取对话历史的引用（用于直接发送给 API）
     * 注意: 每次调用都从存储读取最新数据
     */
    async getHistoryRef(conversationId: string): Promise<ConversationHistory> {
        return await this.loadHistory(conversationId);
    }

    // ==================== 消息操作 ====================

    /**
     * 添加消息（Gemini 格式）
     * 
     * @param conversationId 对话 ID
     * @param role 角色
     * @param parts 消息内容
     * @param metadata 可选的元数据（如 isUserInput）
     */
    async addMessage(
        conversationId: string,
        role: 'user' | 'model' | 'system',
        parts: ContentPart[],
        metadata?: Partial<Pick<Content,
            | 'isUserInput'
            | 'isFunctionResponse'
            | 'isSummary'
            | 'source'
            | 'deepSeekVisionTileSplit'
            | 'foregroundWorkTransition'
            | 'turnDynamicContext'
            | 'turnDynamicContextStrategy'
        >>,
        messageId?: string,
    ): Promise<void> {
        // MED-3 / H1-2：新的真实 user 消息 = 新回合开始。清空主会话信箱未消费消息，
        // 防止上一回合滞留的 agent→main / 用户打断消息跨轮过期投递。
        // 谓词与 addContent/addBatch/formatHistoryForAPI 统一（排除 functionResponse 与总结消息）。
        if (isRealUserMessage({
            role,
            isFunctionResponse: metadata?.isFunctionResponse,
            isSummary: metadata?.isSummary,
            source: metadata?.source
        })) {
            agentMailbox.clearMainSessionInbox(conversationId);
        }
        await this.getTranscriptRepository(conversationId).appendContent({
            role,
            parts: JSON.parse(JSON.stringify(parts)),
            timestamp: Date.now(),  // 自动添加时间
            // BR-01：前端发送时携带稳定节点 id（窗口消息 id 与后端落库 id 对齐，
            // 编辑/重试/分支操作才能按 id 定位）；省略时由仓储委托补齐（ensureNodeId）。
            ...(typeof messageId === 'string' && messageId.length > 0 ? { id: messageId } : {}),
            ...metadata  // 合并可选元数据
        } as Content);
    }

    /**
     * 添加完整的 Content 对象（对 functionResponse 自动去重）
     */
    async addContent(conversationId: string, content: Content): Promise<Content | undefined> {
        const contentCopy = JSON.parse(JSON.stringify(content));
        // 如果没有时间戳，自动添加
        if (!contentCopy.timestamp) {
            contentCopy.timestamp = Date.now();
        }

        // MED-3：新回合边界 = 真实 user 消息（排除 functionResponse / 总结消息——
        // 自动总结发生在回合内，不得清空当轮尚未投递的信箱消息）
        if (isRealUserMessage(contentCopy)) {
            agentMailbox.clearMainSessionInbox(conversationId);
        }

        // HIS-02：纯追加（非 functionResponse）没有配对/去重逻辑，走 append-only 尾段写入，
        // 不再读全量历史做去重（避免长对话下每次追加都全量重写）。
        if (!contentCopy.isFunctionResponse || !contentCopy.parts) {
            const [persistedContent] = await this.getTranscriptRepository(conversationId).appendContents([contentCopy]);
            // appendContents 返回本次真实落盘副本，其中包含委托补齐的稳定 id / parentId。
            // 流式调用方需要把它原样回传前端，避免前端临时消息 ID 被误当作分支节点 ID。
            return persistedContent;
        }

        // functionResponse 保留配对语义：去重 + 追加整体放入仓储互斥执行器，
        // 两个并发 addContent 基于同一旧快照各自追加时，同一 tool_use_id 会出现两条
        // functionResponse（会触发 API 400）。锁内重新收集 existingResponseIds 再过滤；
        // 全部被过滤时返回原引用跳过写回。
        let appendedContent: Content | undefined;
        await this.getTranscriptRepository(conversationId).mutateContents(history => {
            // 去重：过滤掉历史中已有响应的 tool call ID。
            // 这是一道安全网，防止 cancelStream→rejectAllPendingToolCalls 与工具执行循环之间的
            // 竞态条件导致同一 tool_use_id 出现多条 functionResponse（会触发 API 400 错误）。
            const existingResponseIds = new Set<string>();
            for (const msg of history) {
                if (msg.parts) {
                    for (const part of msg.parts) {
                        if (part.functionResponse?.id) {
                            existingResponseIds.add(part.functionResponse.id);
                        }
                    }
                }
            }

            const filteredParts = contentCopy.parts.filter((part: any) =>
                !(part.functionResponse?.id && existingResponseIds.has(part.functionResponse.id))
            );

            if (filteredParts.length === 0) {
                return history; // 所有 parts 均已有响应，无需添加空消息（原引用=跳过写回）
            }

            const persistedContent = ensureNodeId(
                { ...contentCopy, parts: filteredParts },
                history[history.length - 1] ?? null
            );
            history.push(persistedContent);
            appendedContent = cloneJson(persistedContent);
            return history.slice();
        });
        return appendedContent;
    }

    /**
     * 批量添加消息。
     *
     * 契约（L4）：addBatch 仅限纯追加的 user/model 消息，走 append-only 尾段写入（HIS-02），
     * 没有配对/去重逻辑。禁止经 addBatch 追加 functionResponse——functionResponse 必须走
     * addContent（保留配对去重语义，防 cancelStream 与工具执行循环竞态产生重复响应）。
     */
    async addBatch(conversationId: string, contents: Content[]): Promise<void> {
        const now = Date.now();
        const contentsCopy = JSON.parse(JSON.stringify(contents)).map((content: Content, index: number) => {
            // 如果没有时间戳，自动添加（同一批次的消息时间戳递增）
            if (!content.timestamp) {
                content.timestamp = now + index;
            }
            // L4：functionResponse 无去重安全网——显式拒绝而不是静默追加重复响应
            const hasFunctionResponse = content.isFunctionResponse === true ||
                (Array.isArray(content.parts) && content.parts.some(part => !!part.functionResponse?.id));
            if (hasFunctionResponse) {
                throw new Error(
                    'addBatch does not support functionResponse messages (no dedupe); use addContent instead'
                );
            }
            return content;
        });
        // MED-3：批次含真实 user 消息 = 新回合开始，清空主会话信箱未消费消息（防跨轮过期投递）
        if (contentsCopy.some((content: Content) => isRealUserMessage(content))) {
            agentMailbox.clearMainSessionInbox(conversationId);
        }
        // HIS-02：批量追加是纯追加（无配对/去重逻辑），走 append-only 尾段写入
        await this.getTranscriptRepository(conversationId).appendContents(contentsCopy);
    }



    /**
     * 获取所有消息（含工具调用配对补齐；实现见 manager/query.ts）
     */
    async getMessages(conversationId: string, workspaceUri?: string): Promise<Content[]> {
        return await this.query.getMessages(conversationId, workspaceUri);
    }

    /**
     * 轻量读取原始消息（供用量统计等只关心 usageMetadata 的场景使用；实现见 manager/query.ts）
     */
    async getMessagesRaw(conversationId: string): Promise<Content[]> {
        return await this.query.getMessagesRaw(conversationId);
    }

    async getMessageNodeIdAt(conversationId: string, index: number): Promise<string | undefined> {
        return await this.nodeIds.getMessageNodeIdAt(conversationId, index);
    }




    /**
     * 分页获取对话消息（仅返回一个窗口，避免一次性向 Webview 发送全量历史；实现见 manager/query.ts）
     */
    async getMessagesPaged(
        conversationId: string,
        options: { beforeIndex?: number; offset?: number; limit?: number } = {},
        workspaceUri?: string
    ): Promise<{ total: number; messages: Content[] }> {
        return await this.query.getMessagesPaged(conversationId, options, workspaceUri);
    }

    /** 获取滚动条所需的轻量用户消息索引（实现见 manager/query.ts）。 */
    async getMessageMarkers(
        conversationId: string
    ): Promise<{ total: number; markers: Array<{ index: number; id?: string; preview?: string }>; floorIndices: number[] }> {
        return await this.query.getMessageMarkers(conversationId);
    }

    async getMessagePosition(conversationId: string, messageId: string): Promise<{ index?: number }> {
        return await this.query.getMessagePosition(conversationId, messageId);
    }

    /**
     * 获取指定索引的消息（实现见 manager/query.ts）
     */
    async getMessage(conversationId: string, index: number): Promise<Content | undefined> {
        return await this.query.getMessage(conversationId, index);
    }

    /**
     * 更新消息
     */
    async updateMessage(
        conversationId: string,
        messageIndex: number,
        updates: Partial<Content>
    ): Promise<void> {
        await this.getTranscriptRepository(conversationId).mutateContents(history => {
            if (messageIndex < 0 || messageIndex >= history.length) {
                throw new Error(t('modules.conversation.errors.messageIndexOutOfBounds', { index: messageIndex }));
            }
            const patch = { ...updates };
            if (patch.parts !== undefined) {
                // parts 深拷贝：patch 可能被调用方复用/继续修改，避免与落盘历史共享嵌套引用
                patch.parts = JSON.parse(JSON.stringify(patch.parts));
            }
            Object.assign(history[messageIndex], patch);
            return history.slice(); // 有变更必须返回新引用（契约：返回原引用=跳过写回）
        });
        if (shouldInvalidateContextManagementStateForUpdate(updates)) {
            await this.invalidateContextManagementState(conversationId, 'message_structure_updated');
        }
    }

    /**
     * 批量更新多条消息（一次读写，避免并发 updateMessage 导致的覆盖写入）
     *
     * 典型场景：Token 预计算会并行更新多条 user 消息的 tokenCountByChannel。
     * 如果对每条消息单独 load+save，并行执行会出现“后写覆盖先写”，导致大量 token 结果丢失，
     * 进而在下一次请求里又重复对同一批消息进行 token 计数。
     */
    async updateMessagesBatch(
        conversationId: string,
        updates: Array<{ messageIndex: number; updates: Partial<Content> }>
    ): Promise<void> {
        if (updates.length === 0) {
            return;
        }

        await this.getTranscriptRepository(conversationId).mutateContents(history => {
            let changed = false;
            for (const item of updates) {
                const { messageIndex, updates: patch } = item;
                if (messageIndex < 0 || messageIndex >= history.length) {
                    throw new Error(t('modules.conversation.errors.messageIndexOutOfBounds', { index: messageIndex }));
                }
                // 仅当 patch 确实改变了目标消息时才写回：patch 为空或各字段值相同（===）时
                // 跳过，避免无意义的整体落盘覆盖（mutateContents 契约：返回原引用=跳过写回）。
                const target = history[messageIndex];
                let patchChangesTarget = false;
                for (const key of Object.keys(patch) as Array<keyof Content>) {
                    if (target[key] !== patch[key]) {
                        patchChangesTarget = true;
                        break;
                    }
                }
                if (patchChangesTarget) {
                    Object.assign(target, patch.parts !== undefined
                        ? { ...patch, parts: JSON.parse(JSON.stringify(patch.parts)) }
                        : patch);
                    changed = true;
                }
            }
            return changed ? history.slice() : history;
        });

        if (updates.some(item => shouldInvalidateContextManagementStateForUpdate(item.updates))) {
            await this.invalidateContextManagementState(conversationId, 'messages_batch_updated');
        }
    }

    /**
     * 删除消息
     */
    async deleteMessage(conversationId: string, messageIndex: number): Promise<void> {
        const repository = this.getTranscriptRepository(conversationId);
        let deletedMessageId: string | null = null;
        let deletedWasSummary = false;
        let deletedWasTailDelete = false;
        const nextHistory = await repository.mutateContents(contents => {
            if (messageIndex < 0 || messageIndex >= contents.length) {
                throw new Error(t('modules.conversation.errors.messageIndexOutOfBounds', { index: messageIndex }));
            }
            // 在实际持锁快照内捕获删除锚点、总结类型与「是否尾部删除」，避免 getContents 与
            // mutateContents 之间并发插入/删除导致按旧下标走错分支同步策略。
            deletedMessageId = contents[messageIndex]?.id ?? null;
            deletedWasSummary = contents[messageIndex]?.isSummary === true;
            let next = contents;
            // 逻辑截断：删除总结消息时先恢复其覆盖的原文（取消 isSummarized 标记），
            // 避免「既无总结文本也无原文」的上下文真空（原文保留在存储中但不再发送）。
            if (next[messageIndex]?.isSummary) {
                const restored = restoreSummarizedRange(next, messageIndex);
                next = restored.contents;
            }
            const deleted = deleteLogicalMessage(next, messageIndex);
            // 尾部删除 = 删除后锚点及其后（含其 functionResponse 级联删除）没有任何幸存消息：
            // 只有此时「整棵子树软删 + 回退活跃尾」才与主历史一致；中间删除必须走 rebase（见下）。
            deletedWasTailDelete = deleted.length <= messageIndex;
            return deleted;
        });
        // HIS-11：结构性删除后同步 custom.messageCount（防对话列表 messageCount 漂移）
        await this.metadata.syncMessageCountAfterStructuralChange(conversationId, nextHistory.length);
        await this.invalidateContextManagementState(conversationId, 'message_deleted');

        // 决策 6：删除后同步软删分支图——「被删节点及其后续整棵子树」（TREE-09 软删语义：
        // 节点标记 deleted + deletedAt，不物理移除 sidecar；可经恢复接口还原）。
        // 锁取舍：删除历史已随 mutateContents 释放会话写锁（仓储互斥执行器非重入，此时锁空闲），
        // 因此直接 await 图同步（内部顺序再取会话写锁，非嵌套，无死锁）——单条删除是用户显式
        // 操作，删除响应返回前保证图一致（避免响应后立即续写时 appendHistoryToGraph 挂在已被
        // 硬删除的旧尾上）；这与 appendContents 的 fire-and-forget（彼处仍处于写锁内不可重入）
        // 场景不同。图同步失败仅告警（主历史为唯一真源，图侧由下次读图/写图自校验兜底），
        // 不阻断删除；无全局 BranchService（未注册/测试环境）时静默跳过。
        // 图同步进会话级串行队列（graphSyncQueues，与 appendContents 同一队列）：删除前已入队的
        // append 图同步必须先完成，再执行本次软删/重链——不经队列直接同步时，先入队的 append
        // 任务会在删除同步完成后把已删消息挂回图（幻影节点，切分支时"复活"）。队列内按入队顺序
        // 串行执行，图活跃路径与主历史严格一致。
        if (deletedMessageId) {
            const branchService = getGlobalBranchService();
            if (branchService) {
                try {
                    await this.withGraphSyncQueue(conversationId, async () => {
                        if (deletedWasSummary) {
                            // 删除总结会同时恢复其覆盖原文的 isSummarized 标记，不是普通子树删除；
                            // 必须按当前主历史重建活跃路径与消息元数据，不能把总结后的全部后继软删。
                            await branchService.syncMainHistoryAfterStructuralMutation(conversationId, 'summary_deleted');
                        } else if (deletedWasTailDelete) {
                            // 尾部删除：锚点及其后续整棵子树整体软删，活跃尾回退到锚点父节点
                            // （TREE-09；主历史在锚点后已无幸存消息，与软删范围一致）。
                            await branchService.syncGraphAfterHistoryDelete(conversationId, deletedMessageId);
                        } else {
                            // 中间消息删除：主历史保留锚点后的幸存消息，整棵子树软删会把仍在主历史中的
                            // 后继消息在图中标记 deleted 且活跃尾错误回退——后续 append 挂到旧父节点、
                            // 切分支时消息"复活"。与 deletedWasSummary 分支一致，按当前主历史 rebase
                            // 保留后继（被删节点退化为非活跃候选，不软删）。头部删除（index 0 且非尾删）
                            // 导致主历史根前移时，rebase 以 allowRootChange 走根变更重链（新根挂图、
                            // 旧根专属子树清理，BranchService 内告警），避免图根永久陈旧（round4 复查 P1）。
                            await branchService.syncMainHistoryAfterStructuralMutation(conversationId, 'message_deleted_middle');
                        }
                    });
                } catch (error) {
                    log.warn('branch_delete_sync_failed', {
                        conversationId,
                        messageIndex,
                        error: (error as Error)?.message ?? String(error),
                    });
                }
            }
        }
    }

    /**
     * 插入消息
     */
    async insertMessage(
        conversationId: string,
        position: number,
        role: 'user' | 'model' | 'system',
        parts: ContentPart[]
    ): Promise<void> {
        await this.getTranscriptRepository(conversationId).mutateContents(history => {
            const index = Math.max(0, Math.min(position, history.length));
            const oldParent = index > 0 ? history[index - 1] : null;
            const oldParentId = oldParent?.id ?? null;
            const inserted = ensureNodeId({
                role,
                parts: JSON.parse(JSON.stringify(parts)),
                timestamp: Date.now()  // 自动添加时间
            } as Content, oldParent);
            history.splice(index, 0, inserted);
            // R5b-2.4：插入后修复线性 parentId 链（插入点之后 parentId===旧父id 的消息
            // 重链到新插入消息，与 deleteMessagesInRange 的 repairParentChainAfterDelete 语义对称）
            repairParentChainAfterInsert(history, index, oldParentId, inserted.id as string);
            return history.slice(); // 有变更必须返回新引用（契约：返回原引用=跳过写回）
        });
        await this.invalidateContextManagementState(conversationId, 'message_inserted');

        // M-conv：插入是结构性变更（插入点后继 parentId 重链到新消息，活跃路径变化），与
        // deleteMessage/deleteToMessage/clearHistory 同口径同步分支图——否则图缺插入消息，切分支时
        // rewriteHistoryFromBranchGraph 会用图重建主历史、静默丢消息。走会话级串行队列
        // （graphSyncQueues）：插入前已入队的 append 图同步必须先完成再 rebase。失败仅告警
        // （主历史为唯一真源，图侧由下次读图/写图自校验兜底）；无全局 BranchService 时静默跳过。
        const branchService = getGlobalBranchService();
        if (branchService) {
            try {
                await this.withGraphSyncQueue(conversationId, async () => {
                    await branchService.syncMainHistoryAfterStructuralMutation(conversationId, 'message_inserted');
                });
            } catch (error) {
                log.warn('branch_insert_sync_failed', {
                    conversationId,
                    position,
                    error: (error as Error)?.message ?? String(error),
                });
            }
        }
    }

    /** 在指定数值位置插入；实际钳制与写入委托给锁内解析版本。 */
    async insertContent(
        conversationId: string,
        position: number,
        content: Content
    ): Promise<void> {
        await this.insertContentAtResolvedPosition(conversationId, content, () => position);
    }

    /**
     * 在 transcript mutate 锁内基于最新历史解析插入位置。
     * Agent 卡片不能先 getHistory 再拿陈旧 position 写回：工具结果/后台消息可能在两步间插入。
     */
    async insertContentAtResolvedPosition(
        conversationId: string,
        content: Content,
        resolvePosition: (history: ReadonlyArray<Content>) => number
    ): Promise<number> {
        const contentCopy = JSON.parse(JSON.stringify(content));
        if (!contentCopy.timestamp) {
            contentCopy.timestamp = Date.now();
        }
        let insertedIndex = 0;
        await this.getTranscriptRepository(conversationId).mutateContents(history => {
            const requestedPosition = resolvePosition(history);
            const finitePosition = Number.isFinite(requestedPosition) ? Math.trunc(requestedPosition) : history.length;
            const index = Math.max(0, Math.min(finitePosition, history.length));
            insertedIndex = index;
            const oldParent = index > 0 ? history[index - 1] : null;
            const oldParentId = oldParent?.id ?? null;
            const inserted = ensureNodeId(contentCopy, oldParent);
            history.splice(index, 0, inserted);
            repairParentChainAfterInsert(history, index, oldParentId, inserted.id as string);
            return history.slice();
        });
        await this.invalidateContextManagementState(conversationId, contentCopy.isSummary ? 'summary_inserted' : 'content_inserted');

        const branchService = getGlobalBranchService();
        if (branchService) {
            try {
                await this.withGraphSyncQueue(conversationId, async () => {
                    await branchService.syncMainHistoryAfterStructuralMutation(conversationId, 'message_inserted');
                });
            } catch (error) {
                log.warn('branch_insert_sync_failed', {
                    conversationId,
                    position: insertedIndex,
                    error: (error as Error)?.message ?? String(error),
                });
            }
        }
        return insertedIndex;
    }

    // ==================== 批量操作 ====================

    /**
     * 删除指定范围的消息
     */
    async deleteMessagesInRange(
        conversationId: string,
        startIndex: number,
        endIndex: number
    ): Promise<void> {
        // 入口参数校验：非法区间（非整数 / 负数 / start > end）直接抛参数错误，
        // 避免负值 splice 静默 no-op 造成“调用成功但什么都没删”的假象。
        if (!Number.isInteger(startIndex) || !Number.isInteger(endIndex)
            || startIndex < 0 || startIndex > endIndex) {
            throw new TypeError(
                `Invalid message range [${startIndex}, ${endIndex}]: expected integers with 0 <= startIndex <= endIndex`
            );
        }
        const nextHistory = await this.getTranscriptRepository(conversationId).mutateContents(history => {
            const start = Math.max(0, startIndex);
            const end = Math.min(history.length, endIndex + 1);
            let next = history;
            // 逻辑截断：删除区间内的总结消息前，先恢复其覆盖的原文（取消 isSummarized 标记）。
            // 从晚到早逐个恢复：每个总结的覆盖区间以历史中它之前的最近总结为界，互不重叠；
            // 覆盖区间可能延伸到删除区间之外（幸存部分同样恢复，避免上下文真空）。
            const summaryIndices: number[] = [];
            for (let i = start; i < end; i++) {
                if (history[i]?.isSummary) {
                    summaryIndices.push(i);
                }
            }
            if (summaryIndices.length > 0) {
                // 性能：restoreSummarizedRange 每次调用全量 JSON 深拷贝（O(n)），k 个总结即
                // O(k·n)；先克隆一次，循环内仅原地清除 isSummarized 标记（纯字段变更，不改变
                // 数组长度与 parentId 链，与 restoreSummarizedRange 语义一致）。
                next = JSON.parse(JSON.stringify(history)) as Content[];
                for (let i = summaryIndices.length - 1; i >= 0; i--) {
                    const summaryIndex = summaryIndices[i];
                    // 覆盖区间起点 = 该总结之前最近的总结消息之后（无更早总结则从 0 开始）
                    let rangeStart = 0;
                    for (let j = summaryIndex - 1; j >= 0; j--) {
                        if (next[j]?.isSummary) {
                            rangeStart = j + 1;
                            break;
                        }
                    }
                    for (let j = rangeStart; j < summaryIndex; j++) {
                        const message = next[j];
                        if (message?.isSummarized) {
                            const { isSummarized: _removed, ...rest } = message;
                            next[j] = rest as Content;
                        }
                    }
                }
            }
            const deleted = next.slice(start, end);
            next.splice(start, end - start);
            // 删除区间可能只移除了 functionResponse、却保留其 functionCall。写锁内立即把
            // 失去响应的调用标记为 rejected，避免后续请求命中 orphan_function_call 校验错误。
            repairFunctionCallPairsAfterDelete(next, deleted);
            // R5b-2.4：删除中间消息后修复线性 parentId 链（被删消息的直系后继
            // parentId===被删id 的消息重链到被删消息的 parent；分支跨链不受影响）
            repairParentChainAfterDelete(next, deleted);
            return next.slice(); // 有变更必须返回新引用（契约：返回原引用=跳过写回）
        });
        // HIS-11：结构性删除后同步 custom.messageCount（防对话列表 messageCount 漂移）
        await this.metadata.syncMessageCountAfterStructuralChange(conversationId, nextHistory.length);
        await this.invalidateContextManagementState(conversationId, 'message_range_deleted');
    }

    /**
     * 删除到指定消息（从后往前删除）
     *
     * @param conversationId 对话 ID
     * @param targetIndex 目标消息索引（删除到这个索引为止，包括该消息）
     * @param expectedMessageId 可选的目标消息稳定 ID；在截断写锁内做最终并发校验
     * @returns 删除的消息数量
     *
     * @example
     * // 删除最后 3 条消息（假设历史有 10 条）
     * await manager.deleteToMessage('chat-001', 7); // 删除索引 7, 8, 9
     *
     * 注意：若截断删除了保留区间中 functionCall 的配对 functionResponse，
     * truncateFrom 会在同一次仓储变更中将该调用标记为 rejected，避免产生孤儿调用。
     */
    async deleteToMessage(
        conversationId: string,
        targetIndex: number,
        expectedMessageId?: string,
        capture?: DeleteToMessageCapture
    ): Promise<number> {
        const repository = this.getTranscriptRepository(conversationId);
        // 修改原因：重试/删除到指定消息的语义是从目标索引开始截断，不能在主对话和 SubAgent 子对话各写一套实现。
        // 修改方式：通过 TranscriptRepository.mutateContents 委托 TranscriptMutation.truncateFrom 统一处理截断和 index 规范化。
        // 修改目的：保证后续工具配对规则升级时，主窗口和 Monitor 同步继承。
        // deleteCount 必须在 mutateContents 回调内基于同一份锁内快照计算：
        // 此前用外部 history.length 减 nextHistory.length，两次读取之间若有并发追加，
        // 删除数会失真（甚至为负）。
        // targetIndex 校验同样移入锁内基于当前快照进行：锁外 getContents 快照校验后，并发
        // 删除可能让 targetIndex 越界（truncateFrom 抛原始 Error）或指向错误消息，锁内重校验
        // 保证边界判定与截断基于同一份数据。
        let deleteCount = 0;
        // 决策 6：锁内捕获分支图同步锚点（与 deleteMessage 同模式）——删除区间首条消息 id、
        // 最后保留消息 id、删除区间是否含总结消息；与 truncateFrom 基于同一份锁内快照计算，
        // 避免锁外读取与 mutateContents 之间并发追加/删除导致锚点漂移。
        let deletedFromMessageId: string | null = null;
        let lastKeptMessageId: string | null = null;
        let deletedWasSummary = false;
        const normalizedExpectedMessageId = expectedMessageId?.trim();
        let graphSyncPromise: Promise<void> | undefined;
        const nextHistory = await repository.mutateContents(currentHistory => {
            if (!Number.isInteger(targetIndex) || targetIndex < 0) {
                throw new Error(t('modules.conversation.errors.messageIndexOutOfBounds', { index: targetIndex }));
            }
            // M1：这是 messageId 的最终权威校验，必须和 truncateFrom 位于同一个
            // mutateContents 写锁内。编排层预检之后会等待 diff/tool/checkpoint 清理，期间
            // 任何前序插入或删除都会让旧 targetIndex 指向另一条消息；锁内不匹配时拒绝
            // 整次 mutation，绝不能按漂移后的索引截断。
            const actualMessageId = currentHistory[targetIndex]?.id;
            if (normalizedExpectedMessageId && actualMessageId !== normalizedExpectedMessageId) {
                throw new ConversationMessageChangedError(normalizedExpectedMessageId, actualMessageId);
            }
            // 不带 expectedMessageId 的旧调用仍维持原有越界错误；带 expectedMessageId 时，
            // 并发删除导致 index 消失属于 MESSAGE_CHANGED，已由上面的 missing id 分支区分。
            if (targetIndex >= currentHistory.length) {
                throw new Error(t('modules.conversation.errors.messageIndexOutOfBounds', { index: targetIndex }));
            }
            if (capture) {
                capture.deletedMessageIds = currentHistory
                    .slice(targetIndex)
                    .map(message => message.id)
                    .filter((id): id is string => typeof id === 'string' && id.length > 0);
            }
            deletedFromMessageId = currentHistory[targetIndex]?.id ?? null;
            lastKeptMessageId = targetIndex > 0 ? (currentHistory[targetIndex - 1]?.id ?? null) : null;
            deletedWasSummary = currentHistory.slice(targetIndex).some(message => message.isSummary === true);
            const next = truncateFrom(currentHistory, targetIndex);
            deleteCount = currentHistory.length - next.length;
            return next;
        }, () => {
            // 保存已成功、会话锁尚未释放：此刻把删除同步接到图队列尾部，确保随后 append
            // 虽可在本次锁释放后提交 transcript，但它的图同步只能排在本次删除之后。
            if (!deletedFromMessageId) {
                return;
            }
            const branchService = getGlobalBranchService();
            if (!branchService) {
                return;
            }
            graphSyncPromise = this.withGraphSyncQueue(conversationId, async () => {
                if (deletedWasSummary) {
                    await branchService.syncMainHistoryAfterStructuralMutation(conversationId, 'summary_deleted');
                } else {
                    await branchService.syncGraphAfterHistoryDelete(conversationId, deletedFromMessageId, {
                        lastKeptMessageId,
                    });
                }
            });
        });
        if (deleteCount > 0) {
            // HIS-11：结构性删除后同步 custom.messageCount（防对话列表 messageCount 漂移）
            await this.metadata.syncMessageCountAfterStructuralChange(conversationId, nextHistory.length);
            // 主 transcript 已在上面的 mutateContents 中提交；上下文管理 metadata 是可重建的
            // 派生状态。这里若写盘失败不能把已成功的删除伪装成失败，否则编排层不会继续清理
            // checkpoint，而用户按旧索引重试也无法恢复这次部分提交。
            try {
                await this.invalidateContextManagementState(conversationId, 'history_truncated');
            } catch (error) {
                log.warn('delete_to_message_context_metadata_invalidation_failed', {
                    conversationId,
                    targetIndex,
                    error: (error as Error)?.message ?? String(error),
                });
            }

            // 决策 6：删除成功后同步软删分支图「该点之后」的整棵子树（TREE-09 软删语义：
            // 节点标记 deleted + deletedAt，不物理移除 sidecar；活跃尾同步回退到保留锚点）。
            // 截断区间内含总结消息：原文的 isSummarized 标记已恢复，必须按当前主历史重建
            // 活跃路径与消息元数据（summary_deleted），否则切分支后已恢复的原文会被图中
            // 陈旧的 isSummarized 元数据重新压缩；否则走常规「软删被删节点及其后续子树」。
            // 锁取舍：deleteToMessage 的仓储互斥（会话写锁）已随 mutateContents 返回释放，
            // 此处再取会话写锁是顺序获取（非嵌套），故同步 await 而非 fire-and-forget——删除
            // 响应返回前保证分支图一致（避免响应后立即续写新消息时 appendHistoryToGraph 挂在
            // 已被硬删除的旧尾上）。失败仅告警不阻断：主历史为唯一真源，硬删除已提交，图侧由
            // 下次读图/写图自校验兜底。
            // 图同步进会话级串行队列（graphSyncQueues，与 appendContents/deleteMessage 同一队列）：
            // 删除前已入队的 append 图同步必须先完成，再执行本次软删——不经队列直接同步时，
            // 先入队的 append 任务会在删除同步完成后把已删消息挂回图（幻影节点，切分支时"复活"）。
            // 队列内按入队顺序串行，图活跃路径与主历史严格一致。
            if (graphSyncPromise) {
                try {
                    await graphSyncPromise;
                } catch (error) {
                    log.warn('branch_delete_to_message_sync_failed', {
                        conversationId,
                        targetIndex,
                        error: (error as Error)?.message ?? String(error),
                    });
                }
            }
        }

        return deleteCount;
    }

    /**
     * 清空对话历史
     */
    async clearHistory(conversationId: string): Promise<void> {
        // 修改原因：清空 transcript 属于 replace 整体快照的典型场景，应直接走统一 replace 入口。
        // 修改方式：委托 repository.replaceContents([]) 保存空 transcript。
        // 修改目的：主聊天 clear 与 SubAgent replace 拥有同一仓储操作语义。
        const repository = this.getTranscriptRepository(conversationId);
        // 决策 6：清空前捕获首条消息 id 作为分支图同步锚点（forceResetToEmpty 时仅作语义传参，
        // 不依赖锚点是否图根/是否存在）。轻量读取（只读首段），避免 getContents 的全量深拷贝。
        const firstMessageId = await this.getFirstMessageId(conversationId);
        const nextHistory = await repository.replaceContents([]);
        // HIS-11：结构性清空后同步 custom.messageCount（防对话列表 messageCount 漂移）
        await this.metadata.syncMessageCountAfterStructuralChange(conversationId, nextHistory.length);
        await this.invalidateContextManagementState(conversationId, 'history_cleared');
        // 图同步：主历史已整体清空，无条件重置分支图为空（forceResetToEmpty，round4 复查 P1）——
        // 锚点非图根（图根陈旧）时仅软删子树会残留旧根/旧活跃尾，清空后 append 挂旧尾；
        // 无分支图时幂等 no-op；失败仅告警不阻断——主历史为唯一真源，图侧由下次读图/写图自校验兜底。
        // 图同步进会话级串行队列（graphSyncQueues，与 appendContents 同一队列）：清空前已入队的
        // append 图同步必须先完成，再执行本次重置——不经队列直接同步时，先入队的 append 任务会在
        // 重置完成后把已清空的消息挂回空图（幻影节点，切分支时"复活"）。队列内按入队顺序串行，
        // 图活跃路径与主历史严格一致。
        const branchService = getGlobalBranchService();
        if (branchService) {
            try {
                await this.withGraphSyncQueue(conversationId, async () => {
                    await branchService.syncGraphAfterHistoryDelete(conversationId, firstMessageId, { forceResetToEmpty: true });
                });
            } catch (error) {
                log.warn('branch_clear_history_sync_failed', {
                    conversationId,
                    error: (error as Error)?.message ?? String(error),
                });
            }
        }
    }

    // ==================== 查询和过滤 ====================
    /**
     * 查找消息（实现见 manager/query.ts）
     */
    async findMessages(
        conversationId: string,
        filter: MessageFilter
    ): Promise<MessagePosition[]> {
        return await this.query.findMessages(conversationId, filter);
    }

    /**
     * 获取指定角色的所有消息（实现见 manager/query.ts）
     */
    async getMessagesByRole(
        conversationId: string,
        role: 'user' | 'model' | 'system'
    ): Promise<Content[]> {
        return await this.query.getMessagesByRole(conversationId, role);
    }

    async createSnapshot(
        conversationId: string,
        name?: string,
        description?: string
    ): Promise<HistorySnapshot> {
        return await this.lifecycle.createSnapshot(conversationId, name, description);
    }

    async restoreSnapshot(conversationId: string, snapshotId: string): Promise<void> {
        return await this.lifecycle.restoreSnapshot(conversationId, snapshotId);
    }

    async deleteSnapshot(snapshotId: string): Promise<void> {
        return await this.lifecycle.deleteSnapshot(snapshotId);
    }

    async listSnapshots(conversationId: string): Promise<string[]> {
        return await this.lifecycle.listSnapshots(conversationId);
    }

    // ==================== 统计信息 ====================

    /**
     * 获取统计信息
     */
    async getStats(conversationId: string): Promise<ConversationStats> {
        const history = await this.loadHistory(conversationId);
        return computeStatsFrom(history);
    }

    /**
     * 从已加载内容计算统计（HIS-03/HIS-04）：同一迭代内避免重复 loadHistory。
     */
    getStatsFrom(contents: ReadonlyArray<Content>): ConversationStats {
        return computeStatsFrom(contents);
    }


    /**
     * 获取适合 API 调用的对话历史
     *
     * 此方法返回格式化的历史记录，移除内部字段（如 token 计数）
     *
     * 思考内容过滤策略：
     * - 默认情况下，只保留最后一个非函数响应 user 消息及之后的思考内容和签名
     * - 如果启用 sendHistoryThoughts，则保留所有历史思考内容
     * - 如果启用 sendHistoryThoughtSignatures，则保留所有历史思考签名（按渠道类型过滤）
     *
     * @param conversationId 对话 ID
     * @param options 选项对象（向后兼容：如果传入 boolean，视为 includeThoughts）
     * @returns 格式化的对话历史，移除了 token 计数字段
     *
     * @example
     * // 不含思考（用于常规 API 调用）
     * const history = await manager.getHistoryForAPI('chat-001');
     *
     * // 含思考（用于带思考的 API 调用，如 Gemini 3）
     * const historyWithThoughts = await manager.getHistoryForAPI('chat-001', { includeThoughts: true });
     *
     * // 发送所有历史思考签名（Gemini 格式）
     * const historyWithSignatures = await manager.getHistoryForAPI('chat-001', {
     *     includeThoughts: true,
     *     sendHistoryThoughtSignatures: true,
     *     channelType: 'gemini'
     * });
     */
    async getHistoryForAPI(
        conversationId: string,
        options: GetHistoryOptions | boolean = false
    ): Promise<ConversationHistory> {
        const history = await this.loadHistory(conversationId);
        return formatHistoryForAPI(history, options);
    }

    /**
     * 从已加载的原始内容直接格式化（HIS-03/HIS-04）。
     *
     * 同一逻辑步骤内（上下文裁剪、Token 计算、工具配对、API 格式化）已经拿到完整
     * 历史时，不要再调用 getHistoryForAPI(conversationId) 触发第二次 loadHistory；
     * 直接把该数组传进来格式化。跨越历史写入后必须重新获取 contents，不能长期缓存旧引用。
     */
    getHistoryForAPIFrom(
        contents: ReadonlyArray<Content>,
        options: GetHistoryOptions | boolean = false
    ): ConversationHistory {
        return formatHistoryForAPI(contents, options);
    }

    async setTitle(conversationId: string, title: string): Promise<void> {
        return await this.metadata.setTitle(conversationId, title);
    }

    async setWorkspaceUri(conversationId: string, workspaceUri?: string): Promise<void> {
        return await this.metadata.setWorkspaceUri(conversationId, workspaceUri);
    }

    async getMetadata(conversationId: string): Promise<ConversationMetadata | null> {
        return await this.metadata.getMetadata(conversationId);
    }

    async updateSummary(
        conversationId: string,
        summary: { messageCount?: number; preview?: string }
    ): Promise<void> {
        return await this.metadata.updateSummary(conversationId, summary);
    }

    async getMetadataLight(conversationId: string): Promise<ConversationMetadata | null> {
        return await this.metadata.getMetadataLight(conversationId);
    }

    async getConversationMetadataBatch(conversationIds: string[]): Promise<ConversationSummary[]> {
        return await this.metadata.getConversationMetadataBatch(conversationIds);
    }


    /**
     * 获取 conversations 目录的本地文件系统路径（供用量统计目录监听使用）；
     * 存储适配器不支持时返回 undefined，统计退化全量扫描。
     */
    getConversationsDirFsPath(): string | undefined {
        return this.storage.getConversationsDirFsPath?.();
    }

    async saveSubAgentTranscript(conversationId: string, runId: string, data: SubAgentTranscriptData): Promise<string> {
        if (!this.storage.saveSubAgentTranscript) {
            throw new Error('SubAgent transcript storage is unavailable');
        }
        return await this.storage.saveSubAgentTranscript(conversationId, runId, data);
    }

    async loadSubAgentTranscript(conversationId: string, runId: string): Promise<SubAgentTranscriptData | null> {
        return this.storage.loadSubAgentTranscript
            ? await this.storage.loadSubAgentTranscript(conversationId, runId)
            : null;
    }

    async deleteSubAgentTranscript(conversationId: string, runId: string): Promise<void> {
        await this.storage.deleteSubAgentTranscript?.(conversationId, runId);
    }

    async setCustomMetadata(
        conversationId: string,
        key: string,
        value: unknown
    ): Promise<void> {
        return await this.metadata.setCustomMetadata(conversationId, key, value);
    }

    async updateCustomMetadata(
        conversationId: string,
        key: string,
        updater: (current: unknown) => unknown | Promise<unknown>
    ): Promise<unknown> {
        return await this.metadata.updateCustomMetadata(conversationId, key, updater);
    }

    async getCustomMetadata(conversationId: string, key: string): Promise<unknown> {
        return await this.metadata.getCustomMetadata(conversationId, key);
    }


    

    // ==================== 工具调用管理 ====================

    /**
     * 标记指定消息中的工具调用为拒绝状态（实现见 manager/toolCalls.ts）
     */
    async rejectToolCalls(
        conversationId: string,
        messageIndex: number,
        toolCallIds?: string[]
    ): Promise<void> {
        return await this.toolCalls.rejectToolCalls(conversationId, messageIndex, toolCallIds);
    }

    /**
     * 拒绝所有未响应的工具调用（实现见 manager/toolCalls.ts）
     */
    async rejectAllPendingToolCalls(
        conversationId: string,
        options: { preserveDetachedSubAgents?: boolean } = {}
    ): Promise<void> {
        return await this.toolCalls.rejectAllPendingToolCalls(conversationId, options);
    }

    /**
     * 结算工具执行结果：用真实 functionResponse 覆盖占位拒绝（实现见 manager/toolCalls.ts）
     */
    async settleFunctionResponses(conversationId: string, parts: ContentPart[]): Promise<void> {
        return await this.toolCalls.settleFunctionResponses(conversationId, parts);
    }
}
