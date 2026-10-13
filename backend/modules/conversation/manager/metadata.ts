import { t } from '../../../i18n';
import { Logger } from '../../../core/logger';
import type { ConversationMetadata } from '../types';
import type { ConversationStorageIntegrity, HistoryIndexInfo, IStorageAdapter } from '../storage';
import { withMetadataWriteSerialized } from '../storageWriteQueues';
import { createFallbackMetadata, resolveIntegrityStatus } from './metadataUtils';
import { runBounded } from './utils';
import type { ConversationSummary } from './types';

const log = Logger.get('ConversationManager');

/** 元数据缓存、完整性读取和写入共用一个所有者；历史提交通过显式失效保持一致。 */
export class ConversationMetadataService {
    constructor(private readonly storage: IStorageAdapter) {}


    /** 会话元数据 LRU（容量上限：对话列表分页 + 打开标签页通常远小于此） */
    private static readonly META_CACHE_CAPACITY = 256;


    private readonly metaCache = new Map<string, { value: ConversationMetadata | null; version: number | undefined }>();
    private cacheEpoch = 0;


    private touchMetaCache(conversationId: string): void {
        const value = this.metaCache.get(conversationId);
        if (value !== undefined) {
            this.metaCache.delete(conversationId);
            this.metaCache.set(conversationId, value);
        }
        if (this.metaCache.size > ConversationMetadataService.META_CACHE_CAPACITY) {
            const oldest = this.metaCache.keys().next().value;
            if (oldest !== undefined) {
                this.metaCache.delete(oldest);
            }
        }
    }


    cacheMetadata(conversationId: string, metadata: ConversationMetadata | null): void {
        this.metaCache.set(conversationId, { value: metadata, version: this.storage.metadataVersion });
        this.touchMetaCache(conversationId);
    }


    /**
     * 元数据落盘并同步缓存：所有 ConversationManager 层级的 saveMetadata 都应走这里，
     * 保证写后读（getMetadataLight）命中缓存而不是重新走磁盘。
     */
    async persistMetadata(meta: ConversationMetadata): Promise<void> {
        await this.storage.saveMetadata(meta);
        this.cacheMetadata(meta.id, meta);
    }



    private async loadMetadataForWrite(conversationId: string): Promise<ConversationMetadata | null> {
        const result = await this.storage.loadMetadataWithStatus(conversationId);
        if (result.value) {
            return result.value;
        }
        if (!result.errorCode || result.errorCode === 'not_found') {
            // R5b-2.5：元数据缺失（not_found）时先确认历史仍存在，再允许调用方基于基础字段重建。
            // 删除对话后并发的 setTitle/updateSummary/setCustomMetadata 会基于 not_found
            // 重建并落盘 meta.json，把已删除会话的元数据“复活”（幽灵 meta）。
            // 历史不存在 → 会话已删除或从未创建 → 抛错中断写入（跳过重建），
            // 与 append/mutate 入口的 assertNotDeleted 短路语义一致。
            const indexInfo = await this.resolveHistoryIndexInfo(conversationId);
            if (!indexInfo?.exists) {
                throw new Error(
                    `Conversation ${conversationId} has been deleted or does not exist; refusing to write metadata`
                );
            }
            return null;
        }
        throw new Error(
            `Failed to load conversation metadata (${result.errorCode}) for ${conversationId}: ${result.errorMessage || 'Unknown error'}`
        );
    }


    async loadStoredMetadata(conversationId: string): Promise<ConversationMetadata | null> {
        const result = await this.storage.loadMetadataWithStatus(conversationId);
        if (result.value) {
            return result.value;
        }
        if (!result.errorCode || result.errorCode === 'not_found') {
            return null;
        }
        throw new Error(
            `Failed to load conversation metadata (${result.errorCode}) for ${conversationId}: ${result.errorMessage || 'Unknown error'}`
        );
    }



    // ==================== 元数据管理 ====================

    /**
     * 设置对话标题
     */
    async setTitle(conversationId: string, title: string): Promise<void> {
        // 整对象读改写必须与 setCustomMetadata 共用同一条元数据写链：
        // 否则并发时 setTitle 基于旧 meta 的后写会把 custom 对象整体冲掉
        // （同类覆盖丢失，见 setCustomMetadata 的锁注释）。
        await withMetadataWriteSerialized(conversationId, async () => {
            let meta = await this.loadMetadataForWrite(conversationId);
            if (!meta) {
                meta = {
                    id: conversationId,
                    title,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                    custom: {}
                };
            } else {
                meta.title = title;
                meta.updatedAt = Date.now();
            }
            await this.persistMetadata(meta);
        });
    }


