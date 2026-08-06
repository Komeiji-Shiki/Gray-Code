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
    CONVERSATION_CONTEXT_TRIM_STATE_KEY
} from './types';
import type { ConversationStorageIntegrity, ConversationStorageLocation, HistoryIndexInfo, IStorageAdapter, SubAgentTranscriptData } from './storage';
import { withMetadataWriteSerialized, withHangTimeout } from './storage';
import { cleanFunctionResponseForAPI, isRealUserMessage } from './helpers';
import { ConversationTranscriptRepository, type ITranscriptRepository } from './TranscriptRepository';
import { deleteLogicalMessage, truncateFrom, repairParentChainAfterDelete, repairParentChainAfterInsert, restoreSummarizedRange } from './TranscriptMutation';
import { estimatePartialMessageTokens, buildConversationUsageIndex, type UsageIndexMessage, type UsageIndexStore } from './usageStats';
import { getDiffStorageManager } from './DiffStorageManager';
import { getGlobalBranchService } from './branch/BranchService';
import { activePath, findUnsyncedFunctionResponses, isFunctionResponseMessage } from './branch/BranchGraph';
import { BranchError } from './branch/types';
import { agentMailbox } from '../../tools/subagents/agentMailbox';
import { Logger } from '../../core/logger';
import { createHash, randomUUID } from 'node:crypto';

const log = Logger.get('ConversationManager');

/** 会话写锁任务挂起超时（与 usage 队列 60s / 分段历史 60s 对齐；元数据链 30s 更短因小文件） */
const CONVERSATION_WRITE_LOCK_HANG_TIMEOUT_MS = 60000;

/**
 * BR-02：确定性消息节点 ID 生成（RFC 4122 v5 风格）。
 *
 * namespace=conversationId，seed=role+index+timestamp。
 * 幂等硬要求：同一历史多次迁移必须产出同一 ID 集合，因此迁移 ID 不能是随机值。
 */
