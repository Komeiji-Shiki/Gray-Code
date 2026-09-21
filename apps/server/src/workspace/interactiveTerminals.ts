import { workspaceForRoot } from './paths';
import type { WorkspaceDefinition } from '@graycode/contracts';

export interface DebugTerminalProgram { info: InteractiveTerminalSnapshot; stop(): Promise<void> }
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { stopOwnedProcess } from './processLifecycle';
import type { InteractiveTerminalInfo, InteractiveTerminalSnapshot } from '@graycode/contracts';
import type { PlatformApplication } from '../application';

interface TerminalSession {
  info: InteractiveTerminalInfo;
  host: ChildProcess;
  closed: Promise<void>;
  stopping?: Promise<void>;
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
    const shell = process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/bash';
    return (await this.spawnProgram(actorId, workspace, workspace.directory, shell, process.platform === 'win32' ? ['-NoLogo'] : [],
      { ...process.env, TERM: 'xterm-256color' }, workspace.name, cols, rows)).info;
  }
  async launchProgram(actorId: string, workspaceId: string, input: { args: string[]; cwd: string; env?: Record<string, string | null>; title?: string }): Promise<DebugTerminalProgram> {
    this.application.requireOwner(actorId);
    const workspace = this.application.workspace(actorId, workspaceId, ['process_execute']);
    if (!Array.isArray(input.args) || !input.args.length || !input.args.every(value => typeof value === 'string' && !value.includes('\0'))) throw new Error('调试器的终端启动参数无效。');
    const cwd = await this.application.files.resolve(workspace, input.cwd || '.');
    const env: Record<string, string | undefined> = { ...process.env, TERM: 'xterm-256color' };
    for (const [key, value] of Object.entries(input.env ?? {})) {
      if (value === null) delete env[key]; else if (typeof value === 'string') env[key] = value; else throw new Error('调试器的环境变量无效。');
    }
    return this.spawnProgram(actorId, workspace, cwd, input.args[0], input.args.slice(1), env, input.title || '调试程序', 100, 25);
  }
  private async spawnProgram(actorId: string, workspace: WorkspaceDefinition, cwd: string, command: string, args: string[],
    env: Record<string, string | undefined>, title: string, cols: number, rows: number): Promise<DebugTerminalProgram> {
    if (this.closed) throw new Error('核心服务正在关闭。');
    if (this.sessions.size + this.creating >= 12) throw new Error('请先关闭不用的终端。');
    this.creating++;
    try {
      const entry = [path.join(__dirname, 'terminalHost.cjs'), path.resolve(__dirname, '../../dist/terminalHost.cjs')].find(existsSync);
      if (!entry) throw new Error('安装内容缺少终端宿主，请修复安装。');
      this.application.workspace(actorId, workspace.id, ['process_execute']);
      cols = this.dimension(cols, 500); rows = this.dimension(rows, 200);
      const host = spawn(process.execPath, [entry], { windowsHide: true, cwd,
        env: { ...process.env, ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      const session: TerminalSession = { info: { id: randomUUID(), workspaceId: workspace.id, title,
        pid: 0, createdAt: Date.now(), cols, rows, status: 'running' }, host, output: '', offset: 0,
        closed: new Promise(resolve => host.once('close', () => resolve())) };
      let errorText = '';
      host.stderr?.on('data', bytes => { errorText = (errorText + bytes.toString()).slice(-8192); });
      const ready = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('终端宿主启动超时。')), 10_000);
        host.once('error', error => { clearTimeout(timer); reject(error); });
        host.once('exit', code => { clearTimeout(timer); if (!session.info.pid) reject(new Error(errorText || '终端宿主启动失败：' + code)); });
        host.on('message', (message: { type: string; pid?: number; data?: string; message?: string; exitCode?: number }) => {
          if (message.type === 'ready') { clearTimeout(timer); session.info.pid = message.pid!; resolve(); }
          if (message.type === 'data') {
            const data = message.data ?? ''; session.output = (session.output + data).slice(-256_000); session.offset += data.length;
            if (this.sessions.get(session.info.id) === session) this.application.publish({ type: 'terminal.data', id: session.info.id, data, offset: session.offset });
          }
          if (message.type === 'error') {
            errorText = message.message ?? '终端宿主运行失败。'; clearTimeout(timer); reject(new Error(errorText));
          }
          if (message.type === 'exit') session.info.exitCode = message.exitCode;
        });
      });
      host.once('exit', code => {
        session.info.status = 'exited'; session.info.exitCode ??= code ?? -1;
        if (this.sessions.get(session.info.id) !== session) return;
        if (errorText) { const data = '\r\n' + errorText + '\r\n'; session.output = (session.output + data).slice(-256_000); session.offset += data.length;
          this.application.publish({ type: 'terminal.data', id: session.info.id, data, offset: session.offset }); }
        this.application.publish({ type: 'terminal.exit', id: session.info.id, exitCode: session.info.exitCode }); this.changed();
      });
      host.send({ type: 'start', command, args, cwd, env, cols, rows });
      try { await ready; if (this.closed) throw new Error('核心服务正在关闭。'); }
      catch (error) { await stopOwnedProcess(host); throw error; }
      this.sessions.set(session.info.id, session); this.changed();
      return { info: this.snapshot(session.info.id), stop: () => this.stopSession(session) };
    } finally { this.creating--; }
  }
  input(id: string, data: string): void {
    if (typeof data !== 'string' || data.length > 1_000_000) throw new Error('终端输入无效或过长。');
    const session = this.get(id);
    if (session.info.status !== 'running') throw new Error('终端已经退出。');
    this.send(session, { type: 'input', data });
  }
  resize(id: string, cols: number, rows: number): void {
    const session = this.get(id); if (session.info.status !== 'running') return;
    cols = this.dimension(cols, 500); rows = this.dimension(rows, 200);
    if (session.info.cols === cols && session.info.rows === rows) return;
    this.send(session, { type: 'resize', cols, rows }); session.info.cols = cols; session.info.rows = rows;
  }
  private send(session: TerminalSession, message: Record<string, unknown>) {
    if (!session.host.connected) throw new Error('终端已经退出。');
    session.host.send(message, error => {
      if (error && session.info.status === 'running') this.application.publish({ type: 'notification', severity: 'warning', message: '终端通信失败：' + String(error) });
    });
  }
  stop(id: string): Promise<void> { return this.stopSession(this.get(id)); }
  private stopSession(session: TerminalSession): Promise<void> {
    if (session.stopping) return session.stopping;
    session.stopping = (async () => {
      if (session.host.connected) this.send(session, { type: 'stop' });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const graceful = await Promise.race([session.closed.then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 3000); })]);
      clearTimeout(timer);
      if (!graceful) await stopOwnedProcess(session.host);
    })();
    return session.stopping;
  }
  async remove(id: string): Promise<void> {
    const session = this.get(id); await this.stopSession(session); this.sessions.delete(id); this.changed();
  }
  private dimension(value: number, max: number) {
    if (!Number.isFinite(value)) throw new Error('终端尺寸必须是有效数字。');
    return Math.max(2, Math.min(max, Math.floor(value)));
  }
  private get(id: string) {
    const session = this.sessions.get(id); if (!session) throw new Error('终端已经关闭。'); return session;
  }
  private changed() { this.application.publish({ type: 'terminal.changed' }); }
  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.sessions.values()].map(session => this.stopSession(session)));
    this.sessions.clear();
  }
}
