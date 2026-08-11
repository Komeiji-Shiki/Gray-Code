/**
 * GrayCode - 工具循环 abort 收尾公共模块（第五批解环：E4）
 *
 * MAIN_LOOP_ABORT_DRAIN_GRACE_MS / drainToolExecutionGeneratorAfterAbort（含其内部使用的
 * GEN_RETURN_RECOVERY_GRACE_MS 与 drainLog）从 ToolIterationLoopService 迁出：
 * ToolExecutionService 侧（tool-execution/execution.ts）与 ToolIterationLoopService 侧都
 * 从这里导入，解除二者之间的直接互相 import。常量值、函数体、行为语义逐字保持，逻辑零改动。
 */

import { Logger } from '../../../../core/logger';
import type { ToolExecutionFullResult, ToolExecutionProgressEvent } from './ToolExecutionService';

/**
 * 主工具循环 abort 后给工具执行生成器的收尾窗口（毫秒）。
 *
 * abort 先于 gen.next() 落定时，响应 abort 的工具会快速返回已完成部分的真实结果；
 * 窗口内返回则正常结算（真实副作用结果不能丢），窗口结束仍未返回（工具不响应 abort
 * 且永不结束）则放弃，避免请求永久挂起、停止按钮失效。
 */
export const MAIN_LOOP_ABORT_DRAIN_GRACE_MS = 2000;

/**
 * 收尾窗口超时后给 gen.return() 的回收窗口（毫秒）。
 *
 * M2：工具不响应 abort 且永不结束时，drain 超时返回前必须显式调用 gen.return()，
 * 让 executeFunctionCallsWithProgress 的 finally（mailbox drain epoch 释放等）有机会执行。
 * 但生成器若挂在某个不可中断的 await 上，return() 也只能排队等待——窗口结束即放弃并记录
 * 日志（JS 无法强制中断挂起的 promise），避免请求进一步被拖长。
 */
export const GEN_RETURN_RECOVERY_GRACE_MS = 500;

/** drain 收尾日志（模块级，供 drainToolExecutionGeneratorAfterAbort 使用） */
const drainLog = Logger.get('ToolLoopDrain');

/**
 * promise 与超时竞速：超时先到返回 undefined。
 *
 * 竞速双方任意一方先落定都清理 timer，避免残留 open handle。
 * 供 drainToolExecutionGeneratorAfterAbort 内部与 tool-execution/execution.ts
 * 的并行组收尾窗口共用（同构实现合并，行为零改动）。
 */
export function raceWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), Math.max(0, timeoutMs));
    });
    // 竞速双方任意一方先落定都清理 timer，避免残留 open handle
    promise.then(
        () => { if (timer) clearTimeout(timer); },
        () => { if (timer) clearTimeout(timer); }
    );
    return Promise.race([promise, timeoutPromise]);
}

/**
 * abort 先于 gen.next() 落定时驱动工具执行生成器收尾，取回已完成部分的真实结果。
 *
 * 必须先等 initialNext（即主循环里那次正在恢复生成器的 next() 请求）：
 * - 若生成器直接返回（如 abort 落在工具间隙、核心循环检查 abort 后直接结束），
 *   返回值交给 initialNext；此时再调 gen.next() 只会拿到 { done: true, value: undefined }；
 * - 若生成器先 yield 当前工具的 end 事件再返回（abort 落在工具执行中），
 *   initialNext 拿到事件，随后 gen.next() 才会拿到返回值。
 *
 * 窗口（graceMs）内拿到最终值则返回；超时（工具不响应 abort 且永不结束）返回 undefined，
 * 调用方走既有取消路径，保证请求不永久挂起。
 *
 * M2：超时路径会显式调用 gen.return() 回收生成器（带独立短窗口），确保
 * executeFunctionCallsWithProgress 的 finally（mailbox drain epoch 释放）尽量执行，
 * 避免生成器被放弃后资源泄漏。
 */
export async function drainToolExecutionGeneratorAfterAbort(
    gen: AsyncGenerator<ToolExecutionProgressEvent, ToolExecutionFullResult, void>,
    initialNext: Promise<IteratorResult<ToolExecutionProgressEvent, ToolExecutionFullResult>>,
    graceMs: number
): Promise<ToolExecutionFullResult | undefined> {
    // 收尾窗口内生成器抛错（initialNext / gen.next() reject）：已无法取回真实结果，
    // 按「drain 失败」处理（返回 undefined，调用方走既有取消路径 → cancelled 语义），
    // 不让异常穿透为 error chunk。
    const settleDrainStep = async (
        step: Promise<IteratorResult<ToolExecutionProgressEvent, ToolExecutionFullResult>>
    ): Promise<IteratorResult<ToolExecutionProgressEvent, ToolExecutionFullResult> | undefined> => {
        try {
            return await step;
        } catch (error) {
            drainLog.warn('drain_next_rejected', {
                graceMs,
                error: (error as Error)?.message ?? String(error),
            });
            return undefined;
        }
    };

    const drainDeadline = Date.now() + graceMs;
    let drained = await raceWithTimeout(settleDrainStep(initialNext), drainDeadline - Date.now());
    while (drained !== undefined && !drained.done && Date.now() < drainDeadline) {
        drained = await raceWithTimeout(settleDrainStep(gen.next()), drainDeadline - Date.now());
    }

    if (drained !== undefined && drained.done) {
        return drained.value as ToolExecutionFullResult;
    }

    // M2：窗口超时（工具不响应 abort 且永不结束）——回收生成器，让 try/finally 执行。
    // return 给独立短窗口：生成器若挂在不可中断的 await 上，return() 只能排队，窗口结束
    // 即放弃（finally 无法强制执行），记录日志便于排查泄漏。
    try {
        // TReturn 为 ToolExecutionFullResult，undefined 需经类型断言传入
        const returnResult = gen.return(undefined as unknown as ToolExecutionFullResult);
        // 伪生成器（测试 mock 等）的 return() 可能不返回 promise：此时没有 finally 可回收，
        // 直接放弃，不做竞速（raceWithTimeout 需要 promise）。
        if (!returnResult || typeof (returnResult as Promise<unknown>)?.then !== 'function') {
            return undefined;
        }
        const returned = await raceWithTimeout(returnResult as Promise<unknown>, GEN_RETURN_RECOVERY_GRACE_MS);
        if (returned === undefined) {
            drainLog.warn('drain_return_timeout', {
                graceMs,
                note: 'generator did not respond to return() within grace window; its finally may not have run',
            });
        }
    } catch (error) {
        drainLog.warn('drain_return_failed', {
            graceMs,
            error: (error as Error)?.message ?? String(error),
        });
    }
    return undefined;
}

