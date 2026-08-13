/**
 * GrayCode - 工具迭代循环 · 检查点编排切面
 *
 * 从 ToolIterationLoopService 拆出：流式/非流式工具批次检查点的状态定义、受影响路径累计、
 * 批次 before 创建（早启动 / 主循环 / 确认路径）、批次 after 收尾与模型消息前检查点。
 *
 * 所有函数都是无副作用编排，依赖通过 `CheckpointCoordinatorContext` 注入，
 * 行为与拆分前逐字一致（逻辑零改动）。
 */

import type { CheckpointRecord } from '../../../../checkpoint';
import type { ConversationManager } from '../../../../conversation/ConversationManager';
import type { ChatStreamCheckpointsData } from '../../types';
import type { FunctionCallInfo } from '../../utils';
import type { Logger } from '../../../../../core/logger';
import type { CheckpointService } from '../CheckpointService';
import { extractAffectedPaths } from '../../../../checkpoint/affectedPaths';

/**
 * 检查点编排依赖。
 */
export interface CheckpointCoordinatorContext {
    checkpointService: CheckpointService;
    conversationManager: ConversationManager;
    log: Logger;
}

/**
 * CPF-07：流式工具批次检查点状态（一次模型回复 = 一个工具批次，共享一组 before/after 存档）。
 *
 * 背景：流式早启动路径对每个工具单独调用 executeFunctionCallsWithResults，若各自创建检查点
 * 会产生 N 组物理存档（每组独立扫描工作区 + 前端多行展示 + 消耗 maxCheckpoints 配额）。
 * 这里把检查点提升到批次维度统一管理：
 * - before：第一个「已配置存档工具」启动前创建（挂模型消息索引，与 createModelMessageCheckpoint
 *   的 before 语义一致）；纯只读批次（批内无已配置存档工具）不创建（CPF-05 语义）。
 * - after：全部工具执行完成后创建（finalize 幂等，取消/中止路径不补 after）。
 *
 * 早启动工具执行时以 checkpointMode='skip' 跳过执行核心内部检查点；主循环同样 skip，
 * 由本状态统一在批次边界创建并随 yield 下发（前端展示为一条 tool_batch 前/后存档）。
 */
export interface StreamToolBatchCheckpointState {
    /** 模型消息索引（批次检查点统一挂载点；在模型消息落盘前的 history.length 处取值） */
    messageIndex?: number;
    /** 批次挂载索引计算 promise（首个工具到达时惰性启动；before/after 创建与 finalize 共用） */
    batchIndexPromise?: Promise<void>;
    /** before 检查点（仅创建一次） */
    beforeCheckpoint: CheckpointRecord | null;
    /** before 是否已创建（含创建失败——失败后本批次不再重试，后续工具降级为无存档执行） */
    beforeCreated: boolean;
    /** 批内是否存在配置了 after 存档的工具（决定是否创建 after 与是否下发） */
    needsCheckpoint: boolean;
    /** after 检查点（finalize 幂等，避免多个 yield 点重复创建） */
    afterCheckpoint: CheckpointRecord | null;
    /** 是否已 finalize（after 已尝试创建） */
    finalized: boolean;
    /** 批内已见工具名（CPF-07 精确判定：tool_batch 存档按批内工具与 beforeTools/afterTools 交集创建） */
    batchToolNames: Set<string>;
    /**
     * CP-PARTIAL-1：批次累计的受影响文件绝对路径（工具执行存档按参数限定的文件构建部分快照，
     * 不再全量扫描工作区）。undefined = 尚未累计或已回退全量（affectedPathsResolved=true）。
     */
    affectedPaths?: string[];
    /**
     * CP-PARTIAL-1：批次是否已确定回退全量（批内任一工具无法确定受影响路径，如 execute_command）
     * ——确定后不再累计，后续检查点（含 after）全部全量扫描。
     */
    affectedPathsResolved: boolean;
    /**
     * CP-PARTIAL-1：工作区根 fsPath（从 runtimeContext.workspaceUri 解析；无法解析时缺省 = 回退全量）。
     * 早启动/主循环共用同一份；确认分支复用 batch 状态里存的值。
     */
    workspaceRootFsPath?: string;
}

