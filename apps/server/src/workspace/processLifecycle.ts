import { execFile, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import treeKill from 'tree-kill';

const stoppingChildren = new WeakMap<ChildProcess, Promise<void>>();

/** 等待所创建的进程及管道实际关闭，避免关闭服务后工作目录仍被占用。 */
export function stopOwnedProcess(child: ChildProcess): Promise<void> {
  const pending = stoppingChildren.get(child);
  if (pending) return pending;
  if (!child.pid) return Promise.resolve();
  const pid = child.pid;
  let timer: ReturnType<typeof setTimeout>;
  let onClose: () => void;
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  let release: ReturnType<typeof setTimeout> | undefined;
  const closed = new Promise<void>((resolve, reject) => {
    onClose = resolve;
    child.once('close', onClose);
    timer = setTimeout(() => reject(new Error('受管进程未能退出：' + pid)), 7000);
    if (exited() && child.stdio.every(stream => !stream || 'destroyed' in stream && stream.destroyed)) resolve();
    // 进程已退出而管道仍被它留下的后代占用时，close 不会到达；稍等后关闭本端输出管道，停止不再报超时。
    else if (exited()) release = setTimeout(() => { child.stdout?.destroy(); child.stderr?.destroy(); }, 2000);
  });
  const terminate = exited() ? Promise.resolve() : new Promise<void>((resolve, reject) => {
    const done = (error?: Error | null) => error && !exited() ? reject(error) : resolve();
    if (process.platform === 'win32') execFile(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
      ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, done);
    else treeKill(pid, 'SIGTERM', done);
  });
  const result = Promise.all([closed, terminate]).then(() => {}).finally(() => {
    clearTimeout(timer); clearTimeout(release); child.off('close', onClose);
  }).catch(error => { stoppingChildren.delete(child); throw error; });
  stoppingChildren.set(child, result);
  return result;
}
