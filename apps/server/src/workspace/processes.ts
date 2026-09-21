import { executableEffects } from './commandRisk';
import { randomUUID } from "node:crypto";
import { spawn as nativeSpawn, type ChildProcess } from "node:child_process";
import crossSpawn from "cross-spawn";
import type { ToolEffect, WorkspaceDefinition } from "@graycode/contracts";
import type { PlatformStorage } from '@graycode/core';
import { stopOwnedProcess } from './processLifecycle';

export interface ProcessResult {
  id: string;
  output: string;
  truncated: boolean;
  exitCode: number | null;
  running: boolean;
}
interface ManagedProcess {
  id: string;
  ownerId: string;
  child?: ChildProcess;
  output: string;
  truncated: boolean;
  exitCode: number | null;
  running: boolean;
  done: Promise<void>;
}
const spawn: typeof nativeSpawn = crossSpawn;

/** 按命令内容生成审批分类，不因使用 Shell 就统一判为高风险。 */
export function commandEffects(args: Record<string, unknown>): ToolEffect[] {
  return executableEffects(String(args.command), args.args as string[]);
}
export class WorkspaceProcesses {
  private readonly entries = new Map<string, ManagedProcess>();
  private closing = false;
  constructor(private readonly storage: Pick<PlatformStorage, 'putRecord' | 'getRecord'>) {}
  async start(
    workspace: WorkspaceDefinition,
    ownerId: string,
    command: string,
    args: string[],
    onOutput?: (text: string) => void,
  ): Promise<ProcessResult> {
    if (this.closing) throw new Error('宿主正在关闭，不能启动新命令。');
    if (
      !command ||
      !Array.isArray(args) ||
      args.some((arg) => typeof arg !== "string" || arg.includes("\0"))
    )
      throw new Error("Use an executable and an array of arguments.");
    if (
      [...this.entries.values()].filter((entry) => entry.running).length >= 24
    )
      throw new Error("Too many managed processes are already running.");
    const child = spawn(command, args, {
      cwd: workspace.directory,
      shell: false,
      windowsHide: true,
      env: { ...process.env, FORCE_COLOR: "0" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let finish!: () => void;
    let fail!: (error: unknown) => void;
    const entry: ManagedProcess = {
      id: randomUUID(),
      ownerId,
      child,
      output: "",
      truncated: false,
      exitCode: null,
      running: true,
      done: new Promise((resolve, reject) => {
        finish = resolve;
        fail = reject;
      }),
    };
    this.entries.set(entry.id, entry);
    const output = (chunk: Buffer | string) => {
      const text = chunk.toString();
      entry.output += text;
      if (entry.output.length > 256_000) {
        entry.output = entry.output.slice(-256_000);
        entry.truncated = true;
      }
      onOutput?.(text);
    };
    child.stdout!.on("data", output);
    child.stderr!.on("data", output);
    const onError = (error: Error) => {
      output(error.message);
      entry.exitCode = -1;
    };
    child.once("error", onError);
    child.once("close", (code) => {
      entry.exitCode = code ?? entry.exitCode;
      entry.running = false;
      child.stdout?.off('data', output);
      child.stderr?.off('data', output);
      child.off('error', onError);
      entry.child = undefined;
      // 完成结果进入现有存储，释放活动进程及输出回调；历史查询不再占用常驻内存。
      void this.storage.putRecord({ namespace: 'workspace-processes', id: entry.id,
        ownerId, value: { ...this.result(entry), ownerId } }).then(() => {
        this.entries.delete(entry.id);
        finish();
      }, fail);
    });
    void entry.done.catch(error => console.error('命令结果保存失败：', entry.id, error));
    let timer: ReturnType<typeof setTimeout>;
    try {
      await Promise.race([entry.done, new Promise(resolve => { timer = setTimeout(resolve, 300); timer.unref(); })]);
    } finally { clearTimeout(timer!); }
    return this.result(entry);
  }
  private result(entry: ManagedProcess): ProcessResult {
    return {
      id: entry.id,
      output: entry.output,
      truncated: entry.truncated,
      exitCode: entry.exitCode,
      running: entry.running,
    };
  }
  private get(id: string, ownerId: string): ManagedProcess {
    const entry = this.entries.get(id);
    if (!entry || entry.ownerId !== ownerId)
      throw new Error(
        "Managed process is not accessible to this task or client.",
      );
    return entry;
  }
  async read(id: string, ownerId: string): Promise<ProcessResult> {
    const active = this.entries.get(id);
    if (active) {
      const entry = this.get(id, ownerId);
      if (!entry.running) await entry.done;
      return this.result(entry);
    }
    const record = await this.storage.getRecord('workspace-processes', id) as (ProcessResult & { ownerId: string }) | null;
    if (!record || record.ownerId !== ownerId) throw new Error('Managed process is not accessible to this task or client.');
    const { ownerId: _ownerId, ...result } = record;
    return result;
  }
  input(id: string, ownerId: string, text: string): void {
    const entry = this.get(id, ownerId);
    if (!entry.running || !entry.child) throw new Error('命令已经退出。');
    entry.child.stdin!.write(text);
  }
  async stop(id: string, ownerId: string): Promise<void> {
    if (!this.entries.has(id)) { await this.read(id, ownerId); return; }
    const entry = this.get(id, ownerId);
    if (entry.child) await stopOwnedProcess(entry.child);
    await entry.done;
  }
  async close(): Promise<void> {
    this.closing = true;
    await Promise.allSettled(
      [...this.entries.values()].map((entry) =>
        this.stop(entry.id, entry.ownerId),
      ),
    );
  }
}