export function deterministicNodeId(namespace: string, seed: string): string {
    const hash = createHash('sha1');
    hash.update(namespace, 'utf8');
    hash.update('\u0000', 'utf8');
    hash.update(seed, 'utf8');
    const bytes = hash.digest();
    bytes[6] = (bytes[6] & 0x0f) | 0x50; // RFC 4122 version 5
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

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

/** TREE-06：主历史重写结果（rewriteHistoryFromBranchGraph） */
export interface BranchHistoryRewriteResult {
    /** 是否实际落盘重写了主历史（false = 主历史已等于活跃路径，无变更未写盘） */
    rewritten: boolean;
    /** 重写后的主历史消息数（含 functionResponse 拆分消息） */
    historyLength: number;
    /** 图活跃路径节点数（不含 functionResponse，决策 8） */
    activePathLength: number;
    /**
     * 旧主历史与新主历史首次按 id 分歧的数组下标（含该下标；检查点从该索引起清理）。
     * null = 无分歧（未重写 / 内容完全一致）。
     */
    divergenceIndex: number | null;
    /** 重写后主历史消息 id 列表（含 functionResponse 消息 id，供校验/测试） */
    historyIds: string[];
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
 * - 元数据轻量读（getMetadataLight）带 LRU 内存缓存：所有写路径统一失效/回填，
 *   对话列表分页（每页 30 条）与用量统计/检查点查询的逐对话读取不再重复走磁盘
 */
export class ConversationManager {
    constructor(private storage: IStorageAdapter, private readonly usageIndexStore?: UsageIndexStore) {}

    /** 会话元数据 LRU（容量上限：对话列表分页 + 打开标签页通常远小于此） */
    private static readonly META_CACHE_CAPACITY = 256;
    /**
     * BCP-01 PERF：getMessageNodeIdAt 短 TTL 缓存时长。
     * 该缓存只在「缓存条目的权威数据」上生效（见 nodeIdCache 注释），TTL 仅用于
     * 兜底会话外部的直写存储场景（进程内写链全部走失效，不受 TTL 影响）。
     */
    private static readonly NODE_ID_CACHE_TTL_MS = 300;
    /** BCP-01 PERF：节点 ID 反查缓存容量（与历史 LRU 同量级） */
    private static readonly NODE_ID_CACHE_CAPACITY = 24;

    private readonly metaCache = new Map<string, ConversationMetadata | null>();
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

    private touchMetaCache(conversationId: string): void {
        const value = this.metaCache.get(conversationId);
        if (value !== undefined) {
            this.metaCache.delete(conversationId);
            this.metaCache.set(conversationId, value);
        }
        if (this.metaCache.size > ConversationManager.META_CACHE_CAPACITY) {
            const oldest = this.metaCache.keys().next().value;
            if (oldest !== undefined) {
                this.metaCache.delete(oldest);
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
        if (this.nodeIdCache.size > ConversationManager.NODE_ID_CACHE_CAPACITY) {
            const oldest = this.nodeIdCache.keys().next().value;
            if (oldest !== undefined) {
                this.nodeIdCache.delete(oldest);
            }
        }
    }

    /** 会话所有缓存统一失效（元数据/节点 ID 反查）；结构性变更后必须调用 */
    private invalidateCaches(conversationId: string): void {
        this.metaCache.delete(conversationId);
        this.nodeIdCache.delete(conversationId);
    }

    private cacheMetadata(conversationId: string, metadata: ConversationMetadata | null): void {
        this.metaCache.set(conversationId, metadata);
        this.touchMetaCache(conversationId);
    }

    /** 供测试/诊断清理元数据缓存 */
    clearMetadataCache(): void {
        this.metaCache.clear();
        this.nodeIdCache.clear();
    }

    /**
     * 元数据落盘并同步缓存：所有 ConversationManager 层级的 saveMetadata 都应走这里，
     * 保证写后读（getMetadataLight）命中缓存而不是重新走磁盘。
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
        // R5b-2.1：挂起超时与其余队列对齐（usage 60s / 分段历史 60s / metadata 链 30s）。
        // 任务长时间不结束视为挂起，按失败处理并让链继续前进，防止卡死任务永久阻塞该会话所有写入。
        const current = previous.catch(() => undefined).then(() =>
            withHangTimeout(task(), `conversationWriteLock(${conversationId})`, CONVERSATION_WRITE_LOCK_HANG_TIMEOUT_MS)
        );
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

    /** append/mutate 入口短路：会话已被删除时拒绝写入（正常删除后不应再有写入） */
    private assertNotDeleted(conversationId: string): void {
        if (this.deletedConversationIds.has(conversationId)) {
            throw new Error(`Conversation ${conversationId} has been deleted; refusing to write history`);
        }
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
                this.assertNotDeleted(conversationId);
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
                this.assertNotDeleted(conversationId);
                const tail = await this.readTailContent(conversationId);
                let previous = tail;
                const withNodeIds = contents.map(content => {
                    const next = this.ensureNodeId(content, previous);
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
                        void (async () => {
                            try {
                                const loaded = await branchService.getBranchGraph(conversationId);
                                const graph = loaded.graph;
                                if (!graph) {
                                    return; // 线性对话未建图：不强制建
                                }
                                const tail = graph.activeTailNodeId ? graph.nodes[graph.activeTailNodeId] : undefined;
                                if (tail && (tail.parts?.length ?? 0) === 0
                                    && (tail.kind === 'reroll' || tail.kind === 'edit')) {
                                    return; // 流式占位候选：跳过，由 finishReroll 回填
                                }
                                await branchService.appendHistoryToGraph(conversationId, withNodeIds);
                            } catch (error) {
                                log.warn('branch_append_sync_failed', {
                                    conversationId,
                                    error: (error as Error)?.message ?? String(error),
                                });
                            }
                        })();
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
        createdAt: number,
        sourceNodeId?: string
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
            // BR-09：sourceNodeId 与 sourceMessageIndex 双写（新字段为主，旧字段兼容过渡）
            ...(sourceNodeId ? { sourceNodeId } : {}),
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

    private async loadStoredMetadata(conversationId: string): Promise<ConversationMetadata | null> {
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

    // ==================== BR-01/BR-02：稳定消息节点 ID ====================

    /**
     * BR-01：为新写入/插入的内容补齐稳定节点 ID。
     *
     * - id：已有则保留，否则生成随机 UUID；
     * - parentId：未定义（undefined）时取 parent 的 id（线性链接），首条为 null；显式 null/string 保留。
     */
    private ensureNodeId(content: Content, parent: Content | null | undefined): Content {
        if (typeof content.id !== 'string' || content.id.length === 0) {
            content.id = randomUUID();
        }
        if (content.parentId === undefined) {
            content.parentId = parent?.id ?? null;
        }
        return content;
    }

    /**
     * BR-02：幂等判据（自判定，无需额外标记文件）——历史中存在无 id 或 parentId 未定义的消息。
     */
    private static needsNodeIdMigration(history: ReadonlyArray<Content>): boolean {
        return history.some(message =>
            typeof message.id !== 'string' || message.id.length === 0
            || message.parentId === undefined
        );
    }

    /**
     * BR-02：迁移前后的结构指纹（不含 id/parentId，用于写回后校验首尾消息与总数未变）。
     */
    private static computeHistoryFingerprint(history: ReadonlyArray<Content>): string {
        if (history.length === 0) return 'empty';
        const fingerprintOf = (content: Content | undefined): string => {
            if (!content) return 'none';
            const partKinds = (content.parts || []).map(part => {
                if (part.functionCall) return 'fc';
                if (part.functionResponse) return 'fr';
                if (part.thought) return 'th';
                if (part.inlineData) return 'in';
                return 'tx';
            }).join(',');
            return createHash('sha256')
                .update(String(content.role))
                .update('\u0000').update(String(content.timestamp ?? ''))
                .update('\u0000').update(String((content.parts || []).length))
                .update('\u0000').update(partKinds)
                .digest('hex');
        };
        return `${fingerprintOf(history[0])}|${fingerprintOf(history[history.length - 1])}`;
    }

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
        return await this.withConversationWriteLock(conversationId, async () => {
            const result = await this.storage.loadHistoryWithStatus(conversationId);
            const history = result.value;
            if (!history || history.length === 0) return false;

            if (!ConversationManager.needsNodeIdMigration(history)) return false;

            const beforeTotal = history.length;
            const beforeFingerprint = ConversationManager.computeHistoryFingerprint(history);

            const migrated = this.buildMigratedHistory(conversationId, history);

            this.assertNotDeleted(conversationId);
            await this.storage.saveHistory(conversationId, migrated);
            // 迁移直写不走仓储：同步失效元数据缓存（存储层刷新 updatedAt）；迁移重写了历史，
            // 节点 ID 反查缓存一并失效（BCP-01）
            this.invalidateCaches(conversationId);
            await this.updateUsageIndex(conversationId, migrated);

            const persisted = await this.storage.loadHistoryWithStatus(conversationId);
            const afterTotal = persisted.value?.length ?? -1;
            const afterFingerprint = ConversationManager.computeHistoryFingerprint(persisted.value ?? []);
            if (afterTotal !== beforeTotal || afterFingerprint !== beforeFingerprint) {
                throw new Error(
                    `Node ID migration verification failed for conversation ${conversationId}: ` +
                    `total ${beforeTotal}→${afterTotal}, fingerprint ${beforeFingerprint}→${afterFingerprint}`
                );
            }
            return true;
        });
    }

    /** BR-02：按数组顺序补齐确定性 id + 线性 parentId（纯函数，不落盘） */
    private buildMigratedHistory(conversationId: string, history: ConversationHistory): ConversationHistory {
        const migrated: ConversationHistory = [];
        let previousId: string | null = null;
        for (let i = 0; i < history.length; i++) {
            const message = history[i];
            const id = (typeof message.id === 'string' && message.id.length > 0)
                ? message.id
                : deterministicNodeId(conversationId, `${message.role}|${i}|${message.timestamp ?? ''}`);
            // 线性链修复：parentId 未定义，或 i>0 时显式 null（主历史只有首条允许 root）→ 取前一条 id。
            // 覆盖场景：读取时插入的 functionResponse 在父消息尚无 id 时被置 null，迁移时补回正确父链。
            const hasValidParent = typeof message.parentId === 'string' && message.parentId.length > 0;
            const parentId = hasValidParent
                ? message.parentId
                : (i === 0 ? null : previousId);
            migrated.push({ ...message, id, parentId });
            previousId = id;
        }
        return migrated;
    }

    // ==================== TREE-06：切换后主历史重写 ====================

    /**
     * TREE-06：从分支图活跃路径重建主历史——「切换后主历史 = 新活跃路径」的唯一真源操作。
     *
     * 语义：
     * - 通过全局 BranchService 读取分支图（会话写锁内只读，图读不持图锁，无死锁）；
     * - 沿 activePath 顺序把节点映射为主历史 Content[]：
     *   · user/model/system 节点 → 一条消息（role / parts(剔除 functionResponse) / id /
     *     parentId / timestamp / modelVersion / usageMetadata 取自节点，决策 8）；
     *   · 节点 parts 中的 functionResponse 拆分回独立消息（role='user' + isFunctionResponse=true，
     *     依附在所属节点消息之后）——与 importLinearHistory / finishReroll 的合并规则互为逆操作；
     *   · 拆分出的 functionResponse 消息优先复用旧主历史对应 FR 消息 id（按「所属节点 id +
     *     FR part id 集」匹配，匹配不到才生成随机 id；R8a-H1 幂等修复），并补齐
     *     timestamp（R8a-L1）——保证含 FR 路径的重复切换 rewritten=false、检查点不被误删。
     * - 重写前检查主历史非 FR 消息是否全部存在于图中（R8a-M2）：存在未同步消息
     *   （appendHistoryToGraph 为锁外 fire-and-forget，同步完成前切换会丢消息）时抛
     *   BRANCH_OPERATION_CONFLICT 拒绝切换，防止未入图消息被整体替换丢弃；
     * - 与旧主历史逐元素按 id 比对：完全一致 → 不落盘（rewritten=false，幂等）；
     *   否则全量重写——先失效上下文裁剪状态（R8a-M1：先于历史变更、幂等无害，避免
     *   saveHistory 成功后 metadata 写失败抛错 → 图/历史永久分裂），再 storage.saveHistory
     *   （分段原子写 + updatedAt）+ 用量索引全量重建，并返回 divergenceIndex
     *   （旧历史与新历史首次 id 分歧的数组下标，检查点清理起点）。
     *
     * 锁边界（BR-07 / M-3 强约束）：
     * - 本方法整体在 runExclusive（会话写锁）内执行；内部只调用不重复获取会话写锁的存储写入
     *   （storage.saveHistory / updateUsageIndex / setCustomMetadata 各走独立写队列），
     *   不触碰存档操作锁——「会话锁内严禁获取存档锁」（存档锁只能在会话锁之外获取，
     *   见 BranchService 头部注释）；检查点清理由调用方在会话锁之外编排。
     *
     * @throws BranchError('BRANCH_STORAGE_CORRUPT') 分支图损坏（解析/语义）时拒绝重写；
     *         BranchError('BRANCH_OPERATION_CONFLICT') 全局分支服务未注册时（调用方应先注册）。
     */
    async rewriteHistoryFromBranchGraph(conversationId: string): Promise<BranchHistoryRewriteResult> {
        await this.ensureHistoryNodeIds(conversationId);
        return await this.runExclusive(conversationId, async () => {
            const branchService = getGlobalBranchService();
            if (!branchService) {
                throw new BranchError(
                    'BRANCH_OPERATION_CONFLICT',
                    'branch service is not registered; cannot rewrite main history from branch graph'
                );
            }
            const loaded = await branchService.getBranchGraph(conversationId);
            const graph = loaded.graph;
            if (!graph || graph.rootNodeId === null) {
                if (loaded.errorCode === 'BRANCH_STORAGE_CORRUPT') {
                    throw new BranchError(
                        'BRANCH_STORAGE_CORRUPT',
                        `cannot rewrite main history from corrupt branch graph: ${loaded.errorMessage ?? 'unknown error'}`
                    );
                }
                // 线性模式（无图/空图）：主历史即活跃路径，无需重写（不强制建图）
                const history = await this.getMessagesRaw(conversationId);
                return {
                    rewritten: false,
                    historyLength: history.length,
                    activePathLength: 0,
                    divergenceIndex: null,
                    historyIds: history.map(message => message.id ?? ''),
                };
            }

            // 1. 活跃路径 → Content[]（functionResponse 拆分，决策 8）
            const pathIds = activePath(graph);
            const oldHistory = await this.getMessagesRaw(conversationId);

            // R8a-M2：切换重写前一致性检查——主历史中存在于图之外（未同步进图）的消息。
            // appendHistoryToGraph 是锁外 fire-and-forget（失败仅告警，ConversationManager
            // appendContents 接线）；异步同步完成前切换或同步失败时，重写只取图节点内容
            // （下述 nextContents），主历史尾部未入图的消息会被整体替换丢弃 → 此处拒绝切换并
            // 返回明确错误（BRANCH_OPERATION_CONFLICT），等待同步收敛（或修复图）后重试；
            // 不丢弃任何历史消息。判定口径分两层：
            // 1) 主历史非 functionResponse 消息的 id 必须存在于图节点集合（FR 消息按决策 8
            //    并入所属节点 parts，不单独成节点，故排除）；
            // 2) FR 消息内容必须已并入所属节点 parts——findUnsyncedFunctionResponses 沿主历史
            //    以最近非 FR 消息 id 为 owner，校验 FR parts 的 functionResponse.id 集合是
            //    owner 节点 parts 中 FR id 集合的子集；owner 节点已入图但 FR 内容未同步
            //    （addContent(FR) 走 mutateContents 不触发图同步 / appendHistoryToGraph 同步
            //    失败）时，重写会静默丢弃 FR 内容，同样拒绝。
            const unsyncedCount = oldHistory.filter(message =>
                !isFunctionResponseMessage(message) && !graph.nodes[message.id ?? '']).length;
            const unsyncedFunctionResponses = findUnsyncedFunctionResponses(oldHistory, graph);
            if (unsyncedCount > 0 || unsyncedFunctionResponses.length > 0) {
                throw new BranchError(
                    'BRANCH_OPERATION_CONFLICT',
                    `switch rejected: ${unsyncedCount} message(s) in main history are not yet synced to ` +
                    `the branch graph (${unsyncedFunctionResponses.length} functionResponse message(s) ` +
                    `not yet synced to their owner node parts); retry after the pending append sync completes`
                );
            }

            // R8a-H1：为拆分出的 functionResponse 消息构建旧主历史 id 复用查找表。
            // 图不存 FR 消息 id（决策 8），旧主历史中的 FR id 是写入时生成的随机 UUID；每次重建
            // 都重新随机生成会使「与旧主历史逐元素按 id 比对」必然失败（同一路径重复切换永远
            // rewritten=true，且 divergenceIndex 落到首个 FR 位置 → 内容未变、索引仍有效的
            // 检查点被误删）。匹配口径：key = 「所属节点 id + FR part id 集」——FR 消息依附的
            // 最近非 FR 消息（写入时 FR 的 parentId 可能是前一条 FR，不能直接用作所属节点）与
            // parts 中 functionResponse.id 的有序集合；精确匹配优先，同一节点拆分多条旧 FR 消息
            // （逐条追加形态）时按并集兜底复用第一条旧 id；匹配不到才在步骤 2 生成新 id。
            const oldFrIdsByKey = new Map<string, string[]>();
            const oldFrUnionByOwner = new Map<string, { ids: string[]; firstId: string | null }>();
            {
                let ownerId: string | null = null;
                for (const message of oldHistory) {
                    if (!isFunctionResponseMessage(message)) {
                        ownerId = message.id ?? null;
                        continue;
                    }
                    const frIds = (message.parts ?? [])
                        .map(part => part.functionResponse?.id)
                        .filter((id): id is string => typeof id === 'string' && id.length > 0)
                        .sort();
                    const messageId = message.id ?? '';
                    if (ownerId === null || frIds.length === 0) continue;
                    const key = `${ownerId}|${frIds.join(',')}`;
                    const exact = oldFrIdsByKey.get(key) ?? [];
                    exact.push(messageId);
                    oldFrIdsByKey.set(key, exact);
                    const union = oldFrUnionByOwner.get(ownerId) ?? { ids: [], firstId: null };
                    if (!union.firstId && messageId) union.firstId = messageId;
                    for (const id of frIds) {
                        if (!union.ids.includes(id)) union.ids.push(id);
                    }
                    union.ids.sort();
                    oldFrUnionByOwner.set(ownerId, union);
                }
            }

            const nextContents: Content[] = [];
            for (const nodeId of pathIds) {
                const node = graph.nodes[nodeId]!;
                const parts = node.parts ?? [];
                const functionResponseParts = parts.filter(part => !!part.functionResponse);
                const restParts = parts.filter(part => !part.functionResponse);
                nextContents.push({
                    ...(node.contentMetadata
                        ? JSON.parse(JSON.stringify(node.contentMetadata))
                        : {}),
                    role: node.role,
                    parts: JSON.parse(JSON.stringify(restParts)),
                    id: node.id,
                    parentId: node.parentId,
                    timestamp: node.timestamp ?? node.createdAt,
                    modelVersion: node.modelVersion,
                    usageMetadata: node.usageMetadata,
                    usageMetadataPartial: node.usageMetadataPartial,
                });
                if (functionResponseParts.length > 0) {
                    // R8a-H1：优先复用旧主历史中对应 FR 消息的 id（匹配不到留给步骤 2 生成）。
                    // R8a-L1：拆分消息补 timestamp（所属节点 timestamp/createdAt），不再丢失。
                    let reusedId: string | undefined;
                    const frIds = functionResponseParts
                        .map(part => part.functionResponse?.id)
                        .filter((id): id is string => typeof id === 'string' && id.length > 0)
                        .sort();
                    if (frIds.length > 0) {
                        const exact = oldFrIdsByKey.get(`${node.id}|${frIds.join(',')}`);
                        if (exact && exact.length > 0) {
                            reusedId = exact.shift();
                        } else {
                            const union = oldFrUnionByOwner.get(node.id);
                            if (union && union.firstId && union.ids.join(',') === frIds.join(',')) {
                                reusedId = union.firstId;
                            }
                        }
                    }
                    nextContents.push({
                        role: 'user',
                        parts: JSON.parse(JSON.stringify(functionResponseParts)),
                        isFunctionResponse: true,
                        id: reusedId,
                        timestamp: node.timestamp ?? node.createdAt,
                    });
                }
            }
            // 2. 拆分出的 functionResponse 消息补齐 id / 线性 parentId（parentId = 前一条消息 id）
            for (let i = 0; i < nextContents.length; i += 1) {
                const message = nextContents[i]!;
                if (typeof message.id !== 'string' || message.id.length === 0) {
                    message.id = randomUUID();
                }
                if (message.parentId === undefined) {
                    message.parentId = i === 0 ? null : (nextContents[i - 1]!.id ?? null);
                }
            }

            const historyIds = nextContents.map(message => message.id ?? '');

            // 3. 与旧主历史逐元素按 id 比对：完全一致 → 不落盘（幂等，避免无变更全量重写）
            let identical = oldHistory.length === nextContents.length;
            if (identical) {
                for (let i = 0; i < nextContents.length; i += 1) {
                    if ((oldHistory[i]!.id ?? '') !== (nextContents[i]!.id ?? '')) {
                        identical = false;
                        break;
                    }
                }
            }
            if (identical) {
                return {
                    rewritten: false,
                    historyLength: nextContents.length,
                    activePathLength: pathIds.length,
                    divergenceIndex: null,
                    historyIds,
                };
            }

            // 4. 分歧索引：旧历史与新历史首次按 id 分歧的数组下标（含该下标，检查点清理起点）。
            //    初值 = min(旧,新)：旧历史更长（新路径为旧路径前缀）时即新历史长度（清理全部越界
            //    检查点）；旧历史更短（新路径为旧路径延伸）时即新历史首个越界下标（旧历史无此索引，
            //    清理效果等价）——与 BranchHistoryRewriteResult.divergenceIndex 注释一致
            //    （R8a-L2：旧实现恒取新历史长度，在「旧短新长且旧为前缀」时与注释不符）。
            let divergenceIndex = Math.min(oldHistory.length, nextContents.length);
            const common = Math.min(oldHistory.length, nextContents.length);
            for (let i = 0; i < common; i += 1) {
                if ((oldHistory[i]!.id ?? '') !== (nextContents[i]!.id ?? '')) {
                    divergenceIndex = i;
                    break;
                }
            }

            // 5. 全量重写：直接走 storage.saveHistory（分段原子写 + updatedAt），不走仓储
            //    （仓储自带会话写锁，嵌套会死锁）；用量索引全量重建（TREE-08 口径：活跃路径）。
            //    R8a-M1：invalidateContextManagementState（setCustomMetadata → saveMetadata）先于
            //    saveHistory 执行——历史变更前失效 trim 状态幂等无害；避免「saveHistory 已成功、
            //    metadata 写失败」时抛错 → handler 只回滚图而主历史保持新路径 → 图/历史永久分裂。
            this.assertNotDeleted(conversationId);
            await this.invalidateContextManagementState(conversationId, 'branch_path_switched');
            await this.storage.saveHistory(conversationId, nextContents);
            // 全量重写直写不走仓储：invalidateContextManagementState 已回填旧 custom，
            // 必须在 saveHistory 刷新 updatedAt 后再失效一次，保证缓存与落盘形态一致；
            // 分支切换重写了历史，节点 ID 反查缓存一并失效（BCP-01）
            this.invalidateCaches(conversationId);
            await this.updateUsageIndex(conversationId, nextContents);

            return {
                rewritten: true,
                historyLength: nextContents.length,
                activePathLength: pathIds.length,
                divergenceIndex,
                historyIds,
            };
        });
    }

    /** 把历史映射为返回给前端的显示消息：补绝对 index、过滤内部字段、深拷贝 */
    private toDisplayMessages(history: ConversationHistory): Content[] {
        return history.map((message, index) => {
            // 过滤后端内部字段（turnDynamicContext 数据量大且前端无需使用）
            const { turnDynamicContext, ...rest } = message;
            return { ...JSON.parse(JSON.stringify(rest)), index } as Content;
        });
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
                const parent = insertAt > 0 ? history[insertAt - 1] : null;
                history.splice(insertAt, 0, this.ensureNodeId({
                    role: 'user',
                    parts: rejectedResponseParts,
                    isFunctionResponse: true
                }, parent));
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

        let history = await this.loadHistory(normalizedSourceId);
        if (ConversationManager.needsNodeIdMigration(history)) {
            // BR-01/BR-02：分支源历史先完成惰性补 ID（首次分支操作也是迁移触发点），
            // 保证复制到新对话的历史带稳定节点 ID（BR-09 sourceNodeId 依赖）。
            await this.ensureHistoryNodeIds(normalizedSourceId);
            history = await this.loadHistory(normalizedSourceId);
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
            custom: this.buildBranchCustomMetadata(
                sourceMeta?.custom,
                normalizedSourceId,
                index,
                messageCount,
                preview,
                now,
                sourceNodeId
            )
        };

        await this.storage.saveHistory(targetConversationId, branchHistory);
        await this.updateUsageIndex(targetConversationId, branchHistory);
        await this.persistMetadata(meta);

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
        if (this.deletedConversationIds.size > ConversationManager.MAX_DELETED_IDS) {
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
            await this.withConversationWriteLock(conversationId, async () => {
                await this.storage.deleteHistory(conversationId);
                // R5b-1.3：usage remove 的 enqueue 必须在会话写锁内完成。锁外 enqueue 时，
                // 在途 append 的 usage 写（appendUsage / 增量缺失回退读改写）可能晚于 remove
                // 入队，删除后被回退写重新创建 usage.json（“复活”）。锁内 enqueue 保证 remove
                // 排在在途 usage 写之后；删除后新发起的 append 已被 assertNotDeleted 短路。
                if (this.usageIndexStore) {
                    try {
                        await this.usageIndexStore.remove(conversationId);
                    } catch {
                        // 索引不存在/删除失败忽略（统计侧按 missing 自然跳过）
                    }
                }
                // MED-2：对话删除即清理 A-COMM 信箱（内存同步操作，与删除同一锁内原子执行；
                // 删除失败不会走到这里，信箱状态与对话生命周期保持一致，防 ID 复用时限流/误注入）
                agentMailbox.clearConversation(conversationId);
                // 删除成功后统一失效元数据缓存：已删除会话的快照（含负缓存）不得泄漏给下一次读；
                // 节点 ID 反查缓存一并清除（BCP-01：防 ID 复用后反查命中旧会话节点）
                this.invalidateCaches(conversationId);
            });
        } catch (error) {
            // 删除失败：撤销标记，避免会话被冻结（后续 append/mutate 仍可用）
            this.deletedConversationIds.delete(conversationId);
            throw error;
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

    /**
     * 列出所有对话
     */
    async listConversations(): Promise<string[]> {
        return await this.storage.listConversations();
    }

    /**
     * 加载对话历史（直接从存储读取）
     */
    private async loadHistory(conversationId: string): Promise<ConversationHistory> {
        if (this.deletedConversationIds.has(conversationId)) {
            // 已删除会话：读路径不再自动重建（防止删除后读操作把会话“复活”为空历史）
            return [];
        }
        const result = await this.storage.loadHistoryWithStatus(conversationId);
        if (result.value) {
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
        if (ConversationManager.needsNodeIdMigration(history)) {
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
        metadata?: Partial<Pick<Content, 'isUserInput' | 'isFunctionResponse' | 'isSummary' | 'source'>>,
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

            const persistedContent = this.ensureNodeId(
                { ...contentCopy, parts: filteredParts },
                history[history.length - 1] ?? null
            );
            history.push(persistedContent);
            appendedContent = this.cloneJson(persistedContent);
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
     * 获取所有消息
     *
     * 返回的每条消息都包含 index 字段，用于前端在删除/重试时直接使用
     * 每次调用都从存储读取最新数据
     * 
     * 注意：对于没有响应的 pending 工具调用，会自动标记为 rejected 并添加 functionResponse
     */
    async getMessages(conversationId: string): Promise<Content[]> {
        const history = await this.normalizeHistoryForDisplay(conversationId);
        if (ConversationManager.needsNodeIdMigration(history)) {
            // BR-02：惰性补 ID（幂等），迁移后重新读取（normalize 返回的数组是迁移前形态）
            await this.ensureHistoryNodeIds(conversationId);
            return this.toDisplayMessages(await this.loadHistory(conversationId));
        }
        return this.toDisplayMessages(history);
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
        if (cached && Date.now() - cached.storedAt < ConversationManager.NODE_ID_CACHE_TTL_MS) {
            const cachedMessage = cached.history[index];
            return typeof cachedMessage?.id === 'string' && cachedMessage.id.length > 0
                ? cachedMessage.id
                : undefined;
        }
        // 直读磁盘（不经内存缓存）：调用方可能刚写入历史（含外部直写存储的迁移场景），
        // 缓存可能滞后；反查是低频操作，直接读最保守。
        const result = await this.storage.loadHistoryWithStatus(conversationId);
        let history = result.value ?? [];
        if (ConversationManager.needsNodeIdMigration(history)) {
            // BR-02：写锁内幂等补 ID（迁移自判定），迁移后重新读取
            await this.ensureHistoryNodeIds(conversationId);
            history = await this.loadHistory(conversationId);
        }
        this.nodeIdCache.set(conversationId, { history, storedAt: Date.now() });
        this.touchNodeIdCache(conversationId);
        const message = history[index];
        return typeof message?.id === 'string' && message.id.length > 0 ? message.id : undefined;
    }

    /**
     * 只读浅扫描（首次加载页用）：检查历史是否存在未响应的 functionCall（悬空工具调用），
     * 以及是否存在缺 id 的消息（BR-02 迁移判据）。
     * 只遍历检查、不深拷贝、不写回——正常路径（绝大多数历史无悬空调用/已迁移）可完全跳过
     * normalizeHistoryForDisplay 的全量 JSON 深拷贝（HIS-13 后端收益）。
     */
    private async scanHistoryForInitialPage(conversationId: string): Promise<{ hasUnresolvedCalls: boolean; needsNodeIdMigration: boolean }> {
        const result = await this.storage.loadHistoryWithStatus(conversationId);
        const history = result.value;
        if (!history) return { hasUnresolvedCalls: false, needsNodeIdMigration: false };

        const respondedToolCallIds = new Set<string>();
        for (const message of history) {
            if (!message.parts) continue;
            for (const part of message.parts) {
                if (part.functionResponse?.id) {
                    respondedToolCallIds.add(part.functionResponse.id);
                }
            }
        }
        let hasUnresolvedCalls = false;
        for (const message of history) {
            if (!message.parts) continue;
            for (const part of message.parts) {
                if (part.functionCall?.id
                    && !respondedToolCallIds.has(part.functionCall.id)
                    && !part.functionCall.rejected) {
                    hasUnresolvedCalls = true;
                    break;
                }
            }
            if (hasUnresolvedCalls) break;
        }
        return {
            hasUnresolvedCalls,
            needsNodeIdMigration: ConversationManager.needsNodeIdMigration(history),
        };
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
            // 单次全量浅扫描（无深拷贝）：悬空工具调用 + 缺节点 ID 检测。
            const scan = await this.scanHistoryForInitialPage(conversationId);
            if (scan.hasUnresolvedCalls) {
                // 只有浅扫描命中悬空工具调用时才走 mutate + 深拷贝写回路径；
                // 正常历史跳过 normalizeHistoryForDisplay 的全量 JSON 深拷贝。
                await this.normalizeHistoryForDisplay(conversationId);
            }
            if (scan.needsNodeIdMigration) {
                // BR-02：首次加载检测到缺 id 时在写锁内补 ID（幂等，之后不再触发）
                await this.ensureHistoryNodeIds(conversationId);
            }
        }

        const pagedHistory = await this.storage.loadHistoryPage(conversationId, options);
        if (pagedHistory.value && pagedHistory.value.format === 'paged') {
            return {
                total: pagedHistory.value.total,
                messages: pagedHistory.value.messages.map((message, i) => {
                    const index = pagedHistory.value!.startIndex + i;
                    const { turnDynamicContext, ...rest } = message;
                    return { ...JSON.parse(JSON.stringify(rest)), index } as Content;
                })
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

        const slice = history.slice(start, endExclusive);
        const messages = slice.map((message, i) => {
            const index = start + i;
            // 深拷贝并过滤后端内部字段（turnDynamicContext 数据量大且前端无需使用）
            const { turnDynamicContext, ...rest } = message;
            return {
                ...JSON.parse(JSON.stringify(rest)),
                index
            } as Content;
        });

        return { total, messages };
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
        let deletedMessageId: string | null = null;
        let deletedWasSummary = false;
        const nextHistory = await repository.mutateContents(contents => {
            if (messageIndex < 0 || messageIndex >= contents.length) {
                throw new Error(t('modules.conversation.errors.messageIndexOutOfBounds', { index: messageIndex }));
            }
            // 在实际持锁快照内捕获删除锚点与总结类型，避免 getContents 与 mutateContents 之间
            // 并发插入/删除导致按旧下标走错分支同步策略。
            deletedMessageId = contents[messageIndex]?.id ?? null;
            deletedWasSummary = contents[messageIndex]?.isSummary === true;
            let next = contents;
            // 逻辑截断：删除总结消息时先恢复其覆盖的原文（取消 isSummarized 标记），
            // 避免「既无总结文本也无原文」的上下文真空（原文保留在存储中但不再发送）。
            if (next[messageIndex]?.isSummary) {
                const restored = restoreSummarizedRange(next, messageIndex);
                next = restored.contents;
            }
            return deleteLogicalMessage(next, messageIndex);
        });
        // HIS-11：结构性删除后同步 custom.messageCount（防对话列表 messageCount 漂移）
        await this.syncMessageCountAfterStructuralChange(conversationId, nextHistory.length);
        await this.invalidateContextManagementState(conversationId, 'message_deleted');

        // 决策 6：删除后同步软删分支图——「被删节点及其后续整棵子树」（TREE-09 软删语义：
        // 节点标记 deleted + deletedAt，不物理移除 sidecar；可经恢复接口还原）。
        // 锁取舍：删除历史已随 mutateContents 释放会话写锁（仓储互斥执行器非重入，此时锁空闲），
        // 因此直接 await 图同步（内部顺序再取会话写锁，非嵌套，无死锁）——单条删除是用户显式
        // 操作，删除响应返回前保证图一致（避免响应后立即续写时 appendHistoryToGraph 挂在已被
        // 硬删除的旧尾上）；这与 appendContents 的 fire-and-forget（彼处仍处于写锁内不可重入）
        // 场景不同。图同步失败仅告警（主历史为唯一真源，图侧由下次读图/写图自校验兜底），
        // 不阻断删除；无全局 BranchService（未注册/测试环境）时静默跳过。
        if (deletedMessageId) {
            const branchService = getGlobalBranchService();
            if (branchService) {
                try {
                    if (deletedWasSummary) {
                        // 删除总结会同时恢复其覆盖原文的 isSummarized 标记，不是普通子树删除；
                        // 必须按当前主历史重建活跃路径与消息元数据，不能把总结后的全部后继软删。
                        await branchService.syncMainHistoryAfterStructuralMutation(conversationId, 'summary_deleted');
                    } else {
                        await branchService.syncGraphAfterHistoryDelete(conversationId, deletedMessageId);
                    }
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
            const inserted = this.ensureNodeId({
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
            const oldParent = index > 0 ? history[index - 1] : null;
            const oldParentId = oldParent?.id ?? null;
            const inserted = this.ensureNodeId(contentCopy, oldParent);
            history.splice(index, 0, inserted);
            // R5b-2.4：插入后修复线性 parentId 链（插入点之后 parentId===旧父id 的消息
            // 重链到新插入消息，与 deleteMessagesInRange 的 repairParentChainAfterDelete 语义对称）
            repairParentChainAfterInsert(history, index, oldParentId, inserted.id as string);
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
            for (let i = summaryIndices.length - 1; i >= 0; i--) {
                const restored = restoreSummarizedRange(next, summaryIndices[i]);
                next = restored.contents;
            }
            const deleted = next.slice(start, end);
            next.splice(start, end - start);
            // R5b-2.4：删除中间消息后修复线性 parentId 链（被删消息的直系后继
            // parentId===被删id 的消息重链到被删消息的 parent；分支跨链不受影响）
            repairParentChainAfterDelete(next, deleted);
            return next.slice(); // 有变更必须返回新引用（契约：返回原引用=跳过写回）
        });
        // HIS-11：结构性删除后同步 custom.messageCount（防对话列表 messageCount 漂移）
        await this.syncMessageCountAfterStructuralChange(conversationId, nextHistory.length);
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
            // HIS-11：结构性删除后同步 custom.messageCount（防对话列表 messageCount 漂移）
            await this.syncMessageCountAfterStructuralChange(conversationId, nextHistory.length);
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
        const nextHistory = await this.getTranscriptRepository(conversationId).replaceContents([]);
        // HIS-11：结构性清空后同步 custom.messageCount（防对话列表 messageCount 漂移）
        await this.syncMessageCountAfterStructuralChange(conversationId, nextHistory.length);
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
        
        // 找到最后一个非函数响应的 user 消息的索引（H1-1：与 MED-3 同谓词，
        // 总结消息不构成回合边界——SummarizeService 在历史中间插入总结，
        // 不得让总结之前的当轮 functionResponse 被判为历史而剥离 agentInbox）
        let lastNonFunctionResponseUserIndex = -1;
        for (let i = history.length - 1; i >= 0; i--) {
            const message = history[i];
            if (isRealUserMessage(message)) {
                lastNonFunctionResponseUserIndex = i;
                break;
            }
        }
        
        // 识别所有回合并计算哪些回合需要发送历史思考
        // 回合定义：从一个真实 user 消息（排除 functionResponse / 总结消息，H1-1 与 MED-3 同谓词）
        // 开始，到下一个真实 user 消息之前结束
        const roundStartIndices: number[] = [];
        for (let i = 0; i < history.length; i++) {
            const message = history[i];
            if (isRealUserMessage(message)) {
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
        
        // 已见的 functionCall id 集合（BR-07 防御）：functionCall → functionResponse
        // 按 id 一一对应。functionCall 被截断/reroll 后，残留的孤儿 functionResponse
        // 在 Anthropic 渠道会引用不存在的 tool_use（400 错误），需要在下发前剔除。
        // 顺序遍历历史：先登记 functionCall id，再校验后续 functionResponse 是否匹配。
        const seenFunctionCallIds = new Set<string>();
        
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
        const processFunctionResponse = (part: ContentPart, isHistoryMessage: boolean): ContentPart => {
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
            
            // 清理不应发送给 AI 的内部字段（使用共享函数确保一致性）。
            // HIGH-1：历史消息剥离 agentInbox（防跨轮重放）；当轮（isHistoryMessage=false）保留——
            // injectInboxMessages 注入的 agent→main 信箱消息随工具结果落盘后，下一轮请求仍属
            // 当前回合（lastNonFunctionResponseUserIndex 之后），保留才能让主模型真正看到。
            const cleanedResponse = cleanFunctionResponseForAPI(
                part.functionResponse.response as Record<string, unknown>,
                isHistoryMessage
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
            
            // 登记本消息中的 functionCall id（BR-07）：后续的 functionResponse 只有
            // 出现在该集合中才被保留，被截断/reroll 后残留的孤儿 functionResponse 将被过滤。
            for (const part of message.parts) {
                if (part.functionCall?.id) {
                    seenFunctionCallIds.add(part.functionCall.id);
                }
            }
            
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
                .map(part => part ? processFunctionResponse(part, isHistoryMessage) : part)
                // 过滤空 part：
                // - null（被 cleanInlineData 等过滤）
                // - 空对象
                // - 仅包含 thought: true 的“空 thought 块”（常见于：原本只有 thoughtSignatures，后续又被配置过滤掉签名）
                //   这类 part 在不同模型/渠道下可能导致兼容性问题。
                .filter((part): part is ContentPart => {
                    if (part === null) return false;
                    // BR-07：孤儿 functionResponse 过滤——functionResponse.id 必须匹配
                    // 已见的 functionCall id（见 processMessage 开头的登记）。无 id 的
                    // functionResponse（Gemini 等按顺序配对的渠道）保守保留，不做激进过滤。
                    if (part.functionResponse && part.functionResponse.id
                        && !seenFunctionCallIds.has(part.functionResponse.id)) {
                        return false;
                    }
                    const keys = Object.keys(part);
                    if (keys.length === 0) return false;
                    if (keys.length === 1 && keys[0] === 'thought' && (part as any).thought === true) return false;
                    return true;
                });
            
            if (parts.length === 0) {
                return null;
            }
            
            // 保留必要的元数据字段
            // BR-01：白名单过滤——id/parentId 等节点字段只用于存储与前端定位，不发送给模型
            //        （新增字段必须显式加入白名单才会下发）。
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
                // M3：钳制 messageCount 不超过实际历史提交数。appendHistory 失败但前端已乐观更新并
                // 调 updateSummary 时，不钳制会让 custom.messageCount 永久超前于真实历史。
                // 走轻量只读 index JSON（getHistoryTotalMessages：1 次读、0 次逐段 stat）；
                // 索引不可读/legacy 时跳过钳制。
                const totalMessages = await this.resolveHistoryTotalMessages(conversationId);
                if (typeof totalMessages === 'number' && totalMessages >= 0) {
                    messageCount = Math.min(messageCount, totalMessages);
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
    private async syncMessageCountAfterStructuralChange(conversationId: string, count: number): Promise<void> {
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
        const cached = this.metaCache.get(conversationId);
        if (cached !== undefined) {
            return cached === null ? null : JSON.parse(JSON.stringify(cached)) as ConversationMetadata;
        }
        const result = await this.storage.loadMetadataWithStatus(conversationId);
        if (result.value) {
            this.cacheMetadata(conversationId, result.value);
            return result.value;
        }
        // 与 loadStoredMetadata 相同的降级语义：仅 not_found 才做负缓存，
        // io_error/parse_error 不缓存（parse_error 的 getMetadata 走损坏降级，不在此污染缓存）
        if (!result.errorCode || result.errorCode === 'not_found') {
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
        const summaries = await this.runBounded(ids, 16, async conversationId => this.buildConversationSummary(conversationId));
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
        let modified = false;

        // R2 4.1：get→修改→replace 整体走仓储互斥执行器（withConversationWriteLock），
        // 与 settleFunctionResponses / rejectAllPendingToolCalls / 其它 mutate 串行。
        // 旧实现锁外 get + 锁内 replace：并发时基于旧快照的整体写回会把并发写入的
        // 真实结果（如已追加的新消息）覆盖丢失。mutateContents 契约：无变更返回原引用
        // 跳过写回，有变更返回新引用触发写回。
        await repository.mutateContents((history) => {
            if (messageIndex < 0 || messageIndex >= history.length) {
                throw new Error(t('modules.conversation.errors.messageIndexOutOfBounds', { index: messageIndex }));
            }

            const message = history[messageIndex];
            let localModified = false;

            // 收集所有已有响应的工具 ID
            const respondedToolIds = new Set<string>();
            for (let i = messageIndex + 1; i < history.length; i++) {
                const msg = history[i];
                // R5b-2.3：与 rejectAllPendingToolCalls / normalizeHistoryForDisplay 对齐，
                // 防御历史中存在无 parts 的消息时抛错
                if (!msg.parts) {
                    continue;
                }
                for (const part of msg.parts) {
                    if (part.functionResponse?.id) {
                        respondedToolIds.add(part.functionResponse.id);
                    }
                }
            }

            // 收集需要拒绝的工具调用
            const rejectedCalls: Array<{ id: string; name: string }> = [];

            // 标记工具为拒绝状态（R5b-2.4：与同函数 2904-2910 行 / rejectAllPendingToolCalls 一致，
            // 防御目标消息本身无 parts 时抛 TypeError）
            if (message.parts) {
                for (const part of message.parts) {
                    if (part.functionCall && part.functionCall.id) {
                        // 检查是否需要标记此工具
                        const shouldReject = toolCallIds
                            ? toolCallIds.includes(part.functionCall.id)
                            : !respondedToolIds.has(part.functionCall.id);

                        if (shouldReject && !part.functionCall.rejected) {
                            part.functionCall.rejected = true;
                            localModified = true;

                            // 收集被拒绝的工具信息
                            rejectedCalls.push({
                                id: part.functionCall.id,
                                name: part.functionCall.name || 'unknown'
                            });
                        }
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
                const parent = insertAt > 0 ? history[insertAt - 1] : null;
                history.splice(insertAt, 0, this.ensureNodeId({
                    role: 'user',
                    parts: rejectedResponseParts,
                    isFunctionResponse: true
                }, parent));
                localModified = true;
            }

            if (localModified) {
                modified = true;
                // 有变更：返回新引用触发写回（mutateContents 契约：返回原引用=跳过写回）
                return history.slice();
            }
            // 无变更：返回原引用跳过写回（此时没有任何原地修改）
            return history;
        });

        if (modified) {
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
                    const parent = insertAt > 0 ? history[insertAt - 1] : null;
                    history.splice(insertAt, 0, this.ensureNodeId({
                        role: 'user',
                        parts: rejectedResponseParts,
                        isFunctionResponse: true
                    }, parent));
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
                history.push(this.ensureNodeId({
                    role: 'user',
                    parts: newParts,
                    isFunctionResponse: true,
                }, history[history.length - 1] ?? null));
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

