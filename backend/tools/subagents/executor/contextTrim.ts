/**
 * 子代理请求级上下文裁剪（发送前防御性裁剪，不改动 run 内部 history）。
 *
 * 拆分说明：从 executor.ts 迁出（纯移动，逻辑一字未改）。
 */

import type { Content } from '../../../modules/conversation/types';
import type { BaseChannelConfig } from '../../../modules/config/configs/base';

/**
 * 子代理请求级上下文裁剪（SEC：子代理无 ContextTrimService，history 只增不减，
 * 长任务会撞上模型上下文上限直接失败；裁剪在发送前对本次请求生效，不改动
 * run 内部持有的原 history，也不影响事件总线/续跑记录）。
 *
 * 策略：
 * - 预算 = 渠道 maxContextTokens（缺省 128000）× 0.8，为模型输出与工具声明留余量；
 * - 超预算时从最旧开始整轮丢弃：functionResponse 必须与其配对的 model 消息一起移除
 *   （单独丢会留下孤儿 functionResponse，部分 provider 直接报错）；首条用户任务
 *   消息与末尾两轮始终保留；
 * - 仍超预算（单条巨型工具结果/文本）时，对超大字符串原地截断并标记截断，保留结构。
 */
const SUBAGENT_CONTEXT_BUDGET_DEFAULT_TOKENS = 128000;
const SUBAGENT_CONTEXT_BUDGET_RATIO = 0.8;
/** 单条字符串保留上限（约 5 万 token），超过即截断并标记 */
const SUBAGENT_MAX_SINGLE_STRING_CHARS = 200000;

function hasFunctionResponseParts(message: Content): boolean {
    return (message.parts || []).some(part => !!part.functionResponse);
}

/**
 * 本地 token 估算：口径与主链路对齐——
 * - 文本按「4 字符 ≈ 1 token」计算（主链路 TokenEstimationService 同口径）；
 * - 估算含 1.5× 安全系数（主链路 applyLocalEstimateSafetyFactor 同系数），
 *   多模态 part 按主链路 estimateMultimodalTokens 的近似下界折算
 *   （inlineData 图片 ≥500 token、fileData 引用按 300 token），避免图像/视频密集
 *   的工具结果被低估导致裁剪触发过晚；
 * - 序列化失败（工具结果含 BigInt 等不可 JSON 序列化对象）不抛错，按固定开销兜底——
 *   估算只服务于裁剪决策，不能因估算失败打断整个 run。
 */
const SUBAGENT_TOKEN_SAFETY_FACTOR = 1.5;

function estimateMessageTokens(message: Content): number {
    let tokens = 4; // 消息级开销（role 等）
    for (const part of message.parts || []) {
        if (part.text) {
            tokens += Math.ceil(part.text.length / 4) + 1;
        } else if (part.functionResponse) {
            tokens += safeStringifyTokens(part.functionResponse);
        } else if (part.functionCall) {
            tokens += safeStringifyTokens(part.functionCall);
        } else if (part.inlineData?.data) {
            tokens += 500 + Math.ceil(part.inlineData.data.length / 4); // base64 数据按 4 字符/token 折算
        } else if (part.fileData?.fileUri) {
            tokens += 300;
        } else {
            tokens += 8; // 未知 part 固定开销
        }
    }
    return Math.ceil(tokens * SUBAGENT_TOKEN_SAFETY_FACTOR);
}

/** 序列化 part 估算 token；不可序列化（BigInt/循环引用等）按固定开销兜底，不抛错 */
function safeStringifyTokens(value: unknown): number {
    try {
        return Math.ceil(JSON.stringify(value).length / 4) + 1;
    } catch {
        return 64; // 序列化失败兜底：按一条中等大小消息的开销估算
    }
}

