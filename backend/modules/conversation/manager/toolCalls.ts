/**
 * 工具调用拒绝/结算服务（拆分自 ConversationManager.ts 的工具调用管理方法组）。
 *
 * 依赖 ConversationManager 的 public 能力（getTranscriptRepository /
 * invalidateContextManagementState）与 manager 下纯函数（ensureNodeId /
 * findFunctionResponseInsertIndex），ConversationManager 持有本服务实例并在同名
 * public 方法中委托，方法签名与行为保持不变。
 * 注意：本文件内容按原文件缩进保留（纯移动，不重排）。
 */

import { t } from '../../../i18n';
import type { ContentPart } from '../types';
import type { ConversationManager } from '../ConversationManager';
import { ensureNodeId } from './nodeId';
import { findFunctionResponseInsertIndex } from './utils';

export class ConversationToolCallService {
    constructor(private readonly manager: ConversationManager) {}

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
        const repository = this.manager.getTranscriptRepository(conversationId);
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
                const insertAt = findFunctionResponseInsertIndex(history, messageIndex);
                const parent = insertAt > 0 ? history[insertAt - 1] : null;
                history.splice(insertAt, 0, ensureNodeId({
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
            await this.manager.invalidateContextManagementState(conversationId, 'tool_calls_rejected');
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
    async rejectAllPendingToolCalls(
        conversationId: string,
        options: { preserveDetachedSubAgents?: boolean } = {}
    ): Promise<void> {
        const repository = this.manager.getTranscriptRepository(conversationId);
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
            const unresolvedCallsByIndex: Map<number, Array<{ id: string; name: string; detached?: boolean }>> = new Map();
            for (let i = 0; i < history.length; i++) {
                const message = history[i];
                if (message.parts) {
                    for (const part of message.parts) {
                        if (part.functionCall && part.functionCall.id) {
                            // 如果工具调用没有对应的响应，且还没有被标记为 rejected
                            if (!respondedToolCallIds.has(part.functionCall.id) && !part.functionCall.rejected) {
                                const call = {
                                    id: part.functionCall.id,
                                    name: part.functionCall.name || 'unknown',
                                    detached: options.preserveDetachedSubAgents === true
                                        && part.functionCall.name === 'subagents'
                                };
                                if (!call.detached) {
                                    part.functionCall.rejected = true;
                                }
                                const calls = unresolvedCallsByIndex.get(i) || [];
                                calls.push(call);
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
                            response: call.detached
                                ? {
                                    success: true,
                                    detached: true,
                                    background: true,
                                    note: 'SubAgent continued in background after the parent turn was replaced.'
                                }
                                : {
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
                changed = true;
                // 有插入：返回新引用触发写回（mutateContents 契约：返回原引用=跳过写回）
                return history.slice();
            }

            // 无变更：返回原引用跳过写回（此时没有任何原地修改）
            return history;
        });

        if (changed) {
            await this.manager.invalidateContextManagementState(conversationId, 'pending_tool_calls_rejected');
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

        const repository = this.manager.getTranscriptRepository(conversationId);
        let changed = false;

        // 与 rejectAllPendingToolCalls 共用同一互斥执行器，整个 get→修改→replace 串行化，
        // 避免并发时真实结果被“用户拒绝”占位覆盖。
        await repository.mutateContents((history) => {
            // 索引现有调用、响应与拒绝/取消占位的位置。真实响应只允许结算到当前历史中
            // 仍存在的 functionCall；调用已被截断时丢弃迟到结果，避免制造 orphan_function_response。
            const functionCallIds = new Set<string>();
            const responseIdx = new Map<string, number>();     // id → historyIndex
            const placeholderIds = new Set<string>();          // id 是占位
            for (let i = 0; i < history.length; i++) {
                const msg = history[i];
                if (!msg.parts) continue;
                for (const part of msg.parts) {
                    const callId = part.functionCall?.id;
                    if (callId) {
                        functionCallIds.add(callId);
                    }
                    const fr = part.functionResponse;
                    if (!fr?.id) continue;
                    responseIdx.set(fr.id, i);
                    if (fr.response?.rejected || fr.response?.cancelled) {
                        placeholderIds.add(fr.id);
                    }
                }
            }

            const newParts: ContentPart[] = [];
            const settledResponseIds = new Set<string>();

            for (const part of parts) {
                const id = part.functionResponse?.id;
                if (!id) {
                    // 无 id 的 part（如多模态附件）一律走追加
                    newParts.push(part);
                    continue;
                }

                // 工具调用所属旧分支已被截断：真实副作用虽已发生，但结果不能再写回当前分支。
                if (!functionCallIds.has(id)) {
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
                        settledResponseIds.add(id);
                        placeholderIds.delete(id);
                        changed = true;
                    }
                } else if (existingIdx === undefined) {
                    // 全新响应 → 收集后追加
                    newParts.push(part);
                    settledResponseIds.add(id);
                } else {
                    // 已有真实响应：保持幂等，但仍借此修复可能残留的 rejected 标记。
                    settledResponseIds.add(id);
                }
            }

            if (newParts.length > 0) {
                // BR-08：新响应插到「所属 functionCall 消息的紧后 FR 块」之后，而不是追加到
                // 历史末尾。正常路径下（assistant 消息就是历史末条）两者位置相同；竞态路径下
                // （用户消息已追加、旧流迟到结算）末尾追加会形成 [assistant(tool_calls), user,
                // tool] 的非法交替顺序，触发 OpenAI/Anthropic 400。插回 FR 块保证 assistant
                // 的 tool_calls 永远紧随其 tool 消息，且与前端窗口（按 FR 块顺序渲染）对齐。
                // 按「消息内 FR 块顺序」逐归属插入：同一批结算可能覆盖多个 functionCall 消息，
                // 旧实现取「含已结算 id 的最后一条消息」整体插入，早先消息的响应会被插到其它
                // 消息的 FR 块之后，与 functionCall 输出顺序错位。先按归属消息分组并预计算插入
                // 位置（基于插入前的历史），再从后往前插入（避免先插入引起的下标偏移）；
                // 同归属的多条响应仍合并为一条 FR 消息。
                const partsByOwner = new Map<number, ContentPart[]>();
                for (const part of newParts) {
                    const id = part.functionResponse?.id;
                    let ownerIndex = -1;
                    if (id) {
                        // 有 id：定位所属 functionCall 消息
                        for (let i = 0; i < history.length; i++) {
                            const msg = history[i];
                            if (!msg.parts) {
                                continue;
                            }
                            if (msg.parts.some(p => p.functionCall?.id === id)) {
                                ownerIndex = i;
                                break;
                            }
                        }
                    }
                    if (ownerIndex === -1) {
                        // 无 id 的 part（如多模态附件）没有归属 functionCall，按上方注释承诺
                        // 一律归入历史末尾追加；兼作防御：找不到归属消息（不应发生——上方已按
                        // functionCallIds 过滤过无归属的迟到结果）时与旧行为一致归入末尾。
                        ownerIndex = history.length;
                    }
                    const group = partsByOwner.get(ownerIndex) ?? [];
                    group.push(part);
                    partsByOwner.set(ownerIndex, group);
                }
                const ownerIndices = Array.from(partsByOwner.keys());
                const insertAtByOwner = new Map<number, number>();
                for (const ownerIndex of ownerIndices) {
                    insertAtByOwner.set(ownerIndex, ownerIndex < history.length
                        ? findFunctionResponseInsertIndex(history, ownerIndex)
                        : history.length);
                }
                ownerIndices.sort((a, b) => b - a);
                for (const ownerIndex of ownerIndices) {
                    const groupParts = partsByOwner.get(ownerIndex)!;
                    const insertAt = insertAtByOwner.get(ownerIndex)!;
                    const parent = insertAt > 0 ? history[insertAt - 1] : null;
                    history.splice(insertAt, 0, ensureNodeId({
                        role: 'user',
                        parts: groupParts,
                        isFunctionResponse: true,
                    }, parent));
                }
                // 每个 newPart 都会进入分组并被实际插入；仅在有真实插入时置 changed，
                // 避免全部 part 被跳过时仍返回新引用触发空写回。
                if (partsByOwner.size > 0) {
                    changed = true;
                }
            }

            // 只有真实响应已经存在或将在本次变更中追加时才清除 rejected。
            // 这同时覆盖“截断先把调用标记 rejected，随后工具结果在写锁后结算”的时序。
            if (settledResponseIds.size > 0) {
                for (const message of history) {
                    if (!message.parts) continue;
                    for (const part of message.parts) {
                        const call = part.functionCall;
                        if (call?.id && settledResponseIds.has(call.id) && call.rejected) {
                            call.rejected = false;
                            changed = true;
                        }
                    }
                }
            }

            // 有变更（占位替换、新追加或 rejected 清理）：返回新引用触发写回；无变更返回原引用
            // （mutateContents 契约：返回原引用=跳过写回）
            return changed ? history.slice() : history;
        });

        if (changed) {
            await this.manager.invalidateContextManagementState(conversationId, 'tool_calls_settled');
        }
    }
}
