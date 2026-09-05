/**
 * GrayCode - 流式内容构造（回调/读出职责）
 *
 * 由 StreamAccumulator 拆分而来：把「将已累积 parts 投影为最终/快照 Content」
 * 的纯逻辑抽到独立模块；StreamAccumulator 只保留累积职责。
 */

import type { Content, ContentPart, UsageMetadata, ThoughtSignatures } from '../../conversation';
import { parseToolArguments } from '../formatters/toolArguments';

export interface BuildContentOptions {
    parsePartialArgs: boolean;
    includeInternalFunctionCallFields: boolean;
    warnOnParseFailure: boolean;
    finalizeFunctionCallIndex?: number;
}

/** buildContentFromState 所需的状态快照 */
export interface StreamContentBuildState {
    parts: ContentPart[];
    thoughtSignatures: ThoughtSignatures;
    modelVersion?: string;
    usageMetadata?: UsageMetadata;
    thinkingStartTime?: number;
    thinkingDuration?: number;
    hasReceivedNormalText: boolean;
    chunkCount: number;
    firstChunkTime?: number;
    requestStartTime?: number;
    lastChunkTime?: number;
}

/**
 * 解析工具调用参数增量：解析成功时更新 fc.args 并清除预填标记，返回是否成功。
 *
 * 预填 input（forced tool use，anthropic content_block_start 携带完整 input）场景：
 * 后续 input_json_delta 存在两种语义——
 * - 剩余片段：预填 JSON 去尾闭合符 + 累积片段 = 完整 JSON；
 * - 完整重放（部分代理行为）：片段自身即完整 JSON。
 * 两种候选都尝试，任一解析成功即采用，保证预填参数与流式增量不丢不破。
 */
export function tryParseFunctionCallArgs(fc: any): boolean {
    if (!fc.partialArgs || !fc.partialArgs.trim()) {
        return false;
    }
    // 预填 input 已显式提供即参与拼接（含空对象 {}：JSON.stringify({}) = '{}'，
    // slice(0,-1) 后为 '{'，与剩余片段合并 {"b":2} → '{"b":2}'；空对象 + 完整重放
    // 场景由候选 2（片段自身）兜底）
    const prefillJson = fc.prefilledArgs === true
        && fc.args && typeof fc.args === 'object'
        ? JSON.stringify(fc.args)
        : '';
    // 候选 1（剩余片段）：prefillJson 是完整闭合 JSON（如 {"a":1}），直接拼接增量片段必非法
    // （闭合 JSON + 片段）；预填参数为对象/数组时去掉尾闭合符再拼接：
    // {"a":1} + ,"b":2} → {"a":1,"b":2}，数组同理。
    // 候选 2（完整重放）：片段自身即完整 JSON。
    const candidates = prefillJson
        ? [prefillJson.slice(0, -1) + fc.partialArgs, fc.partialArgs]
        : [fc.partialArgs];
    for (const candidate of candidates) {
        try {
            fc.args = parseToolArguments(candidate, fc.name || 'unknown');
            // 参数已并入流式增量：预填标记失效，后续按普通累积语义继续
            fc.prefilledArgs = false;
            // 清空已消费的增量片段（合并路径与新块路径共用此成功点）：
            // 参数已并入 fc.args，残留 partialArgs 会在下一次合并时追加到已闭合 JSON
            // 之后（{"a":1} + ,"b":2} 必非法），导致后续增量永远无法解析并无限累积
            fc.partialArgs = '';
            return true;
        } catch {
            // JSON 尚未完整，继续等待更多增量
        }
    }
    return false;
}

/**
 * 构造 Content 的唯一入口（已从 StreamAccumulator 抽出）。
 * streaming snapshot 只做轻量投影；最终写历史或工具执行前才解析 partialArgs 并清理内部字段。
 */
