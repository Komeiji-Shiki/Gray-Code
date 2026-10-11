import { t } from '../../../i18n';
import { Logger } from '../../../core/logger';
import { agentMailbox } from '../../../core/services/agentMailbox';
import { getDiffStorageManager } from '../DiffStorageManager';
import { getGlobalBranchService } from '../branch/BranchService';
import type { ConversationHistory, ConversationMetadata, HistorySnapshot } from '../types';
import type { IStorageAdapter } from '../storage';
import type { ITranscriptRepository } from '../TranscriptRepository';
import type { UsageIndexStore } from '../usageStats';
import { buildBranchCustomMetadata, buildBranchTitle, cloneJson, getTextPreviewFromContent } from './metadataUtils';
import { needsNodeIdMigration } from './nodeId';
import type { ConversationMetadataService } from './metadata';
import type { ConversationNodeIdService } from './nodeIdService';
import type { CreateBranchConversationResult } from './types';

const log = Logger.get('ConversationManager');

interface ConversationLifecycleContext {
    storage: IStorageAdapter;
    usageIndexStore?: UsageIndexStore;
    metadata: ConversationMetadataService;
    nodeIds: ConversationNodeIdService;
    withConversationWriteLock<T>(conversationId: string, task: () => Promise<T>): Promise<T>;
    withGraphSyncQueue(conversationId: string, task: () => Promise<void>): Promise<void>;
    loadHistory(conversationId: string): Promise<ConversationHistory>;
    updateUsageIndex(conversationId: string, history: ConversationHistory): Promise<void>;
    invalidateCaches(conversationId: string): void;
    getTranscriptRepository(conversationId: string): ITranscriptRepository;
    getFirstMessageId(conversationId: string): Promise<string | null>;
    invalidateContextManagementState(conversationId: string, reason: string): Promise<void>;
}

/** 会话与快照的创建、删除、恢复共用生命周期状态，持久化继续使用原有写队列。 */
export class ConversationLifecycleService {
    constructor(private readonly context: ConversationLifecycleContext) {}


    /**
     * 已删除会话集合：删除后新发起的 append/mutate 在此短路，防止流式收尾把已删除会话
     * 的历史目录重新创建（“删除后复活”竞态：delete 只排队到 storage 级写队列，保证已排队的
     * 写先完成再删，但删除后新发起的写会排到 delete 之后 → 重新创建 {id}/history/ 幽灵会话）。
     * 显式重建（createConversation 同 ID）时移除标记；删除失败时撤销标记。
     */
    private readonly deletedConversationIds = new Set<string>();

    private static readonly MAX_DELETED_IDS = 10000;


    /**
     * 同一会话 ID 的首次创建合并表。
     *
     * loadHistory 的按需创建可能与前端显式 createConversation 同时发生；两条路径都采用
     * “先查不存在、再落盘”时，后到者会把正常竞态误报成“对话已存在”。这里只合并仍在进行的
     * 创建，创建完成后的显式重复调用仍按原语义报错。
     */
    private readonly conversationCreations = new Map<string, Promise<void>>();


    /**
     * 同一 targetConversationId 的并发 createBranchConversation 合并表（BR-13）。
     * 与 conversationCreations 同风格：只合并仍在进行的创建；创建完成后的显式重复
     * 调用仍按「对话已存在」原语义报错。防止并发分支创建都通过「不存在」检查后
     * 互相覆盖落盘（内容不同的分支静默丢失其一）。
     */
    private readonly branchCreations = new Map<string, Promise<CreateBranchConversationResult>>();


    /** append/mutate 入口短路：会话已被删除时拒绝写入（正常删除后不应再有写入） */
    assertNotDeleted(conversationId: string): void {
        if (this.deletedConversationIds.has(conversationId)) {
            throw new Error(`Conversation ${conversationId} has been deleted; refusing to write history`);
        }
    }


    // ==================== 对话管理 ====================

    /**
     * 创建新对话
     * @param conversationId 对话 ID
     * @param title 对话标题
     * @param workspaceUri 工作区 URI（可选）
     */
    async createConversation(conversationId: string, title?: string, workspaceUri?: string): Promise<void> {
        const inFlight = this.conversationCreations.get(conversationId);
        if (inFlight) {
            await inFlight;
            return;
        }

        const creation = this.createConversationInternal(conversationId, title, workspaceUri);
        this.conversationCreations.set(conversationId, creation);
        try {
            await creation;
        } finally {
            if (this.conversationCreations.get(conversationId) === creation) {
                this.conversationCreations.delete(conversationId);
            }
        }
    }


