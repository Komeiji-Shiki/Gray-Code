/**
 * GrayCode - 流式工具调用完成上报（回调职责）
 *
 * 由 StreamAccumulator 拆分而来：把「返回自上次调用以来新完成的 functionCall」
 * 的读出逻辑抽为纯函数，供流式边执行工具使用。
 */

import type { ContentPart } from '../../conversation';

export interface CompletedFunctionCall {
    index: number;
    name: string;
    id: string;
    args: Record<string, unknown>;
}

/**
 * 返回自上次调用以来新完成（args 已解析成功）的 functionCall。
 *
 * 用于流式边执行工具：ToolIterationLoopService 在流式消费循环中
 * 每处理一个chunk 后调用此方法，检测是否有新的 functionCall 完成，
 * 对不需要确认的工具立即启动异步执行。
 *
 * "完成"的判定：functionCall.args 已有值（partialArgs 已成功JSON.parse）。
 * 每个 functionCall 只会被返回一次（通过 reportedFunctionCallIds 去重）。
 */
export function collectNewCompletedFunctionCalls(
    parts: ContentPart[],
    reportedFunctionCallIds: Set<string>
): CompletedFunctionCall[] {
    const result: CompletedFunctionCall[] = [];

    for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (!part.functionCall) continue;

        const fc = part.functionCall as any;
        // "完成"判定：args 必须包含至少一个键，排除初始占位空壳{}。
        //
        // Anthropic content_block_start 发送input: {}，formatter 存为
        // args: {}；OpenAI 首个 tool_call chunk 也设 args: {}。
        // 真正的参数通过后续增量（input_json_delta / arguments delta）
        // 拼接到partialArgs，JSON.parse 成功后才更新 args。
        // 仅检查args 是否为对象会在初始阶段误判为完成，导致以空参数执行。
        //
        // 只有 partialArgs 被成功JSON.parse 后，args 才会含有实际的键。
        const hasRealArgs = fc.args && typeof fc.args === 'object' && Object.keys(fc.args).length > 0;
        // 所有 provider 都要求稳定 id 才允许提前执行：
        // - 常规路径下 functionCall 在入列时就会生成 id，此条件恒满足；
        // - openai-responses 的占位调用要等官方 call_id 到达；
        // - 没有稳定 id 的调用交给最终统一执行路径兜底，
        //   避免 id 后补时与提前执行结果对不上号导致重复执行。
        const hasStableToolCallId = typeof fc.id === 'string' && fc.id.trim().length > 0;
        if (!hasRealArgs || !fc.name || !hasStableToolCallId) continue;
        // 预填 input（forced tool use）的调用：流式增量可能仍在到达（prefilledArgs
        // 直到增量并入才清除），未完成前不提前上报执行，避免以预填的部分参数执行工具
        if (fc.prefilledArgs === true) continue;
        if (reportedFunctionCallIds.has(fc.id)) continue;

        reportedFunctionCallIds.add(fc.id);
        result.push({
            index: i,
            name: fc.name,
            id: fc.id,
            // 返回浅拷贝：避免调用方修改污染累加器内部 parts 的 args 引用
            args: { ...fc.args },
        });
    }

    return result;
}
