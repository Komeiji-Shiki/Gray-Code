/**
 * 通用对话转录变更工具。
 *
 * 修改原因：主聊天和 SubAgent Monitor 都需要删除/重试消息，并且都必须正确处理 functionCall 与 functionResponse 的配对关系。
 * 修改方式：把“截断、删除逻辑消息组、重新规范化 index”集中到 conversation 模块，调用方只提供 Content[]。
 * 修改目的：避免主窗口和 SubAgent 子对话各自复制一套消息变更逻辑，后续工具配对规则升级时只改一个入口。
 */

import type { Content, ContentPart } from './types';
import { t } from '../../i18n';
import { deepClone } from '../../core/deepClone';

export interface TranscriptAdapter {
    load(): Promise<Content[]>;
    save(contents: Content[]): Promise<void>;
}

function cloneContents(contents: Content[]): Content[] {
    // 修改原因：调用方传入的 Content[] 可能来自内存快照或存储层，直接原地改会造成难以追踪的引用污染。
    // 修改方式：所有变更函数先做 JSON 深拷贝，再返回新的数组。
    // 修改目的：让 TranscriptMutation 成为纯变更入口，便于测试和复用。
    return deepClone(contents || []);
}

function normalizeIndexes(contents: Content[]): Content[] {
    // 修改原因：删除或截断后 backendIndex/content.index 必须重新连续，否则前端按 index 定位会错位。
    // 修改方式：按数组当前位置重写 index 字段，保留其它 Content 字段。
    // 修改目的：让主对话窗口和 SubAgent Monitor 都能用稳定的真实 contentIndex 做后续操作。
    return contents.map((content, index) => ({
        ...content,
        index
    } as Content));
}