/** 深度截断超过上限的字符串（保留 JSON 结构，最大递归深度 3 层） */
function truncateOversizedStrings(value: unknown, depth: number): unknown {
    if (typeof value === 'string') {
        if (value.length > SUBAGENT_MAX_SINGLE_STRING_CHARS) {
            return value.slice(0, SUBAGENT_MAX_SINGLE_STRING_CHARS)
                + `…[sub-agent context trim: truncated ${value.length} chars]`;
        }
        return value;
    }
    if (depth <= 0) return value;
    if (Array.isArray(value)) {
        return value.map(item => truncateOversizedStrings(item, depth - 1));
    }
    if (value && typeof value === 'object') {
        const result: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
            result[key] = truncateOversizedStrings(item, depth - 1);
        }
        return result;
    }
    return value;
}

function truncateOversizedParts(history: Content[]): void {
    for (const message of history) {
        for (const part of message.parts || []) {
            if (part.text) {
                part.text = truncateOversizedStrings(part.text, 0) as string;
            }
            if (part.functionCall) {
                part.functionCall = {
                    ...part.functionCall,
                    args: truncateOversizedStrings(part.functionCall.args, 3) as Record<string, unknown>
                };
            }
            if (part.functionResponse) {
                part.functionResponse = {
                    ...part.functionResponse,
                    response: truncateOversizedStrings(part.functionResponse.response, 3) as Record<string, unknown>
                };
            }
        }
    }
}

export function trimSubAgentHistoryForContext(history: Content[], channelConfig: BaseChannelConfig): Content[] {
    const maxContextTokens = typeof channelConfig.maxContextTokens === 'number' && channelConfig.maxContextTokens > 0
        ? channelConfig.maxContextTokens
        : SUBAGENT_CONTEXT_BUDGET_DEFAULT_TOKENS;
    const budget = Math.floor(maxContextTokens * SUBAGENT_CONTEXT_BUDGET_RATIO);
    if (budget <= 0 || history.length <= 1) {
        return history;
    }
    const perMessageTokens = history.map(estimateMessageTokens);
    const total = perMessageTokens.reduce((sum, tokens) => sum + tokens, 0);
    if (total <= budget) {
        return history;
    }

    // 从最旧开始整轮丢弃：函数响应必须与其配对的 model 消息一起移除（不产生孤儿，
    // 部分 provider 对孤立 functionResponse 直接报错）。前提：executor 的 history 形态
    // 不变量是「model 调用消息与其 functionResponse 消息严格相邻」（见下方 push 逻辑），
    // dropPair 只检查相邻下一条；若未来形态变化，防御性 break 会保守地停止丢弃。
    // 循环从 index 1 开始，首条任务消息（index 0）在裁剪后重新前置、始终保留；
    // 末尾两轮（含配对）由 i < history.length - 2 保证不进入丢弃范围。
    // 停止条件：再丢一轮就会低于预算时停止（尽量保留内容），结果可能仍略超预算——
    // 由超大字符串截断与 isContextLengthError 兜底文案继续收敛，不追求精确填满预算。
    let keepFrom = 0;
    let remaining = total;
    for (let i = 1; i < history.length - 2 && remaining > budget; ) {
        const message = history[i];
        if (message.role === 'user' && hasFunctionResponseParts(message)) {
            break; // 防御：函数响应不应单独出现在丢弃位（配对总是整轮消费）
        }
        const next = history[i + 1];
        const dropPair = !!next && next.role === 'user' && hasFunctionResponseParts(next);
        const cost = perMessageTokens[i] + (dropPair ? perMessageTokens[i + 1] : 0);
        if (remaining - cost <= budget) {
            break;
        }
        remaining -= cost;
        i += dropPair ? 2 : 1;
        keepFrom = i;
    }

    // 裁剪结果深拷贝后截断：不修改 run 内后续轮继续使用的原 history 引用。
    // 深拷贝失败（工具结果含 BigInt 等不可序列化内容）时放弃截断、仅做引用裁剪：
    // 裁剪决策与请求发送都不应被序列化能力限制打断。
    let trimmed: Content[];
    try {
        trimmed = JSON.parse(JSON.stringify(
            keepFrom > 0 ? [history[0], ...history.slice(keepFrom)] : history
        )) as Content[];
        truncateOversizedParts(trimmed);
    } catch {
        trimmed = keepFrom > 0 ? [history[0], ...history.slice(keepFrom)] : history;
    }
    return trimmed;
}
