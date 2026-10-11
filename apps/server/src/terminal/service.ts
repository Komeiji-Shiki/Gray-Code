import { executableEffects, shellCommandEffects } from '../workspace/commandRisk';
import { randomUUID } from 'node:crypto';
import type { RuntimeTool, ToolContext } from '@graycode/core';
import type { ToolDeclaration, ToolOutcome } from '@graycode/contracts';
import type { TaskEvent } from '../../../../backend/tools/taskManager';
import { createTerminalRuntime } from '../../../../backend/tools/terminal/processRunnerRuntime';
import { createShellRuntime } from '../../../../backend/tools/terminal/shellConfigRuntime';
import { createOutputRuntime } from '../../../../backend/tools/terminal/outputDecoderRuntime';
import { createTerminalPrompts } from '../../../../backend/tools/terminal/promptDescriptionsRuntime';
import { windowsProcessTreePort } from '../../../../backend/tools/terminal/processTree';
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { computerHostExecutable } from '../computer/native';
import { getDefaultExecuteCommandConfig, type ExecuteCommandToolConfig } from '../../../../backend/modules/settings/types/toolsTypes';
import type { PlatformApplication } from '../application';
import { mergedOperationEnabled } from '../settings/agent';
import { TerminalTaskPort } from './tasks';
import { TerminalOutputBuffer } from './output';
import { appendProcessOutput, readProcessOutput, ProcessSessionError, type ProcessOutputBuffer } from '../../../../shared/processOutput';
import { getActualLanguage, t } from '../../../../backend/i18n';
import { AnsiStreamStripper } from '../../../../shared/ansi';

interface TerminalRecord {
  id: string;
  actorId: string;
  conversationId: string;
  runId: string;
  workspaceId: string;
  status: 'queued' | 'running' | 'completed' | 'cancelled' | 'error' | 'interrupted';
  startTime: number;
  updatedAt: number;
  data: Record<string, unknown>;
  outputBuffer?: ProcessOutputBuffer;
  /** 原生异步只保存原调用关联，进程仍由已有终端任务持有。 */
  nativeCallId?: string;
}
type Runner = ReturnType<typeof createTerminalRuntime>;
interface ActiveTerminal {
  record: TerminalRecord;
  runner: Runner;
  events: Promise<void>;
  outputSave?: ReturnType<typeof setTimeout>;
}

/** 独立宿主保存任务归属和终态；Shell 与进程处理复用原运行器。 */
export class PlatformTerminals {
  private readonly active = new Map<string, ActiveTerminal>();
  private closing = false;
  constructor(
    private readonly app: PlatformApplication,
    private readonly processTree = windowsProcessTreePort(
      process.platform === 'win32' && existsSync(computerHostExecutable) ? computerHostExecutable : undefined,
    ),
  ) {}

  private runtime(config: ExecuteCommandToolConfig, tasks: TerminalTaskPort, directory?: string): Runner {
    const getConfig = () => config;
    const nativeShells = createShellRuntime({ getConfig });
    // 目录声明只取配置，不因临时探测结果改变前缀；真正执行前仍检查所选 Shell。
    const shells = {
      ...nativeShells,
      getEnabledShellTypesForEnum: () => ['default', ...config.shells.filter((shell) => shell.enabled).map((shell) => shell.type)],
    };
    const output = createOutputRuntime({ getConfig });
    const prompts = createTerminalPrompts({ shells, getMaxOutputLines: output.getMaxOutputLines, roots: () => [], workspaceBinding: 'task' });
    const workspace = directory ? { name: 'workspace', fsPath: directory } : undefined;
    return createTerminalRuntime({
      getConfig,
      tasks,
      shells,
      output,
      prompts,
      // Windows 上追踪后代链，中断时连父进程已退出的后代一并终止并核实。
      ...(process.platform === 'win32' ? { processTree: this.processTree } : {}),
      getAllWorkspaces: () => (workspace ? [workspace] : []),
      parseWorkspacePath: (value) => ({ workspace, relativePath: value }),
    });
  }