function normalizeFunctionId(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function getFunctionCallIds(content: Content | undefined): Set<string> {
    const ids = new Set<string>();
    for (const part of content?.parts || []) {
        const id = normalizeFunctionId(part.functionCall?.id);
        if (id) {
            ids.add(id);
        }
    }
    return ids;
}

function getFunctionResponseIds(contents: ReadonlyArray<Content>): Set<string> {
    const ids = new Set<string>();
    for (const content of contents) {
        for (const part of content?.parts || []) {
            const id = normalizeFunctionId(part.functionResponse?.id);
            if (id) {
                ids.add(id);
            }
        }
    }
    return ids;
}

function hasMatchingFunctionResponse(content: Content | undefined, functionCallIds: Set<string>): boolean {
    if (!content || functionCallIds.size === 0) return false;
    for (const part of content.parts || []) {
        const id = normalizeFunctionId(part.functionResponse?.id);
        if (id && functionCallIds.has(id)) {
            return true;
        }
    }
    return false;
}

/**
 * 删除消息后修复被本次删除拆开的 functionCall/functionResponse 配对。
 *
 * 只处理“响应原本存在、但被本次删除移除”的调用：若同 id 的其它响应仍保留，则不修改；
 * 原本就处于 pending 的调用也不在这里自动取消。失去响应的保留调用标记为 rejected，
 * 请求格式化时会整体过滤该调用，从而不会产生 orphan_function_call。
 *
 * 不插入“用户拒绝”占位响应：截断是历史变更，不等同于用户拒绝执行工具。
 *
 * @returns 本次新标记为 rejected 的 functionCall 数量
 */
export function repairFunctionCallPairsAfterDelete(
    remaining: Content[],
    deletedMessages: ReadonlyArray<Content>
): number {
    const deletedResponseIds = getFunctionResponseIds(deletedMessages);
    if (deletedResponseIds.size === 0) {
        return 0;
    }

    const remainingResponseIds = getFunctionResponseIds(remaining);
    let repairedCount = 0;
    for (const message of remaining) {
        for (const part of message?.parts || []) {
            const id = normalizeFunctionId(part.functionCall?.id);
            if (!id
                || !deletedResponseIds.has(id)
                || remainingResponseIds.has(id)
                || part.functionCall?.rejected) {
                continue;
            }
            part.functionCall!.rejected = true;
            repairedCount++;
        }
    }
    return repairedCount;
}

export function truncateFrom(contents: Content[], contentIndex: number): Content[] {
    const cloned = cloneContents(contents);
    if (contentIndex < 0 || contentIndex > cloned.length) {
        throw new Error(`Transcript content index out of bounds: ${contentIndex}`);
    }

    // 重试语义是从目标位置开始删除后续上下文。若被删后缀包含保留区间中某个
    // functionCall 的响应，则把该调用标记为 rejected，避免截断制造孤儿调用。
    const remaining = cloned.slice(0, contentIndex);
    const deleted = cloned.slice(contentIndex);
    repairFunctionCallPairsAfterDelete(remaining, deleted);
    return normalizeIndexes(remaining);
}

/**
 * R5b-2.4：删除中间消息后修复线性 parentId 链。
 *
 * 删除会让「被删消息的直系后继」的 parentId 悬空指向已不存在的 id（needsNodeIdMigration
 * 只修 null/undefined，不修悬空 string）。此函数把 parentId 直接指向被删 id 的消息重链到
 * 被删消息的 parentId；若该 parent 也在本次删除中（连续删除），沿链向上解析到最近未删除
 * 祖先（首条为 null）。
 *
 * 分支语义保留：parentId 指向未删除消息的跨链关系不受影响——只修 parentId 直接指向被删
 * id 的消息（主链直系后继 / 挂在被删节点上的分支挂点），其余原样保留。
 *
 * @param remaining 删除后的消息数组（原地修改 parentId，不改变数组内容）
 * @param deletedMessages 本次删除的消息（需含 id/parentId）
 */
export function repairParentChainAfterDelete(
    remaining: Content[],
    deletedMessages: ReadonlyArray<Content>
): void {
    const deletedById = new Map<string, string | null>();
    for (const message of deletedMessages) {
        if (message && typeof message.id === 'string' && message.id.length > 0) {
            deletedById.set(message.id, message.parentId ?? null);
        }
    }
    if (deletedById.size === 0) {
        return;
    }

    for (const message of remaining) {
        const direct = message.parentId;
        if (typeof direct !== 'string' || !deletedById.has(direct)) {
            continue;
        }
        // 沿被删链向上解析最近未删除祖先（被删消息的 parent 可能也在本次删除中）
        let parentId: string | null = direct;
        let guard = 0;
        while (typeof parentId === 'string' && deletedById.has(parentId)) {
            parentId = deletedById.get(parentId) ?? null;
            if (++guard > deletedById.size) {
                // 防御：异常长链时终止，退化为 null（根），避免死循环
                parentId = null;
                break;
            }
        }
        message.parentId = parentId;
    }
}

/**
 * R5b-2.4：插入中间消息后修复线性 parentId 链（与 repairParentChainAfterDelete 对称）。
 *
 * 插入只给新消息设 parentId（指向插入点前一条），插入点之后的消息仍指向插入前的旧父节点
 * （新插入消息被跳过），形成图分叉。此函数把插入点之后 parentId === 旧父 id 的消息重链到
 * 新插入消息 id（线性主链中唯一，即主链直系后继；若存在挂在旧父上的分支挂点同样被重链，
 * 与 delete 路径“挂在被删节点上的分支挂点”的处理语义一致）。
 *
 * 分支语义保留：parentId 指向其它未受影响节点的消息原样保留。
 *
 * @param remaining 插入后的消息数组（原地修改 parentId，不改变数组内容）
 * @param insertIndex 新插入消息所在下标（插入点）
 * @param oldParentId 插入点之前的旧父节点 id（插入前 remaining[insertIndex-1]?.id；
 *                    首条插入为 null；旧父无 id 时按 null 处理，与 ensureNodeId 的
 *                    parent?.id ?? null 口径一致）
 * @param insertedId 新插入消息的 id（由 ensureNodeId 保证非空）
 */
export function repairParentChainAfterInsert(
    remaining: Content[],
    insertIndex: number,
    oldParentId: string | null,
    insertedId: string
): void {
    if (typeof insertedId !== 'string' || insertedId.length === 0) {
        return; // 防御：新插入消息无 id 时无法作为重链目标，跳过
    }
    for (let i = insertIndex + 1; i < remaining.length; i += 1) {
        const message = remaining[i];
        if (message && message.parentId === oldParentId) {
            message.parentId = insertedId;
        }
    }
}

export function deleteLogicalMessage(contents: Content[], contentIndex: number): Content[] {
    const cloned = cloneContents(contents);
    if (contentIndex < 0 || contentIndex >= cloned.length) {
        throw new Error(`Transcript content index out of bounds: ${contentIndex}`);
    }

    const target = cloned[contentIndex];
    const functionCallIds = getFunctionCallIds(target);
    const indexesToDelete = new Set<number>([contentIndex]);

    if (functionCallIds.size > 0) {
        // 修改原因：删除包含工具调用的模型消息时，如果保留配对 functionResponse，会在后续请求中形成孤儿工具结果。
        // 修改方式：扫描目标消息之后的 Content，删除含有匹配 functionResponse.id 的消息。
        // 修改目的：保持 provider 要求的 functionCall/functionResponse 配对完整性，避免重试时报历史结构错误。
        for (let index = contentIndex + 1; index < cloned.length; index++) {
            if (hasMatchingFunctionResponse(cloned[index], functionCallIds)) {
                indexesToDelete.add(index);
            }
        }
    }

    const deletedMessages = cloned.filter((_, index) => indexesToDelete.has(index));
    const next = cloned.filter((_, index) => !indexesToDelete.has(index));
    // 删除 functionResponse 本身时，其 functionCall 可能仍保留；统一修复配对，避免孤儿调用。
    repairFunctionCallPairsAfterDelete(next, deletedMessages);
    // R5b-2.4：删除中间消息后修复线性 parentId 链（被删消息的直系后继重链到被删消息的 parent）
    repairParentChainAfterDelete(next, deletedMessages);
    return normalizeIndexes(next);
}

/**
 * 逻辑截断：恢复指定总结消息覆盖的原文区间（取消 isSummarized 标记）。
 *
 * 覆盖区间 = [该总结之前最近的总结消息之后, 该总结位置)；区间内所有 isSummarized 消息
 * 取消标记，恢复为活跃消息（重新参与发送与统计）。首条用户消息从不标记，不受影响。
 * 不改变数组长度与 parentId 链（纯字段变更）。
 *
 * 幂等：区间内无 isSummarized 消息时 restoredCount = 0，返回克隆（无副作用）。
 *
 * @param contents 完整历史
 * @param summaryIndex 要恢复的总结消息下标
 * @returns 恢复后的历史（新数组）与恢复的消息数
 */
export function restoreSummarizedRange(
    contents: Content[],
    summaryIndex: number
): { contents: Content[]; restoredCount: number } {
    const cloned = cloneContents(contents);
    if (summaryIndex < 0 || summaryIndex >= cloned.length || !cloned[summaryIndex]?.isSummary) {
        return { contents: cloned, restoredCount: 0 };
    }

    // 覆盖区间起点 = 该总结之前最近的总结消息之后（无更早总结则从 0 开始）
    let rangeStart = 0;
    for (let i = summaryIndex - 1; i >= 0; i--) {
        if (cloned[i]?.isSummary) {
            rangeStart = i + 1;
            break;
        }
    }

    let restoredCount = 0;
    for (let i = rangeStart; i < summaryIndex; i++) {
        const message = cloned[i];
        if (message?.isSummarized) {
            const { isSummarized: _removed, ...rest } = message;
            cloned[i] = rest as Content;
            restoredCount++;
        }
    }
    return { contents: cloned, restoredCount };
}

export async function mutateTranscript(
    adapter: TranscriptAdapter,
    mutator: (contents: Content[]) => Content[]
): Promise<Content[]> {
    // 修改原因：主对话和 SubAgent 子对话使用不同存储后端，但变更流程都是 load -> mutate -> save。
    // 修改方式：抽象 adapter 后统一执行变更，并返回保存后的新快照。
    // 修改目的：让 handler 不复制读写流程，也方便后续加入完整性校验。
    const contents = await adapter.load();
    const next = mutator(contents);
    await adapter.save(next);
    return next;
}

// ==================== 未响应工具调用的拒绝/补齐（共享逻辑） ====================
// 修改原因：normalizeHistoryForDisplay / rejectToolCalls / rejectAllPendingToolCalls 三处
// 各自复制「收集未响应 functionCall → 构造 rejected functionResponse → 定位插入位置」逻辑，
// 工具配对规则升级时容易漏同步。
// 修改方式：把纯函数部分收敛到本模块（原地标记 rejected + 构造占位 parts + 插入位置查找），
// 调用方只负责互斥执行器（mutateContents）与写回契约（返回原引用=跳过写回）。
// 修改目的：三处行为完全等价且只保留一个升级入口。

/** 收集历史中所有已有响应的工具调用 ID（functionResponse.id 集合） */
export function collectRespondedToolCallIds(history: ReadonlyArray<Content>): Set<string> {
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
    return respondedToolCallIds;
}

/**
 * 扫描历史中「没有对应响应且尚未被标记 rejected」的 functionCall，原地标记 rejected，
 * 并按所在消息索引分组返回调用信息。无未响应调用时返回空 Map（不做任何修改）。
 */
export function collectUnresolvedToolCalls(
    history: Content[],
    respondedToolCallIds: ReadonlySet<string>
): Map<number, Array<{ id: string; name: string }>> {
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
    return unresolvedCallsByIndex;
}

/** 构造「用户拒绝」的 functionResponse parts（与三处旧实现逐字段一致） */
export function buildRejectedResponseParts(calls: Array<{ id: string; name: string }>): ContentPart[] {
    return calls.map(call => ({
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
}

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
export function findFunctionResponseInsertIndex(history: ReadonlyArray<Content>, messageIndex: number): number {
    let insertAt = messageIndex + 1;
    while (insertAt < history.length && history[insertAt]?.isFunctionResponse) {
        insertAt++;
    }
    return insertAt;
}

/**
 * 从后往前在工具调用消息紧接后面插入 rejected functionResponse 占位消息（原地修改），
 * 返回是否有插入（调用方据此决定是否触发写回）。
 *
 * @param ensureNodeId 为新消息补齐稳定节点 id / 线性 parentId（由 ConversationManager 注入）
 */
export function insertRejectedResponses(
    history: Content[],
    unresolvedCallsByIndex: Map<number, Array<{ id: string; name: string }>>,
    ensureNodeId: (content: Content, parent: Content | null | undefined) => Content
): boolean {
    let inserted = false;
    // 从后往前插入以避免索引偏移问题
    const sortedIndices = Array.from(unresolvedCallsByIndex.keys()).sort((a, b) => b - a);

    for (const messageIndex of sortedIndices) {
        const calls = unresolvedCallsByIndex.get(messageIndex)!;
        const rejectedResponseParts = buildRejectedResponseParts(calls);

        // 插到工具调用消息的紧接后面，保持与 functionCall 输出顺序一致
        const insertAt = findFunctionResponseInsertIndex(history, messageIndex);
        const parent = insertAt > 0 ? history[insertAt - 1] : null;
        history.splice(insertAt, 0, ensureNodeId({
            role: 'user',
            parts: rejectedResponseParts,
            isFunctionResponse: true
        }, parent));
        inserted = true;
    }
    return inserted;
}

/**
 * 全历史「标记未响应工具调用为 rejected + 插入 functionResponse 占位」一体化入口
 * （normalizeHistoryForDisplay 与 rejectAllPendingToolCalls 共用）。
 *
 * 原地修改 history；返回是否有任何变更（标记或插入）。
 */
export function rejectUnresolvedToolCalls(
    history: Content[],
    ensureNodeId: (content: Content, parent: Content | null | undefined) => Content
): boolean {
    const respondedToolCallIds = collectRespondedToolCallIds(history);
    const unresolvedCallsByIndex = collectUnresolvedToolCalls(history, respondedToolCallIds);
    if (unresolvedCallsByIndex.size === 0) {
        return false;
    }
    return insertRejectedResponses(history, unresolvedCallsByIndex, ensureNodeId);
}
