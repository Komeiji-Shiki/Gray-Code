import type { PlatformMessage, RunRecord, ToolEffect, WorkspaceDefinition } from '@graycode/contracts';
import type { ToolContext } from '@graycode/core';
import type { PlatformApplication } from '../application';

/** 复用原按真实用户回合备份一次 before、每轮工具完成后备份 after 的边界。 */
export class CheckpointLifecycle {
  private readonly beforeAttempted = new Set<string>();
  private readonly executed = new Map<string, Set<string>>();
  constructor(private readonly app: PlatformApplication) {}
  clear(runId: string): void { this.beforeAttempted.delete(runId); this.executed.delete(runId); }
  private async capture(run: Pick<RunRecord, 'id' | 'actorId' | 'conversationId'>, options: { phase: 'before' | 'after'; toolName: string; messageId?: string; signal?: AbortSignal; capturedWorkspace: WorkspaceDefinition }) {
    try { await this.app.checkpoints.create(run.actorId, run.conversationId, { ...options, runId: run.id }); }
    catch (error) {
      // 保留原行为：快照失败明确报告，不把已授权工具伪装为未执行。
      this.app.publish({ type: 'workspace.checkpoint.warning', runId: run.id, error: String(error) });
    }
  }
  async beforeRun(run: RunRecord, workspace: WorkspaceDefinition | undefined, signal: AbortSignal) {
    const config = this.app.product.runtimeSettings().getCheckpointConfig();
    if (!workspace || !config.enabled) return;
    const page = await this.app.storage.readFullHistory(run.conversationId);
    const input = page.messages.find(message => message.runId === run.id && message.isUserInput);
    if (!input) return;
    for (const phase of ['before', 'after'] as const) if (config.messageCheckpoint?.[phase === 'before' ? 'beforeMessages' : 'afterMessages'].includes('user'))
      await this.capture(run, { phase, toolName: 'user_message', messageId: input.id, signal, capturedWorkspace: workspace });
  }
  async modelBoundary(run: RunRecord, workspace: WorkspaceDefinition | undefined, signal: AbortSignal, phase: 'before' | 'after', iteration: number, message?: PlatformMessage) {
    const config = this.app.product.runtimeSettings().getCheckpointConfig();
    const messageConfig = config.messageCheckpoint;
    if (!workspace || !config.enabled || !messageConfig?.[phase === 'before' ? 'beforeMessages' : 'afterMessages'].includes('model')) return;
    if (messageConfig.modelOuterLayerOnly !== false && (phase === 'before' ? iteration > 1 : message?.parts.some(part => part.functionCall))) return;
    await this.capture(run, { phase, toolName: 'model_message', messageId: message?.id, signal, capturedWorkspace: workspace });
  }
  async beforeTool(context: ToolContext, name: string, args: Record<string, unknown>, effects: ToolEffect[]) {
    if (!context.workspace || !context.conversationId || !effects.some(effect => ['workspace_write', 'process_execute'].includes(effect))) return;
    const canonicalName = name === 'workspace_files' ? args.action === 'delete' ? 'delete_file' : 'write_file' : name === 'run_command' ? 'execute_command' : name;
    const config = this.app.product.runtimeSettings().getCheckpointConfig();
    if (!config.enabled) return;
    const executed = this.executed.get(context.runId) ?? new Set<string>();
    executed.add(canonicalName); this.executed.set(context.runId, executed);
    if (this.beforeAttempted.has(context.runId) || !config.beforeTools.includes(canonicalName)) return;
    this.beforeAttempted.add(context.runId);
    const page = await this.app.storage.readFullHistory(context.conversationId);
    const message = [...page.messages].reverse().find(item => item.parts.some(part => (part.functionCall as { id?: string } | undefined)?.id === context.toolCallId));
    await this.capture({ id: context.runId, actorId: context.actorId, conversationId: context.conversationId },
      { phase: 'before', toolName: 'tool_batch', messageId: message?.id, signal: context.signal, capturedWorkspace: context.workspace });
  }
  async afterTools(run: RunRecord, workspace: WorkspaceDefinition | undefined, signal: AbortSignal, message: PlatformMessage) {
    const names = this.executed.get(run.id); this.executed.delete(run.id);
    const config = this.app.product.runtimeSettings().getCheckpointConfig();
    if (!workspace || !config.enabled || !names || ![...names].some(name => config.afterTools.includes(name))) return;
    await this.capture(run, { phase: 'after', toolName: 'tool_batch', messageId: message.id, signal: signal.aborted ? undefined : signal, capturedWorkspace: workspace });
  }
}
