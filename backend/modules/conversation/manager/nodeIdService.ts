import type { ConversationHistory } from '../types';
import type { IStorageAdapter } from '../storage';
import { buildMigratedHistory, computeHistoryFingerprint, needsNodeIdMigration } from './nodeId';

interface ConversationNodeIdContext {
    storage: IStorageAdapter;
    withConversationWriteLock<T>(conversationId: string, task: () => Promise<T>): Promise<T>;
    assertNotDeleted(conversationId: string): void;
    invalidateCaches(conversationId: string): void;
    updateUsageIndex(conversationId: string, history: ConversationHistory): Promise<void>;
    loadHistory(conversationId: string): Promise<ConversationHistory>;
}

/** 稳定节点 ID 的迁移标记、反查缓存与写入代际一起管理，写锁仍由会话管理器提供。 */
export class ConversationNodeIdService {
    constructor(private readonly context: ConversationNodeIdContext) {}

    /**
     * BCP-01 PERF：getMessageNodeIdAt 短 TTL 缓存时长。
     * 该缓存只在「缓存条目的权威数据」上生效（见 nodeIdCache 注释），TTL 仅用于
     * 兜底会话外部的直写存储场景（进程内写链全部走失效，不受 TTL 影响）。
     */
    private static readonly NODE_ID_CACHE_TTL_MS = 300;

    /** BCP-01 PERF：节点 ID 反查缓存容量（与历史 LRU 同量级） */
    private static readonly NODE_ID_CACHE_CAPACITY = 24;

    /**
     * BCP-01 PERF：getMessageNodeIdAt 的轻量读缓存（history 引用 + 填充时刻）。
     *
     * 现状：CheckpointService 在每个消息前/后、工具执行前后频繁反查节点 ID，每次
     * 反查都全量重读 transcript 文件，一轮对话产生十几次全量磁盘 IO。
     * 缓存契约（与 metaCache 一致）：
     * - 只在「权威条目」上生效——由 loadHistory/saveContents/ensureHistoryNodeIds 等
     *   读盘或写盘路径填充的条目（createConversation 的「空历史种子」不填充本缓存，
     *   避免种子状态被外部直写存储更新后反查命中陈旧快照）；
     * - 所有写路径（invalidateCaches / append-only 失效）同步删除条目，保证读缓存与
     *   写链一致；TTL 仅在无写变更但外部直写存储的极端场景兜底。
     */
    private readonly nodeIdCache = new Map<string, { history: ConversationHistory; storedAt: number }>();

    /**
     * BCP-01 PERF 补充：节点 ID 反查缓存的写链代际计数。
     *
     * getMessageNodeIdAt 读盘不持会话写锁：读盘开始 → 写提交并失效缓存 → 读盘完成
     * 用旧盘面回填缓存，会在 300ms TTL 窗口内返回陈旧节点 id。每次 invalidateCaches
     * 递增对应会话计数，读盘前后计数一致才允许回填，消除该窗口。
     */
    private readonly nodeIdCacheEpochs = new Map<string, number>();

    /**
     * 全局单调 epoch 计数器：每个会话的 epoch 取全局递增值，清理 Map 时不会归零。
     * 若 per-conversation 自增 + 整体清空，清空后所有会话回落为 0，恰好与
     * 「读盘前捕获 0」的在途反查碰撞（0 === 0 误放行回填），竞态窗口回归。
     */
    private nodeIdCacheEpochCounter = 0;


    private bumpNodeIdCacheEpoch(conversationId: string): void {
        this.nodeIdCacheEpochs.set(conversationId, ++this.nodeIdCacheEpochCounter);
        if (this.nodeIdCacheEpochs.size > 200) {
            // LRU 淘汰最旧而非整体 clear()：整体清空会把「刚 bump 的条目」也删掉，
            // 让「清空后 get 回落为 undefined ?? 0」与首次读捕获的 0 碰撞（0 === 0 误放行）；
            // 删最旧则刚写入的条目必然幸存，且被淘汰会话的在途读（捕获旧值 N ≥ 1）
            // 与回落值 0 不相等，守卫保持完整。
            const oldest = this.nodeIdCacheEpochs.keys().next().value;
            if (oldest !== undefined) {
                this.nodeIdCacheEpochs.delete(oldest);
            }
        }
    }


