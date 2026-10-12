import { t } from '../../../i18n';
import { Content, ContentPart } from '../types';

import { type ITranscriptRepository } from '../TranscriptRepository';
import {
    deleteLogicalMessage,
    truncateFrom,
    repairFunctionCallPairsAfterDelete,
    repairParentChainAfterDelete,
    repairParentChainAfterInsert,
    restoreSummarizedRange,
} from '../TranscriptMutation';

import { getGlobalBranchService } from '../branch/BranchService';
import { Logger } from '../../../core/logger';
import { ConversationMetadataService } from './metadata';
import { ensureNodeId } from './nodeId';
import { shouldInvalidateContextManagementStateForUpdate } from './utils';

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
        readonly actualMessageId: string | undefined,
    ) {
        super(`Conversation message changed: expected ${expectedMessageId}, got ${actualMessageId ?? '<missing>'}`);
        this.name = 'ConversationMessageChangedError';
    }
}

/** deleteToMessage 在同一写锁快照中捕获的删除区间信息。 */
export interface DeleteToMessageCapture {
    deletedMessageIds: string[];
}
const log = Logger.get('ConversationManager');

interface ConversationMutationServiceContext {
    metadata: ConversationMetadataService;
    getTranscriptRepository(conversationId: string, workspaceUri?: string): ITranscriptRepository;
    invalidateContextManagementState(conversationId: string, reason: string): Promise<void>;
    withGraphSyncQueue(conversationId: string, task: () => Promise<void>): Promise<void>;
    getFirstMessageId(conversationId: string): Promise<string | null>;
}

export class ConversationMutationService {
    constructor(private readonly ctx: ConversationMutationServiceContext) {}

    /**
     * 更新消息
     */
    async updateMessage(conversationId: string, messageIndex: number, updates: Partial<Content>): Promise<void> {
        await this.ctx.getTranscriptRepository(conversationId).mutateContents((history) => {
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
            await this.ctx.invalidateContextManagementState(conversationId, 'message_structure_updated');
        }
    }

    /**
     * 批量更新多条消息（一次读写，避免并发 updateMessage 导致的覆盖写入）
     *
     * 典型场景：Token 预计算会并行更新多条 user 消息的 tokenCountByChannel。
     * 如果对每条消息单独 load+save，并行执行会出现“后写覆盖先写”，导致大量 token 结果丢失，
     * 进而在下一次请求里又重复对同一批消息进行 token 计数。
     */
    async updateMessagesBatch(conversationId: string, updates: Array<{ messageIndex: number; updates: Partial<Content> }>): Promise<void> {
        if (updates.length === 0) {
            return;
        }

        await this.ctx.getTranscriptRepository(conversationId).mutateContents((history) => {
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
                    Object.assign(target, patch.parts !== undefined ? { ...patch, parts: JSON.parse(JSON.stringify(patch.parts)) } : patch);
                    changed = true;
                }
            }
            return changed ? history.slice() : history;
        });

