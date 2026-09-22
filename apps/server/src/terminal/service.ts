import { shellCommandEffects } from '../workspace/commandRisk';
import { randomUUID } from 'node:crypto';
import type { RuntimeTool, ToolContext } from '@graycode/core';
import type { ToolDeclaration } from '@graycode/contracts';
import type { TaskEvent } from '../../../../backend/tools/taskManager';
import { createTerminalRuntime } from '../../../../backend/tools/terminal/processRunnerRuntime';
import { createShellRuntime } from '../../../../backend/tools/terminal/shellConfigRuntime';
import { createOutputRuntime } from '../../../../backend/tools/terminal/outputDecoderRuntime';
import { createTerminalPrompts } from '../../../../backend/tools/terminal/promptDescriptionsRuntime';
import { getDefaultExecuteCommandConfig, type ExecuteCommandToolConfig } from '../../../../backend/modules/settings/types/toolsTypes';
import type { PlatformApplication } from '../application';
import { TerminalTaskPort } from './tasks';

interface TerminalRecord {
  id: string; actorId: string; conversationId: string; runId: string; workspaceId: string;
  status: 'queued' | 'running' | 'completed' | 'cancelled' | 'error' | 'interrupted';
  startTime: number; updatedAt: number; data: Record<string, unknown>;
}
type Runner = ReturnType<typeof createTerminalRuntime>;

/** 独立宿主保存任务归属和终态；Shell 与进程处理复用原运行器。 */
export class PlatformTerminals {
  private readonly active = new Map<string, { record: TerminalRecord; runner: Runner }>();
  private events: Promise<void> = Promise.resolve();
  private closing = false;
  constructor(private readonly app: PlatformApplication) {}

  private runtime(config: ExecuteCommandToolConfig, tasks: TerminalTaskPort, directory?: string): Runner {
    const getConfig = () => config;
    const nativeShells = createShellRuntime({ getConfig });
    // 目录声明只取配置，不因临时探测结果改变前缀；真正执行前仍检查所选 Shell。
    const shells = { ...nativeShells,
      getEnabledShellTypesForEnum: () => ['default', ...config.shells.filter(shell => shell.enabled).map(shell => shell.type)],
      getAvailableShellsDescription: () => config.shells.filter(shell => shell.enabled)
        .map(shell => `- ${shell.displayName ?? shell.type} (${shell.type})`).join('\n'),
      getUnavailableShellsDescription: () => '- Availability is checked immediately before execution.',
    };
    const output = createOutputRuntime({ getConfig });
    const prompts = createTerminalPrompts({ shells, getMaxOutputLines: output.getMaxOutputLines, roots: () => [], workspaceBinding: 'task' });
    const workspace = directory ? { name: 'workspace', fsPath: directory } : undefined;
    return createTerminalRuntime({ getConfig, tasks, shells, output, prompts,
      getAllWorkspaces: () => workspace ? [workspace] : [],
      parseWorkspacePath: value => ({ workspace, relativePath: value }) });
  }

  tool(config = getDefaultExecuteCommandConfig()): RuntimeTool {
    const declaration = this.runtime(config, new TerminalTaskPort(() => {})).createExecuteCommandTool().declaration;
    return { declaration: declaration as ToolDeclaration,
      effects: args => shellCommandEffects(String(args.command)),
      execute: (args, context) => this.execute(args, context, declaration, structuredClone(config)) };
  }

