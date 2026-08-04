/**
 * LimCode - 对话历史管理器
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
    ConversationTailVersion,
    ConversationTailVersionInfo,
    CONVERSATION_CONTEXT_TRIM_STATE_KEY
} from './types';
import type { ConversationStorageIntegrity, ConversationStorageLocation, HistoryIndexInfo, IStorageAdapter } from './storage';
import { withMetadataWriteSerialized } from './storage';
import { cleanFunctionResponseForAPI } from './helpers';
import { ConversationTranscriptRepository, type ITranscriptRepository } from './TranscriptRepository';
import { deleteLogicalMessage, truncateFrom } from './TranscriptMutation';
import { estimatePartialMessageTokens, buildConversationUsageIndex, type UsageIndexMessage, type UsageIndexStore } from './usageStats';
import { getDiffStorageManager } from './DiffStorageManager';
import { Logger } from '../../core/logger';

const log = Logger.get('ConversationManager');

/**
 * 适配器不支持 saveTailVersions 时，尾部版本回退存储在 custom 元数据的键名。
 */
const TAIL_VERSIONS_META_KEY = 'tailVersions';

/**
 * 多模态能力（用于过滤历史中的多模态数据）
 */
export interface MultimodalCapability {
    /** 是否支持图片 */
    supportsImages: boolean;
    /** 是否支持文档（PDF） */
    supportsDocuments: boolean;
    /** 是否支持回传多模态数据到历史记录 */
    supportsHistoryMultimodal: boolean;
}

/**
 * 获取历史的选项
 */
export interface GetHistoryOptions {
    /** 是否包含当前轮次的思考内容（默认 false） */
    includeThoughts?: boolean;
    
    /** 是否发送历史思考内容（默认 false） */
    sendHistoryThoughts?: boolean;
    
    /** 是否发送历史思考签名（默认 false） */
    sendHistoryThoughtSignatures?: boolean;

    /** 是否发送当前轮次的思考内容（默认根据渠道决定） */
    sendCurrentThoughts?: boolean;

    /** 是否发送当前轮次的思考签名（默认根据渠道决定） */
    sendCurrentThoughtSignatures?: boolean;
    
    /** 渠道类型，用于选择对应格式的签名 */
    channelType?: 'gemini' | 'openai' | 'anthropic' | 'openai-responses' | 'custom';
    
    /**
     * 多模态能力（可选）
     *
     * 如果提供，将根据能力过滤历史中的多模态数据：
     * - 如果不支持 supportsHistoryMultimodal，则过滤所有历史中的 inlineData
     * - 如果不支持 supportsDocuments，则过滤文档类型的 inlineData
     * - 如果不支持 supportsImages，则过滤图片类型的 inlineData
     */
    multimodalCapability?: MultimodalCapability;
    
    /**
     * 历史思考回合数
     *
     * 控制发送多少轮非最新回合的历史对话思考：
     * - `-1`: 发送全部历史回合的思考（默认值）
     * - `0`: 不发送任何历史回合的思考
     * - 正数 `n`: 发送最近 n 轮非最新回合的思考（如 1 表示只发送倒数第二回合）
     *
     * 仅在 sendHistoryThoughts 或 sendHistoryThoughtSignatures 为 true 时生效
     */
    historyThinkingRounds?: number;
    
    /**
     * 起始索引（可选）
     *
     * 从指定索引开始获取历史，用于上下文裁剪。
     * 默认为 0（从头开始）。
     */
    startIndex?: number;

    /**
     * 是否保留内部动态上下文字段 turnDynamicContext。
     *
     * 默认 false：常规 API 历史会过滤内部字段。
     * preserve 策略构建请求时会开启，用于把旧动态上下文固定插回原位。
     */
    includeTurnDynamicContext?: boolean;
}

export interface CreateBranchConversationResult {
    conversationId: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    messageCount: number;
    preview?: string;
    workspaceUri?: string;
}

/**
 * 对话列表摘要（HIS-10）：一次批量 IPC 返回一页对话列表所需的轻量元数据。
 * 完整 metadata 只在打开具体对话时读取。
 */
export interface ConversationSummary {
    id: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    messageCount: number;
    preview?: string;
    workspaceUri?: string;
    integrityStatus?: string;
}


/**
 * 对话管理器
 *
 * 特点:
 * - 完整支持 Gemini 格式的所有特性
 * - 自动维护元数据
 * - 支持思考签名、函数调用等高级特性
 * - 可直接将历史发送给 Gemini API
 * - 带内存缓存：历史/元数据按会话 LRU 缓存，所有写路径统一失效，
 *   读取热路径（列表元数据、分页、API 历史）不再重复走磁盘
 */
export class ConversationManager {
    constructor(private storage: IStorageAdapter, private readonly usageIndexStore?: UsageIndexStore) {}

    // ==================== 内存缓存 ====================

    /** 会话历史 LRU（容量上限：超出按插入序淘汰最旧会话） */
    private static readonly HISTORY_CACHE_CAPACITY = 24;
    /** 会话元数据 LRU（容量上限：对话列表分页 + 打开标签页通常远小于此） */
    private static readonly META_CACHE_CAPACITY = 256;

    private readonly historyCache = new Map<string, ConversationHistory>();
    private readonly metaCache = new Map<string, ConversationMetadata | null>();

    private touchCache<T>(map: Map<string, T>, key: string, capacity: number): void {
        const value = map.get(key);
        if (value !== undefined) {
            map.delete(key);
            map.set(key, value);
        }
        if (map.size > capacity) {
            const oldest = map.keys().next().value;
            if (oldest !== undefined) {
                map.delete(oldest);
            }
        }
    }

    /** 会话所有缓存统一失效（历史/元数据）；结构性变更后必须调用 */
    private invalidateCaches(conversationId: string): void {
        this.historyCache.delete(conversationId);
        this.metaCache.delete(conversationId);
    }

    private cacheHistory(conversationId: string, history: ConversationHistory): void {
        this.historyCache.set(conversationId, history);
        this.touchCache(this.historyCache, conversationId, ConversationManager.HISTORY_CACHE_CAPACITY);
    }

    private cacheMetadata(conversationId: string, metadata: ConversationMetadata | null): void {
        this.metaCache.set(conversationId, metadata);
        this.touchCache(this.metaCache, conversationId, ConversationManager.META_CACHE_CAPACITY);
    }

    /** 供测试/诊断清理全部缓存 */
    clearCaches(): void {
        this.historyCache.clear();
        this.metaCache.clear();
    }

    /**
     * 元数据落盘并同步缓存：所有 ConversationManager 层级的 saveMetadata 都应走这里，
     * 保证写后读命中缓存而不是重新走磁盘。
     */
    private async persistMetadata(meta: ConversationMetadata): Promise<void> {
        await this.storage.saveMetadata(meta);
        this.cacheMetadata(meta.id, meta);
    }

    /**
     * 同一会话的 read-modify-write 串行队列（历史 mutate、自定义元数据等）。
     * 无内存缓存、直接文件读改写：并发时后写覆盖先写，真实执行成功的工具结果
     * 会被"用户拒绝"占位覆盖，或两个并发 checkpoint 元数据互相覆盖整个 custom 对象。
     */
    private readonly conversationWriteQueues = new Map<string, Promise<void>>();

