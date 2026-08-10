/**
 * TREE-06：切换后主历史重写实现（拆分自 ConversationManager.ts 的 rewriteHistoryFromBranchGraph）。
 *
 * 通过 BranchRewriteContext 接入 ConversationManager 的私有能力（storage / 会话写锁 /
 * 缓存失效 / usage 索引等），ConversationManager 的同名 public 方法构造上下文后委托，
 * 方法签名、锁边界与异常语义保持不变。
 * 注意：本文件内容按原文件缩进保留（纯移动，不重排）。
 */

import { randomUUID } from 'node:crypto';
import type { Content, ConversationHistory } from '../types';
import type { IStorageAdapter } from '../storage';
import { getGlobalBranchService } from '../branch/BranchService';
import { activePath, findUnsyncedFunctionResponses, isFunctionResponseMessage } from '../branch/BranchGraph';
import { BranchError } from '../branch/types';
import type { BranchHistoryRewriteResult } from './types';

/** rewriteHistoryFromBranchGraph 依赖的 ConversationManager 能力（委托绑定） */
export interface BranchRewriteContext {
    storage: IStorageAdapter;
    ensureHistoryNodeIds(conversationId: string): Promise<boolean>;
    runExclusive<T>(conversationId: string, task: () => Promise<T>): Promise<T>;
    getMessagesRaw(conversationId: string): Promise<Content[]>;
    assertNotDeleted(conversationId: string): void;
    invalidateContextManagementState(conversationId: string, reason: string): Promise<void>;
    invalidateCaches(conversationId: string): void;
    updateUsageIndex(conversationId: string, history: ConversationHistory): Promise<void>;
}

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
export async function rewriteHistoryFromBranchGraph(
    ctx: BranchRewriteContext,
    conversationId: string
): Promise<BranchHistoryRewriteResult> {
    await ctx.ensureHistoryNodeIds(conversationId);
    return await ctx.runExclusive(conversationId, async () => {
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
            const history = await ctx.getMessagesRaw(conversationId);
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
        const oldHistory = await ctx.getMessagesRaw(conversationId);

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
                ...(node.contentMetadata ? structuredClone(node.contentMetadata) : {}),
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
        ctx.assertNotDeleted(conversationId);
        await ctx.invalidateContextManagementState(conversationId, 'branch_path_switched');
        await ctx.storage.saveHistory(conversationId, nextContents);
        // 全量重写直写不走仓储：invalidateContextManagementState 已回填旧 custom，
        // 必须在 saveHistory 刷新 updatedAt 后再失效一次，保证缓存与落盘形态一致；
        // 分支切换重写了历史，节点 ID 反查缓存一并失效（BCP-01）
        ctx.invalidateCaches(conversationId);
        await ctx.updateUsageIndex(conversationId, nextContents);

        return {
            rewritten: true,
            historyLength: nextContents.length,
            activePathLength: pathIds.length,
            divergenceIndex,
            historyIds,
        };
    });
}