    /** LRU 触碰 + 容量淘汰（节点 ID 反查缓存专用） */
    private touchNodeIdCache(conversationId: string): void {
        const value = this.nodeIdCache.get(conversationId);
        if (value !== undefined) {
            this.nodeIdCache.delete(conversationId);
            this.nodeIdCache.set(conversationId, value);
        }
        if (this.nodeIdCache.size > ConversationNodeIdService.NODE_ID_CACHE_CAPACITY) {
            const oldest = this.nodeIdCache.keys().next().value;
            if (oldest !== undefined) {
                this.nodeIdCache.delete(oldest);
            }
        }
    }


    /**
     * 已确认「无需节点 ID 迁移」的会话集合（内存标记，BR-02 append 热路径优化）。
     *
     * ensureHistoryNodeIds 每次调用都全量读盘 + 全量迁移判据扫描；有分支图的会话每条
     * 消息 append 都会经 appendHistoryToGraph 再触发一次（appendContents 已保证新消息带
     * 稳定 id，迁移判据必然为否）。标记后跳过全量读盘：
     * - 写入时机：确认无需迁移 / 迁移成功（含写回校验）时；
     * - 失效时机：restoreSnapshot（可能写入旧格式无 id 历史）与 deleteConversation；
     * - 跨进程直写存储的极端场景由标记失效 + 后续完整迁移路径兜底（与 metaCache 同取舍）。
     */
    private readonly nodeIdMigratedConversationIds = new Set<string>();


    /**
     * BR-02：旧历史惰性补 ID（幂等迁移）。
     *
     * 检测到历史存在无 id（或 parentId 未定义）的消息时，在会话写锁内按数组顺序生成
     * 确定性 ID（namespace=conversationId，seed=role+index+timestamp）+ 线性 parentId，
     * 并全量重写一次（复用 saveHistory 分段原子写路径 + 用量索引全量重建）。
     *
     * 幂等保证：
     * - 迁移后「全量有 id 且 parentId 已定义」作为幂等判据（自判定，无需额外标记文件）；
     * - 确定性生成保证同一历史多次迁移产出同一 ID 集合；
     * - 已有 id/parentId 的消息原样保留。
     *
     * 回滚/校验：迁移前记录 totalMessages + 首尾结构指纹，写回后回读校验；
     * saveHistory 为 tmp+rename 原子写，校验失败即抛错（上层按迁移失败处理，不留下部分迁移状态）。
     *
     * @returns 是否发生了迁移
     */
    async ensureHistoryNodeIds(conversationId: string): Promise<boolean> {
        // 已迁移标记命中：直接跳过全量读盘 + 迁移判据扫描（append 热路径——有分支图的
        // 会话每条消息 append 都会经 appendHistoryToGraph 触发一次本调用）。
        // 标记由下方「确认无需迁移 / 迁移成功」写入；restoreSnapshot / deleteConversation 失效。
        if (this.nodeIdMigratedConversationIds.has(conversationId)) {
            return false;
        }
        return await this.context.withConversationWriteLock(conversationId, async () => {
            const result = await this.context.storage.loadHistoryWithStatus(conversationId);
            const history = result.value;
            if (!history || history.length === 0) {
                // 空历史/不存在：无需迁移（后续写入均带稳定 id），标记后跳过后续全量读
                this.nodeIdMigratedConversationIds.add(conversationId);
                return false;
            }

            if (!needsNodeIdMigration(history)) {
                this.nodeIdMigratedConversationIds.add(conversationId);
                return false;
            }

            const beforeTotal = history.length;
            const beforeFingerprint = computeHistoryFingerprint(history);

            const migrated = buildMigratedHistory(conversationId, history);

            this.context.assertNotDeleted(conversationId);
            await this.context.storage.saveHistory(conversationId, migrated);
            // 迁移直写不走仓储：同步失效元数据缓存（存储层刷新 updatedAt）；迁移重写了历史，
            // 节点 ID 反查缓存一并失效（BCP-01）
            this.context.invalidateCaches(conversationId);
            await this.context.updateUsageIndex(conversationId, migrated);

            const persisted = await this.context.storage.loadHistoryWithStatus(conversationId);
            const afterTotal = persisted.value?.length ?? -1;
            const afterFingerprint = computeHistoryFingerprint(persisted.value ?? []);
            if (afterTotal !== beforeTotal || afterFingerprint !== beforeFingerprint) {
                throw new Error(
                    `Node ID migration verification failed for conversation ${conversationId}: ` +
                    `total ${beforeTotal}→${afterTotal}, fingerprint ${beforeFingerprint}→${afterFingerprint}`
                );
            }
            // 迁移成功（含写回校验通过）：标记已迁移，后续 append 不再全量读盘
            this.nodeIdMigratedConversationIds.add(conversationId);
            return true;
        });
    }