/**
 * 回合级工具批次 before 状态（同一真实用户回合内多次模型请求/多次迭代共享）。
 *
 * 背景：同一用户回合内模型可能多次请求（多次工具迭代，含确认工具跨请求执行），旧实现每次
 * 迭代各自创建一对「批次前/批次后」存档，相邻迭代间出现「迭代 N 的批次后存档」紧挨
 * 「迭代 N+1 的批次前存档」的冗余展示。
 *
 * 修复：before 提升到回合维度——整个真实用户回合只创建一次（挂在首个创建迭代的模型消息
 * 位置），中间迭代不再创建 before；after 保持迭代级（每次迭代一个），迭代 N 的 after 即
 * 迭代 N+1 的「执行前状态」，恢复粒度不损失。
 */
export interface TurnBatchCheckpointState {
    /** 回合锚点：起始用户消息 id（防跨回合串用；null/空 = 无锚点，与既有模式一致） */
    turnStartMessageId: string | null;
    /** before 挂载索引（回合首个创建迭代的模型消息位置；创建成功后写回） */
    messageIndex?: number;
    /** before 检查点（回合内仅创建一次） */
    beforeCheckpoint: CheckpointRecord | null;
    /** before 是否已创建（含创建失败——失败后本回合不再重试，降级为无存档执行） */
    beforeCreated: boolean;
}

/**
 * CP-PARTIAL-1：在批次状态上累计受影响路径（工具执行存档按参数限定的文件构建部分快照）。
 *
 * 对每个调用调用 extractAffectedPaths；任一调用无法确定（返回 null，如 execute_command 副作用
 * 不可知）→ 整个批次 affectedPaths = undefined（回退全量，保证快照完整性）。
 * 已确定回退全量（affectedPathsResolved）的批次不再累计。
 * 同一路径多次出现只保留一次（保持顺序）。
 *
 * 注意（流式早启动固有语义）：批次 before 在首个已配置工具启动前创建，此时后续工具调用仍在
 * 流式传输中，before 只可能基于「当时已见工具」的路径；后续工具导致回退全量时，before 保持
 * 已创建的部分快照，after 及后续检查点回退全量（最佳努力，不阻塞工具执行）。
 */
export function collectAffectedPaths(
    batch: StreamToolBatchCheckpointState,
    calls: readonly FunctionCallInfo[],
    workspaceRootFsPath?: string
): void {
    if (batch.affectedPathsResolved) {
        // 已确定回退全量：不再累计
        return;
    }
    if (!workspaceRootFsPath) {
        batch.affectedPaths = undefined;
        batch.affectedPathsResolved = true;
        return;
    }
    const accumulated = new Set(batch.affectedPaths ?? []);
    for (const call of calls) {
        const paths = extractAffectedPaths(call.name, call.args, workspaceRootFsPath);
        if (paths === null) {
            batch.affectedPaths = undefined;
            batch.affectedPathsResolved = true;
            return;
        }
        for (const p of paths) {
            accumulated.add(p);
        }
    }
    batch.affectedPaths = [...accumulated];
}

/**
 * CPF-07：流式工具批次 before 检查点——第一个「已配置 before 存档」的工具启动前创建一次。
 *
 * 与调用方约定（见 ensure 处注释）：本方法只创建 before 并把结果写入 batch 状态；
 * 调用方把返回的 promise 与工具执行串在同一链上（before 完成后工具才启动），
 * 保证「写工具执行前已有存档」；不阻塞流式循环。
 *
 * 挂载索引：模型消息尚未落盘，history.length = 模型消息即将写入的位置
 * （与 createModelMessageCheckpoint 的 before 语义一致；批次内所有检查点共用该索引，
 * 前端据此把前后存档显示在模型消息两侧）。
 *
 * 配置未命中（批内已见工具均未配置 before，createToolExecutionCheckpoint 返回 null）时
 * 重置 beforeCreated，允许后续到达的已配置工具再次触发创建。
 *
 * @param turnBatch 回合级 before 状态：创建/重置后立即写回，保证跨迭代/跨请求一致
 *   （同一真实用户回合内 before 只创建一次）
 * @returns before 检查点创建完成时 resolve（null = 配置未启用/未配置，不创建）
 */