        if (updates.some((item) => shouldInvalidateContextManagementStateForUpdate(item.updates))) {
            await this.ctx.invalidateContextManagementState(conversationId, 'messages_batch_updated');
        }
    }

    /**
     * 删除消息
     */
    async deleteMessage(conversationId: string, messageIndex: number): Promise<void> {
        const repository = this.ctx.getTranscriptRepository(conversationId);
        let deletedMessageId: string | null = null;
        let deletedWasSummary = false;
        let deletedWasTailDelete = false;
        const nextHistory = await repository.mutateContents((contents) => {
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
        await this.ctx.metadata.syncMessageCountAfterStructuralChange(conversationId, nextHistory.length);
        await this.ctx.invalidateContextManagementState(conversationId, 'message_deleted');

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
                    await this.ctx.withGraphSyncQueue(conversationId, async () => {
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
    async insertMessage(conversationId: string, position: number, role: 'user' | 'model' | 'system', parts: ContentPart[]): Promise<void> {
        await this.ctx.getTranscriptRepository(conversationId).mutateContents((history) => {
            const index = Math.max(0, Math.min(position, history.length));
            const oldParent = index > 0 ? history[index - 1] : null;
            const oldParentId = oldParent?.id ?? null;
            const inserted = ensureNodeId(
                {
                    role,
                    parts: JSON.parse(JSON.stringify(parts)),
                    timestamp: Date.now(), // 自动添加时间
                } as Content,
                oldParent,
            );
            history.splice(index, 0, inserted);
            // R5b-2.4：插入后修复线性 parentId 链（插入点之后 parentId===旧父id 的消息
            // 重链到新插入消息，与 deleteMessagesInRange 的 repairParentChainAfterDelete 语义对称）
            repairParentChainAfterInsert(history, index, oldParentId, inserted.id as string);
            return history.slice(); // 有变更必须返回新引用（契约：返回原引用=跳过写回）
        });
        await this.ctx.invalidateContextManagementState(conversationId, 'message_inserted');

        // M-conv：插入是结构性变更（插入点后继 parentId 重链到新消息，活跃路径变化），与
        // deleteMessage/deleteToMessage/clearHistory 同口径同步分支图——否则图缺插入消息，切分支时
        // rewriteHistoryFromBranchGraph 会用图重建主历史、静默丢消息。走会话级串行队列
        // （graphSyncQueues）：插入前已入队的 append 图同步必须先完成再 rebase。失败仅告警
        // （主历史为唯一真源，图侧由下次读图/写图自校验兜底）；无全局 BranchService 时静默跳过。
        const branchService = getGlobalBranchService();
        if (branchService) {
            try {
                await this.ctx.withGraphSyncQueue(conversationId, async () => {
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
    async insertContent(conversationId: string, position: number, content: Content): Promise<void> {
        await this.insertContentAtResolvedPosition(conversationId, content, () => position);
    }

    /**
     * 在 transcript mutate 锁内基于最新历史解析插入位置。
     * Agent 卡片不能先 getHistory 再拿陈旧 position 写回：工具结果/后台消息可能在两步间插入。
     */
    async insertContentAtResolvedPosition(
        conversationId: string,
        content: Content,
        resolvePosition: (history: ReadonlyArray<Content>) => number,
    ): Promise<number> {
        const contentCopy = JSON.parse(JSON.stringify(content));
        if (!contentCopy.timestamp) {
            contentCopy.timestamp = Date.now();
        }
        let insertedIndex = 0;
        await this.ctx.getTranscriptRepository(conversationId).mutateContents((history) => {
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
        await this.ctx.invalidateContextManagementState(conversationId, contentCopy.isSummary ? 'summary_inserted' : 'content_inserted');

        const branchService = getGlobalBranchService();
        if (branchService) {
            try {
                await this.ctx.withGraphSyncQueue(conversationId, async () => {
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
    async deleteMessagesInRange(conversationId: string, startIndex: number, endIndex: number): Promise<void> {
        // 入口参数校验：非法区间（非整数 / 负数 / start > end）直接抛参数错误，
        // 避免负值 splice 静默 no-op 造成“调用成功但什么都没删”的假象。
        if (!Number.isInteger(startIndex) || !Number.isInteger(endIndex) || startIndex < 0 || startIndex > endIndex) {
            throw new TypeError(`Invalid message range [${startIndex}, ${endIndex}]: expected integers with 0 <= startIndex <= endIndex`);
        }
        const nextHistory = await this.ctx.getTranscriptRepository(conversationId).mutateContents((history) => {
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
        await this.ctx.metadata.syncMessageCountAfterStructuralChange(conversationId, nextHistory.length);
        await this.ctx.invalidateContextManagementState(conversationId, 'message_range_deleted');
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
    async deleteToMessage(conversationId: string, targetIndex: number, expectedMessageId?: string, capture?: DeleteToMessageCapture): Promise<number> {
        const repository = this.ctx.getTranscriptRepository(conversationId);
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
        const nextHistory = await repository.mutateContents(
            (currentHistory) => {
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
                        .map((message) => message.id)
                        .filter((id): id is string => typeof id === 'string' && id.length > 0);
                }
                deletedFromMessageId = currentHistory[targetIndex]?.id ?? null;
                lastKeptMessageId = targetIndex > 0 ? (currentHistory[targetIndex - 1]?.id ?? null) : null;
                deletedWasSummary = currentHistory.slice(targetIndex).some((message) => message.isSummary === true);
                const next = truncateFrom(currentHistory, targetIndex);
                deleteCount = currentHistory.length - next.length;
                return next;
            },
            () => {
                // 保存已成功、会话锁尚未释放：此刻把删除同步接到图队列尾部，确保随后 append
                // 虽可在本次锁释放后提交 transcript，但它的图同步只能排在本次删除之后。
                if (!deletedFromMessageId) {
                    return;
                }
                const branchService = getGlobalBranchService();
                if (!branchService) {
                    return;
                }
                graphSyncPromise = this.ctx.withGraphSyncQueue(conversationId, async () => {
                    if (deletedWasSummary) {
                        await branchService.syncMainHistoryAfterStructuralMutation(conversationId, 'summary_deleted');
                    } else {
                        await branchService.syncGraphAfterHistoryDelete(conversationId, deletedFromMessageId, {
                            lastKeptMessageId,
                        });
                    }
                });
            },
        );
        if (deleteCount > 0) {
            // HIS-11：结构性删除后同步 custom.messageCount（防对话列表 messageCount 漂移）
            await this.ctx.metadata.syncMessageCountAfterStructuralChange(conversationId, nextHistory.length);
            // 主 transcript 已在上面的 mutateContents 中提交；上下文管理 metadata 是可重建的
            // 派生状态。这里若写盘失败不能把已成功的删除伪装成失败，否则编排层不会继续清理
            // checkpoint，而用户按旧索引重试也无法恢复这次部分提交。
            try {
                await this.ctx.invalidateContextManagementState(conversationId, 'history_truncated');
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
        const repository = this.ctx.getTranscriptRepository(conversationId);
        // 决策 6：清空前捕获首条消息 id 作为分支图同步锚点（forceResetToEmpty 时仅作语义传参，
        // 不依赖锚点是否图根/是否存在）。轻量读取（只读首段），避免 getContents 的全量深拷贝。
        const firstMessageId = await this.ctx.getFirstMessageId(conversationId);
        const nextHistory = await repository.replaceContents([]);
        // HIS-11：结构性清空后同步 custom.messageCount（防对话列表 messageCount 漂移）
        await this.ctx.metadata.syncMessageCountAfterStructuralChange(conversationId, nextHistory.length);
        await this.ctx.invalidateContextManagementState(conversationId, 'history_cleared');
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
                await this.ctx.withGraphSyncQueue(conversationId, async () => {
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
}