    /**
     * BCP-01: 按消息索引反查稳定节点 ID（存档关联 messageNodeId 用）。
     *
     * - 旧历史（无 id / parentId 未定义）先触发 BR-02 惰性补 ID（幂等），保证反查结果稳定；
     * - index 越界或消息无 id 时返回 undefined：调用方按“无 nodeId”处理，
     *   不阻塞既有按 messageIndex 的定位/删除路径（兼容旧存档）。
     */
    async getMessageNodeIdAt(conversationId: string, index: number): Promise<string | undefined> {
        if (!Number.isInteger(index) || index < 0) {
            return undefined;
        }
        // BCP-01 PERF：短 TTL 读缓存——CheckpointService 每个消息前/后、工具执行前后
        // 频繁反查，同一条写链内多次全量读盘是纯浪费（写路径已统一失效本缓存，进程内
        // 写链上的反查永远命中权威快照；TTL 仅兜底会话外部直写存储的极端场景）。
        const cached = this.nodeIdCache.get(conversationId);
        if (cached && Date.now() - cached.storedAt < ConversationNodeIdService.NODE_ID_CACHE_TTL_MS) {
            const cachedMessage = cached.history[index];
            return typeof cachedMessage?.id === 'string' && cachedMessage.id.length > 0
                ? cachedMessage.id
                : undefined;
        }
        // 直读磁盘（不经内存缓存）：调用方可能刚写入历史（含外部直写存储的迁移场景），
        // 缓存可能滞后；反查是低频操作，直接读最保守。
        const epochBeforeRead = this.nodeIdCacheEpochs.get(conversationId) ?? 0;
        const result = await this.context.storage.loadHistoryWithStatus(conversationId);
        let history = result.value ?? [];
        if (needsNodeIdMigration(history)) {
            // BR-02：写锁内幂等补 ID（迁移自判定），迁移后重新读取
            await this.ensureHistoryNodeIds(conversationId);
            history = await this.context.loadHistory(conversationId);
        }
        // 读盘期间若有写提交并失效缓存（epoch 变化），本次读到的可能是旧盘面，不得回填——
        // 否则 300ms TTL 窗口内反查命中陈旧节点 id（如存档绑定到已删除的节点）。
        if ((this.nodeIdCacheEpochs.get(conversationId) ?? 0) === epochBeforeRead) {
            this.nodeIdCache.set(conversationId, { history, storedAt: Date.now() });
            this.touchNodeIdCache(conversationId);
        }
        const message = history[index];
        return typeof message?.id === 'string' && message.id.length > 0 ? message.id : undefined;
    }

    invalidateCache(conversationId: string): void {
        this.nodeIdCache.delete(conversationId);
        this.bumpNodeIdCacheEpoch(conversationId);
    }

    forgetMigration(conversationId: string): void {
        this.nodeIdMigratedConversationIds.delete(conversationId);
    }
}