  private async execute(args: Record<string, unknown>, context: ToolContext,
    declaration: Parameters<Runner['createExecuteCommandTool']>[0], config: ExecuteCommandToolConfig) {
    if (this.closing) throw new Error('宿主正在关闭，不能启动新命令。');
    if (!context.workspace || !context.conversationId) throw new Error('请先为任务选择工作区。');
    context.signal.throwIfAborted();
    // 工作目录属于本轮绑定的工作区，之后切换界面工作区不影响当前命令。
    const cwd = await this.app.files.resolve(context.workspace, String(args.cwd || context.workspace.directory));
    if (this.closing) throw new Error('宿主正在关闭，不能启动新命令。');
    const id = `terminal-${randomUUID()}`;
    const record: TerminalRecord = { id, actorId: context.actorId, conversationId: context.conversationId,
      runId: context.runId, workspaceId: context.workspace.id, status: 'queued', startTime: Date.now(), updatedAt: Date.now(),
      data: { command: args.command, cwd, shell: args.shell ?? 'default', background: args.background === true } };
    const tasks = new TerminalTaskPort(event => this.queue(record, event));
    const runner = this.runtime(config, tasks, context.workspace.directory);
    const unsubscribe = runner.onTerminalOutput(event => {
      this.app.publish({ type: 'ui.message', message: { type: 'command', command: 'terminalOutput', data: event } });
      if (event.data) context.progress({ terminalId: id, text: event.data });
    });
    this.active.set(id, { record, runner });
    try {
      await this.save(record, true);
      context.signal.throwIfAborted();
      if (this.closing) throw new Error('宿主正在关闭，不能启动新命令。');
      const result = await runner.createExecuteCommandTool(declaration).handler({ ...args, cwd },
        { toolId: id, conversationId: context.conversationId, abortSignal: context.signal });
      await this.events;
      if (!result.data?.background && this.active.has(id)) {
        record.status = result.cancelled ? 'cancelled' : result.success ? 'completed' : 'error';
        record.data = { ...record.data, ...result.data, error: result.error };
        await this.finish(record);
      }
      return { success: result.success, data: result.data, error: result.error,
        ...(result.cancelled ? { code: 'CANCELLED' } : {}) };
    } catch (error) {
      if (this.active.has(id)) {
        await runner.killTerminalProcess(id);
        record.status = context.signal.aborted ? 'cancelled' : 'error';
        record.data.error = error instanceof Error ? error.message : String(error);
        await this.finish(record);
      }
      throw error;
    } finally {
      if (!this.active.has(id)) unsubscribe();
      else tasks.onTaskEventByType('terminal', event => { if (event.type !== 'start' && event.type !== 'progress') unsubscribe(); });
    }
  }

