import { ConversationMutationService, ConversationMessageChangedError, type DeleteToMessageCapture } from './manager/ConversationMutationService';
import { ConversationPersistenceService } from './manager/ConversationPersistenceService';
export { ConversationMessageChangedError };
export type { DeleteToMessageCapture };
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

import {
    ConversationHistory,
    ConversationMetadata,
    Content,
    ContentPart,
    MessagePosition,
    MessageFilter,
    HistorySnapshot,
    ConversationStats,
    CONVERSATION_CONTEXT_TRIM_STATE_KEY,
} from './types';
import type { ConversationStorageLocation, IStorageAdapter, SubAgentTranscriptData } from './storage';
import { withHangTimeout } from './storageWriteQueues';
import { isRealUserMessage } from './helpers';
import { type ITranscriptRepository } from './TranscriptRepository';

import { type UsageIndexMessage, type UsageIndexStore } from './usageStats';
import { getGlobalBranchService } from './branch/BranchService';

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
    private readonly mutations: ConversationMutationService;
    private readonly persistence: ConversationPersistenceService;
    private readonly nodeIds: ConversationNodeIdService;
    private readonly lifecycle: ConversationLifecycleService;

    constructor(private storage: IStorageAdapter, private readonly usageIndexStore?: UsageIndexStore) {
        this.metadata = new ConversationMetadataService(storage);
        this.persistence = new ConversationPersistenceService({
            storage,
            usageIndexStore,
            loadHistory: (conversationId, workspaceUri) => this.loadHistory(conversationId, workspaceUri),
            assertNotDeleted: conversationId => this.lifecycle.assertNotDeleted(conversationId),
            invalidateCaches: conversationId => this.invalidateCaches(conversationId),
            readTailContent: conversationId => this.readTailContent(conversationId),
            withGraphSyncQueue: (conversationId, task) => this.withGraphSyncQueue(conversationId, task),
            withConversationWriteLock: (conversationId, task) => this.withConversationWriteLock(conversationId, task),
        });
        this.mutations = new ConversationMutationService({
            metadata: this.metadata,
            getTranscriptRepository: (conversationId, workspaceUri) => this.getTranscriptRepository(conversationId, workspaceUri),
            invalidateContextManagementState: (conversationId, reason) => this.invalidateContextManagementState(conversationId, reason),
            withGraphSyncQueue: (conversationId, task) => this.withGraphSyncQueue(conversationId, task),
            getFirstMessageId: conversationId => this.getFirstMessageId(conversationId),
        });
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
        return this.persistence.getTranscriptRepository(conversationId, workspaceUri);
    }

    /**
     * 对话落盘后同步维护用量索引（消息级 token 明细，供统计页免全量扫描）。
     *
     * 失败静默降级：索引写失败不影响对话保存主流程，统计侧会按 mtime 判定
     * stale/missing 并重建兜底。空历史不写索引（createConversation 的初始化落盘）。
     */
    private async updateUsageIndex(conversationId: string, history: ConversationHistory): Promise<void> {
        return this.persistence.updateUsageIndex(conversationId, history);
    }

    /**
     * 增量维护用量索引（HIS-08）：普通追加助手消息只更新对应用量条目；
     * 仅追加 user/functionResponse 时不重复写盘。增量不可用（索引缺失/损坏）
     * 时回退全量重建；删除/编辑/回档/分支切换仍走全量重建（updateUsageIndex）。
     */
    private async updateUsageIndexAppend(conversationId: string, appended: ConversationHistory): Promise<void> {
        return this.persistence.updateUsageIndexAppend(conversationId, appended);
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
        return this.persistence.appendUsageIndexMessages(conversationId, messages);
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
        return this.mutations.updateMessage(conversationId, messageIndex, updates);
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
        return this.mutations.updateMessagesBatch(conversationId, updates);
    }

    /**
     * 删除消息
     */
    async deleteMessage(conversationId: string, messageIndex: number): Promise<void> {
        return this.mutations.deleteMessage(conversationId, messageIndex);
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
        return this.mutations.insertMessage(conversationId, position, role, parts);
    }

    /** 在指定数值位置插入；实际钳制与写入委托给锁内解析版本。 */
    async insertContent(
        conversationId: string,
        position: number,
        content: Content
    ): Promise<void> {
        return this.mutations.insertContent(conversationId, position, content);
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
        return this.mutations.deleteMessagesInRange(conversationId, startIndex, endIndex);
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
        return this.mutations.deleteToMessage(conversationId, targetIndex, expectedMessageId, capture);
    }

    /**
     * 清空对话历史
     */
    async clearHistory(conversationId: string): Promise<void> {
        return this.mutations.clearHistory(conversationId);
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