    private async createConversationInternal(conversationId: string, title?: string, workspaceUri?: string): Promise<void> {
        // 显式重建同一 ID：撤销“已删除”标记（删除后新会话可正常写入）
        this.deletedConversationIds.delete(conversationId);
        // 检查存储中是否已存在
        const existing = await this.context.storage.loadHistoryWithStatus(conversationId);
        if (existing.value) {
            throw new Error(t('modules.conversation.errors.conversationExists', { conversationId }));
        }
        if (existing.errorCode && existing.errorCode !== 'not_found') {
            throw new Error(
                `Cannot create conversation ${conversationId}: history file is not readable (${existing.errorCode})`
            );
        }

        const now = Date.now();
        const meta: ConversationMetadata = {
            id: conversationId,
            title: title || t('modules.conversation.defaultTitle', { conversationId }),
            createdAt: now,
            updatedAt: now,
            workspaceUri,
            custom: {}
        };

        if (this.context.storage.createConversation) {
            await this.context.storage.createConversation(meta);
            this.context.metadata.cacheMetadata(meta.id, meta);
            await this.context.updateUsageIndex(conversationId, []);
        } else {
            await this.context.storage.saveHistory(conversationId, []);
            await this.context.updateUsageIndex(conversationId, []);
            await this.context.metadata.persistMetadata(meta);
        }
    }