  private queue(record: TerminalRecord, event: TaskEvent) {
    this.events = this.events.catch(() => {}).then(async () => {
      record.data = { ...record.data, ...event.data };
      record.updatedAt = Date.now();
      if (event.type === 'start' || event.type === 'progress') {
        record.status = 'running'; await this.save(record, true);
      } else {
        record.status = event.type === 'complete' ? 'completed' : event.type === 'cancelled' ? 'cancelled' : 'error';
        await this.finish(record);
      }
      this.app.publish({ type: 'ui.message', message: { type: 'command', command: 'taskEvent',
        data: { ...event, data: { ...record.data, conversationId: record.conversationId, delivery: 'platform_history' } } } });
    });
    void this.events.catch(error => {
      const message = `终端结果同步失败：${error instanceof Error ? error.message : String(error)}。请从输出卡片查看命令结果。`;
      record.data.deliveryError = message;
      this.app.publish({ type: 'notification', severity: 'error', message });
      this.app.publish({ type: 'ui.message', message: { type: 'command', command: 'taskEvent',
        data: { taskId: record.id, taskType: 'terminal', type: 'error', error: message,
          data: { ...record.data, conversationId: record.conversationId, delivery: 'platform_history' } } } });
    });
  }
  private save(record: TerminalRecord, active: boolean) {
    return this.app.storage.commitRecords([
      { namespace: 'terminal-records', id: record.id, ownerId: record.conversationId, value: structuredClone(record) },
      active ? { namespace: 'terminal-active', id: record.id, ownerId: record.conversationId, value: { id: record.id } }
        : { namespace: 'terminal-active', id: record.id, delete: true },
    ]);
  }
  private async finish(record: TerminalRecord) {
    record.updatedAt = Date.now();
    // 先保存终态，重启时仍可补发尚未交付的后台结果。
    await this.save(record, true);
    await this.feedback(record);
    await this.save(record, false);
    this.active.delete(record.id);
  }
  private async feedback(record: TerminalRecord) {
    if (record.data.background !== true) return;
    const root = this.app.subagents.rootConversationId(record.conversationId);
    const conversationId = root !== record.conversationId &&
      !(await this.app.storage.listRuns({ conversationId: record.conversationId, activeOnly: true, limit: 1 })).length
      ? root : record.conversationId;
    const text = `[Background task ${record.status}]\nCommand: ${String(record.data.command)}\n` +
      (record.data.exitCode !== undefined ? `Exit code: ${String(record.data.exitCode)}\n` : '') +
      (record.data.error ? `Error: ${String(record.data.error)}\n` : '') + `\n${String(record.data.output ?? '')}`;
    await this.app.subagents.feedback.enqueueMessage({ id: `terminal-result-${record.id}`, conversationId,
      actorId: record.actorId, sourceRunId: record.runId, message: { id: `terminal-result-${record.id}`, role: 'user', parts: [{ text }], timestamp: Date.now(),
        isUserInput: false, source: 'background_task', backgroundTask: { kind: 'terminal', taskId: record.id, status: record.status }, userFeedback: { kind: 'background_task', taskId: record.id } } });
  }
  async initialize() {
    for (const id of await this.app.storage.listRecords('terminal-active')) {
      const record = await this.app.storage.getRecord('terminal-records', id) as TerminalRecord | null;
      if (!record) { await this.app.storage.deleteRecord('terminal-active', id); continue; }
      if (record.status === 'running' || record.status === 'queued') {
        record.status = 'interrupted'; record.data.error = '宿主已经重启，原命令执行现场无法恢复，未自动重放命令。';
      }
      await this.finish(record);
    }
  }
  list() {
    return [...this.active.values()].filter(({ record }) => record.status === 'queued' || record.status === 'running').map(({ record }) => ({ id: record.id, type: 'terminal', startTime: record.startTime,
      metadata: { ...record.data, conversationId: record.conversationId, runId: record.runId } }));
  }
  has(id: string) { return this.active.has(id); }
  private async accessible(actorId: string, id: string) {
    const record = this.active.get(id)?.record ?? await this.app.storage.getRecord('terminal-records', id) as TerminalRecord | null;
    if (!record) throw new Error('终端任务不存在。');
    await this.app.conversation(actorId, record.conversationId);
    return record;
  }
  async output(actorId: string, id: string) {
    const record = await this.accessible(actorId, id);
    const live = this.active.get(id)?.runner.getTerminalOutput(id);
    return live?.success ? live : { success: true, output: String(record.data.output ?? ''), running: false,
      exitCode: record.data.exitCode, error: record.data.error };
  }
  async kill(actorId: string, id: string) {
    await this.accessible(actorId, id);
    const runner = this.active.get(id)?.runner;
    if (runner) await runner.killTerminalProcess(id);
    await this.events;
    return this.output(actorId, id);
  }
  async detach(actorId: string, conversationId: string) {
    await this.app.conversation(actorId, conversationId);
    const detached: string[] = [];
    for (const { record, runner } of this.active.values()) if (record.conversationId === conversationId)
      detached.push(...runner.detachRunningTerminalsToBackground(conversationId).detached);
    await this.events;
    return { success: true, detached };
  }
  async removeConversation(conversationId: string) {
    for (const { record, runner } of this.active.values()) if (record.conversationId === conversationId)
      await runner.killTerminalProcess(record.id);
    await this.events;
  }
  async close() {
    this.closing = true;
    await Promise.allSettled([...this.active.values()].map(({ record, runner }) => runner.killTerminalProcess(record.id)));
    await this.events;
  }
}