  tool(config = getDefaultExecuteCommandConfig()): RuntimeTool {
    const declaration = this.runtime(config, new TerminalTaskPort(() => {})).createExecuteCommandTool().declaration;
    const isZh = getActualLanguage() === 'zh-CN';
    declaration.description +=
      isZh
        ? '\n返回的 taskId 交给 terminal_task 查询、续读、输入或停止。background=true 的任务有完成通知；普通 argv 会话按需读取。'
        : '\nUse terminal_task with the returned taskId to inspect, read, send input or stop. background=true tasks send completion notices; read ordinary argv sessions when needed.';
    return {
      declaration: declaration as ToolDeclaration,
      approvalName: (args) => (args.mode === 'argv' ? 'run_command' : 'execute_command'),
      nativeAsync: true,
      nativeAsyncDescription: isZh
        ? '原生异步模式下，background=true 在原调用返回最终输出。常驻服务或交互进程使用 mode=argv 并省略 background，最多等待 300 毫秒后返回可管理的 taskId。'
        : 'In native async mode, background=true returns the final output on the original call. For persistent servers or interactive processes, use mode=argv without background: the call returns a managed taskId after up to 300 ms.',
      nativeAsyncParameterDescriptions: {
        background: isZh
          ? '当前生成取消后继续执行，并忽略前台超时。原生异步调用等到进程退出后在原调用返回最终输出，不另发后台消息。先继续独立工作，需要结果时使用 wait_for_tasks。'
          : 'Keep the command running if the current generation is cancelled; ignore the foreground timeout. The native async call stays pending until exit and returns the final output on its original call, without a separate background message. Continue independent work; use wait_for_tasks when its result is needed.',
      },
      effects: (args) =>
        args.mode === 'argv' ? executableEffects(String(args.command), (args.args ?? []) as string[]) : shellCommandEffects(String(args.command)),
      execute: (args, context) => this.execute(args, context, declaration, structuredClone(config)),
    };
  }