    /**
     * 基于源对话的某条消息创建分支对话。
     *
     * 分支会复制从开头到目标消息（包含目标消息）的完整 Gemini 历史，
     * 并继承模型、提示词模式、固定文件和 Skills 等稳定上下文元数据。
     * 运行态元数据（如 checkpoints、activeBuild、pendingApprovalGate、trimState）不会复制。
     */
    async createBranchConversation(
        sourceConversationId: string,
        branchAtIndex: number,
        options: { conversationId?: string; title?: string; workspaceUri?: string } = {}
    ): Promise<CreateBranchConversationResult> {
        const normalizedSourceId = typeof sourceConversationId === 'string' ? sourceConversationId.trim() : '';
        if (!normalizedSourceId) {
            throw new Error('Source conversation id is required');
        }

        let history = await this.context.loadHistory(normalizedSourceId);
        if (needsNodeIdMigration(history)) {
            // BR-01/BR-02：分支源历史先完成惰性补 ID（首次分支操作也是迁移触发点），
            // 保证复制到新对话的历史带稳定节点 ID（BR-09 sourceNodeId 依赖）。
            await this.context.nodeIds.ensureHistoryNodeIds(normalizedSourceId);
            history = await this.context.loadHistory(normalizedSourceId);
        }
        if (history.length === 0) {
            throw new Error('Cannot create a branch from an empty conversation');
        }

        const index = Math.floor(branchAtIndex);
        if (!Number.isFinite(index) || index < 0 || index >= history.length) {
            throw new Error(t('modules.conversation.errors.messageIndexOutOfBounds', { index: branchAtIndex }));
        }

        const targetConversationId = typeof options.conversationId === 'string' && options.conversationId.trim()
            ? options.conversationId.trim()
            : `conv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

        // BR-13：同一 targetConversationId 的并发 createBranchConversation 去重保护。
        // 两条并发调用都可能先通过「历史不存在」检查（existing.value 为空），随后各自落盘
        // 互相覆盖（后写覆盖先写，内容不同的分支会静默丢失其一）。与 createConversation 的
        // conversationCreations 同风格：先到者持有 in-flight 创建，后到者等待其完成后重查
        // 「已存在」按原语义报错（幂等保护）；先到者失败未落盘时后到者继续正常创建。
        const inFlight = this.branchCreations.get(targetConversationId);
        if (inFlight) {
            // 先到者失败（未落盘）时忽略其错误，后到者按「不存在」语义继续正常创建
            await inFlight.catch(() => undefined);
            const recheck = await this.context.storage.loadHistoryWithStatus(targetConversationId);
            if (recheck.value) {
                throw new Error(t('modules.conversation.errors.conversationExists', { conversationId: targetConversationId }));
            }
        }

        const creation = this.createBranchConversationCore(
            normalizedSourceId,
            history,
            index,
            targetConversationId,
            options
        );
        this.branchCreations.set(targetConversationId, creation);
        try {
            return await creation;
        } finally {
            if (this.branchCreations.get(targetConversationId) === creation) {
                this.branchCreations.delete(targetConversationId);
            }
        }
    }


    /**
     * createBranchConversation 的核心落盘体（BR-13 并发去重保护的受保护区）。
     *
     * 入参 history/index 已在调用方完成分支点校验，此处只做目标会话的存在性检查与落盘。
     */
    private async createBranchConversationCore(
        normalizedSourceId: string,
        history: ConversationHistory,
        index: number,
        targetConversationId: string,
        options: { conversationId?: string; title?: string; workspaceUri?: string }
    ): Promise<CreateBranchConversationResult> {
        const existing = await this.context.storage.loadHistoryWithStatus(targetConversationId);
        if (existing.value) {
            throw new Error(t('modules.conversation.errors.conversationExists', { conversationId: targetConversationId }));
        }
        if (existing.errorCode && existing.errorCode !== 'not_found') {
            throw new Error(
                `Cannot create branch conversation ${targetConversationId}: history file is not readable (${existing.errorCode})`
            );
        }

        const sourceMeta = await this.context.metadata.loadStoredMetadata(normalizedSourceId);
        const now = Date.now();
        const branchHistory = cloneJson(history.slice(0, index + 1));
        const messageCount = branchHistory.length;
        const lastUserMessage = [...branchHistory]
            .reverse()
            .find(message => message.role === 'user' && !message.isFunctionResponse);
        const preview = getTextPreviewFromContent(lastUserMessage);
        const title = typeof options.title === 'string' && options.title.trim()
            ? options.title.trim()
            : buildBranchTitle(sourceMeta?.title, index);
        const workspaceUri = typeof options.workspaceUri === 'string' && options.workspaceUri.trim()
            ? options.workspaceUri.trim()
            : sourceMeta?.workspaceUri;

        // BR-09：分支点（复制到的最后一条消息）的稳定节点 ID——metadata 双写 + BranchGraph 建模的入参
        const sourceNodeId = typeof branchHistory[branchHistory.length - 1]?.id === 'string'
            ? branchHistory[branchHistory.length - 1]!.id
            : undefined;

        const meta: ConversationMetadata = {
            id: targetConversationId,
            title,
            createdAt: now,
            updatedAt: now,
            workspaceUri,
            custom: buildBranchCustomMetadata(
                sourceMeta?.custom,
                normalizedSourceId,
                index,
                messageCount,
                preview,
                now,
                sourceNodeId
            )
        };

        await this.context.storage.saveHistory(targetConversationId, branchHistory);
        await this.context.updateUsageIndex(targetConversationId, branchHistory);
        await this.context.metadata.persistMetadata(meta);

        // BR-09：跨对话「复制为新对话」建模进 BranchGraph（分支服务未注册时跳过——测试/旧环境不阻塞）
        if (sourceNodeId) {
            try {
                const branchService = getGlobalBranchService();
                if (branchService) {
                    // 新对话：全量导入（kind='imported'）+ 图元数据 exportedFrom；
                    // 源头对话：exportedRefs 列表记录导出关系（最小实现，不新增标注节点）。
                    await branchService.initializeBranchConversation(
                        targetConversationId,
                        normalizedSourceId,
                        sourceNodeId
                    );
                    await branchService.recordExport(normalizedSourceId, targetConversationId, sourceNodeId);
                }
            } catch (error) {
                log.warn('branch_graph_init_failed', {
                    conversationId: targetConversationId,
                    error: (error as Error)?.message ?? String(error)
                });
            }
        }

        return {
            conversationId: targetConversationId,
            title,
            createdAt: now,
            updatedAt: now,
            messageCount,
            preview,
            workspaceUri
        };
    }


    /**
     * 删除对话
     */
    async deleteConversation(conversationId: string): Promise<void> {
        // 先记入已删除集合再执行删除：删除进行中/完成后新发起的 append/mutate 被短路，
        // 不会在 delete 之后重新创建历史目录（“删除后复活”）。已排队在 storage 写队列里的
        // 旧写会先于 delete 完成（写写串行），随后被 delete 一并清掉。
        this.deletedConversationIds.add(conversationId);
        if (this.deletedConversationIds.size > ConversationLifecycleService.MAX_DELETED_IDS) {
            // 防无界增长：淘汰最旧的已删除 ID（对应会话早已删除，不会再有新写入）
            const oldest = this.deletedConversationIds.values().next().value;
            if (oldest !== undefined) {
                this.deletedConversationIds.delete(oldest);
            }
        }
        try {
            // R2 3.2：删除与 append/mutate 共用会话写锁串行。此前 assertNotDeleted 只在
            // append 委托入口检查，删除可滑入「断言未删 → 读尾 → 入队 storage 写」的异步
            // 窗口：deleteHistory 先入队、append 的写随后入队，删除后新写重新创建历史目录
            // （幽灵会话）。删除入锁后：在途 append 先完成（其 storage 写在 delete 之前入队），
            // 删除后新发起的 append 在锁内被 assertNotDeleted 短路。
            await this.context.withConversationWriteLock(conversationId, async () => {
                await this.context.storage.deleteHistory(conversationId);
                // R5b-1.3：usage remove 的 enqueue 必须在会话写锁内完成。锁外 enqueue 时，
                // 在途 append 的 usage 写（appendUsage / 增量缺失回退读改写）可能晚于 remove
                // 入队，删除后被回退写重新创建 usage.json（“复活”）。锁内 enqueue 保证 remove
                // 排在在途 usage 写之后；删除后新发起的 append 已被 assertNotDeleted 短路。
                if (this.context.usageIndexStore) {
                    try {
                        await this.context.usageIndexStore.remove(conversationId);
                    } catch {
                        // 索引不存在/删除失败忽略（统计侧按 missing 自然跳过）
                    }
                }
                // MED-2：对话删除即清理 A-COMM 信箱（内存同步操作，与删除同一锁内原子执行；
                // 删除失败不会走到这里，信箱状态与对话生命周期保持一致，防 ID 复用时限流/误注入）
                agentMailbox.clearConversation(conversationId);
                // 删除成功后统一失效元数据缓存：已删除会话的快照（含负缓存）不得泄漏给下一次读；
                // 节点 ID 反查缓存一并清除（BCP-01：防 ID 复用后反查命中旧会话节点）
                this.context.invalidateCaches(conversationId);
                // 「已迁移」标记一并失效（会话 ID 可能被复用重建）
                this.context.nodeIds.forgetMigration(conversationId);
            });
        } catch (error) {
            // 删除失败：撤销标记，避免会话被冻结（后续 append/mutate 仍可用）
            this.deletedConversationIds.delete(conversationId);
            throw error;
        }

        // 清理孤儿快照：listSnapshots 已按会话过滤，删除对话时必须一并清理，
        // 否则 snapshots/ 目录残留孤儿数据（低危 L10）。
        try {
            const snapshots = await this.context.storage.listSnapshots(conversationId);
            for (const snapshotId of snapshots) {
                await this.context.storage.deleteSnapshot(snapshotId);
            }
        } catch {
            // 快照清理失败不影响对话删除
        }

        // 清理孤儿 diff 目录（对话已删除但 diff 文件残留）
        try {
            const diffStorageManager = getDiffStorageManager();
            if (diffStorageManager) {
                await diffStorageManager.deleteConversationDiffs(conversationId);
            }
        } catch {
            // diff 清理失败不影响对话删除
        }

        // BR-04/BR-06：清理分支 sidecar（branches.json）
        // 分支服务未注册（测试环境等）时跳过；清理失败不影响对话删除（残留为孤儿文件，无害）
        try {
            const branchService = getGlobalBranchService();
            if (branchService) {
                await branchService.deleteConversationBranch(conversationId);
            }
        } catch {
            // sidecar 清理失败不影响对话删除
        }
    }





    // ==================== 快照管理 ====================

    /**
     * 创建快照
     */
    async createSnapshot(
        conversationId: string,
        name?: string,
        description?: string
    ): Promise<HistorySnapshot> {
        const history = await this.context.loadHistory(conversationId);
        const snapshot: HistorySnapshot = {
            // Date.now() 同一毫秒内连续创建会互相覆盖，追加随机后缀保证唯一
            id: `snapshot_${conversationId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            conversationId,
            name,
            description,
            timestamp: Date.now(),
            // loadHistory 返回的是存储层 M2 浅拷贝：元素顶层是新对象，但嵌套结构（parts 等）
            // 仍与 HistorySegmentCache 共享引用。快照仅序列化落盘 + 只读返回（调用方约定不得
            // 原地修改嵌套结构，需修改应先深拷贝），因此不需要再全量深拷贝一次。
            history,
        };
        await this.context.storage.saveSnapshot(snapshot);
        return snapshot;
    }


