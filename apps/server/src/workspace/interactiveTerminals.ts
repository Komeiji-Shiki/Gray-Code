import { workspaceForRoot } from './paths';
import { randomUUID } from 'node:crypto';
import type { IPty } from 'node-pty';
import type { InteractiveTerminalInfo, InteractiveTerminalSnapshot } from '@graycode/contracts';
import type { PlatformApplication } from '../application';

interface TerminalSession {
  info: InteractiveTerminalInfo;
  pty: IPty;
  output: string;
  offset: number;
}
export class InteractiveTerminals {
  private readonly sessions = new Map<string, TerminalSession>();
  private creating = 0;
  private closed = false;
  constructor(private readonly application: PlatformApplication) {}
  get hasRunning() { return [...this.sessions.values()].some(session => session.info.status === 'running'); }
  list(): InteractiveTerminalInfo[] { return [...this.sessions.values()].map(session => ({ ...session.info })); }
  snapshot(id: string): InteractiveTerminalSnapshot {
    const session = this.get(id); return { ...session.info, output: session.output, offset: session.offset };
  }
  async create(actorId: string, workspaceId: string, cols = 100, rows = 25, directory?: string): Promise<InteractiveTerminalSnapshot> {
    this.application.requireOwner(actorId);
    const workspace = workspaceForRoot(this.application.workspace(actorId, workspaceId, ['process_execute']), directory);
    if (this.closed) throw new Error('核心服务正在关闭。');
    if (this.sessions.size + this.creating >= 12) throw new Error('请先关闭不用的终端。');
    this.creating++;
    try {
      // 只在真正打开终端时加载原生模块，普通核心任务不依赖其加载成功。
      const { spawn } = await import('node-pty');
      if (this.closed) throw new Error('核心服务正在关闭。');
      this.application.workspace(actorId, workspaceId, ['process_execute']);
      cols = this.dimension(cols, 500); rows = this.dimension(rows, 200);
      const shell = process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/bash';
      const terminal = spawn(shell, process.platform === 'win32' ? ['-NoLogo'] : [], {
        name: 'xterm-256color', cols, rows, cwd: workspace.directory,
        ...(process.platform === 'win32' ? { useConptyDll: true } : {}),
        env: { ...process.env, TERM: 'xterm-256color' },
      });
      const session: TerminalSession = { info: { id: randomUUID(), workspaceId, title: workspace.name,
        pid: terminal.pid, createdAt: Date.now(), cols, rows, status: 'running' }, pty: terminal, output: '', offset: 0 };
      this.sessions.set(session.info.id, session);
      terminal.onData(data => {
        if (this.sessions.get(session.info.id) !== session) return;
        session.output = (session.output + data).slice(-256_000); session.offset += data.length;
        this.application.publish({ type: 'terminal.data', id: session.info.id, data, offset: session.offset });
      });
      terminal.onExit(event => {
        if (this.sessions.get(session.info.id) !== session) return;
        session.info.status = 'exited'; session.info.exitCode = event.exitCode;
        this.application.publish({ type: 'terminal.exit', id: session.info.id, exitCode: event.exitCode });
        this.changed();
      });
      this.changed(); return this.snapshot(session.info.id);
    } finally { this.creating--; }
  }
  input(id: string, data: string): void {
    if (typeof data !== 'string' || data.length > 1_000_000) throw new Error('终端输入无效或过长。');
    const session = this.get(id);
    if (session.info.status !== 'running') throw new Error('终端已经退出。');
    session.pty.write(data);
  }
  resize(id: string, cols: number, rows: number): void {
    const session = this.get(id); if (session.info.status !== 'running') return;
    cols = this.dimension(cols, 500); rows = this.dimension(rows, 200);
    if (session.info.cols === cols && session.info.rows === rows) return;
    session.pty.resize(cols, rows); session.info.cols = cols; session.info.rows = rows;
  }
  stop(id: string): void {
    const session = this.get(id);
    if (session.info.status === 'running') session.pty.kill();
  }
  remove(id: string): void {
    const session = this.get(id);
    if (session.info.status === 'running') session.pty.kill();
    this.sessions.delete(id); this.changed();
  }
  private dimension(value: number, max: number) {
    if (!Number.isFinite(value)) throw new Error('终端尺寸必须是有效数字。');
    return Math.max(2, Math.min(max, Math.floor(value)));
  }
  private get(id: string) {
    const session = this.sessions.get(id); if (!session) throw new Error('终端已经关闭。'); return session;
  }
  private changed() { this.application.publish({ type: 'terminal.changed' }); }
  close(): void {
    this.closed = true;
    for (const session of this.sessions.values()) if (session.info.status === 'running') session.pty.kill();
    this.sessions.clear();
  }
}
