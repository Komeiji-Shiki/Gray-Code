/**
 * LimCode - 同参数重复失败调用护栏（turn 级别）
 *
 * 解决的问题：模型（尤其是较小的模型）会陷入"用完全相同的参数反复调用
 * 同一个工具"的失败循环，每次都得到相同的错误，直到烧完 maxIterations。
 * 以前系统对此没有任何运行时护栏，只靠提示词自觉。
 *
 * 策略（刻意保守，避免误伤合法场景）：
 * - 只统计"连续失败"：相同 name+args 的调用返回 success:false 才计数，
 *   一旦成功立即清零。
 * - 重复的成功调用完全不干预（重跑测试、文件修改后重读等都是合法工作流）。
 * - 被策略拒绝的调用（rejected:true，如 subagent 并发超限、模式策略过滤）
 *   不计入失败：拒绝不代表参数有问题，稍后同参重试可能完全合理，
 *   而且护栏的"换个思路"文案对拒绝场景是误导。
 * - 参数签名使用键排序的稳定序列化，键顺序不同的语义等价参数命中同一签名。
 * - 连续失败达到阈值（默认 2 次）后，第 3 次相同调用不再真正执行，
 *   而是通过合成错误参数短路，把"换个思路"的提示作为工具结果回传给模型。
 *
 * 生命周期：每个对话轮次（turn）创建一个实例，跨工具迭代存活。
 */

import type { FunctionCallInfo } from '../utils';

/**
 * 被护栏拦截的调用会被替换为携带此参数的合成调用，
 * ToolExecutionService 检测到该参数后直接把提示作为工具错误结果返回，
 * 不进入真实执行。
 */
export const REPEATED_CALL_GUARD_ARG_KEY = '__repeatedCallGuardError';

interface RecordableToolResult {
    name: string;
    args?: Record<string, any>;
    result?: unknown;
}

export class RepeatedCallGuard {
    /** signature -> 连续失败次数 */
    private readonly failureCounts = new Map<string, number>();

    constructor(private readonly maxConsecutiveFailures: number = 2) {}

    /**
     * 检查单个调用。达到连续失败阈值的调用会被替换为合成错误调用。
     */
    guardCall(call: FunctionCallInfo): FunctionCallInfo {
        if (isGuardedCall(call.args)) {
            return call;
        }

        const signature = signatureOf(call.name, call.args);
        const failures = this.failureCounts.get(signature) ?? 0;
        if (failures < this.maxConsecutiveFailures) {
            return call;
        }

        return {
            ...call,
            args: {
                [REPEATED_CALL_GUARD_ARG_KEY]:
                    `Blocked: you have already called \`${call.name}\` with these exact arguments ${failures} times in this turn ` +
                    'and it failed every time. Repeating the identical call will not produce a different result. ' +
                    'Change the arguments or try a different approach.'
            }
        };
    }

    guardCalls(calls: FunctionCallInfo[]): FunctionCallInfo[] {
        return calls.map(call => this.guardCall(call));
    }

    /**
     * 根据执行结果更新连续失败计数。
     * 成功的调用清零计数；被护栏拦截的合成调用与被策略拒绝的调用不参与统计。
     */
    recordResults(results: RecordableToolResult[]): void {
        for (const r of results) {
            if (isGuardedCall(r.args)) {
                continue;
            }

            const resultRecord = r.result && typeof r.result === 'object'
                ? r.result as Record<string, unknown>
                : undefined;

            // rejected:true 表示调用没有真正执行（策略/并发限制/确认拒绝），
            // 既不计失败也不清零：不影响该签名已有的连续失败判断
            if (resultRecord?.rejected === true) {
                continue;
            }

            const signature = signatureOf(r.name, r.args);
            if (resultRecord?.success === false) {
                this.failureCounts.set(signature, (this.failureCounts.get(signature) ?? 0) + 1);
            } else {
                this.failureCounts.delete(signature);
            }
        }
    }
}

function isGuardedCall(args: Record<string, any> | undefined): boolean {
    return !!args && typeof args === 'object' && REPEATED_CALL_GUARD_ARG_KEY in args;
}

function signatureOf(name: string, args: Record<string, any> | undefined): string {
    try {
        return `${name}:${stableStringify(args ?? {})}`;
    } catch {
        return `${name}:<unserializable>`;
    }
}

/**
 * 键排序的稳定 JSON 序列化。
 *
 * JSON.stringify 对键顺序敏感：模型两次输出语义完全相同、仅键顺序不同的参数
 * 会得到不同签名，从而绕过护栏。这里递归排序所有对象键，保证签名稳定。
 */
function stableStringify(value: unknown): string {
    return JSON.stringify(sortKeysDeep(value));
}

/**
 * 超过此长度的字符串参数在签名中用“长度+哈希”占位。
 *
 * 修改原因：guardCall + recordResults 对每个调用各做一次全量 JSON 序列化，
 * 携带几 MB content 的 write_file 每轮白付两次 MB 级拷贝，签名本身也是 MB 级。
 * 修改方式：超长字符串降级为定长指纹；哈希碰撞只影响护栏误拦概率，风险可忽。
 */
const LARGE_STRING_THRESHOLD = 64 * 1024;

function hashLargeString(value: string): string {
    // djb2：快、无依赖，护栏签名用途下强度足够
    let hash = 5381;
    for (let i = 0; i < value.length; i++) {
        hash = ((hash << 5) + hash + value.charCodeAt(i)) | 0;
    }
    return (hash >>> 0).toString(36);
}

function sortKeysDeep(value: unknown): unknown {
    if (typeof value === 'string' && value.length > LARGE_STRING_THRESHOLD) {
        return `__lc_large_str:${value.length}:${hashLargeString(value)}`;
    }
    if (Array.isArray(value)) {
        return value.map(sortKeysDeep);
    }
    if (value !== null && typeof value === 'object') {
        const sorted: Record<string, unknown> = {};
        for (const key of Object.keys(value as Record<string, unknown>).sort()) {
            sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
        }
        return sorted;
    }
    return value;
}
