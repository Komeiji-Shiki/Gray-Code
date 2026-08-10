/**
 * 对话只读查询服务（拆分自 ConversationManager.ts 的消息读取/分页/配对规范化方法组）。
 *
 * 通过 ConversationQueryContext 接入 ConversationManager 的私有能力（storage / loadHistory /
 * ensureHistoryNodeIds / getTranscriptRepository），ConversationManager 持有本服务实例并在
 * 同名 public 方法中委托，方法签名与行为保持不变。
 * 注意：本文件内容按原文件缩进保留（纯移动，不重排）。
 */

import { t } from '../../../i18n';
import type { Content, ContentPart, ConversationHistory, MessageFilter, MessagePosition } from '../types';
import type { IStorageAdapter } from '../storage';
import type { ITranscriptRepository } from '../TranscriptRepository';
import { ensureBackgroundTaskSourceForDisplay } from '../helpers';
import { ensureNodeId, needsNodeIdMigration } from './nodeId';
import { findFunctionResponseInsertIndex, scanHistoryForInitialPage } from './utils';
import { toDisplayMessages } from './historyFormatting';

/** ConversationQueryService 依赖的 ConversationManager 能力（委托绑定） */
export interface ConversationQueryContext {
    storage: IStorageAdapter;
    loadHistory(conversationId: string, workspaceUri?: string): Promise<ConversationHistory>;
    ensureHistoryNodeIds(conversationId: string): Promise<boolean>;
    getTranscriptRepository(conversationId: string, workspaceUri?: string): ITranscriptRepository;
}

export class ConversationQueryService {
    constructor(private readonly ctx: ConversationQueryContext) {}

    /**
     * 获取所有消息
     *
     * 返回的每条消息都包含 index 字段，用于前端在删除/重试时直接使用
     * 每次调用都从存储读取最新数据
     * 
     * 注意：对于没有响应的 pending 工具调用，会自动标记为 rejected 并添加 functionResponse
     */
    async getMessages(conversationId: string, workspaceUri?: string): Promise<Content[]> {
        const history = await this.normalizeHistoryForDisplay(conversationId, workspaceUri);
        if (needsNodeIdMigration(history)) {
            // BR-02：惰性补 ID（幂等），迁移后重新读取（normalize 返回的数组是迁移前形态）
            await this.ctx.ensureHistoryNodeIds(conversationId);
            return toDisplayMessages(await this.ctx.loadHistory(conversationId, workspaceUri));
        }
        return toDisplayMessages(history);
    }

    /**
     * 轻量读取原始消息（供用量统计等只关心 usageMetadata 的场景使用）
     *
     * 与 getMessages 不同：不做显示规范化（工具调用配对补齐等）与逐条深拷贝，
     * 直接返回存储中的原始消息，显著降低全量扫描的成本。
     */
    async getMessagesRaw(conversationId: string): Promise<Content[]> {
        const result = await this.ctx.storage.loadHistoryWithStatus(conversationId);
        return result.value ?? [];
    }

