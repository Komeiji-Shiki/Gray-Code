import * as cp from 'child_process';
import * as os from 'os';
import { describeProcessTree, type ProcessTreeReport } from './processTree';
import type { TerminalProcess, TerminalInterruptReason } from './runtimeTypes';

const treeKill = require('tree-kill') as (pid: number, signal?: string, callback?: (error?: Error) => void) => void;
const KILL_WAIT_CLOSE_TIMEOUT_MS = 10_000;

/**
 * 调整终端进程的 CPU 优先级（尽力而为，失败静默）。
 *
 * Windows：用 PowerShell 设置 shell 进程的优先级类（BELOW_NORMAL / NORMAL）。
 * Windows 上子进程在创建时继承父进程的优先级类，因此 cmd/powershell 后续启动的
 * node/jest 等子进程树同样降级——后台跑测试/长任务时让出 CPU 给前台交互，
 * 空闲时仍全速执行。
 * POSIX：process.setPriority（nice 值），子进程同样继承。
 *
 * 注：Node 的 spawn priority 选项在 Windows 上实测不生效，且 @types/node 24 类型
 * 定义缺失，故采用 spawn 后外部设置。spawn→设置的竞态窗口（毫秒级）内启动的
 * 子进程可能继承 normal，可接受。
 */
export function setTerminalProcessPriority(pid: number | undefined, background: boolean): void {
    if (!pid) return;
    try {
        if (os.platform() === 'win32') {
            const priorityClass = background ? 'BelowNormal' : 'Normal';
            cp.exec(
                `powershell -NoProfile -Command "(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).PriorityClass = '${priorityClass}'"`,
                { windowsHide: true, timeout: 5000 },
                () => {
                    /* 失败静默：优先级是软约束 */
                },
            );
        } else {
            // POSIX：belowNormal ≈ nice +5，normal = 0
            const setPriority = (process as any).setPriority as ((pid: number, p: number | string) => void) | undefined;
            setPriority?.(pid, background ? 'belowNormal' : 'normal');
        }
    } catch {
        // 忽略：优先级设置失败不影响命令执行
    }
}

/**
 * 以「SIGTERM → 等待 KILL_WAIT_CLOSE_TIMEOUT_MS → SIGKILL 升级」终止进程树。
 *
 * 修改原因：超时/取消路径此前只发一次 SIGTERM——POSIX 上进程树捕获/忽略 SIGTERM 时
 *          'close' 永不触发，execute_command 的 Promise 永不 resolve，模型工具循环挂死。
 * 修改方式：与 killTerminalProcess 的强杀流程共用同一升级逻辑（幂等：进程已退出或
 *          close 已触发时不再重复发信号；SIGKILL 不可捕获、close 必达，等待不永久挂起）。
 * 修改目的：SIGTERM 免疫进程最终被 SIGKILL 强杀，等待方必然收到 close。
 */