    /**
     * 设置工作区 URI
     *
     * workspaceUri 传 undefined 表示解绑对话（恢复"跟随活动编辑器"）：
     * 元数据持久化时该字段会被 JSON.stringify 丢弃，即从磁盘移除。
     */
    async setWorkspaceUri(conversationId: string, workspaceUri?: string): Promise<void> {
        // 同 setTitle：整对象读改写必须与 setCustomMetadata 共用同一条元数据写链。
        await withMetadataWriteSerialized(conversationId, async () => {
            let meta = await this.loadMetadataForWrite(conversationId);
            if (!meta) {
                meta = {
                    id: conversationId,
                    title: t('modules.conversation.defaultTitle', { conversationId }),
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                    workspaceUri,
                    custom: {}
                };
            } else {
                meta.workspaceUri = workspaceUri;
                meta.updatedAt = Date.now();
            }
            await this.persistMetadata(meta);
        });
    }


    /**
     * 获取对话元数据
     *
     * HIS-11：完整性检查只读历史索引结构（index.json 的 totalMessages/segments），
     * 不再解析末段历史消息内容，避免长对话下每次打开元数据都读一段文件。
     */
    async getMetadata(conversationId: string): Promise<ConversationMetadata | null> {
        const [metadataResult, indexInfo] = await Promise.all([
            this.storage.loadMetadataWithStatus(conversationId),
            this.resolveHistoryIndexInfo(conversationId),
        ]);

        const historyExists = indexInfo?.exists ?? false;
        const integrity: ConversationStorageIntegrity = {
            historyExists,
            metadataExists: metadataResult.value !== null || metadataResult.errorCode !== 'not_found',
            historyReadable: indexInfo?.readable ?? false,
            metadataReadable: metadataResult.value !== null,
            historyErrorCode: indexInfo?.errorCode,
            metadataErrorCode: metadataResult.errorCode,
            historyErrorMessage: indexInfo?.errorMessage,
            metadataErrorMessage: metadataResult.errorMessage,
        };
        const integrityStatus = resolveIntegrityStatus(integrity);

        if (metadataResult.value) {
            const metadata = JSON.parse(JSON.stringify(metadataResult.value)) as ConversationMetadata;
            if (integrityStatus && integrityStatus !== 'ok') {
                metadata.integrityStatus = integrityStatus;
            } else {
                delete metadata.integrityStatus;
            }
            return metadata;
        }

        if (!historyExists) {
            return null;
        }

        // 元数据文件损坏（parse_error）降级：不向调用方抛 UNKNOWN_ERROR。
        // 把损坏文件改名备份为 {id}.meta.json.corrupt-{Date.now()}（只保留一份，改名失败不阻塞），
        // 之后 loadMetadataWithStatus 对该会话返回 not_found，写路径（loadMetadataForWrite）会
        // 基于基础字段重建元数据，不会再被同一个损坏文件反复中断。
        // 降级代价：custom 字段（如 checkpoints 存档记录列表）随损坏文件丢失——cp_xxx 备份目录
        // 仍留在数据目录中，但 removeOrphanBackupDirs 只在显式清理时执行，不会自动删除。
        if (metadataResult.errorCode && metadataResult.errorCode !== 'not_found') {
            if (metadataResult.errorCode === 'parse_error') {
                // 只有 parse_error（文件内容损坏）才改名备份；io_error 等瞬时读错误不改名（文件未必损坏）。
                try {
                    if (typeof this.storage.backupCorruptMetadata === 'function') {
                        await this.storage.backupCorruptMetadata(conversationId);
                    }
                } catch (error) {
                    // 备份失败不阻塞降级主流程（改名失败不阻塞）
                    log.warn('metadata.corruptBackupFailed', { conversationId, error: String(error) });
                }
                log.warn('metadata.corruptFallback', {
                    conversationId,
                    errorCode: metadataResult.errorCode,
                    errorMessage: metadataResult.errorMessage,
                    note: 'meta.json 损坏：已改名备份并返回从历史重建的 fallback 元数据；custom 字段（含 checkpoints 存档记录列表）丢失，cp_xxx 备份目录不会被自动清理',
                });
            } else {
                log.warn('metadata.unreadableFallback', {
                    conversationId,
                    errorCode: metadataResult.errorCode,
                    errorMessage: metadataResult.errorMessage,
                });
            }
        }

        const historyResult = await this.storage.loadHistoryWithStatus(conversationId);
        const fallback = createFallbackMetadata(conversationId, historyResult.value);
        if (integrityStatus) {
            fallback.integrityStatus = integrityStatus;
        }
        return fallback;
    }


