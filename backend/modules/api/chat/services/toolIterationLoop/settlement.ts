/**
 * GrayCode - 工具迭代循环 · 结算切面
 *
 * 从 ToolIterationLoopService 拆出：工具结果/函数响应按调用顺序重排、
 * 取消场景下的工具调用结算（补 cancelled 占位或保留真实结果）。
 *
 * 依赖通过参数注入（ConversationManager / Logger），行为与拆分前逐字一致。
 */

import type { Content, ContentPart } from '../../../../conversation/types';
import type { ConversationManager } from '../../../../conversation/ConversationManager';
import type { FunctionCallInfo, ToolExecutionResult } from '../../utils';
import type { ToolExecutionFullResult } from '../ToolExecutionService';
import type { Logger } from '../../../../../core/logger';
import { t } from '../../../../../i18n';

/**
 * 按 AI 调用顺序重排工具执行结果。
 *
 * 早启动（流式边执行）工具与主循环工具会各自产生结果组，这里把两组结果合并后
 * 按 `calls` 的顺序输出；无 id 或无法匹配的结果追加到末尾，保证 toolResults 顺序
 * 与模型视角一致。
 */
export function orderToolResultsByCallSequence(
    calls: FunctionCallInfo[],
    groups: Array<ToolExecutionResult[] | undefined>
): ToolExecutionResult[] {
    const byId = new Map<string, ToolExecutionResult>();
    const extras: ToolExecutionResult[] = [];

    for (const group of groups) {
        if (!group) continue;
        for (const result of group) {
            if (!result?.id) {
                extras.push(result);
                continue;
            }
            if (!byId.has(result.id)) {
                byId.set(result.id, result);
            }
        }
    }

    const ordered: ToolExecutionResult[] = [];
    for (const call of calls) {
        const match = byId.get(call.id);
        if (match) {
            ordered.push(match);
            byId.delete(call.id);
        }
    }

    ordered.push(...byId.values(), ...extras);
    return ordered;
}

/**
 * 按 AI 调用顺序重排函数响应 parts（functionResponse）。
 */
export function orderFunctionResponsePartsByCallSequence(
    calls: FunctionCallInfo[],
    groups: Array<ContentPart[] | undefined>
): ContentPart[] {
    const byId = new Map<string, ContentPart>();
    const extras: ContentPart[] = [];

    for (const group of groups) {
        if (!group) continue;
        for (const part of group) {
            const id = part.functionResponse?.id;
            if (!id) {
                extras.push(part);
                continue;
            }
            if (!byId.has(id)) {
                byId.set(id, part);
            }
        }
    }

    const ordered: ContentPart[] = [];
    for (const call of calls) {
        const match = byId.get(call.id);
        if (match) {
            ordered.push(match);
            byId.delete(call.id);
        }
    }

    ordered.push(...byId.values(), ...extras);
    return ordered;
}

/**
 * 取消时结算模型消息里已经落地的工具调用。
 *
 * 流式取消会把累加器中的部分内容直接写进历史，其中可能已经包含**完整**的 functionCall。
 * 不补对应的 functionResponse，历史里就留下悬空的 tool_use：Anthropic / OpenAI 在下一次
 * 请求时会直接以 400 拒绝，而用户看到的是一句和「我刚才按了停止」毫无关系的报错。
 *
 * 流式提前执行已经跑完的工具用真实结果结算——它们的副作用（写文件、跑命令）已经发生，
 * 丢掉结果等于对模型隐瞒；其余标记为已取消。
 */
export async function settleCancelledToolCalls(
    conversationManager: ConversationManager,
    conversationId: string,
    cancelledContent: Content,
    settledResults: Map<string, ToolExecutionFullResult>
): Promise<void> {
    const cancelledCalls = cancelledContent.parts
        .map(part => part.functionCall)
        .filter((call): call is NonNullable<ContentPart['functionCall']> & { id: string } => !!call?.id);

    if (cancelledCalls.length === 0) {
        return;
    }

    const responseParts: ContentPart[] = cancelledCalls.map(call => {
        const settledPart = settledResults.get(call.id)
            ?.responseParts
            .find(part => part.functionResponse?.id === call.id);

        return settledPart ?? {
            functionResponse: {
                id: call.id,
                name: call.name || 'unknown',
                response: {
                    success: false,
                    error: t('modules.api.chat.errors.toolCallCancelled'),
                    cancelled: true
                }
            }
        };
    });

    // 提前执行工具产生的多模态附件（xml/json prompt 模式）不能丢：
    // 与响应 part 一并写入，否则 generate_image / MCP 图片结果静默丢失。
    const multimodalAttachments = Array.from(settledResults.values())
        .flatMap(result => result.multimodalAttachments ?? []);
    const allParts = multimodalAttachments.length > 0
        ? [...multimodalAttachments, ...responseParts]
        : responseParts;

    // 用 settleFunctionResponses 代替 addContent：cancelStream 的
    // rejectAllPendingToolCalls 可能已写入"用户拒绝"占位，addContent 的去重
    // 会把真实结果丢弃（真实副作用结果永久丢失）；settleFunctionResponses
    // 保证真实结果永远覆盖占位。
    await conversationManager.settleFunctionResponses(conversationId, allParts);
}

/**
 * 非流式 abort 结算（与流式 settleCancelledToolCalls 同构）。
 *
 * runNonStreamLoop 主循环顶部发现 abort 时，最近一次 addContent 写入历史的
 * assistant 消息可能已包含**完整**的 functionCall，但工具执行被 abort 中断
 * （并行组收尾窗口超时返回空结果、executeFunctionCallsWithProgressCore 主循环
 * 顶部 break 跳过未启动调用）导致部分调用没有配对 functionResponse。不补占位
 * 会在历史留下悬空 tool_use：重试/新消息时 rejectAllPendingToolCalls 误标
 * "用户拒绝"，或 formatter 原样发送孤儿调用触发 400。
 *
 * 与流式路径一致：已执行完的调用（settledResult 中有真实响应）保持原样，
 * 其余补 cancelled 占位，经 settleFunctionResponses 幂等落盘（覆盖占位、
 * 插入到所属 functionCall 消息之后，避免 addContent 去重丢弃或非法消息交替顺序）。
 */
export async function settleCancelledNonStreamToolCalls(
    conversationManager: ConversationManager,
    log: Logger,
    conversationId: string,
    functionCalls: FunctionCallInfo[],
    settledResult: ToolExecutionFullResult | undefined
): Promise<void> {
    if (functionCalls.length === 0) {
        return;
    }

    const settledIds = new Set(
        (settledResult?.responseParts ?? [])
            .map(part => part.functionResponse?.id)
            .filter((id): id is string => !!id)
    );
    const cancelledCalls = functionCalls.filter(call => !settledIds.has(call.id));
    if (cancelledCalls.length === 0) {
        return;
    }

    log.info('nonstream.abort_settle_cancelled', {
        conversationId,
        totalCalls: functionCalls.length,
        cancelledCalls: cancelledCalls.length
    });

    const responseParts: ContentPart[] = cancelledCalls.map(call => ({
        functionResponse: {
            id: call.id,
            name: call.name || 'unknown',
            response: {
                success: false,
                error: t('modules.api.chat.errors.toolCallCancelled'),
                cancelled: true
            }
        }
    }));

    await conversationManager.settleFunctionResponses(conversationId, responseParts);
}