    /**
     * 恢复快照
     */
    async restoreSnapshot(conversationId: string, snapshotId: string): Promise<void> {
        const snapshot = await this.context.storage.loadSnapshot(snapshotId);
        if (!snapshot) {
            throw new Error(t('modules.conversation.errors.snapshotNotFound', { snapshotId }));
        }
        if (snapshot.conversationId !== conversationId) {
            throw new Error(t('modules.conversation.errors.snapshotNotBelongToConversation'));
        }
        
        const repository = this.context.getTranscriptRepository(conversationId);
        // 恢复为空历史时等价 clearHistory，需要首条旧消息 id 作为分支图重置锚点；
        // 轻量读取（只读首段），避免 getContents 的全量深拷贝。
        // 快照内容可能来自旧格式（无稳定 id）：先失效「已迁移」标记，写回后由惰性迁移兜底。
        this.context.nodeIds.forgetMigration(conversationId);
        const firstMessageId = snapshot.history.length === 0
            ? await this.context.getFirstMessageId(conversationId)
            : null;

        await repository.replaceContents(snapshot.history);
        // HIS-11：整体重写后同步 custom.messageCount（防对话列表 messageCount 漂移）
        await this.context.metadata.syncMessageCountAfterStructuralChange(conversationId, snapshot.history.length);
        await this.context.invalidateContextManagementState(conversationId, 'snapshot_restored');

        // 决策 6：整体重写主历史后同步分支图（此前 restoreSnapshot 只改主历史，branches.json
        // 仍含旧节点与旧活跃尾，后续 append 挂旧尾、切分支时消息"复活"）。
        // - 恢复为空历史：等价清空，按删除路径整体重置图（rebase 无法处理「空历史 + 非空图」）；
        // - 其余：按恢复后的主历史重建活跃路径（对齐 delete 路径 deletedWasSummary 分支的
        //   rebase 保留逻辑——旧候选保留为归档，活跃路径以主历史为准）。
        // 无分支图 / 无锚点幂等 no-op；失败仅告警不阻断（主历史为唯一真源）。
        // 图同步进会话级串行队列（graphSyncQueues，与 appendContents 同一队列）：恢复前已入队的
        // append 图同步必须先完成，再执行本次重建/重置——不经队列直接同步时，先入队的 append
        // 任务会把已恢复（清空/替换）的消息挂回图（幻影节点，切分支时"复活"）。
        const branchService = getGlobalBranchService();
        if (branchService) {
            try {
                await this.context.withGraphSyncQueue(conversationId, async () => {
                    if (snapshot.history.length === 0) {
                        // 恢复为空历史 = 等价清空：无条件重置空图（forceResetToEmpty 不依赖锚点
                        // 是否图根/是否存在——历史早空但图残留旧根的陈旧场景同样重置）
                        await branchService.syncGraphAfterHistoryDelete(conversationId, firstMessageId, { forceResetToEmpty: true });
                    } else {
                        await branchService.syncMainHistoryAfterStructuralMutation(conversationId, 'summary_restored');
                    }
                });
            } catch (error) {
                log.warn('branch_snapshot_restore_sync_failed', {
                    conversationId,
                    snapshotId,
                    error: (error as Error)?.message ?? String(error),
                });
            }
        }
    }


    /**
     * 删除快照
     */
    async deleteSnapshot(snapshotId: string): Promise<void> {
        await this.context.storage.deleteSnapshot(snapshotId);
    }


    /**
     * 列出对话的所有快照
     */
    async listSnapshots(conversationId: string): Promise<string[]> {
        return await this.context.storage.listSnapshots(conversationId);
    }

    isDeleted(conversationId: string): boolean {
        return this.deletedConversationIds.has(conversationId);
    }
}