    /**
     * 轻量读取历史消息总数（updateSummary M3 钳制用，HIS-11）：
     * 优先走只读 index JSON 的 getHistoryTotalMessages（1 次读、0 次逐段 stat）；
     * 适配器未实现时回退 getHistoryIndexInfo（可能逐段 stat，仅旧适配器）。
     * 返回 null 表示索引不可读 / legacy / 不存在（钳制应跳过）。
     */
    private async resolveHistoryTotalMessages(conversationId: string): Promise<number | null> {
        if (typeof this.storage.getHistoryTotalMessages === 'function') {
            try {
                return await this.storage.getHistoryTotalMessages(conversationId);
            } catch {
                return null;
            }
        }
        const indexInfo = await this.resolveHistoryIndexInfo(conversationId);
        return typeof indexInfo?.totalMessages === 'number' ? indexInfo.totalMessages : null;
    }


    /**
     * 只读历史索引结构（不解析消息内容）。
     * 适配器实现 getHistoryIndexInfo 时优先使用；否则用完整性检查兜底（同样不读消息）。
     */
    private async resolveHistoryIndexInfo(conversationId: string): Promise<HistoryIndexInfo | null> {
        if (typeof this.storage.getHistoryIndexInfo === 'function') {
            return await this.storage.getHistoryIndexInfo(conversationId);
        }
        const integrity = await this.storage.getConversationIntegrity(conversationId);
        return {
            exists: integrity.historyExists,
            readable: integrity.historyReadable,
            errorCode: integrity.historyErrorCode,
            errorMessage: integrity.historyErrorMessage,
        };
    }


    /**
     * 一次性合并写入对话摘要元数据（HIS-09）。
     *
     * messageCount / preview 一次 loadMetadata+saveMetadata 写入；
     * updatedAt 由后端历史提交（saveHistory/appendHistory）统一维护，不在此重复写。
     * 真正的 custom metadata 修改（setCustomMetadata/updateCustomMetadata）仍即时持久化。
     */
    async updateSummary(
        conversationId: string,
        summary: { messageCount?: number; preview?: string }
    ): Promise<void> {
        await withMetadataWriteSerialized(conversationId, async () => {
            let meta = await this.loadMetadataForWrite(conversationId);
            if (!meta) {
                meta = {
                    id: conversationId,
                    title: t('modules.conversation.defaultTitle', { conversationId }),
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                    custom: {}
                };
            }
            if (!meta.custom) {
                meta.custom = {};
            }
            let messageCount = summary.messageCount;
            if (messageCount !== undefined) {
                // 消息数以已提交的历史为准，避免前端乐观值偏高或迟到摘要覆盖成旧的较小值。
                // 只读历史索引，不加载正文；旧格式或索引不可读时保留调用方提供的值。
                const totalMessages = await this.resolveHistoryTotalMessages(conversationId);
                if (typeof totalMessages === 'number' && totalMessages >= 0) {
                    messageCount = totalMessages;
                }
                meta.custom.messageCount = messageCount;
            }
            if (summary.preview !== undefined) {
                meta.custom.preview = summary.preview;
            }
            // 注释语义：updatedAt 由历史提交路径（saveHistory/appendHistory 的 refreshUpdatedAt）
            // 统一维护，不在此重复写——避免 appendHistory 失败但前端仍乐观调用 updateSummary 时，
            // updatedAt 被无意义前移导致对话列表排序抖动。
            await this.persistMetadata(meta);
        });
    }