export function buildContentFromState(state: StreamContentBuildState, options: BuildContentOptions): Content {
    let parts = state.parts
        .map(p => {
            const part = { ...p };
            if (part.functionCall) {
                const fc = { ...part.functionCall } as any;
                const shouldFinalizeFunctionCall =
                    typeof options.finalizeFunctionCallIndex === 'number' &&
                    typeof fc.index === 'number' &&
                    fc.index === options.finalizeFunctionCallIndex;
                // 预填 input（prefilledArgs）时 args 非空但可能不完整（增量尚未并入），
                // 同样走「预填 + 增量 / 增量自身」语义解析（见 tryParseFunctionCallArgs）
                if ((options.parsePartialArgs || shouldFinalizeFunctionCall) && fc.partialArgs) {
                    if (!tryParseFunctionCallArgs(fc) && options.warnOnParseFailure) {
                        // Final invocations must be valid objects; partial/cancelled
                        // snapshots still preserve display state without executing it.
                        parseToolArguments(fc.partialArgs, fc.name || 'unknown');
                    }
                }

                if (!options.includeInternalFunctionCallFields || shouldFinalizeFunctionCall) {
                    delete fc.index;
                    delete fc.partialArgs;
                    // itemId/finalArgs 只是流式合并字段，最终Content 只保留跨 provider 通用协议。
                    delete fc.itemId;
                    delete fc.finalArgs;
                    delete fc.prefilledArgs;
                }
                part.functionCall = fc;
            }
            return part;
        })
        .filter(p => {
            // 保留非文本part（functionCall 等）
            if (!('text' in p) || p.functionCall) return true;
            // 过滤空文本（但保留有意义的内容）
            if ('text' in p && p.text === '' && !p.thought) return false;
            return true;
        });

    // 添加思考签名到 parts 中
    // 如果有收集到的思考签名，需要作为单独的 part 添加
    // 这样可以在后续发送给 API 时正确传递签名
    if (Object.keys(state.thoughtSignatures).length > 0) {
        // 检查parts 中是否已经有包含 thoughtSignatures 的part
        const hasSignaturePart = parts.some(p => p.thoughtSignatures);
        if (!hasSignaturePart) {
            // 添加一个包含所有格式签名的 part
            parts.push({ thoughtSignatures: { ...state.thoughtSignatures } });
        }
    }

    const content: Content = {
        role: 'model',
        parts
    };

    // 添加模型版本
    if (state.modelVersion) {
        content.modelVersion = state.modelVersion;
    }

    // 添加完整的usageMetadata
    if (state.usageMetadata) {
        content.usageMetadata = { ...state.usageMetadata };
    }

    // 添加思考开始时间（用于前端实时显示）
    if (state.thinkingStartTime !== undefined) {
        content.thinkingStartTime = state.thinkingStartTime;
    }

    // 添加思考持续时间
    // 如果有思考内容但没有普通文本，在获取Content 时计算最终持续时间
    if (state.thinkingStartTime !== undefined) {
        if (state.thinkingDuration !== undefined) {
            content.thinkingDuration = state.thinkingDuration;
        } else if (!state.hasReceivedNormalText) {
            // 消息只有思考内容没有普通文本，使用当前时间计算
            content.thinkingDuration = Date.now() - state.thinkingStartTime;
        }
    }

    // 添加流式统计信息
    content.chunkCount = state.chunkCount;
    if (state.firstChunkTime !== undefined) {
        content.firstChunkTime = state.firstChunkTime;
    }

    // 首字延迟（TTFT）：第一个流式块到达时间 - 请求开始时间
    // 用于前端展示首字等待耗时，并让 Token 速率分母剥离首字等待窗口（避免首字等待拉低速率）
    if (state.firstChunkTime !== undefined && state.requestStartTime !== undefined) {
        const ttft = state.firstChunkTime - state.requestStartTime;
        if (ttft >= 0) {
            content.ttft = ttft;
        }
    }

    // 修改原因：旧 streamDuration 只覆盖首块到末块窗口，上游攒包后会让 token 速度分母过小。
    // 修改方式：用同一个requestStartTime -> lastChunkTime / Date.now() 局部值同时写入responseDuration 与streamDuration。
    // 修改目的：字面修复streamDuration 为完整请求到流结束耗时，并避免两个字段因重复采样产生毫秒级抖动。
    if (state.requestStartTime !== undefined) {
        const completeResponseDuration = (state.lastChunkTime ?? Date.now()) - state.requestStartTime;
        content.responseDuration = completeResponseDuration;
        content.streamDuration = completeResponseDuration;
    }

    return content;
}