    private async withConversationWriteLock<T>(conversationId: string, task: () => Promise<T>): Promise<T> {
        const previous = this.conversationWriteQueues.get(conversationId) ?? Promise.resolve();
        const current = previous.catch(() => undefined).then(task);
        const tail = current.then(() => undefined, () => undefined);
        this.conversationWriteQueues.set(conversationId, tail);
        void tail.then(() => {
            if (this.conversationWriteQueues.get(conversationId) === tail) {
                this.conversationWriteQueues.delete(conversationId);
            }
        });
        return current;
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

    private shouldInvalidateContextManagementStateForUpdate(updates: Partial<Content>): boolean {
        return Object.prototype.hasOwnProperty.call(updates, 'parts')
            || Object.prototype.hasOwnProperty.call(updates, 'isSummary')
            || Object.prototype.hasOwnProperty.call(updates, 'isAutoSummary')
            || Object.prototype.hasOwnProperty.call(updates, 'summarizedMessageCount')
            || Object.prototype.hasOwnProperty.call(updates, 'isFunctionResponse');
    }

    getTranscriptRepository(conversationId: string): ITranscriptRepository {
        // 修改原因：主聊天 transcript 需要一个统一的仓储入口，供当前适配和后续协作者复用。
        // 修改方式：把 ConversationManager 既有的“缺失历史时自动建会话”读取语义，与底层 saveHistory 持久化语义一起绑定到仓储委托。
        // 修改目的：外部协作者不再直接接触 storage.loadHistory/saveHistory，也不会复制主聊天特有的初始化规则。
        return new ConversationTranscriptRepository({
            loadContents: async () => await this.loadHistory(conversationId),
            saveContents: async contents => {
                // 落盘后同步缓存：避免下一次读重新走磁盘；同时元数据（存储层 saveHistory 会刷新 updatedAt）
                // 必须失效，否则对话列表排序会读到陈旧时间戳。
                await this.storage.saveHistory(conversationId, contents);
                this.cacheHistory(conversationId, contents);
                this.metaCache.delete(conversationId);
                await this.updateUsageIndex(conversationId, contents);
            },
            // HIS-01/HIS-02：普通追加直通 append-only 尾段写入（不再读全量→push→全量写回）
            appendContents: async contents => {
                if (this.storage.appendHistory) {
                    await this.storage.appendHistory(conversationId, contents);
                } else {
                    // 无 append-only 存储（测试 fake 等）：回退全量读改写，语义不变
                    const history = await this.loadHistory(conversationId);
                    history.push(...contents);
                    await this.storage.saveHistory(conversationId, history);
                }
                // 关键补丁：appendHistory 直写不经过 saveContents 的缓存回填/失效，走 append-only
                // 路径后必须手动失效 LRU 缓存，否则 loadHistory/getMessagesPaged 命中陈旧快照
                // （聊天最后一条消息不显示）；metaCache 因存储层刷新 updatedAt 同样必须失效。
                this.historyCache.delete(conversationId);
                this.metaCache.delete(conversationId);
                await this.updateUsageIndexAppend(conversationId, contents);
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
            const rebuilt = buildConversationUsageIndex(conversationId, history);
            // 修改原因：子代理归集条目（source='subagent'）不在主历史里，全量重建
            //          必须从旧索引合并保留，否则主会话下次落盘后子代理消耗会从统计中消失。
            // 修改方式：重建时读取旧索引，仅保留 source='subagent' 的条目追加到新索引。
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

    private cloneJson<T>(value: T): T {
        return JSON.parse(JSON.stringify(value));
    }

    private getTextPreviewFromContent(content: Content | undefined, maxLength = 50): string | undefined {
        if (!content || !Array.isArray(content.parts)) return undefined;
        const text = content.parts
            .map(part => typeof part.text === 'string' ? part.text : '')
            .join('')
            .trim();
        if (!text) return undefined;
        return text.slice(0, maxLength);
    }

    private buildBranchTitle(sourceTitle: string | undefined, branchAtIndex: number): string {
        const base = typeof sourceTitle === 'string' && sourceTitle.trim()
            ? sourceTitle.trim()
            : 'Conversation';
        const maxBaseLength = 44;
        const compactBase = base.length > maxBaseLength ? `${base.slice(0, maxBaseLength)}...` : base;
        return `${compactBase} · Branch @${branchAtIndex + 1}`;
    }

    private buildBranchCustomMetadata(
        sourceCustom: Record<string, unknown> | undefined,
        sourceConversationId: string,
        branchAtIndex: number,
        messageCount: number,
        preview: string | undefined,
        createdAt: number
    ): Record<string, unknown> {
        const copied: Record<string, unknown> = {};
        const allowedKeys = [
            'inputModelConfig',
            'promptModeConfig',
            'inputPinnedFiles',
            'inputSkills',
            'todoList'
        ];

        if (sourceCustom && typeof sourceCustom === 'object') {
            for (const key of allowedKeys) {
                if (sourceCustom[key] !== undefined) {
                    copied[key] = this.cloneJson(sourceCustom[key]);
                }
            }
        }

        copied.messageCount = messageCount;
        if (preview) copied.preview = preview;
        copied.updatedAt = createdAt;
        copied.branch = {
            sourceConversationId,
            sourceMessageIndex: branchAtIndex,
            createdAt
        };

        return copied;
    }

    private resolveIntegrityStatus(
        integrity: ConversationStorageIntegrity | null
    ): ConversationMetadata['integrityStatus'] | undefined {
        if (!integrity) return undefined;
        if (!integrity.historyExists) return 'history_missing';
        if (!integrity.historyReadable) return 'history_corrupt';
        if (!integrity.metadataExists) return 'meta_missing';
        if (!integrity.metadataReadable) return 'meta_corrupt';
        return 'ok';
    }

    private async loadMetadataForWrite(conversationId: string): Promise<ConversationMetadata | null> {
        // 写路径直接读磁盘：写链上的调用方随后会整体写回 meta，缓存在此处可能已过期，
        // 而且写回后存储层（如 updatedAt 刷新）会改变内容，必须基于最新磁盘状态做读改写。
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

    private async loadStoredMetadata(conversationId: string): Promise<ConversationMetadata | null> {
        const cached = this.metaCache.get(conversationId);
        if (cached !== undefined) {
            return cached;
        }
        const result = await this.storage.loadMetadataWithStatus(conversationId);
        if (result.value) {
            this.cacheMetadata(conversationId, result.value);
            return result.value;
        }
        if (!result.errorCode || result.errorCode === 'not_found') {
            this.cacheMetadata(conversationId, null);
            return null;
        }
        throw new Error(
            `Failed to load conversation metadata (${result.errorCode}) for ${conversationId}: ${result.errorMessage || 'Unknown error'}`
        );
    }

    private createFallbackMetadata(
        conversationId: string,
        history: ConversationHistory | null
    ): ConversationMetadata {
        const timestamps = (history || [])
            .map(item => item.timestamp)
            .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
        const now = Date.now();
        const createdAt = timestamps.length > 0 ? Math.min(...timestamps) : now;
        const updatedAt = timestamps.length > 0 ? Math.max(...timestamps) : now;

        return {
            id: conversationId,
            title: t('modules.conversation.defaultTitle', { conversationId }),
            createdAt,
            updatedAt,
            custom: {},
        };
    }

    /**
     * 规范化历史：补齐未响应的工具调用（rejected + functionResponse 插入），并在必要时写回存储。
     *
     * 注意：此过程会改变 history 的长度，从而改变消息 index。
     * 前端依赖 index 进行删除/重试等操作，因此必须在返回前完成该规范化。
     * 整个读-改-写过程在仓储互斥执行器内完成；无未响应调用时不写回（返回原引用跳过），
     * 避免基于旧快照的整体写回覆盖并发落盘的真实工具结果。
     */
    private async normalizeHistoryForDisplay(conversationId: string): Promise<ConversationHistory> {
        return await this.getTranscriptRepository(conversationId).mutateContents(history => {
            // 收集所有 functionResponse 的 ID
            const respondedToolCallIds = new Set<string>();
            for (const message of history) {
                if (message.parts) {
                    for (const part of message.parts) {
                        if (part.functionResponse?.id) {
                            respondedToolCallIds.add(part.functionResponse.id);
                        }
                    }
                }
            }

            // 收集未响应的工具调用，记录它们所在的消息索引
            const unresolvedCallsByIndex: Map<number, Array<{ id: string; name: string }>> = new Map();
            for (let i = 0; i < history.length; i++) {
                const message = history[i];
                if (message.parts) {
                    for (const part of message.parts) {
                        if (part.functionCall && part.functionCall.id) {
                            // 如果工具调用没有对应的响应，且还没有被标记为 rejected
                            if (!respondedToolCallIds.has(part.functionCall.id) && !part.functionCall.rejected) {
                                part.functionCall.rejected = true;
                                const calls = unresolvedCallsByIndex.get(i) || [];
                                calls.push({
                                    id: part.functionCall.id,
                                    name: part.functionCall.name || 'unknown'
                                });
                                unresolvedCallsByIndex.set(i, calls);
                            }
                        }
                    }
                }
            }

            // 无未响应的工具调用：没有任何修改，返回原引用跳过写回
            if (unresolvedCallsByIndex.size === 0) {
                return history;
            }

            // 如果有未响应的工具调用，在工具调用消息紧接后面插入 functionResponse
            // 从后往前插入以避免索引偏移问题
            const sortedIndices = Array.from(unresolvedCallsByIndex.keys()).sort((a, b) => b - a);

            for (const messageIndex of sortedIndices) {
                const calls = unresolvedCallsByIndex.get(messageIndex)!;
                const rejectedResponseParts: ContentPart[] = calls.map(call => ({
                    functionResponse: {
                        name: call.name,
                        id: call.id,
                        response: {
                            success: false,
                            error: t('modules.api.chat.errors.userRejectedTool'),
                            rejected: true
                        }
                    }
                }));

                // 插到工具调用消息的紧接后面，保持与 functionCall 输出顺序一致
                const insertAt = this.findFunctionResponseInsertIndex(history, messageIndex);
                history.splice(insertAt, 0, {
                    role: 'user',
                    parts: rejectedResponseParts,
                    isFunctionResponse: true
                });
            }

            // 有新插入：返回新引用触发写回（契约：返回原引用=跳过写回）
            return history.slice();
        });
    }

    // ==================== 对话管理 ====================

    /**
     * 创建新对话
     * @param conversationId 对话 ID
     * @param title 对话标题
     * @param workspaceUri 工作区 URI（可选）
     */
    async createConversation(conversationId: string, title?: string, workspaceUri?: string): Promise<void> {
        // 检查存储中是否已存在
        const existing = await this.storage.loadHistoryWithStatus(conversationId);
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

        await this.storage.saveHistory(conversationId, []);
        await this.updateUsageIndex(conversationId, []);
        await this.persistMetadata(meta);
        // 新建会话的缓存种子：空历史 + 元数据，避免后续读取重复走磁盘
        this.cacheHistory(conversationId, []);
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

        const history = await this.loadHistory(normalizedSourceId);
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

        const existing = await this.storage.loadHistoryWithStatus(targetConversationId);
        if (existing.value) {
            throw new Error(t('modules.conversation.errors.conversationExists', { conversationId: targetConversationId }));
        }
        if (existing.errorCode && existing.errorCode !== 'not_found') {
            throw new Error(
                `Cannot create branch conversation ${targetConversationId}: history file is not readable (${existing.errorCode})`
            );
        }

        const sourceMeta = await this.loadStoredMetadata(normalizedSourceId);
        const now = Date.now();
        const branchHistory = this.cloneJson(history.slice(0, index + 1));
        const messageCount = branchHistory.length;
        const lastUserMessage = [...branchHistory]
            .reverse()
            .find(message => message.role === 'user' && !message.isFunctionResponse);
        const preview = this.getTextPreviewFromContent(lastUserMessage);
        const title = typeof options.title === 'string' && options.title.trim()
            ? options.title.trim()
            : this.buildBranchTitle(sourceMeta?.title, index);
        const workspaceUri = typeof options.workspaceUri === 'string' && options.workspaceUri.trim()
            ? options.workspaceUri.trim()
            : sourceMeta?.workspaceUri;

        const meta: ConversationMetadata = {
            id: targetConversationId,
            title,
            createdAt: now,
            updatedAt: now,
            workspaceUri,
            custom: this.buildBranchCustomMetadata(
                sourceMeta?.custom,
                normalizedSourceId,
                index,
                messageCount,
                preview,
                now
            )
        };

        await this.storage.saveHistory(targetConversationId, branchHistory);
        await this.updateUsageIndex(targetConversationId, branchHistory);
        await this.persistMetadata(meta);
        this.cacheHistory(targetConversationId, branchHistory);

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

    // ==================== 对话尾部版本（重roll树状分叉） ====================

    /** 每会话尾部版本上限：超出时按创建时间淘汰最旧版本 */
    private static readonly TAIL_VERSIONS_MAX = 10;

    /** 尾部版本摘要：取尾部第一条非空文本的截断 */
    private getTailPreview(tail: ConversationHistory, maxLength = 50): string | undefined {
        for (const message of tail) {
            if (!message.parts) continue;
            const text = message.parts
                .map(part => typeof part.text === 'string' ? part.text : '')
                .join('')
                .trim();
            if (text) {
                return text.slice(0, maxLength);
            }
        }
        return undefined;
    }

    private toTailVersionInfo(version: ConversationTailVersion): ConversationTailVersionInfo {
        return {
            id: version.id,
            branchIndex: version.branchIndex,
            createdAt: version.createdAt,
            preview: version.preview,
            messageCount: version.messageCount
        };
    }

    private async loadStoredTailVersions(conversationId: string): Promise<ConversationTailVersion[]> {
        try {
            if (this.storage.loadTailVersions) {
                const versions = await this.storage.loadTailVersions(conversationId);
                if (Array.isArray(versions)) return versions;
            }
        } catch (error) {
            console.warn('[ConversationManager] loadTailVersions failed:', error);
        }
        // 适配器不支持时回退到自定义元数据
        const custom = await this.getCustomMetadata(conversationId, TAIL_VERSIONS_META_KEY);
        return Array.isArray(custom) ? custom as ConversationTailVersion[] : [];
    }

    private async persistTailVersions(conversationId: string, versions: ConversationTailVersion[]): Promise<void> {
        if (this.storage.saveTailVersions) {
            await this.storage.saveTailVersions(conversationId, versions);
        } else {
            await this.setCustomMetadata(conversationId, TAIL_VERSIONS_META_KEY, versions);
        }
    }

    /**
     * 保存当前对话尾部（从 branchIndex 到末尾）为一个版本。
     *
     * 用于「重新生成 / 切换版本」前保留当前答案：内容与已有版本完全一致时跳过。
     */
    async saveTailVersion(
        conversationId: string,
        branchIndex: number
    ): Promise<{ saved: boolean; versionId?: string; versions: ConversationTailVersionInfo[] }> {
        const index = Math.floor(branchIndex);
        if (!Number.isFinite(index) || index < 0) {
            throw new Error(t('modules.conversation.errors.messageIndexOutOfBounds', { index: branchIndex }));
        }

        const repository = this.getTranscriptRepository(conversationId);
        const history = await repository.getContents();

        if (index >= history.length) {
            // 分支点之后没有内容，无需保存
            return { saved: false, versions: await this.listTailVersions(conversationId) };
        }

        const tail = history.slice(index).map(message => {
            // 存储层可能在截断后为消息附加 index 字段；版本保存/恢复时这些索引已失效，
            // 必须剥离，避免恢复后污染 transcript（前端索引由 getMessagesPaged 重新计算）。
            if ('index' in message) {
                const { index: _index, ...rest } = message;
                return rest as Content;
            }
            return message;
        });
        const versions = await this.loadStoredTailVersions(conversationId);

        // 与已有版本完全一致时跳过（避免切换/重roll 时重复落盘）
        const tailJson = JSON.stringify(tail);
        const existing = versions.find(v => v.branchIndex === index && JSON.stringify(v.messages) === tailJson);
        if (existing) {
            return { saved: false, versionId: existing.id, versions: versions.map(v => this.toTailVersionInfo(v)) };
        }

        const now = Date.now();
        const version: ConversationTailVersion = {
            id: `ver_${now}_${Math.random().toString(36).slice(2, 8)}`,
            branchIndex: index,
            createdAt: now,
            preview: this.getTailPreview(tail),
            messageCount: tail.length,
            messages: this.cloneJson(tail)
        };
        const next = [...versions, version];
        // 容量上限：按创建时间保留最近 TAIL_VERSIONS_MAX 个
        if (next.length > ConversationManager.TAIL_VERSIONS_MAX) {
            next.sort((a, b) => a.createdAt - b.createdAt);
            next.splice(0, next.length - ConversationManager.TAIL_VERSIONS_MAX);
        }
        await this.persistTailVersions(conversationId, next);
        return {
            saved: true,
            versionId: version.id,
            versions: next.map(v => this.toTailVersionInfo(v))
        };
    }

    /**
     * 列出对话的全部尾部版本摘要（不含消息内容）。
     */
    async listTailVersions(conversationId: string): Promise<ConversationTailVersionInfo[]> {
        const versions = await this.loadStoredTailVersions(conversationId);
        return versions.map(v => this.toTailVersionInfo(v));
    }

    /**
     * 切换到某个已保存的尾部版本。
     *
     * 切换前会把当前活跃尾部先保存为一个版本（内容重复时跳过），因此任何
     * 版本都不会丢失；随后将 transcript 截断到 branchIndex 并恢复目标版本尾部。
     */
    async restoreTailVersion(
        conversationId: string,
        branchIndex: number,
        versionId: string
    ): Promise<{ versions: ConversationTailVersionInfo[] }> {
        const index = Math.floor(branchIndex);
        if (!Number.isFinite(index) || index < 0) {
            throw new Error(t('modules.conversation.errors.messageIndexOutOfBounds', { index: branchIndex }));
        }
        if (!versionId) {
            throw new Error('versionId is required');
        }

        // 1. 先保存当前尾部（防止切换丢失当前答案）
        await this.saveTailVersion(conversationId, index);

        const versions = await this.loadStoredTailVersions(conversationId);
        const target = versions.find(v => v.id === versionId && v.branchIndex === index);
        if (!target) {
            throw new Error(`Tail version not found: ${versionId}`);
        }

        // 2. 截断到分支点并恢复目标尾部
        const repository = this.getTranscriptRepository(conversationId);
        await repository.mutateContents(history => {
            if (index >= history.length) {
                throw new Error(t('modules.conversation.errors.messageIndexOutOfBounds', { index }));
            }
            history.splice(index);
            history.push(...this.cloneJson(target.messages));
            return history.slice();
        });
        await this.invalidateContextManagementState(conversationId, 'tail_version_restored');

        return {
            versions: versions.map(v => this.toTailVersionInfo(v))
        };
    }

    /**
     * 删除对话
     */
    async deleteConversation(conversationId: string): Promise<void> {
        await this.storage.deleteHistory(conversationId);
        this.invalidateCaches(conversationId);
        // 用量索引随对话删除（失败忽略：统计侧按 missing 自然跳过）
        if (this.usageIndexStore) {
            try {
                await this.usageIndexStore.remove(conversationId);
            } catch {
                // 忽略
            }
        }

        // 清理孤儿快照：listSnapshots 已按会话过滤，删除对话时必须一并清理，
        // 否则 snapshots/ 目录残留孤儿数据（低危 L10）。
        try {
            const snapshots = await this.storage.listSnapshots(conversationId);
            for (const snapshotId of snapshots) {
                await this.storage.deleteSnapshot(snapshotId);
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
    }

    /**
     * 列出所有对话
     */
    async listConversations(): Promise<string[]> {
        return await this.storage.listConversations();
    }

    /**
     * 加载对话历史（缓存优先，避免热路径重复磁盘 IO）
     *
     * 缓存契约：
     * - 缓存存的是「最近一次持久化的 transcript 快照」的引用，读路径共享同一份对象；
     * - 所有写路径（TranscriptRepository.saveContents、createConversation、
     *   createBranchConversation、deleteConversation）必须调用 invalidateCaches 或重新填充缓存，
     *   否则旧快照会泄漏给下一次读取；
     * - 读路径拿到引用后禁止原地修改（如需要变更必须走仓储写入口，见 getTranscriptRepository）。
     */
    private async loadHistory(conversationId: string): Promise<ConversationHistory> {
        const cached = this.historyCache.get(conversationId);
        if (cached) {
            return cached;
        }
        const result = await this.storage.loadHistoryWithStatus(conversationId);
        if (result.value) {
            this.cacheHistory(conversationId, result.value);
            return result.value;
        }
        if (!result.errorCode || result.errorCode === 'not_found') {
            await this.createConversation(conversationId);
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
        metadata?: Partial<Pick<Content, 'isUserInput' | 'isFunctionResponse' | 'isSummary'>>
    ): Promise<void> {
        await this.getTranscriptRepository(conversationId).appendContent({
            role,
            parts: JSON.parse(JSON.stringify(parts)),
            timestamp: Date.now(),  // 自动添加时间
            ...metadata  // 合并可选元数据
        } as Content);
    }

    /**
     * 添加完整的 Content 对象（对 functionResponse 自动去重）
     */
    async addContent(conversationId: string, content: Content): Promise<void> {
        const contentCopy = JSON.parse(JSON.stringify(content));
        // 如果没有时间戳，自动添加
        if (!contentCopy.timestamp) {
            contentCopy.timestamp = Date.now();
        }

        // HIS-02：纯追加（非 functionResponse）没有配对/去重逻辑，走 append-only 尾段写入，
        // 不再读全量历史做去重（避免长对话下每次追加都全量重写）。
        if (!contentCopy.isFunctionResponse || !contentCopy.parts) {
            await this.getTranscriptRepository(conversationId).appendContents([contentCopy]);
            return;
        }

        // functionResponse 保留配对语义：去重 + 追加整体放入仓储互斥执行器，
        // 两个并发 addContent 基于同一旧快照各自追加时，同一 tool_use_id 会出现两条
        // functionResponse（会触发 API 400）。锁内重新收集 existingResponseIds 再过滤；
        // 全部被过滤时返回原引用跳过写回。
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

            history.push({ ...contentCopy, parts: filteredParts });
            return history.slice();
        });
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
        // HIS-02：批量追加是纯追加（无配对/去重逻辑），走 append-only 尾段写入
        await this.getTranscriptRepository(conversationId).appendContents(contentsCopy);
    }

    /**
     * 获取所有消息
     *
     * 返回的每条消息都包含 index 字段，用于前端在删除/重试时直接使用
     * 每次调用都从存储读取最新数据
     * 
     * 注意：对于没有响应的 pending 工具调用，会自动标记为 rejected 并添加 functionResponse
     */
    async getMessages(conversationId: string): Promise<Content[]> {
        const history = await this.normalizeHistoryForDisplay(conversationId);

        // 为每条消息添加 index 字段（绝对索引）
        return history.map((message, index) => {
            // 过滤后端内部字段（turnDynamicContext 数据量大且前端无需使用）
            const { turnDynamicContext, ...rest } = message;
            return {
                ...JSON.parse(JSON.stringify(rest)),
                index
            };
        });
    }

    /**
     * 轻量读取原始消息（供用量统计等只关心 usageMetadata 的场景使用）
     *
     * 与 getMessages 不同：不做显示规范化（工具调用配对补齐等）与逐条深拷贝，
     * 直接返回存储中的原始消息，显著降低全量扫描的成本。
     */
    async getMessagesRaw(conversationId: string): Promise<Content[]> {
        const result = await this.storage.loadHistoryWithStatus(conversationId);
        return result.value ?? [];
    }

    /**
     * 计算分页窗口 [startIndex, endExclusive)。
     */
    private buildPageRange(total: number, options: { beforeIndex?: number; offset?: number; limit?: number }): { startIndex: number; endExclusive: number } {
        const limit = Math.max(1, Math.min(options.limit ?? 120, 1000));
        let startIndex = 0;
        let endExclusive = total;

        if (typeof options.beforeIndex === 'number' && Number.isFinite(options.beforeIndex)) {
            endExclusive = Math.max(0, Math.min(total, Math.floor(options.beforeIndex)));
            startIndex = Math.max(0, endExclusive - limit);
        } else if (typeof options.offset === 'number' && Number.isFinite(options.offset)) {
            startIndex = Math.max(0, Math.min(total, Math.floor(options.offset)));
            endExclusive = Math.max(startIndex, Math.min(total, startIndex + limit));
        } else {
            startIndex = Math.max(0, total - limit);
            endExclusive = total;
        }

        return { startIndex, endExclusive };
    }

    /**
     * 将后端消息转换为可发送给前端的形态：
     * - 移除后端内部字段（turnDynamicContext 数据量大且前端无需使用）；
     * - 附加绝对索引。
     *
     * 性能说明：这里只做浅拷贝（嵌套对象与缓存共享）。消息随后会经 IPC 同步序列化
     * 发送给渲染层，前端拿到的是独立副本，不存在被前端反向修改的风险；后端读路径
     * 也约定不原地修改（见 loadHistory 缓存契约），因此省略逐条 JSON 深拷贝。
     */
    private toFrontendMessage(message: Content, index: number): Content {
        if ('turnDynamicContext' in message) {
            const copy = { ...message } as Record<string, unknown>;
            delete copy.turnDynamicContext;
            return { ...copy, index } as Content;
        }
        return { ...message, index } as Content;
    }

    /**
     * 分页获取对话消息（仅返回一个窗口，避免一次性向 Webview 发送全量历史）
     *
     * - beforeIndex: 取 [0, beforeIndex) 区间内的最后 limit 条（用于上拉加载更早消息）
     * - offset/limit: 取 [offset, offset+limit) 区间（用于任意分页）
     *
     * 返回的 messages 中每条都包含绝对 index（即后端历史索引）。
     */
    async getMessagesPaged(
        conversationId: string,
        options: { beforeIndex?: number; offset?: number; limit?: number } = {}
    ): Promise<{ total: number; messages: Content[] }> {
        // 分段存储的分页读取只拿到一个窗口，判断不了跨窗口的工具调用配对，因此下面的快路径
        // 无法复用 normalizeHistoryForDisplay。若不在这里补齐，取消/中断留下的悬空 functionCall
        // 会一直留在历史里，下一次请求直接被 provider 以 400 拒绝。
        // 只在首次加载（默认页）做一次全量补齐：上拉加载更早消息时跳过，避免每翻一页读一次全量。
        // 补齐会插入消息、改变 index，必须发生在分页取数之前。
        const isInitialPage = options.beforeIndex === undefined && options.offset === undefined;
        if (isInitialPage) {
            await this.normalizeHistoryForDisplay(conversationId);
        }

        // 缓存命中：直接从内存快照切片，避免磁盘段读取与解析
        const cached = this.historyCache.get(conversationId);
        if (cached) {
            const { startIndex, endExclusive } = this.buildPageRange(cached.length, options);
            return {
                total: cached.length,
                messages: cached.slice(startIndex, endExclusive).map((message, i) =>
                    this.toFrontendMessage(message, startIndex + i))
            };
        }

        const pagedHistory = await this.storage.loadHistoryPage(conversationId, options);
        if (pagedHistory.value && pagedHistory.value.format === 'paged') {
            return {
                total: pagedHistory.value.total,
                messages: pagedHistory.value.messages.map((message, i) =>
                    this.toFrontendMessage(message, pagedHistory.value!.startIndex + i))
            };
        }

        const history = await this.normalizeHistoryForDisplay(conversationId);

        const total = history.length;
        const limit = Math.max(1, Math.min(options.limit ?? 120, 1000));

        let start = 0;
        let endExclusive = total;

        if (typeof options.beforeIndex === 'number' && Number.isFinite(options.beforeIndex)) {
            endExclusive = Math.max(0, Math.min(total, Math.floor(options.beforeIndex)));
            start = Math.max(0, endExclusive - limit);
        } else if (typeof options.offset === 'number' && Number.isFinite(options.offset)) {
            start = Math.max(0, Math.min(total, Math.floor(options.offset)));
            endExclusive = Math.max(start, Math.min(total, start + limit));
        } else {
            // 默认：取最后 limit 条
            start = Math.max(0, total - limit);
            endExclusive = total;
        }

        return {
            total,
            messages: history.slice(start, endExclusive).map((message, i) =>
                this.toFrontendMessage(message, start + i))
        };
    }

    /**
     * 获取指定索引的消息
     */
    async getMessage(conversationId: string, index: number): Promise<Content | undefined> {
        const history = await this.loadHistory(conversationId);
        if (index < 0 || index >= history.length) {
            return undefined;
        }
        return JSON.parse(JSON.stringify(history[index]));
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
            Object.assign(history[messageIndex], updates);
            return history.slice(); // 有变更必须返回新引用（契约：返回原引用=跳过写回）
        });
        if (this.shouldInvalidateContextManagementStateForUpdate(updates)) {
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
            for (const item of updates) {
                const { messageIndex, updates: patch } = item;
                if (messageIndex < 0 || messageIndex >= history.length) {
                    throw new Error(t('modules.conversation.errors.messageIndexOutOfBounds', { index: messageIndex }));
                }
                Object.assign(history[messageIndex], patch);
            }
            return history.slice(); // 有变更必须返回新引用（契约：返回原引用=跳过写回）
        });

        if (updates.some(item => this.shouldInvalidateContextManagementStateForUpdate(item.updates))) {
            await this.invalidateContextManagementState(conversationId, 'messages_batch_updated');
        }
    }

    /**
     * 删除消息
     */
    async deleteMessage(conversationId: string, messageIndex: number): Promise<void> {
        const repository = this.getTranscriptRepository(conversationId);
        const history = await repository.getContents();
        if (messageIndex < 0 || messageIndex >= history.length) {
            throw new Error(t('modules.conversation.errors.messageIndexOutOfBounds', { index: messageIndex }));
        }
        await repository.mutateContents(contents => deleteLogicalMessage(contents, messageIndex));
        await this.invalidateContextManagementState(conversationId, 'message_deleted');
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
            history.splice(index, 0, {
                role,
                parts: JSON.parse(JSON.stringify(parts)),
                timestamp: Date.now()  // 自动添加时间
            } as Content);
            return history.slice(); // 有变更必须返回新引用（契约：返回原引用=跳过写回）
        });
        await this.invalidateContextManagementState(conversationId, 'message_inserted');
    }

    /**
     * 在指定位置插入完整的 Content 对象
     */
    async insertContent(
        conversationId: string,
        position: number,
        content: Content
    ): Promise<void> {
        const contentCopy = JSON.parse(JSON.stringify(content));
        // 如果没有时间戳，自动添加
        if (!contentCopy.timestamp) {
            contentCopy.timestamp = Date.now();
        }
        await this.getTranscriptRepository(conversationId).mutateContents(history => {
            const index = Math.max(0, Math.min(position, history.length));
            history.splice(index, 0, contentCopy);
            return history.slice(); // 有变更必须返回新引用（契约：返回原引用=跳过写回）
        });
        await this.invalidateContextManagementState(conversationId, contentCopy.isSummary ? 'summary_inserted' : 'content_inserted');
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
        await this.getTranscriptRepository(conversationId).mutateContents(history => {
            const start = Math.max(0, startIndex);
            const end = Math.min(history.length, endIndex + 1);
            history.splice(start, end - start);
            return history.slice(); // 有变更必须返回新引用（契约：返回原引用=跳过写回）
        });
        await this.invalidateContextManagementState(conversationId, 'message_range_deleted');
    }

    /**
     * 删除到指定消息（从后往前删除）
     *
     * @param conversationId 对话 ID
     * @param targetIndex 目标消息索引（删除到这个索引为止，包括该消息）
     * @returns 删除的消息数量
     *
     * @example
     * // 删除最后 3 条消息（假设历史有 10 条）
     * await manager.deleteToMessage('chat-001', 7); // 删除索引 7, 8, 9
     *
     * 注意：删除后可能留下孤立的 functionCall（没有对应的 functionResponse）
     * ChatHandler 在重试时会检测并重新执行这些孤立的函数调用
     */
    async deleteToMessage(
        conversationId: string,
        targetIndex: number
    ): Promise<number> {
        const repository = this.getTranscriptRepository(conversationId);
        const history = await repository.getContents();
        
        if (targetIndex < 0 || targetIndex >= history.length) {
            throw new Error(t('modules.conversation.errors.messageIndexOutOfBounds', { index: targetIndex }));
        }
        
        // 修改原因：重试/删除到指定消息的语义是从目标索引开始截断，不能在主对话和 SubAgent 子对话各写一套实现。
        // 修改方式：通过 TranscriptRepository.mutateContents 委托 TranscriptMutation.truncateFrom 统一处理截断和 index 规范化。
        // 修改目的：保证后续工具配对规则升级时，主窗口和 Monitor 同步继承。
        const nextHistory = await repository.mutateContents(currentHistory => truncateFrom(currentHistory, targetIndex));
        const deleteCount = history.length - nextHistory.length;
        if (deleteCount > 0) {
            await this.invalidateContextManagementState(conversationId, 'history_truncated');
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
        await this.getTranscriptRepository(conversationId).replaceContents([]);
        await this.invalidateContextManagementState(conversationId, 'history_cleared');
    }

    // ==================== 查询和过滤 ====================

    /**
     * 查找消息
     */
    async findMessages(
        conversationId: string,
        filter: MessageFilter
    ): Promise<MessagePosition[]> {
        const history = await this.loadHistory(conversationId);
        const results: MessagePosition[] = [];

        for (let i = 0; i < history.length; i++) {
            const message = history[i];
            let matches = true;

            if (filter.role && message.role !== filter.role) {
                matches = false;
            }

            if (filter.hasFunctionCall !== undefined) {
                const hasFunctionCall = message.parts.some(p => p.functionCall !== undefined);
                if (hasFunctionCall !== filter.hasFunctionCall) {
                    matches = false;
                }
            }

            if (filter.hasText !== undefined) {
                const hasText = message.parts.some(
                    p => p.text !== undefined && p.text.trim() !== ''
                );
                if (hasText !== filter.hasText) {
                    matches = false;
                }
            }

            if (filter.isThought !== undefined) {
                const isThought = message.parts.some(p => p.thought === true);
                if (isThought !== filter.isThought) {
                    matches = false;
                }
            }

            if (filter.indexRange) {
                const { start, end } = filter.indexRange;
                if (i < start || i >= end) {
                    matches = false;
                }
            }

            if (matches) {
                results.push({ index: i, role: message.role });
            }
        }

        return results;
    }

    /**
     * 获取指定角色的所有消息
     */
    async getMessagesByRole(
        conversationId: string,
        role: 'user' | 'model' | 'system'
    ): Promise<Content[]> {
        const history = await this.loadHistory(conversationId);
        return history
            .filter(msg => msg.role === role)
            .map(msg => JSON.parse(JSON.stringify(msg)));
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
        const history = await this.loadHistory(conversationId);
        const snapshot: HistorySnapshot = {
            // Date.now() 同一毫秒内连续创建会互相覆盖，追加随机后缀保证唯一
            id: `snapshot_${conversationId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            conversationId,
            name,
            description,
            timestamp: Date.now(),
            history: JSON.parse(JSON.stringify(history))
        };
        await this.storage.saveSnapshot(snapshot);
        return snapshot;
    }

    /**
     * 恢复快照
     */
    async restoreSnapshot(conversationId: string, snapshotId: string): Promise<void> {
        const snapshot = await this.storage.loadSnapshot(snapshotId);
        if (!snapshot) {
            throw new Error(t('modules.conversation.errors.snapshotNotFound', { snapshotId }));
        }
        if (snapshot.conversationId !== conversationId) {
            throw new Error(t('modules.conversation.errors.snapshotNotBelongToConversation'));
        }
        
        await this.getTranscriptRepository(conversationId).replaceContents(snapshot.history);
        await this.invalidateContextManagementState(conversationId, 'snapshot_restored');
    }

    /**
     * 删除快照
     */
    async deleteSnapshot(snapshotId: string): Promise<void> {
        await this.storage.deleteSnapshot(snapshotId);
    }

    /**
     * 列出对话的所有快照
     */
    async listSnapshots(conversationId: string): Promise<string[]> {
        return await this.storage.listSnapshots(conversationId);
    }

    // ==================== 统计信息 ====================

    /**
     * 获取统计信息
     */
    async getStats(conversationId: string): Promise<ConversationStats> {
        const history = await this.loadHistory(conversationId);
        return this.computeStatsFrom(history);
    }

    /**
     * 从已加载内容计算统计（HIS-03/HIS-04）：同一迭代内避免重复 loadHistory。
     */
    getStatsFrom(contents: ReadonlyArray<Content>): ConversationStats {
        return this.computeStatsFrom(contents);
    }

    private computeStatsFrom(rawHistory: ReadonlyArray<Content>): ConversationStats {
        const history = rawHistory as ConversationHistory;
        
        let userMessages = 0;
        let modelMessages = 0;
        let functionCalls = 0;
        let hasThoughtSignatures = false;
        let hasThoughts = false;
        let hasFileData = false;
        let hasInlineData = false;
        let inlineDataSize = 0;
        const multimedia = {
            images: 0,
            audio: 0,
            video: 0,
            documents: 0
        };
        
        // Token 统计
        let totalThoughtsTokens = 0;
        let totalCandidatesTokens = 0;
        let messagesWithThoughtsTokens = 0;
        let messagesWithCandidatesTokens = 0;

        for (const message of history) {
            if (message.role === 'user') {
                userMessages++;
            } else {
                modelMessages++;
            }
            
            // 统计 token（优先使用 usageMetadata，向后兼容旧格式）
            let thoughtsTokens = message.usageMetadata?.thoughtsTokenCount ?? message.thoughtsTokenCount;
            let candidatesTokens = message.usageMetadata?.candidatesTokenCount ?? message.candidatesTokenCount;

            // 中断/取消流的 usageMetadata 是半截数据：回退到文本长度估算，避免严重少计
            if (message.usageMetadataPartial) {
                const estimated = estimatePartialMessageTokens(message);
                if (estimated) {
                    thoughtsTokens = estimated.thoughts;
                    candidatesTokens = estimated.candidates;
                }
            }
            
            if (thoughtsTokens !== undefined) {
                totalThoughtsTokens += thoughtsTokens;
                messagesWithThoughtsTokens++;
            }
            if (candidatesTokens !== undefined) {
                totalCandidatesTokens += candidatesTokens;
                messagesWithCandidatesTokens++;
            }

            for (const part of message.parts) {
                // 函数调用
                if (part.functionCall) {
                    functionCalls++;
                }
                
                // 检查思考签名
                if (part.thoughtSignatures) {
                    hasThoughtSignatures = true;
                }
                
                // 检查思考内容
                if (part.thought === true) {
                    hasThoughts = true;
                }
                
                // 检查文件数据
                if (part.fileData) {
                    hasFileData = true;
                }
                
                // 检查内嵌数据
                if (part.inlineData) {
                    hasInlineData = true;
                    
                    // 计算 Base64 数据大小（约为原始数据的 4/3）
                    // 旧版本或手动编辑的历史可能缺 data/mimeType，判空避免整个统计崩溃
                    const inlineData = part.inlineData;
                    const base64Length = typeof inlineData.data === 'string' ? inlineData.data.length : 0;
                    inlineDataSize += Math.ceil((base64Length * 3) / 4);
                    
                    // 统计多模态类型
                    const mimeType = inlineData.mimeType;
                    if (typeof mimeType === 'string') {
                        if (mimeType.startsWith('image/')) {
                            multimedia.images++;
                        } else if (mimeType.startsWith('audio/')) {
                            multimedia.audio++;
                        } else if (mimeType.startsWith('video/')) {
                            multimedia.video++;
                        } else if (mimeType === 'application/pdf' || mimeType === 'text/plain') {
                            multimedia.documents++;
                        }
                    }
                }
            }
        }

        return {
            totalMessages: history.length,
            userMessages,
            modelMessages,
            functionCalls,
            hasThoughtSignatures,
            hasThoughts,
            hasFileData,
            hasInlineData,
            inlineDataSize,
            multimedia,
            tokens: {
                totalThoughtsTokens,
                totalCandidatesTokens,
                totalTokens: totalThoughtsTokens + totalCandidatesTokens,
                messagesWithThoughtsTokens,
                messagesWithCandidatesTokens
            }
        };
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
        return this.formatHistoryForAPI(history, options);
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
        return this.formatHistoryForAPI(contents, options);
    }

    private formatHistoryForAPI(
        rawContents: ReadonlyArray<Content>,
        options: GetHistoryOptions | boolean = false
    ): ConversationHistory {
        let history = rawContents as ConversationHistory;
        
        // 向后兼容：如果传入 boolean，视为 includeThoughts
        const opts: GetHistoryOptions = typeof options === 'boolean'
            ? { includeThoughts: options }
            : options;
        
        // 应用起始索引（用于上下文裁剪）
        // 注意：startIndex >= history.length 时必须返回空历史而不是完整历史，
        // slice 自动钳制超界索引（防御性修复，当前调用方已钳制）。
        const startIndex = opts.startIndex ?? 0;
        if (startIndex > 0) {
            history = history.slice(startIndex);
        }
        
        const includeThoughts = opts.includeThoughts ?? false;
        const sendHistoryThoughts = opts.sendHistoryThoughts ?? false;
        const sendHistoryThoughtSignatures = opts.sendHistoryThoughtSignatures ?? false;
        // 当前轮次配置：默认发送当前思考内容
        const sendCurrentThoughts = opts.sendCurrentThoughts ?? true;
        const sendCurrentThoughtSignatures = opts.sendCurrentThoughtSignatures ?? (opts.channelType === 'gemini' || opts.channelType === 'anthropic' || opts.channelType === 'openai-responses');
        const channelType = opts.channelType;
        // 历史思考回合数，默认 -1 表示全部
        const historyThinkingRounds = opts.historyThinkingRounds ?? -1;
        
        // 找到最后一个非函数响应的 user 消息的索引
        let lastNonFunctionResponseUserIndex = -1;
        for (let i = history.length - 1; i >= 0; i--) {
            const message = history[i];
            if (message.role === 'user' && !message.isFunctionResponse) {
                lastNonFunctionResponseUserIndex = i;
                break;
            }
        }
        
        // 识别所有回合并计算哪些回合需要发送历史思考
        // 回合定义：从一个非函数响应的 user 消息开始，到下一个非函数响应的 user 消息之前结束
        const roundStartIndices: number[] = [];
        for (let i = 0; i < history.length; i++) {
            const message = history[i];
            if (message.role === 'user' && !message.isFunctionResponse) {
                roundStartIndices.push(i);
            }
        }
        
        // 计算需要发送历史思考的消息索引范围
        // historyThinkingRounds 控制发送多少轮非最新回合的思考
        let historyThoughtMinIndex = 0;  // 最小索引（包含）
        let historyThoughtMaxIndex = lastNonFunctionResponseUserIndex;  // 最大索引（不包含，由 sendCurrentThoughts 控制）
        
        if (historyThinkingRounds === 0) {
            // 0 表示不发送任何历史回合的思考
            // 设置 min > max 使范围无效
            historyThoughtMinIndex = history.length;
            historyThoughtMaxIndex = -1;
        } else if (historyThinkingRounds > 0) {
            // 正数 n 表示发送最近 n 轮非最新回合的思考
            // 例如 historyThinkingRounds=1，总共有 5 个回合（索引 0-4），最新回合是 4
            // 那么只发送回合 3（倒数第二回合）的思考
            const totalRounds = roundStartIndices.length;
            
            if (totalRounds > 1) {
                // 需要跳过的回合数 = 总回合数 - 1（最新回合） - historyThinkingRounds
                const roundsToSkip = Math.max(0, totalRounds - 1 - historyThinkingRounds);
                
                if (roundsToSkip > 0 && roundsToSkip < totalRounds) {
                    // 从 roundsToSkip 回合开始发送
                    historyThoughtMinIndex = roundStartIndices[roundsToSkip];
                }
            }
        }
        // historyThinkingRounds === -1 时保持默认值，发送所有历史回合的思考
        
        /**
         * 处理单个 part 的思考签名
         * 根据配置决定是否保留签名，并按渠道类型过滤
         *
         * 注意：思考签名发送不依赖于 includeThoughts（渠道是否支持思考）
         * 这是因为历史中的签名可能来自任何渠道（如 Gemini），而当前使用其他渠道继续对话
         * 用户可能希望将 Gemini 产生的签名发送给其他渠道
         *
         * @param part 要处理的 part
         * @param isHistoryPart 是否是历史消息中的 part
         * @param messageIndex 消息在历史中的索引
         */
        const processThoughtSignatures = (
            part: ContentPart,
            isHistoryPart: boolean,
            messageIndex: number
        ): ContentPart => {
            // 1. 处理历史消息的签名
            if (isHistoryPart) {
                if (!sendHistoryThoughtSignatures) {
                    const { thoughtSignatures, thoughtSignature, ...rest } = part as any;
                    return rest;
                }
                // 检查是否在允许的历史思考回合范围内
                const isInHistoryThoughtRange = messageIndex >= historyThoughtMinIndex && messageIndex < historyThoughtMaxIndex;
                if (!isInHistoryThoughtRange) {
                    const { thoughtSignatures, thoughtSignature, ...rest } = part as any;
                    return rest;
                }
            } else {
                // 2. 处理当前轮次的签名
                // 当前轮次的签名发送由 sendCurrentThoughtSignatures 独立控制
                if (!sendCurrentThoughtSignatures) {
                    const { thoughtSignatures, thoughtSignature, ...rest } = part as any;
                    return rest;
                }
            }

            if (!part.thoughtSignatures) {
                return part;
            }
            
            // 3. 如果指定了渠道类型，只保留对应格式的签名
            if (channelType && part.thoughtSignatures[channelType]) {
                return {
                    ...part,
                    thoughtSignatures: {
                        [channelType]: part.thoughtSignatures[channelType]
                    }
                };
            }
            
            // 如果没有指定渠道类型或没有对应格式的签名，保留原样
            return part;
        };
        
        /**
         * 支持的图片 MIME 类型
         */
        const IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
        
        /**
         * 支持的文档 MIME 类型
         */
        const DOCUMENT_MIME_TYPES = ['application/pdf', 'text/plain'];
        
        /**
         * 清理 inlineData 中的元数据字段
         *
         * 根据渠道类型决定保留哪些字段：
         * - Gemini: 保留 mimeType, data, displayName（Gemini API 支持 displayName）
         * - OpenAI/Anthropic: 只保留 mimeType, data（不支持 displayName）
         *
         * id 和 name 字段仅用于存储和前端显示，始终不发送给 AI
         *
         * 多模态能力过滤策略：
         * - 用户主动提交的附件不受多模态工具配置影响
         * - 对于工具响应消息：
         *   - 如果渠道不支持多模态（如 OpenAI function_call），始终过滤
         *   - 如果渠道支持但不支持历史多模态，只过滤历史中的多模态数据
         *   - 否则保留多模态数据
         *
         * @param part 要处理的 ContentPart
         * @param isFunctionResponse 是否是工具响应消息
         * @param isHistoryMessage 是否是历史消息（当前轮次之前的消息）
         */
        const cleanInlineData = (part: ContentPart, isFunctionResponse: boolean, isHistoryMessage: boolean): ContentPart | null => {
            if (!part.inlineData) {
                return part;
            }
            
            // 获取多模态能力配置
            const capability = opts.multimodalCapability;
            
            // 多模态能力过滤策略（仅对工具响应消息生效）：
            // 用户主动提交的附件不受多模态工具配置影响
            if (capability && isFunctionResponse) {
                const mimeType = part.inlineData.mimeType;
                
                // 首先检查渠道是否支持此类型的多模态
                // 如果不支持，即使是当前轮次也要过滤（如 OpenAI function_call 模式）
                const isImage = IMAGE_MIME_TYPES.includes(mimeType);
                const isDocument = DOCUMENT_MIME_TYPES.includes(mimeType);
                
                if (isImage && !capability.supportsImages) {
                    // 渠道不支持图片（如 OpenAI function_call），始终过滤
                    return null;
                }
                
                if (isDocument && !capability.supportsDocuments) {
                    // 渠道不支持文档，始终过滤
                    return null;
                }
                
                // 渠道支持此类型，但需要检查是否支持历史多模态
                // 如果是历史消息且不支持历史多模态，则过滤
                if (isHistoryMessage && !capability.supportsHistoryMultimodal) {
                    return null;
                }
            }
            
            // 根据渠道类型决定是否保留 displayName
            // Gemini 支持 displayName，OpenAI/Anthropic 不支持
            if (channelType === 'gemini') {
                // Gemini: 保留 displayName，移除 id 和 name
                const { id, name, ...cleanedInlineData } = part.inlineData;
                return {
                    ...part,
                    inlineData: cleanedInlineData
                };
            } else {
                // OpenAI/Anthropic/Custom: 移除 id, name, displayName
                const { id, name, displayName, ...cleanedInlineData } = part.inlineData;
                return {
                    ...part,
                    inlineData: cleanedInlineData
                };
            }
        };
        
        // 首先收集所有被拒绝的工具调用 ID
        const rejectedToolCallIds = new Set<string>();
        for (const message of history) {
            for (const part of message.parts) {
                if (part.functionCall?.rejected && part.functionCall.id) {
                    rejectedToolCallIds.add(part.functionCall.id);
                }
            }
        }
        
        /**
         * 清理 functionCall 中的内部字段
         *
         * rejected 字段是内部使用的，用于标记用户拒绝执行的工具
         * 不应该发送给 AI API，因为 API 不识别此字段
         */
        const cleanFunctionCall = (part: ContentPart): ContentPart => {
            if (!part.functionCall) {
                return part;
            }
            
            // 移除 rejected 字段
            const { rejected, ...cleanedFunctionCall } = part.functionCall;
            return {
                ...part,
                functionCall: cleanedFunctionCall
            };
        };
        
        /**
         * 处理 functionResponse
         *
         * 如果对应的 functionCall 被标记为 rejected，
         * 需要将 response 修改为表示被拒绝的状态，
         * 这样 AI 才能知道工具没有被执行
         *
         * 同时清理不应发送给 AI 的内部字段（如 diffContentId）
         */
        const processFunctionResponse = (part: ContentPart): ContentPart => {
            if (!part.functionResponse) {
                return part;
            }
            
            // 检查对应的 functionCall 是否被拒绝
            if (part.functionResponse.id && rejectedToolCallIds.has(part.functionResponse.id)) {
                // 修改 response 为表示被拒绝的状态
                return {
                    ...part,
                    functionResponse: {
                        ...part.functionResponse,
                        response: {
                            success: false,
                            error: t('modules.api.chat.errors.userRejectedTool'),
                            rejected: true
                        }
                    }
                };
            }
            
            // 清理不应发送给 AI 的内部字段（使用共享函数确保一致性）
            const cleanedResponse = cleanFunctionResponseForAPI(
                part.functionResponse.response as Record<string, unknown>
            );
            
            return {
                ...part,
                functionResponse: {
                    ...part.functionResponse,
                    response: cleanedResponse as Record<string, unknown>
                }
            };
        };
        
        /**
         * 处理单条消息
         */
        const processMessage = (message: Content, index: number): Content | null => {
            const isHistoryMessage = index < lastNonFunctionResponseUserIndex;
            // 检查消息是否是工具响应（用于决定是否应用多模态能力过滤）
            const isFunctionResponse = !!message.isFunctionResponse;
            
            let parts = message.parts;
            
            // 处理思考内容 (Thought Text/Reasoning Content)
            // 注意：思考发送不依赖于 includeThoughts（渠道是否支持思考）
            // 这是因为历史中的思考内容可能来自任何渠道（如 Gemini），而当前使用其他渠道继续对话
            // 用户可能希望将 Gemini 产生的思考内容发送给 OpenAI/Anthropic 渠道
            if (isHistoryMessage) {
                // 历史消息：根据 sendHistoryThoughts 配置和 historyThinkingRounds 决定
                if (!sendHistoryThoughts) {
                    // 仅过滤掉纯思考内容，保留包含签名的 Part
                    parts = parts.filter(part => !part.thought || part.thoughtSignatures);
                } else {
                    // 检查当前消息是否在允许的历史思考回合范围内
                    const isInHistoryThoughtRange = index >= historyThoughtMinIndex && index < historyThoughtMaxIndex;
                    if (!isInHistoryThoughtRange) {
                        parts = parts.filter(part => !part.thought);
                    }
                }
            } else {
                // 当前轮次 (Latest Round)
                // 当前轮次的思考发送由 sendCurrentThoughts 独立控制
                if (!sendCurrentThoughts) {
                    // 仅过滤掉纯思考内容，保留包含签名的 Part
                    parts = parts.filter(part => !part.thought || part.thoughtSignatures);
                }
            }
            
            // 处理思考签名、清理 inlineData 元数据、清理 functionCall 内部字段、处理被拒绝的工具响应
            // 注意：只有历史中的工具响应消息才会应用 supportsHistoryMultimodal 过滤
            // 当前轮次的工具响应始终保留多模态数据
            parts = parts
                .map(part => processThoughtSignatures(part, isHistoryMessage, index))
                .map(part => cleanInlineData(part, isFunctionResponse, isHistoryMessage))
                .map(part => part ? cleanFunctionCall(part) : part)
                .map(part => part ? processFunctionResponse(part) : part)
                // 过滤空 part：
                // - null（被 cleanInlineData 等过滤）
                // - 空对象
                // - 仅包含 thought: true 的“空 thought 块”（常见于：原本只有 thoughtSignatures，后续又被配置过滤掉签名）
                //   这类 part 在不同模型/渠道下可能导致兼容性问题。
                .filter((part): part is ContentPart => {
                    if (part === null) return false;
                    const keys = Object.keys(part);
                    if (keys.length === 0) return false;
                    if (keys.length === 1 && keys[0] === 'thought' && (part as any).thought === true) return false;
                    return true;
                });
            
            if (parts.length === 0) {
                return null;
            }
            
            // 保留必要的元数据字段
            const result: Content = {
                role: message.role,
                parts
            };
            
            // 保留 isUserInput 标记（用于确定动态提示词插入位置）
            if (message.isUserInput) {
                result.isUserInput = true;
            }

            // preserve 动态上下文策略需要在 formatter 构建请求时读取旧回合缓存。
            // 字段本身仍会在 formatter.cleanInternalFields 中被过滤，不会直接发送给模型。
            if (opts.includeTurnDynamicContext && message.turnDynamicContext) {
                result.turnDynamicContext = message.turnDynamicContext;
                result.turnDynamicContextStrategy = message.turnDynamicContextStrategy;
            }
            
            return result;
        };
        
        // 处理所有消息
        return history
            .map((message, index) => processMessage(message, index))
            .filter((message): message is Content => message !== null);
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
     */
    async setWorkspaceUri(conversationId: string, workspaceUri: string): Promise<void> {
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
        // 缓存命中：metaCache 是最近一次持久化快照（所有写路径统一失效/回填），
        // 直接跳过磁盘 meta + 索引结构探针的两次 IO；
        // 磁盘上的元数据不持久化 integrityStatus，缓存值无该字段等价于 integrityStatus 'ok'
        // （当前实现会在 'ok' 时删除该字段）。返回深拷贝，防止调用方污染缓存。
        const cached = this.metaCache.get(conversationId);
        if (cached !== undefined) {
            return cached === null ? null : JSON.parse(JSON.stringify(cached)) as ConversationMetadata;
        }

        // 完整性检查需要真实磁盘状态，这里仍直接读存储；读取结果顺带回填元数据缓存，
        // 后续对同一会话的 getMetadata / getCustomMetadata 直接命中缓存。
        const [metadataResult, indexInfo] = await Promise.all([
            this.storage.loadMetadataWithStatus(conversationId),
            this.resolveHistoryIndexInfo(conversationId),
        ]);

        if (metadataResult.value) {
            this.cacheMetadata(conversationId, metadataResult.value);
        }

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
        const integrityStatus = this.resolveIntegrityStatus(integrity);

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
        const fallback = this.createFallbackMetadata(conversationId, historyResult.value);
        if (integrityStatus) {
            fallback.integrityStatus = integrityStatus;
        }
        return fallback;
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
                // M3：钳制 messageCount 不超过实际历史提交数。appendHistory 失败但前端已乐观更新并
                // 调 updateSummary 时，不钳制会让 custom.messageCount 永久超前于真实历史。
                // getHistoryIndexInfo 只读 index 结构，成本低；索引不可读/legacy 时跳过钳制。
                try {
                    const indexInfo = await this.resolveHistoryIndexInfo(conversationId);
                    if (typeof indexInfo?.totalMessages === 'number' && indexInfo.totalMessages >= 0) {
                        messageCount = Math.min(messageCount, indexInfo.totalMessages);
                    }
                } catch {
                    // 索引读取失败不影响本次摘要写入（按原值保存）
                }
                meta.custom.messageCount = messageCount;
            }
            if (summary.preview !== undefined) {
                meta.custom.preview = summary.preview;
            }
            meta.updatedAt = Date.now();
            await this.storage.saveMetadata(meta);
        });
    }

    /**
     * 轻量读取对话元数据（供用量统计等只关心 title/updatedAt 的场景使用）
     *
     * 与 getMetadata 不同：只读 meta.json，不加载历史做完整性检查、
     * 不生成 fallback 元数据——统计侧对缺失 meta 直接回退对话 ID 展示。
     * 避免每次统计都为每个对话额外读一次历史（getMetadata 的 loadHistoryPage）。
     */
    async getMetadataLight(conversationId: string): Promise<ConversationMetadata | null> {
        const result = await this.storage.loadMetadataWithStatus(conversationId);
        return result.value ?? null;
    }

    /**
     * 批量获取对话摘要元数据（HIS-10）。
     *
     * 对话列表一次 IPC 拉一页摘要，避免每个对话一次 IPC。
     * 只读 meta.json（getMetadataLight），不做完整性检查、不解析历史。
     */
    async getConversationMetadataBatch(conversationIds: string[]): Promise<ConversationSummary[]> {
        const ids = Array.isArray(conversationIds) ? conversationIds.slice(0, 200) : [];
        if (ids.length === 0) return [];
        return await this.runBounded(ids, 16, async conversationId => this.buildConversationSummary(conversationId));
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

    /** 限流并发执行（结果按输入顺序返回） */
    private async runBounded<T, R>(
        items: readonly T[],
        concurrency: number,
        task: (item: T) => Promise<R>
    ): Promise<R[]> {
        const results: R[] = new Array(items.length);
        let next = 0;
        const workerCount = Math.max(1, Math.min(concurrency, items.length));
        await Promise.all(Array.from({ length: workerCount }, async () => {
            while (next < items.length) {
                const index = next++;
                results[index] = await task(items[index]);
            }
        }));
        return results;
    }

    /**
     * 获取 conversations 目录的本地文件系统路径（供用量统计目录监听使用）；
     * 存储适配器不支持时返回 undefined，统计退化全量扫描。
     */
    getConversationsDirFsPath(): string | undefined {
        return this.storage.getConversationsDirFsPath?.();
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
     */
    async getCustomMetadata(conversationId: string, key: string): Promise<unknown> {
        const meta = await this.loadStoredMetadata(conversationId);
        return meta?.custom?.[key];
    }

    // ==================== 工具调用管理 ====================

    /**
     * 查找 functionResponse 消息的正确插入位置。
     *
     * 工具响应必须紧跟对应的工具调用消息。若该位置之后已存在同批次
     * functionResponse 消息，则插到它们之后，保持与 functionCall 输出顺序一致。
     *
     * @param history 当前对话历史
     * @param messageIndex 工具调用消息的索引
     * @returns functionResponse 应插入的位置索引
     */
    private findFunctionResponseInsertIndex(history: ConversationHistory, messageIndex: number): number {
        let insertAt = messageIndex + 1;
        while (insertAt < history.length && history[insertAt]?.isFunctionResponse) {
            insertAt++;
        }
        return insertAt;
    }

    /**
     * 标记指定消息中的工具调用为拒绝状态
     *
     * 当用户在等待工具确认时点击终止按钮，需要将等待中的工具标记为拒绝
     * 同时添加对应的 functionResponse，这样 API 才不会报错
     *
     * @param conversationId 对话 ID
     * @param messageIndex 消息索引
     * @param toolCallIds 要标记为拒绝的工具调用 ID 列表（如果为空，则标记所有未执行的工具）
     */
    async rejectToolCalls(
        conversationId: string,
        messageIndex: number,
        toolCallIds?: string[]
    ): Promise<void> {
        const repository = this.getTranscriptRepository(conversationId);
        const history = await repository.getContents();
        
        if (messageIndex < 0 || messageIndex >= history.length) {
            throw new Error(t('modules.conversation.errors.messageIndexOutOfBounds', { index: messageIndex }));
        }
        
        const message = history[messageIndex];
        let modified = false;
        
        // 收集所有已有响应的工具 ID
        const respondedToolIds = new Set<string>();
        for (let i = messageIndex + 1; i < history.length; i++) {
            const msg = history[i];
            for (const part of msg.parts) {
                if (part.functionResponse?.id) {
                    respondedToolIds.add(part.functionResponse.id);
                }
            }
        }
        
        // 收集需要拒绝的工具调用
        const rejectedCalls: Array<{ id: string; name: string }> = [];
        
        // 标记工具为拒绝状态
        for (const part of message.parts) {
            if (part.functionCall && part.functionCall.id) {
                // 检查是否需要标记此工具
                const shouldReject = toolCallIds
                    ? toolCallIds.includes(part.functionCall.id)
                    : !respondedToolIds.has(part.functionCall.id);
                
                if (shouldReject && !part.functionCall.rejected) {
                    part.functionCall.rejected = true;
                    modified = true;
                    
                    // 收集被拒绝的工具信息
                    rejectedCalls.push({
                        id: part.functionCall.id,
                        name: part.functionCall.name || 'unknown'
                    });
                }
            }
        }
        
        // 为被拒绝的工具添加 functionResponse
        if (rejectedCalls.length > 0) {
            const rejectedResponseParts: ContentPart[] = rejectedCalls.map(call => ({
                functionResponse: {
                    name: call.name,
                    id: call.id,
                    response: {
                        success: false,
                        error: t('modules.api.chat.errors.userRejectedTool'),
                        rejected: true
                    }
                }
            }));
            
            // 插到工具调用消息的紧接后面，保持与 functionCall 输出顺序一致
            const insertAt = this.findFunctionResponseInsertIndex(history, messageIndex);
            history.splice(insertAt, 0, {
                role: 'user',
                parts: rejectedResponseParts,
                isFunctionResponse: true
            });
            modified = true;
        }

        if (modified) {
            await repository.replaceContents(history);
            await this.invalidateContextManagementState(conversationId, 'tool_calls_rejected');
        }
    }
    
    /**
     * 拒绝所有未响应的工具调用
     * 
     * 用于用户中断操作（删除消息、切换对话等）时，将所有 pending 的工具调用标记为 rejected
     * 并在工具调用消息紧接后面插入 functionResponse
     * 
     * @param conversationId 对话 ID
     */
    async rejectAllPendingToolCalls(conversationId: string): Promise<void> {
        const repository = this.getTranscriptRepository(conversationId);
        let changed = false;

        // get→修改→replace 整体走仓储互斥执行器（withConversationWriteLock），
        // 与 settleFunctionResponses / mutateContents 串行：避免并发时后写覆盖先写，
        // 真实执行成功的工具结果被“用户拒绝”占位覆盖。
        await repository.mutateContents((history) => {
            if (history.length === 0) return history;

            // 收集所有 functionResponse 的 ID
            const respondedToolCallIds = new Set<string>();
            for (const message of history) {
                if (message.parts) {
                    for (const part of message.parts) {
                        if (part.functionResponse?.id) {
                            respondedToolCallIds.add(part.functionResponse.id);
                        }
                    }
                }
            }

            // 收集未响应的工具调用，记录它们所在的消息索引
            const unresolvedCallsByIndex: Map<number, Array<{ id: string; name: string }>> = new Map();
            for (let i = 0; i < history.length; i++) {
                const message = history[i];
                if (message.parts) {
                    for (const part of message.parts) {
                        if (part.functionCall && part.functionCall.id) {
                            // 如果工具调用没有对应的响应，且还没有被标记为 rejected
                            if (!respondedToolCallIds.has(part.functionCall.id) && !part.functionCall.rejected) {
                                part.functionCall.rejected = true;
                                const calls = unresolvedCallsByIndex.get(i) || [];
                                calls.push({
                                    id: part.functionCall.id,
                                    name: part.functionCall.name || 'unknown'
                                });
                                unresolvedCallsByIndex.set(i, calls);
                            }
                        }
                    }
                }
            }

            // 如果有未响应的工具调用，在工具调用消息紧接后面插入 functionResponse
            // 从后往前插入以避免索引偏移问题
            if (unresolvedCallsByIndex.size > 0) {
                const sortedIndices = Array.from(unresolvedCallsByIndex.keys()).sort((a, b) => b - a);

                for (const messageIndex of sortedIndices) {
                    const calls = unresolvedCallsByIndex.get(messageIndex)!;
                    const rejectedResponseParts: ContentPart[] = calls.map(call => ({
                        functionResponse: {
                            name: call.name,
                            id: call.id,
                            response: {
                                success: false,
                                error: t('modules.api.chat.errors.userRejectedTool'),
                                rejected: true
                            }
                        }
                    }));

                    // 插到工具调用消息的紧接后面，保持与 functionCall 输出顺序一致
                    const insertAt = this.findFunctionResponseInsertIndex(history, messageIndex);
                    history.splice(insertAt, 0, {
                        role: 'user',
                        parts: rejectedResponseParts,
                        isFunctionResponse: true
                    });
                }
                changed = true;
                // 有插入：返回新引用触发写回（mutateContents 契约：返回原引用=跳过写回）
                return history.slice();
            }

            // 无变更：返回原引用跳过写回（此时没有任何原地修改）
            return history;
        });

        if (changed) {
            await this.invalidateContextManagementState(conversationId, 'pending_tool_calls_rejected');
        }
    }

    /**
     * 结算工具执行结果：用真实 functionResponse 覆盖占位拒绝。
     *
     * 与 {@link addContent} 不同的是：当历史中已存在同 id 的 functionResponse 且它是
     * rejected/cancelled 占位时，**就地替换**为真实结果，同时清除 model 消息上对应
     * functionCall 的 rejected 标记。
     *
     * 用于 handleToolConfirmation 的中止路径：cancelStream 的 rejectAllPendingToolCalls
     * 已经写入了拒绝占位，但工具其实已经执行完且产生了真实副作用——此时 addContent 的去重
     * 会把真实结果丢弃；此方法保证真实结果永远覆盖占位。
     */
    async settleFunctionResponses(conversationId: string, parts: ContentPart[]): Promise<void> {
        if (parts.length === 0) return;

        const repository = this.getTranscriptRepository(conversationId);
        let changed = false;

        // 与 rejectAllPendingToolCalls 共用同一互斥执行器，整个 get→修改→replace 串行化，
        // 避免并发时真实结果被“用户拒绝”占位覆盖。
        await repository.mutateContents((history) => {
            // 索引现有响应 & 拒绝占位的位置
            const responseIdx = new Map<string, number>();     // id → historyIndex
            const placeholderIds = new Set<string>();           // id 是占位
            for (let i = 0; i < history.length; i++) {
                const msg = history[i];
                if (!msg.parts) continue;
                for (const part of msg.parts) {
                    const fr = part.functionResponse;
                    if (!fr?.id) continue;
                    responseIdx.set(fr.id, i);
                    if (fr.response?.rejected || fr.response?.cancelled) {
                        placeholderIds.add(fr.id);
                    }
                }
            }

            const newParts: ContentPart[] = [];

            for (const part of parts) {
                const id = part.functionResponse?.id;
                if (!id) {
                    // 无 id 的 part（如多模态附件）一律走追加
                    newParts.push(part);
                    continue;
                }

                const existingIdx = responseIdx.get(id);

                if (existingIdx !== undefined && placeholderIds.has(id)) {
                    // 占位 → 就地替换为真实结果
                    const msg = history[existingIdx];
                    const partIdx = msg.parts!.findIndex(
                        (p) => p.functionResponse?.id === id
                    );
                    if (partIdx !== -1) {
                        msg.parts![partIdx] = part;
                    }
                    // 清除 model 消息上对应 functionCall 的 rejected 标记
                    for (const hmsg of history) {
                        if (!hmsg.parts) continue;
                        for (const hp of hmsg.parts) {
                            if (hp.functionCall && hp.functionCall.id === id) {
                                hp.functionCall.rejected = false;
                            }
                        }
                    }
                    placeholderIds.delete(id);
                    changed = true;
                } else if (existingIdx === undefined) {
                    // 全新响应 → 收集后追加
                    newParts.push(part);
                }
                // else: 已有真实响应 → 跳过（幂等）
            }

            if (newParts.length > 0) {
                history.push({
                    role: 'user',
                    parts: newParts,
                    isFunctionResponse: true,
                });
                changed = true;
            }

            // 有变更（占位替换或新追加）：返回新引用触发写回；无变更返回原引用跳过写回
            // （mutateContents 契约：返回原引用=跳过写回）
            return changed ? history.slice() : history;
        });

        if (changed) {
            await this.invalidateContextManagementState(conversationId, 'tool_calls_settled');
        }
    }
}