    /**
     * 结构性变更后同步 custom.messageCount（HIS-11 配套，防对话列表 messageCount 漂移）。
     *
     * deleteMessage / deleteMessagesInRange / deleteToMessage / clearHistory 是结构性变更，
     * 此前只有 updateSummary 会钳制写入 messageCount，这些路径不更新 → custom.messageCount
     * 永久超前于真实历史，对话列表消息数漂移。这里基于变更后的实际历史长度直接写入：
     * 长度来自本次变更结果，天然不超过真实历史，无需 updateSummary 的钳制逻辑。
     *
     * 与 updateSummary 保持一致的约定：
     * - 整对象读改写走同一元数据写链（withMetadataWriteSerialized），避免与
     *   updateSummary/setTitle/updateCustomMetadata 并发时互相覆盖 custom 字段；
     * - 不更新 updatedAt（由历史提交路径 saveHistory/appendHistory 统一维护）；
     * - 元数据缺失（历史存在但无 meta.json）时不重建 meta，仅跳过；
     * - 会话已删除时 loadMetadataForWrite 抛错，由本方法 catch 吞掉（messageCount 属展示性
     *   元数据，同步失败不阻塞结构性删除主流程，仅告警）。
     */
    async syncMessageCountAfterStructuralChange(conversationId: string, count: number): Promise<void> {
        try {
            await withMetadataWriteSerialized(conversationId, async () => {
                const meta = await this.loadMetadataForWrite(conversationId);
                if (!meta) {
                    return; // 元数据缺失（历史存在）：不重建，仅跳过
                }
                if (!meta.custom) {
                    meta.custom = {};
                }
                if (meta.custom.messageCount === count) {
                    return; // 无变化，跳过写回
                }
                meta.custom.messageCount = count;
                await this.persistMetadata(meta);
            });
        } catch (error) {
            log.warn('conversation.messageCountSyncFailed', {
                conversationId,
                count,
                error: String(error),
            });
        }
    }


    /**
     * 轻量读取对话元数据（供用量统计等只关心 title/updatedAt 的场景使用）
     *
     * 与 getMetadata 不同：只读 meta.json，不加载历史做完整性检查、
     * 不生成 fallback 元数据——统计侧对缺失 meta 直接回退对话 ID 展示。
     * 避免每次统计都为每个对话额外读一次历史（getMetadata 的 loadHistoryPage）。
     */
    async getMetadataLight(conversationId: string): Promise<ConversationMetadata | null> {
        // 与 getMetadata 同源：metaCache 是最近一次持久化快照（所有写路径统一失效/回填），
        // 命中即跳过磁盘 IO——对话列表分页（每页 30 条）与用量统计/检查点查询的逐对话读取
        // 从「每次 fs 读 + JSON parse」降为纯内存命中。返回深拷贝，防止调用方污染缓存。
        const version = this.storage.metadataVersion;
        const epoch = this.cacheEpoch;
        const cached = this.metaCache.get(conversationId);
        if (cached !== undefined && cached.version === version) {
            this.touchMetaCache(conversationId);
            return cached.value === null ? null : JSON.parse(JSON.stringify(cached.value)) as ConversationMetadata;
        }
        const result = await this.storage.loadMetadataWithStatus(conversationId);
        // 写入或显式失效可能先于旧读取返回，旧结果可返回给原调用方，但不能重新填入当前缓存。
        const canCache = epoch === this.cacheEpoch && version === this.storage.metadataVersion;
        if (result.value) {
            if (canCache) this.cacheMetadata(conversationId, result.value);
            // 未命中路径同样返回深拷贝：直接返回原始引用会让调用方修改污染 metaCache
            // （与命中路径同一语义，防止缓存被污染后其它读误用）。
            return JSON.parse(JSON.stringify(result.value)) as ConversationMetadata;
        }
        // 与 loadStoredMetadata 相同的降级语义：仅 not_found 才做负缓存，
        // io_error/parse_error 不缓存（parse_error 的 getMetadata 走损坏降级，不在此污染缓存）
        if (canCache && (!result.errorCode || result.errorCode === 'not_found')) {
            this.cacheMetadata(conversationId, null);
        }
        return result.value ?? null;
    }


    /**
     * 批量获取对话摘要元数据（HIS-10）。
     *
     * 对话列表一次 IPC 拉一页摘要，避免每个对话一次 IPC。
     * 只读 meta.json（getMetadataLight），不做完整性检查、不解析历史。
     */
    async getConversationMetadataBatch(conversationIds: string[]): Promise<ConversationSummary[]> {
        const all = Array.isArray(conversationIds) ? conversationIds : [];
        const truncated = all.length > 200;
        const ids = all.slice(0, 200);
        if (ids.length === 0) return [];
        const summaries = await runBounded(ids, 16, async conversationId => this.buildConversationSummary(conversationId));
        // 截断标志：附加到数组对象上（保持数组主体不变，现有前端按“实际返回数”推进游标不受影响；
        // 支持 structured clone 的通道可读到 truncated，纯 JSON 序列化通道忽略该字段）。
        if (truncated) {
            (summaries as ConversationSummary[] & { truncated?: boolean }).truncated = true;
        }
        return summaries;
    }


