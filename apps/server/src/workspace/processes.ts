import { executableEffects } from './commandRisk';
import { randomUUID } from "node:crypto";
import { spawn as nativeSpawn, type ChildProcess } from "node:child_process";
import crossSpawn from "cross-spawn";
import type { ToolEffect, WorkspaceDefinition } from "@graycode/contracts";

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
  child: ChildProcess;
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
  async start(
    workspace: WorkspaceDefinition,
    ownerId: string,
    command: string,
    args: string[],
    onOutput?: (text: string) => void,
  ): Promise<ProcessResult> {
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
    const entry: ManagedProcess = {
      id: randomUUID(),
      ownerId,
      child,
      output: "",
      truncated: false,
      exitCode: null,
      running: true,
      done: new Promise((resolve) => {
        finish = resolve;
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
    child.once("error", (error) => {
      output(error.message);
      entry.exitCode = -1;
      entry.running = false;
      finish();
    });
    child.once("close", (code) => {
      entry.exitCode = code;
      entry.running = false;
      finish();
    });
    await Promise.race([
      entry.done,
      new Promise((resolve) => {
        const timer = setTimeout(resolve, 300);
        timer.unref();
      }),
    ]);
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
  read(id: string, ownerId: string): ProcessResult {
    return this.result(this.get(id, ownerId));
  }
  input(id: string, ownerId: string, text: string): void {
    this.get(id, ownerId).child.stdin!.write(text);
  }
  async stop(id: string, ownerId: string): Promise<void> {
    const entry = this.get(id, ownerId);
    if (!entry.running || !entry.child.pid) return;
    // Only a retained ChildProcess started here can be stopped; caller-supplied PIDs are never accepted.
    if (process.platform === "win32") {
      await new Promise<void>((resolve, reject) => {
        const kill = spawn(
          "taskkill",
          ["/pid", String(entry.child.pid), "/T", "/F"],
          { windowsHide: true, stdio: "ignore" },
        );
        kill.once("error", reject);
        kill.once("close", () => resolve());
      });
    } else entry.child.kill("SIGTERM");
    await entry.done;
  }
  async close(): Promise<void> {
    await Promise.allSettled(
      [...this.entries.values()].map((entry) =>
        this.stop(entry.id, entry.ownerId),
      ),
    );
  }
}
