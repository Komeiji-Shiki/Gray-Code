import type { ChildProcess } from 'node:child_process';
import { killProcessTree } from '../../../../backend/core/killProcessTree';

const stoppingChildren = new WeakMap<ChildProcess, Promise<void>>();
/** 进程树已结束后等待管道关闭的时间，从终止命令返回时开始计算。 */
const CLOSE_WAIT_MS = 7000;

/** 等待所创建的进程及管道实际关闭，避免关闭服务后工作目录仍被占用。 */
export function stopOwnedProcess(child: ChildProcess): Promise<void> {
  const pending = stoppingChildren.get(child);
  if (pending) return pending;
  if (!child.pid) return Promise.resolve();
  const pid = child.pid;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onClose: () => void;
  let rejectClosed: (error: Error) => void;
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  let release: ReturnType<typeof setTimeout> | undefined;
  const closed = new Promise<void>((resolve, reject) => {
    onClose = () => resolve();
    rejectClosed = reject;
    child.once('close', onClose);
    if (exited() && child.stdio.every(stream => !stream || 'destroyed' in stream && stream.destroyed)) resolve();
    // 进程已退出而管道仍被它留下的后代占用时，close 不会到达；稍等后关闭本端输出管道，停止不再报超时。
    else if (exited()) release = setTimeout(() => { child.stdout?.destroy(); child.stderr?.destroy(); }, 2000);
  });
  const terminate = exited() ? Promise.resolve() : killProcessTree(pid).catch(error => { if (!exited()) throw error; });
  const result = terminate.then(() => {
    timer = setTimeout(() => rejectClosed(new Error('受管进程未能退出：' + pid)), CLOSE_WAIT_MS);
    return closed;
  }).finally(() => {
    clearTimeout(timer); clearTimeout(release); child.off('close', onClose);
  }).catch(error => { stoppingChildren.delete(child); throw error; });
  stoppingChildren.set(child, result);
  return result;
}
