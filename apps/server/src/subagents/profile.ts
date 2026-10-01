import { randomUUID } from 'node:crypto';
import { DEFAULT_SUBAGENTS_CONFIG } from '../../../../backend/modules/settings/types/subAgentsTypes';
import { MAX_SUBAGENT_NESTING_DEPTH } from '../../../../backend/tools/subagents/types';
import { resolveSubagentMaxRuntime } from '../../../../shared/subagentRuntime';
import { isMcpToolName } from '../../../../shared/mcpToolNameCodec';
import { GENERAL_WORKER_SYSTEM_PROMPT, SUBAGENT_COMPLETION_NOTICE, SUBAGENT_TOOL_DISCIPLINE_NOTICE } from '../../../../backend/tools/subagents/executor/prompts';
import type { PlatformApplication } from '../application';
import type { PlatformSubagent, SubagentLaunchContext } from './types';

/** 监控中的第 0 项只展示系统配置；Context/Task 已在真实用户历史中，不能再拼一份。 */
export function subagentInvocationForDisplay(record: Pick<PlatformSubagent, 'invocation' | 'profile'>) {
  return { ...record.invocation, parts: [{ text: `# SubAgent Invocation\n\n## Agent System Prompt\n${record.profile.systemPrompt ?? ''}` }] };
}

/** 新派发和旧记录接续共用配置捕获，不通过模型参数扩大工具与账号权限。 */
export function createSubagentRecord(app: PlatformApplication, args: Record<string, unknown>, context: SubagentLaunchContext, depth: number): PlatformSubagent {
  const settings = { ...DEFAULT_SUBAGENTS_CONFIG, ...app.product.runtimeSettings().getSubAgentsConfig() };
  const general = args.agentName === 'General Worker' || args.agentName === 'general-worker';
  const config = general ? undefined : settings.agents.find(agent => agent.enabled && (agent.name === args.agentName || agent.type === args.agentName));
  if (general ? settings.generalWorkerEnabled === false : !config) throw new Error('此子代理未启用或不存在。');
  const maxRuntime = resolveSubagentMaxRuntime(general, args.maxRuntime,
    general ? settings.generalWorkerMaxRuntimeSeconds! : config?.maxRuntime ?? settings.defaultMaxRuntimeSeconds!);
  const inherit = general || config!.channel.syncWithCurrentModel === true || config!.channel.syncWithCurrentModel === undefined && settings.forceUseCurrentChannel === true;
  const selection = inherit ? structuredClone(context.modelSelection) : { providerId: config!.channel.channelId, modelOverride: config!.channel.modelId };
  if (!app.settings.snapshot().settings.providers.some(provider => provider.id === selection.providerId)) throw new Error('子代理渠道不存在。');
  const tools = config?.tools ?? { mode: 'all' };
  const toolNames = context.agent.toolNames.filter(name => {
    if (/^(memory_|todo_)/.test(name) || !app.product.runtimeSettings().isToolEnabled(name) || depth >= MAX_SUBAGENT_NESTING_DEPTH && name === 'subagents') return false;
    if (tools.mode === 'builtin') return !isMcpToolName(name);
    if (tools.mode === 'mcp') return isMcpToolName(name);
    // 设置页和预设写入具名列表；list 只兼容旧配置，显式 [] 不能回退到旧授权。
    if (tools.mode === 'whitelist') return (tools.whitelist ?? tools.list ?? []).includes(name);
    if (tools.mode === 'blacklist') return !(tools.blacklist ?? tools.list ?? []).includes(name);
    return true;
  });
  const id = randomUUID(); const now = Date.now();
  // 与旧宿主执行器追加同样的工具纪律与结束说明。
  const systemPrompt = (general ? GENERAL_WORKER_SYSTEM_PROMPT : config!.systemPrompt) + SUBAGENT_TOOL_DISCIPLINE_NOTICE + SUBAGENT_COMPLETION_NOTICE;
  const environment = context.workspace ? `Workspace: ${context.workspace.directory}` : 'This task is not bound to a workspace.';
  return { id, parentConversationId: context.conversationId, parentRunId: context.runId, sourceToolCallId: context.toolCallId, conversationId: randomUUID(), actorId: context.actorId,
    agentName: general ? 'General Worker' : config!.name, workspace: structuredClone(context.workspace ?? null), depth, background: args.background === true,
    parentConfiguration: context.parentConfiguration, createdAt: now, updatedAt: now, status: 'queued',
    profile: { ...structuredClone(context.agent), id: `subagent_${id.replaceAll('-', '')}`, providerId: selection.providerId, modelId: selection.modelOverride, toolNames,
      systemPrompt: `${systemPrompt}\n\n${environment}`, maxIterations: config?.maxIterations ?? settings.defaultMaxIterations! },
    selection, invocation: { id: `invocation-${id}`, role: 'user', timestamp: now,
      parts: [{ text: `# SubAgent Invocation\n\n## Agent System Prompt\n${systemPrompt}\n\n## Context\n${environment}\n${typeof args.context === 'string' ? args.context : ''}\n\n## User Prompt\n${args.prompt ?? ''}` }] },
    contentRevision: 0, eventSequence: 0, contentCount: 1, coreRunIds: [], maxRuntime,
    failureMode: config?.failureModeAfterRetries ?? settings.failureModeAfterRetries! };
}