export function terminateProcessTreeWithEscalation(terminalProcess: TerminalProcess): Promise<void> {
    // 超时与取消可能先后触发，同一进程只执行一轮终止与清理。
    return terminating.get(terminalProcess) ?? terminating.set(terminalProcess, terminateProcessTree(terminalProcess)).get(terminalProcess)!;
}
const terminating = new WeakMap<TerminalProcess, Promise<void>>();
function terminateProcessTree(terminalProcess: TerminalProcess): Promise<void> {
    const proc = terminalProcess.process;
    return new Promise<void>((resolve) => {
        // close 已处理（endTime 已落定）：不会再触发，直接返回
        if (terminalProcess.endTime !== undefined) {
            resolve();
            return;
        }
        // Shell 已退出但 close 未到：管道被后代占用。此时 PID 可能已被复用，不再按 PID 发信号。
        const exited = proc.exitCode !== null || proc.signalCode != null;

        let settled = false;
        const timers: NodeJS.Timeout[] = [];
        const later = (callback: () => void, delay: number) => {
            const timer = setTimeout(callback, delay);
            timer.unref?.();
            timers.push(timer);
        };

        const onClose = (): void => {
            if (settled) return;
            settled = true;
            for (const timer of timers) clearTimeout(timer);
            resolve();
        };

        // 先注册 close 监听再发信号，避免进程在两者之间退出导致漏监听
        proc.once('close', onClose);
        // 无法归属的进程仍占用管道时，关闭本端管道让 close 到达，前台命令不再挂起。
        const releasePipes = () => {
            if (!settled) {
                proc.stdout?.destroy();
                proc.stderr?.destroy();
            }
        };

        let rootKilled: Promise<void> = Promise.resolve();
        if (!exited) {
            later(() => {
                try {
                    proc.kill('SIGKILL');
                } catch {
                    // 可能已退出，忽略
                }
                // 修改原因：发 SIGKILL 后立即 onClose() 会让等待方在 close 处理器（落定
                //          endTime/exitCode/output）执行前就返回，拿到 stale 结果。
                // 修改方式：SIGKILL 不可捕获——发完信号不 resolve，继续等真实 close；
                //          若管道仍被其他进程占用而 close 迟迟未达，关闭本端管道后再兜底 resolve。
                later(() => {
                    releasePipes();
                    later(onClose, 1000);
                }, KILL_WAIT_CLOSE_TIMEOUT_MS);
            }, KILL_WAIT_CLOSE_TIMEOUT_MS);

            const pid = proc.pid;
            rootKilled = new Promise<void>((done) => {
                if (pid) {
                    // 使用 tree-kill 终止进程树（Windows: taskkill /F /T；Unix: 递归发信号）
                    treeKill(pid, 'SIGTERM', (err) => {
                        if (err) {
                            // tree-kill 失败：回退到直接 SIGKILL
                            try {
                                proc.kill('SIGKILL');
                            } catch {
                                // 忽略错误，进程可能已经退出
                            }
                        }
                        done();
                    });
                } else {
                    // 没有 PID，使用默认方式
                    try {
                        proc.kill('SIGTERM');
                    } catch {
                        // 忽略错误，进程可能已经退出
                    }
                    done();
                }
            });
        }

        const tracker = terminalProcess.tracker;
        if (tracker) {
            // 根进程树终止后补杀脱链后代并核实；此时 close 仍未到说明管道被占用，顺带报告无法归属的孤儿。
            terminalProcess.cleanup = rootKilled.then(() => tracker.cleanup({ pipeHeld: () => terminalProcess.endTime === undefined }));
            // 根进程已退出而 close 仍未到时关闭管道；根进程仍在运行则交给上面的 SIGKILL 升级。
            void terminalProcess.cleanup.then(() =>
                later(() => {
                    if (proc.exitCode === null && proc.signalCode == null) return;
                    releasePipes();
                    later(onClose, 1000);
                }, 1000),
            );
        } else if (exited) {
            later(() => {
                releasePipes();
                later(onClose, 1000);
            }, 2000);
        }
    });
}

/** 外部取消的原因：任务层取消（如生成失败）与用户点击停止、宿主关闭分开报告。 */
export function abortReason(reason: unknown): TerminalInterruptReason {
    const message = reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : '';
    if ((reason instanceof Error && reason.name === 'AbortError') || !message) return 'user_cancelled';
    if (/shutting down|正在关闭|正在退出/i.test(message)) return 'host_closing';
    if (/cancelled by user|user cancel|用户/i.test(message)) return 'user_cancelled';
    return 'task_cancelled';
}

export function interruptionOf(terminalProcess: TerminalProcess, processTree: ProcessTreeReport | undefined) {
    return {
        reason: terminalProcess.interruptReason ?? 'stopped',
        processTree: processTree ?? { verified: false },
        summary: describeProcessTree(processTree),
    };
}
