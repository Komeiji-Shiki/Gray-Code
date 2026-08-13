/**
 * GrayCode - 工具迭代循环 · 确认门控切面
 *
 * 从 ToolIterationLoopService 拆出：工具是否需要确认的判定、自动执行前缀
 * （第一个需确认工具之前的所有工具）的规划。行为与拆分前逐字一致。
 */

import type { FunctionCallInfo } from '../../utils';
import type { ResolvedPromptModeSnapshot } from '../../../../settings/types';
import type { ToolExecutionService } from '../ToolExecutionService';
import { isDiffReviewToolCall } from '../diffReviewTools';

/**
 * 判断一个工具调用是否应当在模型流式输出期间提前启动执行。
 *
 * 只有「不需要确认」且「不会进入 diff 审阅流程」的工具才提前执行；
 * 需要确认的工具跳过（仍走现有的暂停等待路径）。
 */
export function shouldStartToolDuringModelStream(
    call: FunctionCallInfo,
    toolExecutionService: ToolExecutionService,
    promptModeSnapshot?: ResolvedPromptModeSnapshot
): boolean {
    return !toolExecutionService.toolNeedsConfirmation(call.name, call.args, promptModeSnapshot)
        && !isDiffReviewToolCall(call.name, call.args);
}

/**
 * 规划工具执行顺序：找到第一个需要确认的工具（按顺序），并返回它之前的
 * 可自动执行前缀工具列表。执行规则：执行到第一个需要用户批准的工具时暂停。
 */
export function planToolExecutionOrder(
    functionCalls: FunctionCallInfo[],
    toolExecutionService: ToolExecutionService,
    promptModeSnapshot?: ResolvedPromptModeSnapshot
): { autoPrefix: FunctionCallInfo[]; firstConfirmTool: FunctionCallInfo | null } {
    const autoPrefix: FunctionCallInfo[] = [];
    let firstConfirmTool: FunctionCallInfo | null = null;

    for (const call of functionCalls) {
        if (toolExecutionService.toolNeedsConfirmation(call.name, call.args, promptModeSnapshot)) {
            firstConfirmTool = call;
            break;
        }
        autoPrefix.push(call);
    }

    return { autoPrefix, firstConfirmTool };
}