    /**
     * 分页获取对话消息（仅返回一个窗口，避免一次性向 Webview 发送全量历史）
     *
     * - beforeIndex: 取 [0, beforeIndex) 区间内的最后 limit 条（用于上拉加载更早消息）
     * - offset/limit: 取 [offset, offset+limit) 区间（用于任意分页）
     * - workspaceUri: 可选工作区 URI，仅当历史不存在、按需自动创建会话时使用（H4 记忆隔离）
     *
     * 返回的 messages 中每条都包含绝对 index（即后端历史索引）。
     */
    async getMessagesPaged(
        conversationId: string,
        options: { beforeIndex?: number; offset?: number; limit?: number } = {},
        workspaceUri?: string
    ): Promise<{ total: number; messages: Content[] }> {
        // 分段存储的分页读取只拿到一个窗口，判断不了跨窗口的工具调用配对，因此下面的快路径
        // 无法复用 normalizeHistoryForDisplay。若不在这里补齐，取消/中断留下的悬空 functionCall
        // 会一直留在历史里，下一次请求直接被 provider 以 400 拒绝。
        // 只在首次加载（默认页）做一次全量补齐：上拉加载更早消息时跳过，避免每翻一页读一次全量。
        // 补齐会插入消息、改变 index，必须发生在分页取数之前。
        const isInitialPage = options.beforeIndex === undefined && options.offset === undefined;
        if (isInitialPage) {
            // 单次全量浅扫描（无深拷贝）：悬空工具调用 + 缺节点 ID 检测。
            const scan = await scanHistoryForInitialPage(this.ctx.storage, conversationId);
            if (scan.hasUnresolvedCalls) {
                // 只有浅扫描命中悬空工具调用时才走 mutate + 深拷贝写回路径；
                // 正常历史跳过 normalizeHistoryForDisplay 的全量 JSON 深拷贝。
                await this.normalizeHistoryForDisplay(conversationId, workspaceUri);
            }
            if (scan.needsNodeIdMigration) {
                // BR-02：首次加载检测到缺 id 时在写锁内补 ID（幂等，之后不再触发）
                await this.ctx.ensureHistoryNodeIds(conversationId);
            }
        }

        const pagedHistory = await this.ctx.storage.loadHistoryPage(conversationId, options);
        if (pagedHistory.value && pagedHistory.value.format === 'paged') {
            return {
                total: pagedHistory.value.total,
                messages: pagedHistory.value.messages.map((message, i) => {
                    const index = pagedHistory.value!.startIndex + i;
                    const { turnDynamicContext, ...rest } = ensureBackgroundTaskSourceForDisplay(message);
                    return { ...JSON.parse(JSON.stringify(rest)), index } as Content;
                })
            };
        }

        const history = await this.normalizeHistoryForDisplay(conversationId, workspaceUri);

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
            const { turnDynamicContext, ...rest } = ensureBackgroundTaskSourceForDisplay(message);
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
        const history = await this.ctx.loadHistory(conversationId);
        if (index < 0 || index >= history.length) {
            return undefined;
        }
        return JSON.parse(JSON.stringify(history[index]));
    }

    /**
     * 查找消息
     */
    async findMessages(
        conversationId: string,
        filter: MessageFilter
    ): Promise<MessagePosition[]> {
        const history = await this.ctx.loadHistory(conversationId);
        const results: MessagePosition[] = [];

        for (let i = 0; i < history.length; i++) {
            const message = history[i];
            let matches = true;

            if (filter.role && message.role !== filter.role) {
                matches = false;
            }

            if (filter.hasFunctionCall !== undefined) {
                const hasFunctionCall = (message.parts ?? []).some(p => p.functionCall !== undefined);
                if (hasFunctionCall !== filter.hasFunctionCall) {
                    matches = false;
                }
            }

            if (filter.hasText !== undefined) {
                const hasText = (message.parts ?? []).some(
                    p => p.text !== undefined && p.text.trim() !== ''
                );
                if (hasText !== filter.hasText) {
                    matches = false;
                }
            }

            if (filter.isThought !== undefined) {
                const isThought = (message.parts ?? []).some(p => p.thought === true);
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
        const history = await this.ctx.loadHistory(conversationId);
        return history
            .filter(msg => msg.role === role)
            .map(msg => JSON.parse(JSON.stringify(msg)));
    }

    /**
     * 规范化历史：补齐未响应的工具调用（rejected + functionResponse 插入），并在必要时写回存储。
     *
     * 注意：此过程会改变 history 的长度，从而改变消息 index。
     * 前端依赖 index 进行删除/重试等操作，因此必须在返回前完成该规范化。
     * 整个读-改-写过程在仓储互斥执行器内完成；无未响应调用时不写回（返回原引用跳过），
     * 避免基于旧快照的整体写回覆盖并发落盘的真实工具结果。
     */
    async normalizeHistoryForDisplay(conversationId: string, workspaceUri?: string): Promise<ConversationHistory> {
        return await this.ctx.getTranscriptRepository(conversationId, workspaceUri).mutateContents(history => {
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
                const insertAt = findFunctionResponseInsertIndex(history, messageIndex);
                const parent = insertAt > 0 ? history[insertAt - 1] : null;
                history.splice(insertAt, 0, ensureNodeId({
                    role: 'user',
                    parts: rejectedResponseParts,
                    isFunctionResponse: true
                }, parent));
            }

            // 有新插入：返回新引用触发写回（契约：返回原引用=跳过写回）
            return history.slice();
        });
    }
}