  private async execute(
    args: Record<string, unknown>,
    context: ToolContext,
    declaration: Parameters<Runner['createExecuteCommandTool']>[0],
    config: ExecuteCommandToolConfig,
  ) {
    if (this.closing) throw new Error('宿主正在关闭，不能启动新命令。');
    if (args.mode === 'argv' && !mergedOperationEnabled(this.app.product.runtimeSettings(), 'execute_command', 'run_command')) {
      throw new Error('argv 命令已被原 run_command 工具设置关闭；请在工具设置中启用 execute_command。');
    }
    if (!context.workspace || !context.conversationId) throw new Error('请先为任务选择工作区。');
    context.signal.throwIfAborted();
    const argv = args.mode === 'argv';
    // 工作目录属于本轮绑定的工作区，之后切换界面工作区不影响当前命令。
    const requestedCwd = String(args.cwd ?? '');
    const cwd = await this.app.files.resolve(
      context.workspace,
      requestedCwd === '' || (argv && requestedCwd === '.') ? context.workspace.directory : requestedCwd,
    );
    if (!(await stat(cwd)).isDirectory()) throw new Error('cwd must be a directory within the workspace.');
    context.signal.throwIfAborted();
    if (this.closing) throw new Error('宿主正在关闭，不能启动新命令。');
    if (argv && [...this.active.values()].filter((task) => task.record.data.mode === 'argv').length >= 24) {
      throw new Error('Too many managed processes are already running.');
    }
    const id = `terminal-${randomUUID()}`;
    const record: TerminalRecord = {
      id,
      actorId: context.actorId,
      conversationId: context.conversationId,
      runId: context.runId,
      workspaceId: context.workspace.id,
      status: 'queued',
      startTime: Date.now(),
      updatedAt: Date.now(),
      data: {
        command: args.command,
        mode: argv ? 'argv' : 'shell',
        ...(argv ? { args: args.args } : { shell: args.shell ?? 'default' }),
        cwd,
        background: args.background === true,
      },
      outputBuffer: { output: '', outputOffset: 0, truncated: false },
    };
    if (context.nativeAsync && args.background === true && context.toolCallId) record.nativeCallId = context.toolCallId;
    let task!: ActiveTerminal;
    const tasks = new TerminalTaskPort((event) => this.queue(task, event));
    const runner = this.runtime(config, tasks, context.workspace.directory);
    // terminal_task read 把缓冲交给模型，去掉颜色序列；stdout/stderr 各自保留未完成的序列尾部。
    const strippers = { output: new AnsiStreamStripper(), error: new AnsiStreamStripper() };
    const output = new TerminalOutputBuffer((event) => {
      this.app.publish({
        type: 'ui.message',
        message: {
          type: 'command',
          command: 'terminalOutput',
          data: { ...event, toolId: context.toolCallId, conversationId: context.conversationId },
        },
      });
      if (event.data) context.progress({ terminalId: id, text: event.data });
    });
    const unsubscribe = runner.onTerminalOutput((event) => {
      if (event.data && (event.type === 'output' || event.type === 'error')) {
        const text = strippers[event.type].push(event.data);
        if (text) appendProcessOutput(record.outputBuffer!, text);
        record.updatedAt = Date.now();
        const active = this.active.get(id);
        if (active && !active.outputSave) {
          active.outputSave = setTimeout(() => {
            active.outputSave = undefined;
            if (this.active.has(id)) this.queue(task, { taskId: id, taskType: 'terminal', type: 'progress', data: {} });
          }, 1000);
          active.outputSave.unref();
        }
      }
      if (event.type === 'exit')
        for (const stripper of Object.values(strippers)) {
          const rest = stripper.flush();
          if (rest) appendProcessOutput(record.outputBuffer!, rest);
        }
      output.push(event);
      // 后台任务的完成通知早于 exit，必须等输出终态送达后再释放监听。
      if (event.type === 'exit') unsubscribe();
    });
    task = { record, runner, events: Promise.resolve() };
    this.active.set(id, task);
    try {
      await this.save(record, true);
      context.signal.throwIfAborted();
      if (this.closing) throw new Error('宿主正在关闭，不能启动新命令。');
      const result = await runner
        .createExecuteCommandTool(declaration)
        .handler({ ...args, cwd }, { toolId: id, conversationId: context.conversationId, abortSignal: context.signal });
      await task.events;
      if (!result.data?.background && !result.data?.running && this.active.has(id)) {
        record.status = result.cancelled ? 'cancelled' : result.success ? 'completed' : 'error';
        record.data = { ...record.data, ...result.data, error: result.error };
        await this.finish(record);
      }
      const running = this.active.has(id) && ['queued', 'running'].includes(record.status);
      const nativeTaskHandle = record.nativeCallId && running ? context.nativeTaskHandle : undefined;
      const data = result.data
        ? this.withNextActions(
            {
              ...result.data,
              ...(argv ? { mode: 'argv', args: args.args, ...readProcessOutput(record.outputBuffer!) } : {}),
              taskId: id,
              status: record.status,
              running,
              ...(nativeTaskHandle ? { note: t('tools.terminal.nextActions.nativePending') } : {}),
            },
            nativeTaskHandle,
          )
        : undefined;
      return {
        success: result.success,
        data,
        error: result.error,
        ...(record.nativeCallId && result.data?.background ? { deferred: true } : {}),
        ...(result.cancelled ? { code: 'CANCELLED' } : {}),
        ...(argv && !result.success && !result.cancelled && typeof result.data?.exitCode === 'number' && result.data.exitCode !== 0
          ? { code: 'COMMAND_EXIT_NONZERO' }
          : {}),
      };
    } catch (error) {
      if (this.active.has(id)) {
        await runner.killTerminalProcess(id);
        record.status = context.signal.aborted ? 'cancelled' : 'error';
        record.data.error = error instanceof Error ? error.message : String(error);
        await this.finish(record);
      }
      throw error;
    } finally {
      if (!this.active.has(id)) {
        output.flush();
        unsubscribe();
      }
    }
  }

