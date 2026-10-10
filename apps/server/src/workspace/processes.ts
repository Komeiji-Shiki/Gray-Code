import { executableEffects } from './commandRisk';
import { randomUUID } from "node:crypto";
import { spawn as nativeSpawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from 'node:string_decoder';
import crossSpawn from "cross-spawn";
import type { ToolEffect, WorkspaceDefinition } from "@graycode/contracts";
import type { PlatformStorage } from '@graycode/core';
import { stopOwnedProcess } from './processLifecycle';
import { AnsiStreamStripper } from '../../../../shared/ansi';

/** 字符串始终代表 RPC 客户端；模型身份只能来自可信 ToolContext，不能来自模型参数。 */
export type ProcessOwner = string | { actorId: string; conversationId?: string; runId: string; workspaceId?: string };
export interface ProcessReadOptions { cursor?: number; maxChars?: number }
export class ProcessSessionError extends Error {
  constructor(readonly code: 'NOT_FOUND' | 'FORBIDDEN' | 'EXITED' | 'INPUT_CLOSED' | 'INVALID_CURSOR', message: string) {
    super(message);
    this.name = 'ProcessSessionError';
  }
}
export interface ProcessResult {
  id: string;
  output: string;
  /** 本次 output 的 UTF-16 绝对起点；nextCursor 是本次输出末尾，不是字节或行号。 */
  outputOffset: number;
  nextCursor: number;
  hasMore: boolean;
  outputLost: boolean;
  truncated: boolean;
  exitCode: number | null;
  running: boolean;
}
type ProcessOutput = Pick<ProcessResult, 'id' | 'output' | 'outputOffset' | 'truncated' | 'exitCode' | 'running'>;
interface ManagedProcess extends ProcessOutput {
  owner: ProcessOwner;
  child?: ChildProcess;
  inputError?: Error;
  done: Promise<void>;
}
type SavedProcess = Omit<ProcessOutput, 'outputOffset'> & { outputOffset?: number; ownerId: string; owner?: ProcessOwner };
const spawn: typeof nativeSpawn = crossSpawn;
const outputLimit = 256_000;
export type ProcessOutputBuffer = Pick<ProcessResult, 'output' | 'outputOffset' | 'truncated'>;
export function appendProcessOutput(entry: ProcessOutputBuffer, text: string): void {
  entry.output += text;
  if (entry.output.length > outputLimit) {
    entry.outputOffset += entry.output.length - outputLimit;
    entry.output = entry.output.slice(-outputLimit);
    entry.truncated = true;
  }
}
export function readProcessOutput(entry: ProcessOutputBuffer, options: ProcessReadOptions = {}) {
  const end = entry.outputOffset + entry.output.length;
  if (options.cursor !== undefined && (!Number.isSafeInteger(options.cursor) || options.cursor < 0 || options.cursor > end))
    throw new ProcessSessionError('INVALID_CURSOR', 'cursor must be a non-negative UTF-16 integer no later than nextCursor.');
  if (options.maxChars !== undefined && (!Number.isSafeInteger(options.maxChars) || options.maxChars < 1 || options.maxChars > outputLimit))
    throw new ProcessSessionError('INVALID_CURSOR', `maxChars must be an integer between 1 and ${outputLimit}.`);
  const cursor = options.cursor ?? entry.outputOffset;
  const offset = Math.max(cursor, entry.outputOffset);
  const output = entry.output.slice(offset - entry.outputOffset, offset - entry.outputOffset + (options.maxChars ?? outputLimit));
  const nextCursor = offset + output.length;
  return { output, outputOffset: offset, nextCursor, hasMore: nextCursor < end, outputLost: cursor < entry.outputOffset, truncated: entry.truncated };
}

/** 按命令内容生成审批分类，不因使用 Shell 就统一判为高风险。 */
export function commandEffects(args: Record<string, unknown>): ToolEffect[] {
  return executableEffects(String(args.command), args.args as string[]);
}
export class WorkspaceProcesses {
  private readonly entries = new Map<string, ManagedProcess>();
  private closing = false;
  constructor(private readonly storage: Pick<PlatformStorage, 'putRecord' | 'getRecord' | 'getRun'>, private readonly changed?: () => void) {}
  get activeCount(): number { return [...this.entries.values()].filter(entry => entry.running).length; }
  activeConversationIds(): Set<string> {
    return new Set([...this.entries.values()].flatMap(entry => entry.running && typeof entry.owner !== 'string' && entry.owner.conversationId ? [entry.owner.conversationId] : []));
  }
  async start(
    workspace: WorkspaceDefinition,
    owner: ProcessOwner,
    command: string,
    args: string[],
    onOutput?: (text: string) => void,
    options: { cwd?: string } = {},
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
    // cwd 已由工具入口按工作区及符号链接授权；RPC 不传此选项，仍从原工作区启动。
    const child = spawn(command, args, {
      cwd: options.cwd ?? workspace.directory,
      shell: false,
      windowsHide: true,
      env: { ...process.env, FORCE_COLOR: "0" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let finish!: () => void;
    let fail!: (error: unknown) => void;
    const entry: ManagedProcess = {
      id: randomUUID(),
      owner: typeof owner === 'string' ? owner : { ...owner },
      child,
      output: "",
      outputOffset: 0,
      truncated: false,
      exitCode: null,
      running: true,
      done: new Promise((resolve, reject) => {
        finish = resolve;
        fail = reject;
      }),
    };
    this.entries.set(entry.id, entry);
    // 会话缓冲会交给模型，去掉颜色序列；界面进度仍收到原文。
    const output = (text: string, stripper: AnsiStreamStripper) => {
      if (!text) return;
      const plain = stripper.push(text);
      if (plain) appendProcessOutput(entry, plain);
      onOutput?.(text);
    };
    // 两条管道可能交错且都拆开 UTF-8 多字节字符，必须独立解码，不能逐块 toString。
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    const stdoutAnsi = new AnsiStreamStripper(), stderrAnsi = new AnsiStreamStripper();
    const stdout = (chunk: Buffer | string) => output(typeof chunk === 'string' ? chunk : stdoutDecoder.write(chunk), stdoutAnsi);
    const stderr = (chunk: Buffer | string) => output(typeof chunk === 'string' ? chunk : stderrDecoder.write(chunk), stderrAnsi);
    child.stdout!.on("data", stdout);
    child.stderr!.on("data", stderr);
    // 子进程可在继续运行时关闭 stdin；Writable 的 error 不会转发到 ChildProcess。
    const onInputError = (error: Error) => { entry.inputError = error; };
    child.stdin!.on('error', onInputError);
    const onError = (error: Error) => {
      output(error.message, stderrAnsi);
      entry.exitCode = -1;
    };
    child.once("error", onError);
    child.once("close", (code) => {
      output(stdoutDecoder.end(), stdoutAnsi);
      output(stderrDecoder.end(), stderrAnsi);
      for (const rest of [stdoutAnsi.flush(), stderrAnsi.flush()]) if (rest) appendProcessOutput(entry, rest);
      entry.exitCode = code ?? entry.exitCode;
      entry.running = false;
      child.stdout?.off('data', stdout);
      child.stderr?.off('data', stderr);
      child.stdin?.off('error', onInputError);
      child.off('error', onError);
      entry.child = undefined;
      void this.persistCompleted(entry).then(finish, fail);
      this.changed?.();
    });
    void entry.done.catch(error => console.error('命令结果保存失败：', entry.id, error));
    // 只发布运行状态边界，输出分块继续走原来的 progress 通道。
    this.changed?.();
    let timer: ReturnType<typeof setTimeout>;
    try {
      await Promise.race([entry.done, new Promise(resolve => { timer = setTimeout(resolve, 300); timer.unref(); })]);
    } finally { clearTimeout(timer!); }
    return this.result(entry);
  }
  private async persistCompleted(entry: ManagedProcess): Promise<void> {
    // ownerId 保留旧索引用途，owner 的类型继续隔离 RPC 客户端与模型运行身份。
    const ownerId = typeof entry.owner === 'string' ? entry.owner : entry.owner.runId;
    await this.storage.putRecord({ namespace: 'workspace-processes', id: entry.id,
      ownerId, value: { ...this.result(entry), ownerId, owner: entry.owner } });
    this.entries.delete(entry.id);
  }
  private result(entry: ProcessOutput, options: ProcessReadOptions = {}): ProcessResult {
    return { ...readProcessOutput(entry, options), id: entry.id, exitCode: entry.exitCode, running: entry.running };
  }
  private sameModelOwner(saved: Exclude<ProcessOwner, string>, owner: Exclude<ProcessOwner, string>): boolean {
    // 同一对话继续运行会换 runId；无对话上下文时收紧到原 run，不能退化成账号级共享。
    return saved.actorId === owner.actorId && saved.workspaceId === owner.workspaceId &&
      (saved.conversationId && owner.conversationId ? saved.conversationId === owner.conversationId : saved.runId === owner.runId);
  }
  private async authorize(saved: ProcessOwner | undefined, owner: ProcessOwner, legacyOwnerId?: string): Promise<void> {
    let allowed = false;
    if (typeof owner === 'string') {
      allowed = typeof saved === 'string' ? saved === owner : saved === undefined && legacyOwnerId === owner;
    } else if (saved !== undefined) {
      allowed = typeof saved !== 'string' && this.sameModelOwner(saved, owner);
    } else if (legacyOwnerId) {
      // 旧 value 只有 runId，必须查可信运行记录核验全部边界；查不到时不猜测身份。
      const run = await this.storage.getRun(legacyOwnerId);
      allowed = !!run && run.id === legacyOwnerId && this.sameModelOwner({ actorId: run.actorId,
        conversationId: run.conversationId, workspaceId: run.workspaceId, runId: run.id }, owner);
    }
    if (!allowed) throw new ProcessSessionError('FORBIDDEN', 'Managed process belongs to another client, account, conversation or workspace.');
  }
  private async get(id: string, owner: ProcessOwner): Promise<ManagedProcess | ProcessOutput> {
    const active = this.entries.get(id);
    if (active) {
      await this.authorize(active.owner, owner);
      return active;
    }
    const record = await this.storage.getRecord('workspace-processes', id) as SavedProcess | null;
    if (!record) throw new ProcessSessionError('NOT_FOUND', 'Managed process was not found. Use the id returned by run_command, not an execute_command taskId.');
    await this.authorize(record.owner, owner, record.ownerId);
    // 旧记录未存绝对偏移，无法推断截断前长度；以现存输出为 0 起点，不伪造丢失数量。
    return { ...record, outputOffset: record.outputOffset ?? 0 };
  }
  async read(id: string, owner: ProcessOwner, options: ProcessReadOptions = {}): Promise<ProcessResult> {
    const entry = await this.get(id, owner);
    if ('done' in entry && !entry.running) await entry.done;
    return this.result(entry, options);
  }
  async input(id: string, owner: ProcessOwner, text: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const entry = await this.get(id, owner);
    signal?.throwIfAborted();
    // 完成记录先授权再报告退出；不能把本任务已完成的命令误报为不存在或无权限。
    if (!entry.running || !('child' in entry) || !entry.child || entry.child.exitCode !== null || entry.child.signalCode !== null)
      throw new ProcessSessionError('EXITED', '命令已经退出，不能再发送输入。');
    const input = entry.child.stdin;
    if (entry.inputError || !input || input.destroyed || input.writableEnded || !input.writable)
      throw new ProcessSessionError('INPUT_CLOSED', '命令输入管道已关闭，进程输出仍可读取。');
    // 等待实际写入回调，避免提前报告成功；检查之后关闭管道的竞态也必须回到工具回执。
    let abort: (() => void) | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        // 子进程可能一直不读取 stdin；取消只结束本次等待，已提交的输入不能撤回。
        abort = () => reject(signal!.reason);
        signal?.addEventListener('abort', abort, { once: true });
        input.write(text, error => error
          ? reject(new ProcessSessionError('INPUT_CLOSED', `命令输入写入失败：${error.message}`))
          : resolve());
      });
    } finally {
      if (abort) signal?.removeEventListener('abort', abort);
    }
  }
  async stop(id: string, owner: ProcessOwner): Promise<void> {
    const entry = await this.get(id, owner);
    // 只停止仍持有的 ChildProcess；历史记录不按持久化 PID 杀进程，避免 PID 重用误伤。
    if ('child' in entry && entry.child) await stopOwnedProcess(entry.child);
    if ('done' in entry) {
      const done = entry.done;
      try { await done; }
      catch (error) {
        if (entry.running) throw error;
        // 已退出进程只需重试提交同一份终态记录；并发关闭复用更新后的保存 Promise。
        if (entry.done === done) entry.done = this.persistCompleted(entry);
        await entry.done;
      }
    }
  }
  async close(): Promise<void> {
    this.closing = true;
    const results = await Promise.allSettled(
      [...this.entries.values()].map((entry) =>
        this.stop(entry.id, entry.owner),
      ),
    );
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map(result => result.reason),
      `受管进程关闭失败：${failures.map(result => String(result.reason)).join('；')}`);
  }
}