export async function ensureStreamBatchBeforeCheckpoint(
    ctx: CheckpointCoordinatorContext,
    conversationId: string,
    batch: StreamToolBatchCheckpointState,
    turnBatch: TurnBatchCheckpointState
): Promise<void> {
    // 防重入：并发早启动工具同时到达时只创建一次；创建失败（异常）时保持 beforeCreated=true
    // 降级为无存档执行（与主循环路径一致，仅 warn 不阻断工具），配置未命中（null）时重置
    // 允许后续到达的已配置工具再次触发创建。
    batch.beforeCreated = true;
    const checkpointService = ctx.checkpointService;
    if (!checkpointService) {
        // 调用方经 isToolConfiguredForCheckpoint 确认后才进入本方法，正常不可达；
        // 防御性早退（batch 状态已置位，后续工具不再尝试创建）
        return;
    }
    try {
        // 挂载索引由批次状态统一计算（首个早启动工具到达时惰性启动；此处 await 保证就绪，
        // batchIndexPromise 已挂 catch，失败时 messageIndex 缺省走下方兑底读取）
        if (batch.messageIndex === undefined) {
            await batch.batchIndexPromise;
        }
        let index = batch.messageIndex;
        if (index === undefined) {
            // 防御：索引 promise 异常/未启动时直接读取（正常不可达）
            const history = await ctx.conversationManager.getHistoryRef(conversationId);
            index = history.length;
            batch.messageIndex = index;
        }
        const checkpoint = await checkpointService.createToolExecutionCheckpoint(
            conversationId,
            index,
            'tool_batch',
            'before',
            undefined,
            // CPF-07 精确判定：批内已见工具名透传（CheckpointManager 按 beforeTools 求交）
            {
                batchToolNames: Array.from(batch.batchToolNames),
                ...(batch.affectedPaths ? { affectedPaths: batch.affectedPaths } : {})
            }
        );
        if (checkpoint) {
            batch.beforeCheckpoint = checkpoint;
            // 回合级写回：before 在真实用户回合内只创建一次（后续迭代/确认续跑复用）
            turnBatch.beforeCheckpoint = checkpoint;
            turnBatch.beforeCreated = true;
            turnBatch.messageIndex = index;
        } else {
            // 配置未命中（当前已见工具均未配置 before）：重置防重入，
            // 允许后续到达的已配置工具再次触发创建；回合状态同步（允许后续迭代补建）。
            batch.beforeCreated = false;
            turnBatch.beforeCreated = false;
        }
    } catch (error) {
        // 存档创建异常（磁盘/锁等）：降级为无存档执行（warn），不阻断工具执行，
        // 与主循环路径 checkpoint.batch_before_failed 语义一致。
        ctx.log.warn('checkpoint.batch_before_failed', {
            conversationId,
            error: (error as Error)?.message ?? String(error)
        });
        // 回合状态同步：创建异常降级为无存档执行（batch.beforeCreated 保持 true，
        // 与批次状态一致——后续迭代不再从回合值读到 false 而重复尝试创建）。
        turnBatch.beforeCreated = true;
    }
}

/**
 * CPF-07：确认工具批次补建 before——批内自动工具均未配置 before（批次 before 未创建）时，
 * 若批内存在配置了 before 的工具（如确认工具本身），在进入确认等待前补建批次 before，
 * 保证「确认工具执行前已有存档」。配置未命中（返回 null）时静默跳过。
 *
 * @param turnBatch 回合级 before 状态：创建/重置后立即写回，保证跨迭代/跨请求一致
 * @param messageIndex 可选：主循环路径（模型消息已落盘）传 messageIndex（length - 1）；
 *   早启动路径不传（模型消息未落盘，用 history.length，与 ensureStreamBatchBeforeCheckpoint 一致）
 */
export async function ensureBatchBeforeForConfirmation(
    ctx: CheckpointCoordinatorContext,
    conversationId: string,
    batch: StreamToolBatchCheckpointState,
    calls: FunctionCallInfo[],
    turnBatch: TurnBatchCheckpointState,
    messageIndex?: number
): Promise<void> {
    if (batch.beforeCreated) {
        return;
    }
    const checkpointService = ctx.checkpointService;
    if (!checkpointService) {
        return;
    }
    for (const call of calls) {
        batch.batchToolNames.add(call.name);
        // 批内确认工具/后缀工具命中 afterTools 时，批次完成仍需创建 after 存档
        if (!batch.needsCheckpoint && checkpointService.isToolConfiguredForCheckpoint(call.name, call.args, 'after')) {
            batch.needsCheckpoint = true;
        }
    }
    // CP-PARTIAL-1：确认路径同样累计受影响路径（批内确认工具/后缀工具）
    collectAffectedPaths(batch, calls, batch.workspaceRootFsPath);
    if (!calls.some(call => checkpointService.isToolConfiguredForCheckpoint(call.name, call.args, 'before'))) {
        return;
    }
    if (messageIndex === undefined) {
        await batch.batchIndexPromise;
        messageIndex = batch.messageIndex;
    }
    if (messageIndex === undefined) {
        return;
    }
    batch.messageIndex = messageIndex;
    batch.beforeCreated = true;
    try {
        const checkpoint = await checkpointService.createToolExecutionCheckpoint(
            conversationId,
            messageIndex,
            'tool_batch',
            'before',
            undefined,
            {
                batchToolNames: Array.from(batch.batchToolNames),
                ...(batch.affectedPaths ? { affectedPaths: batch.affectedPaths } : {})
            }
        );
        if (checkpoint) {
            batch.beforeCheckpoint = checkpoint;
            // 回合级写回：before 在真实用户回合内只创建一次（后续迭代/确认续跑复用）
            turnBatch.beforeCheckpoint = checkpoint;
            turnBatch.beforeCreated = true;
            turnBatch.messageIndex = messageIndex;
        } else {
            batch.beforeCreated = false;
            // 配置未命中：回合状态同步（允许后续迭代补建）
            turnBatch.beforeCreated = false;
        }
    } catch (error) {
        ctx.log.warn('checkpoint.batch_before_confirm_failed', {
            conversationId,
            error: (error as Error)?.message ?? String(error)
        });
        // 回合状态同步：创建异常降级为无存档执行（batch.beforeCreated 保持 true）
        turnBatch.beforeCreated = true;
    }
}