  private queue(task: ActiveTerminal, event: TaskEvent) {
    const { record } = task;
    // 同一任务保留事件顺序，后台通知的等待不能拖住其他终端的启动、读取或停止。
    task.events = task.events
      .catch(() => {})
      .then(async () => {
        if ((event.type === 'start' || event.type === 'progress') && !this.active.has(record.id)) return;
        record.data = { ...record.data, ...event.data };
        record.updatedAt = Date.now();
        if (event.type === 'start' || event.type === 'progress') {
          record.status = 'running';
          await this.save(record, true);
        } else {
          record.status = event.type === 'complete' ? 'completed' : event.type === 'cancelled' ? 'cancelled' : 'error';
          await this.finish(record);
        }
        this.app.publish({
          type: 'ui.message',
          message: {
            type: 'command',
            command: 'taskEvent',
            data: { ...event, data: { ...record.data, conversationId: record.conversationId, delivery: 'platform_history' } },
          },
        });
      });
    void task.events.catch((error) => {
      const message = `终端结果同步失败：${error instanceof Error ? error.message : String(error)}。请从输出卡片查看命令结果。`;
      record.data.deliveryError = message;
      this.app.publish({ type: 'notification', severity: 'error', message });
      this.app.publish({
        type: 'ui.message',
        message: {
          type: 'command',
          command: 'taskEvent',
          data: {
            taskId: record.id,
            taskType: 'terminal',
            type: 'error',
            error: message,
            data: { ...record.data, conversationId: record.conversationId, delivery: 'platform_history' },
          },
        },
      });
    });
  }
  private save(record: TerminalRecord, active: boolean) {
    return this.app.storage.commitRecords([
      { namespace: 'terminal-records', id: record.id, ownerId: record.conversationId, value: structuredClone(record) },
      active
        ? { namespace: 'terminal-active', id: record.id, ownerId: record.conversationId, value: { id: record.id } }
        : { namespace: 'terminal-active', id: record.id, delete: true },
    ]);
  }
  private async finish(record: TerminalRecord) {
    clearTimeout(this.active.get(record.id)?.outputSave);
    record.updatedAt = Date.now();
    // 先保存终态，重启时仍可补发尚未交付的后台结果。
    await this.save(record, true);
    await this.feedback(record);
    await this.save(record, false);
    this.active.delete(record.id);
  }
  private async feedback(record: TerminalRecord) {
    if (record.data.background !== true) return;
    if (record.nativeCallId) {
      await this.app.runtime.completeAsyncTool(record.runId, record.nativeCallId, this.nativeOutcome(record));
      return;
    }
    const root = this.app.subagents.rootConversationId(record.conversationId);
    const conversationId =
      root !== record.conversationId &&
      !(await this.app.storage.listRuns({ conversationId: record.conversationId, activeOnly: true, limit: 1 })).length
        ? root
        : record.conversationId;
    const text =
      `[Background task ${record.status}]\nCommand: ${String(record.data.command)}\n` +
      (record.data.exitCode !== undefined ? `Exit code: ${String(record.data.exitCode)}\n` : '') +
      (record.data.error ? `Error: ${String(record.data.error)}\n` : '') +
      `\n${String(record.data.output ?? '')}`;
    // 终态通知只补必要的诊断入口；已结束的命令不会重新建议等待。
    const nextActions = this.withNextActions({ ...record.data, taskId: record.id, status: record.status, running: false }).nextActions;
    await this.app.subagents.feedback.enqueueMessage({
      id: `terminal-result-${record.id}`,
      conversationId,
      actorId: record.actorId,
      sourceRunId: record.runId,
      message: {
        id: `terminal-result-${record.id}`,
        role: 'user',
        parts: [{ text: Array.isArray(nextActions) ? `${text}\n\nnextActions: ${JSON.stringify(nextActions)}` : text }],
        timestamp: Date.now(),
        isUserInput: false,
        source: 'background_task',
        backgroundTask: { kind: 'terminal', taskId: record.id, status: record.status },
        userFeedback: { kind: 'background_task', taskId: record.id },
      },
    });
  }
  private nativeOutcome(record: TerminalRecord): ToolOutcome {
    return {
      success: record.status === 'completed',
      ...(record.status === 'cancelled' ? { code: 'CANCELLED' } : record.status === 'interrupted' ? { code: 'INTERRUPTED' } : {}),
      ...(record.data.error ? { error: String(record.data.error) } : {}),
      data: this.withNextActions({
        ...record.data,
        taskId: record.id,
        status: record.status,
        running: false,
        output: record.data.output ?? record.outputBuffer?.output ?? '',
      }),
    };
  }
  async recoverNativeResult(runId: string, callId: string, conversationId: string): Promise<ToolOutcome | undefined> {
    for (const id of await this.app.storage.listRecords('terminal-records', conversationId)) {
      const record = (await this.app.storage.getRecord('terminal-records', id)) as TerminalRecord | null;
      if (record?.runId !== runId || record.nativeCallId !== callId) continue;
      if (['queued', 'running'].includes(record.status))
        return this.nativeOutcome({ ...record, status: 'interrupted', data: { ...record.data, error: '宿主已重启，原后台命令未自动重放。' } });
      return this.nativeOutcome(record);
    }
  }
  async initialize() {
    for (const id of await this.app.storage.listRecords('terminal-active')) {
      const record = (await this.app.storage.getRecord('terminal-records', id)) as TerminalRecord | null;
      if (!record) {
        await this.app.storage.deleteRecord('terminal-active', id);
        continue;
      }
      if (record.status === 'running' || record.status === 'queued') {
        record.status = 'interrupted';
        record.data.error = '宿主已经重启，原命令执行现场无法恢复，未自动重放命令。';
      }
      await this.finish(record);
    }
  }
  list() {
    return [...this.active.values()]
      .filter(({ record }) => record.status === 'queued' || record.status === 'running')
      .map(({ record }) => ({
        id: record.id,
        type: 'terminal',
        startTime: record.startTime,
        metadata: { ...record.data, conversationId: record.conversationId, runId: record.runId },
      }));
  }
  has(id: string) {
    return this.active.has(id);
  }
  private async accessible(actorId: string, id: string) {
    const record = this.active.get(id)?.record ?? ((await this.app.storage.getRecord('terminal-records', id)) as TerminalRecord | null);
    if (!record) throw new Error('终端任务不存在。');
    await this.app.conversation(actorId, record.conversationId);
    return record;
  }
  async output(actorId: string, id: string) {
    const record = await this.accessible(actorId, id);
    const live = record.data.mode === 'argv' ? undefined : this.active.get(id)?.runner.getTerminalOutput(id);
    return live?.success
      ? live
      : {
          success: true,
          output: String(record.data.mode === 'argv' ? (record.outputBuffer?.output ?? record.data.output ?? '') : (record.data.output ?? '')),
          running: this.active.has(id) && ['queued', 'running'].includes(record.status),
          exitCode: record.data.exitCode,
          killed: record.data.killed === true || record.status === 'cancelled',
          duration: record.data.duration,
          error: record.data.error,
        };
  }
  async kill(actorId: string, id: string) {
    await this.accessible(actorId, id);
    const task = this.active.get(id);
    const runner = task?.runner;
    let interruption: Record<string, unknown> | undefined;
    if (runner) {
      const result = await runner.killTerminalProcess(id, 'stopped');
      if (!result.success && this.active.has(id)) return result;
      interruption = result.interruption;
    }
    await task?.events;
    return { ...(await this.output(actorId, id)), ...(interruption ? { interruption } : {}) };
  }
  private taskSummary(record: TerminalRecord) {
    return {
      taskId: record.id,
      status: record.status,
      running: this.active.has(record.id) && ['queued', 'running'].includes(record.status),
      command: String(record.data.command ?? '').slice(0, 1000),
      ...(record.data.mode === 'argv' ? { mode: 'argv', args: record.data.args } : {}),
      background: record.data.background === true,
      startTime: record.startTime,
      updatedAt: record.updatedAt,
      exitCode: record.data.exitCode ?? null,
      error: record.data.error,
    };
  }
  private withNextActions(data: Record<string, unknown>, nativeTaskHandle?: string, outputRead = false) {
    const nextActions: Array<{ tool: string; args: Record<string, unknown>; when: string }> = [];
    const read = {
      tool: 'terminal_task',
      args: { action: 'read', taskId: data.taskId, cursor: typeof data.nextCursor === 'number' ? data.nextCursor : 0 },
    };
    // 原生调用等待用 task_handle，进程管理用 taskId；建议不改变任务归属或执行生命周期。
    if (data.running === true) {
      if (nativeTaskHandle)
        nextActions.push({ tool: 'wait_for_tasks', args: { task_handles: [nativeTaskHandle] }, when: t('tools.terminal.nextActions.nativeWait') });
      nextActions.push({
        tool: 'terminal_task',
        args: { action: 'status', taskId: data.taskId },
        when: t('tools.terminal.nextActions.terminalStatus'),
      });
      nextActions.push({
        ...read,
        when: t(data.hasMore === true ? 'tools.terminal.nextActions.terminalMoreOutput' : 'tools.terminal.nextActions.terminalIntermediateOutput'),
      });
    } else if (data.hasMore === true) {
      nextActions.push({ ...read, when: t('tools.terminal.nextActions.terminalExitedMoreOutput') });
    } else if (
      !outputRead &&
      (data.truncated === true ||
        !!data.truncatedNote ||
        (typeof data.output !== 'string' && (!!data.error || (typeof data.exitCode === 'number' && data.exitCode !== 0))))
    ) {
      nextActions.push({ ...read, when: t('tools.terminal.nextActions.terminalExitedInspect') });
    }
    return nextActions.length ? { ...data, nextActions } : data;
  }
  async manageTask(args: Record<string, unknown>, context: ToolContext) {
    if (args.action === 'input' && !mergedOperationEnabled(this.app.product.runtimeSettings(), 'terminal_task', 'process_session')) {
      throw new Error('终端输入已被原 process_session 工具设置关闭；请在工具设置中启用 terminal_task。');
    }
    if (!context.conversationId || !context.workspace) throw new Error('请先为当前会话选择工作区。');
    await this.app.conversation(context.actorId, context.conversationId);
    const run = await this.app.storage.getRun(context.runId);
    if (!run || run.actorId !== context.actorId || run.conversationId !== context.conversationId)
      throw new ProcessSessionError('FORBIDDEN', '终端管理需要有效的当前运行身份。');
    const owned = (record: TerminalRecord) =>
      record.actorId === context.actorId && record.conversationId === context.conversationId && record.workspaceId === context.workspace!.id;
    context.signal.throwIfAborted();
    if (args.action === 'list') {
      const offset = args.offset ?? 0,
        limit = args.limit ?? 20;
      if (!Number.isSafeInteger(offset) || Number(offset) < 0 || !Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 100)
        throw new Error('offset/limit 无效。');
      await Promise.all([...this.active.values()].filter((task) => owned(task.record)).map((task) => task.events));
      context.signal.throwIfAborted();
      const records: TerminalRecord[] = [];
      let afterId: string | undefined;
      for (;;) {
        context.signal.throwIfAborted();
        // 列表只需要归属和状态摘要，正文在 read 时读取；持久化分页不改变对模型的时间排序。
        const page = await this.app.storage.readRecordPage('terminal-records', context.conversationId, {
          afterId,
          limit: 200,
          projection: {
            fields: ['id', 'actorId', 'conversationId', 'runId', 'workspaceId', 'status', 'startTime', 'updatedAt', 'data'],
            properties: { data: { fields: ['command', 'mode', 'args', 'background', 'exitCode', 'error'] } },
          },
        });
        for (const saved of page) {
          const record = this.active.get(saved.id)?.record ?? (saved.value as TerminalRecord);
          if (record && owned(record)) records.push(record);
        }
        if (page.length < 200) break;
        afterId = page[page.length - 1].id;
      }
      records.sort((a, b) => b.startTime - a.startTime || a.id.localeCompare(b.id));
      const tasks = records.slice(Number(offset), Number(offset) + Number(limit)).map((record) => this.withNextActions(this.taskSummary(record)));
      const nextOffset = Number(offset) + tasks.length < records.length ? Number(offset) + tasks.length : undefined;
      return {
        success: true,
        data: {
          tasks,
          total: records.length,
          offset,
          nextOffset,
          ...(nextOffset !== undefined
            ? {
                nextActions: [
                  {
                    tool: 'terminal_task',
                    args: { action: 'list', offset: nextOffset, limit },
                    when: t('tools.terminal.nextActions.terminalNextPage'),
                  },
                ],
              }
            : {}),
        },
      };
    }
    if (typeof args.taskId !== 'string' || !args.taskId) throw new Error('需要 execute_command 返回的 taskId。');
    const task = this.active.get(args.taskId);
    const record = task?.record ?? ((await this.app.storage.getRecord('terminal-records', args.taskId)) as TerminalRecord | null);
    if (!record) {
      // 旧模型会话只持久化已完成结果，继续复用原归属校验读取，不重建进程或注册旧工具。
      const saved = await this.app.processes.read(
        args.taskId,
        { actorId: context.actorId, conversationId: context.conversationId, workspaceId: context.workspace.id, runId: context.runId },
        args.action === 'read' ? { cursor: args.cursor as number | undefined, maxChars: args.maxChars as number | undefined } : undefined,
      );
      if (args.action === 'input') throw new ProcessSessionError('EXITED', '命令已经退出，不能再发送输入。');
      const { id, ...output } = saved;
      const data = this.withNextActions(
        { ...output, taskId: id, mode: 'argv', status: saved.running ? 'running' : saved.exitCode === 0 ? 'completed' : 'error' },
        undefined,
        args.action === 'read',
      );
      return this.sessionOutcome(data, args.action === 'read');
    }
    if (!owned(record)) throw new ProcessSessionError('FORBIDDEN', '只能管理同一账号、会话和工作区的终端任务。');
    if (!['status', 'read', 'input', 'stop'].includes(String(args.action))) throw new Error('不支持的终端管理动作。');
    if (args.action === 'input') {
      if (typeof args.text !== 'string') throw new Error('Supply process input.');
      if (!task) throw new ProcessSessionError('EXITED', '命令已经退出，不能再发送输入。');
      await task.runner.inputTerminalProcess(record.id, args.text, context.signal);
    }
    if (args.action === 'stop') {
      context.signal.throwIfAborted();
      const stopped = await this.kill(context.actorId, record.id);
      if (!stopped.success)
        return {
          success: false,
          code: 'STOP_FAILED',
          error: String(stopped.error ?? '终端进程停止失败。'),
          data: this.withNextActions(this.taskSummary(record)),
        };
      // 停止结果说明子进程是否已清理，模型不必再用命令查进程。
      if ('interruption' in stopped && stopped.interruption)
        return { success: true, data: this.withNextActions({ ...this.taskSummary(record), interruption: stopped.interruption }) };
    } else {
      await task?.events;
      context.signal.throwIfAborted();
    }
    const summary = this.taskSummary(record);
    const data =
      args.action === 'read' || args.action === 'input'
        ? {
            ...summary,
            ...readProcessOutput(
              record.outputBuffer ?? {
                output: String(record.data.output ?? ''),
                outputOffset: 0,
                truncated: !!record.data.truncatedNote,
              },
              args.action === 'read'
                ? { cursor: args.cursor as number | undefined, maxChars: (args.maxChars ?? (record.data.mode === 'argv' ? 256000 : 12000)) as number }
                : { maxChars: record.data.mode === 'argv' ? 256000 : 12000 },
            ),
            cursorOriginKnown: !!record.outputBuffer,
          }
        : summary;
    return this.sessionOutcome(
      this.withNextActions(data, undefined, args.action === 'read'),
      record.data.mode === 'argv' && (args.action === 'read' || args.action === 'input'),
    );
  }
  private sessionOutcome(data: Record<string, unknown>, commandResult: boolean): ToolOutcome {
    // shell 的管理动作仍表示查询成功；argv 的续读沿用原会话工具的非零退出失败语义。
    if (commandResult && data.running === false && typeof data.exitCode === 'number' && data.exitCode !== 0) {
      return { success: false, code: 'COMMAND_EXIT_NONZERO', error: String(data.error || `Command exited with code ${data.exitCode}`), data };
    }
    if (commandResult && data.status === 'error' && data.error) {
      return { success: false, code: 'COMMAND_FAILED', error: String(data.error), data };
    }
    return { success: true, data };
  }
  async detach(actorId: string, conversationId: string) {
    await this.app.conversation(actorId, conversationId);
    const detached: string[] = [];
    const entries = [...this.active.values()].filter((task) => task.record.conversationId === conversationId);
    for (const { runner } of entries) detached.push(...runner.detachRunningTerminalsToBackground(conversationId).detached);
    await Promise.all(entries.map((task) => task.events));
    return { success: true, detached };
  }
  async removeConversation(conversationId: string) {
    const entries = [...this.active.values()].filter((task) => task.record.conversationId === conversationId);
    for (const { record, runner } of entries) await runner.killTerminalProcess(record.id, 'conversation_removed');
    await Promise.all(entries.map((task) => task.events));
  }
  async close() {
    this.closing = true;
    const entries = [...this.active.values()];
    const results = await Promise.allSettled(entries.map(({ record, runner }) => runner.killTerminalProcess(record.id, 'host_closing')));
    const events = await Promise.allSettled(entries.map((task) => task.events));
    const failures = [
      ...results.flatMap((result, index) =>
        result.status === 'rejected'
          ? [result.reason]
          : // runner 用结构化结果报告停止失败；终态事件可能已移除自然结束的任务，不能把它误报为失败。
            !result.value.success && this.active.has(entries[index].record.id)
            ? [new Error(result.value.error)]
            : [],
      ),
      ...events.flatMap((result) => (result.status === 'rejected' ? [result.reason] : [])),
    ];
    if (failures.length) throw new AggregateError(failures, `终端任务关闭失败：${failures.map(String).join('；')}`);
  }
}
