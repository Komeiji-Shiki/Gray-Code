import type { ChildProcess } from 'node:child_process';
import treeKill from 'tree-kill';

/** 只停止此服务创建且尚未退出的进程树，包含语言服务自己的子进程。 */
export function stopDevelopmentProcess(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  const pid = child.pid;
  return new Promise(resolve => treeKill(pid, 'SIGTERM', () => resolve()));
}