    private async buildConversationSummary(conversationId: string): Promise<ConversationSummary> {
        const meta = await this.getMetadataLight(conversationId);
        const custom = (meta?.custom ?? {}) as Record<string, unknown>;
        const now = Date.now();
        return {
            id: conversationId,
            title: typeof meta?.title === 'string' && meta.title.trim()
                ? meta.title
                : `Chat ${conversationId.slice(0, 8)}`,
            createdAt: typeof meta?.createdAt === 'number' ? meta.createdAt : now,
            updatedAt: typeof meta?.updatedAt === 'number'
                ? meta.updatedAt
                : (typeof custom.updatedAt === 'number' ? custom.updatedAt : now),
            messageCount: typeof custom.messageCount === 'number' ? custom.messageCount : 0,
            preview: typeof custom.preview === 'string' ? custom.preview : undefined,
            workspaceUri: typeof meta?.workspaceUri === 'string' ? meta.workspaceUri : undefined,
            integrityStatus: typeof meta?.integrityStatus === 'string' ? meta.integrityStatus : undefined,
        };
    }


    /**
     * 设置自定义元数据
     */
    async setCustomMetadata(
        conversationId: string,
        key: string,
        value: unknown
    ): Promise<void> {
        // read-modify-write 必须与 storage.saveHistory 内部的 updatedAt 更新共用同一条元数据写链：
        // 两条独立串行链并发时，后写者基于旧 meta 的整体写回会把先写者的整个 custom 对象覆盖掉
        // （检查点列表 / 裁剪状态随机丢失）。
        await withMetadataWriteSerialized(conversationId, async () => {
            let meta = await this.loadMetadataForWrite(conversationId);
            if (!meta) {
                meta = {
                    id: conversationId,
                    title: t('modules.conversation.defaultTitle', { conversationId }),
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                    custom: {}
                };
            }

            if (!meta.custom) {
                meta.custom = {};
            }
            meta.custom[key] = value;
            meta.updatedAt = Date.now();

            await this.persistMetadata(meta);
        });
    }


    /**
     * 原子更新自定义元数据：链内「读 meta（缺则建）→ next = await updater(current) → next === current 时跳过写回
     * → 否则写回」。返回值是 updater 的结果。
     *
     * updater 可以是异步的（如需要现场核验文件存在性）：整个动作仍在会话级元数据写链内串行执行，
     * 不会与其他元数据读改写互相覆盖。适用于检查点列表等「读列表 → 内存改 → 整体写回」的 RMW 操作：
     * 并发创建/删除时不会互相覆盖。
     */
    async updateCustomMetadata(
        conversationId: string,
        key: string,
        updater: (current: unknown) => unknown | Promise<unknown>
    ): Promise<unknown> {
        return await withMetadataWriteSerialized(conversationId, async () => {
            let meta = await this.loadMetadataForWrite(conversationId);
            if (!meta) {
                meta = {
                    id: conversationId,
                    title: t('modules.conversation.defaultTitle', { conversationId }),
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                    custom: {}
                };
            }

            if (!meta.custom) {
                meta.custom = {};
            }
            const current = meta.custom[key];
            const next = await updater(current);
            if (next === current) {
                return current; // 无变更，跳过写回
            }

            meta.custom[key] = next;
            meta.updatedAt = Date.now();
            await this.persistMetadata(meta);
            return next;
        });
    }


    /**
     * 获取自定义元数据
     *
     * 与 getMetadataLight 相同的降级语义：meta.json 损坏（parse_error）/读失败（io_error）时
     * 不向调用方抛错，返回 undefined（调用方按缺失处理），避免 todo/checkpoints/trimState 等
     * 工具侧因元数据损坏整体中断。
     */
    async getCustomMetadata(conversationId: string, key: string): Promise<unknown> {
        const result = await this.storage.loadMetadataWithStatus(conversationId);
        return result.value?.custom?.[key];
    }

    invalidateCache(conversationId: string): void {
        this.cacheEpoch++;
        this.metaCache.delete(conversationId);
    }

    clearCache(): void {
        this.cacheEpoch++;
        this.metaCache.clear();
    }
}