/**
 * CPF-07：流式工具批次收尾——全部工具执行完成后创建 after 存档（幂等）。
 *
 * 返回批次存档列表（before → after，按顺序）；批内无已配置存档工具时返回 []。
 * after 创建失败仅降级（保留已创建的 before，不阻断工具结果落盘），与
 * execution.ts deferred 模式下 after 失败 warn 降级的语义一致。
 * 取消/中止路径不调用本方法（不补 after；before 保留供前端 loadCheckpoints 可见）。
 *
 * @param createAfter 存在确认工具时传 false：批次未完成（确认工具未执行），
 *   after 由确认路径在全部工具执行完成后补建，避免确认前就产生「批次后」存档
 */
export async function finalizeStreamBatchCheckpoints(
    ctx: CheckpointCoordinatorContext,
    conversationId: string,
    batch: StreamToolBatchCheckpointState,
    createAfter = true
): Promise<CheckpointRecord[]> {
    if (batch.finalized) {
        return [batch.beforeCheckpoint, batch.afterCheckpoint].filter((cp): cp is CheckpointRecord => !!cp);
    }
    batch.finalized = true;
    // 批次挂载索引可能仍由早启动的惰性 promise 计算中（无 before 创建、仅 after 配置的批次）：
    // await 保证就绪后再判定；索引仍缺时说明批次无任何存档需求，直接返回空。
    await batch.batchIndexPromise;
    if (batch.messageIndex === undefined) {
        return [];
    }
    // 仅配 before（批内无工具命中 afterTools，needsCheckpoint=false）或确认路径
    // （createAfter=false）：下发 before，不创建 after。
    if (!createAfter || !batch.needsCheckpoint) {
        return [batch.beforeCheckpoint].filter((cp): cp is CheckpointRecord => !!cp);
    }
    try {
        batch.afterCheckpoint = await ctx.checkpointService.createToolExecutionCheckpoint(
            conversationId,
            batch.messageIndex,
            'tool_batch',
            'after',
            undefined,
            // CPF-07 精确判定：批内工具名透传（CheckpointManager 按 afterTools 求交）
            {
                batchToolNames: Array.from(batch.batchToolNames),
                ...(batch.affectedPaths ? { affectedPaths: batch.affectedPaths } : {})
            }
        );
    } catch (error) {
        ctx.log.warn('checkpoint.batch_after_failed', {
            conversationId,
            error: (error as Error)?.message ?? String(error)
        });
    }
    return [batch.beforeCheckpoint, batch.afterCheckpoint].filter((cp): cp is CheckpointRecord => !!cp);
}

/**
 * 创建模型消息前的检查点
 *
 * @param conversationId 对话 ID
 * @param iteration 当前迭代次数
 * @returns 检查点数据（用于 yield）或 null
 */
export async function createBeforeModelCheckpoint(
    ctx: CheckpointCoordinatorContext,
    conversationId: string,
    iteration: number
): Promise<ChatStreamCheckpointsData | null> {
    const checkpoint = await ctx.checkpointService.createModelMessageCheckpoint(
        conversationId,
        'before',
        iteration
    );
    if (!checkpoint) {
        return null;
    }

    return {
        conversationId,
        checkpoints: [checkpoint],
        checkpointOnly: true as const
    };
}
