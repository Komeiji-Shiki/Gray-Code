import { execFile } from 'node:child_process';
import path from 'node:path';
import treeKill from 'tree-kill';

/**
 * taskkill 依赖系统的进程查询服务，机器繁忙时单次可达数秒。这个上限只防止命令卡死，
 * 留得足够宽：调用方的关闭等待要从它返回后才开始计时，否则慢机器上进程正常退出也会报超时。
 */
const TASKKILL_TIMEOUT_MS = 30_000;

/** 用系统目录下的 taskkill 结束多棵进程树，不经过 PATH 查找。 */
export function taskkillTrees(pids: readonly number[]): Promise<void> {
    return new Promise((resolve, reject) => {
        execFile(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
            [...pids.flatMap(pid => ['/PID', String(pid)]), '/T', '/F'], { windowsHide: true, timeout: TASKKILL_TIMEOUT_MS },
            error => { if (error) reject(error); else resolve(); });
    });
}

/** 结束进程及其后代。调用方负责确认 PID 仍是自己启动的进程。 */
export function killProcessTree(pid: number): Promise<void> {
    if (process.platform === 'win32') return taskkillTrees([pid]);
    return new Promise((resolve, reject) => {
        treeKill(pid, 'SIGTERM', error => { if (error) reject(error); else resolve(); });
    });
}
