import type { AgentDefinition, ModelInput, PlatformMessage } from '@graycode/contracts';
import type { ToolContext } from '@graycode/core';
import { PlatformApplication } from '../../../apps/server/src/application';
import { ApplicationRouter } from '../../../apps/server/src/transport/router';
import { fixture } from './fixtures';

const answer = (text: string): PlatformMessage => ({ role: 'model', parts: [{ text }] });
const waitUntil = async (check: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 500; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('等待子代理审批状态超时。');
};

describe('主对话处理子代理等待的审批', () => {
  let f: Awaited<ReturnType<typeof fixture>>; let app: PlatformApplication; let router: ApplicationRouter; let agent: AgentDefinition;
  let generate: (input: ModelInput) => Promise<PlatformMessage>; let executions: number;
  const client = { actorId: 'owner', clientId: 'pending-ui' };
  const call = (type: string, data: Record<string, unknown>) => router.call(client, 'ui.request', { type, data }) as Promise<any>;
  const tool = () => app.tools.catalog(['subagent_requests']).entries.get('subagent_requests')!.tool;
  const context = (conversationId: string, runId: string): ToolContext => ({ runId, conversationId, actorId: 'owner', toolCallId: 'handle',
    signal: new AbortController().signal, askUser: async () => { throw new Error('unused'); }, progress: () => {} });

  beforeEach(async () => {
    f = await fixture(); await f.store.close(); executions = 0; generate = async () => answer('done');
    app = await PlatformApplication.open({ dataDirectory: f.data, models: { generate: input => generate(input) } });
    router = new ApplicationRouter(app);
    app.tools.register({ declaration: { name: 'delete_fixture', description: 'isolated delete fixture', parameters: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' } } } } },
      effects: () => ['data_delete'], execute: async () => { executions++; return { success: true }; } });
    const preferences = await app.product.draft();
    const providerId = await preferences.configs.createConfig({ type: 'openai', enabled: true, timeout: 5000,
      url: 'http://127.0.0.1:9/v1', name: '子代理审批模型', model: 'fixture', apiKey: '' });
    await app.product.save(preferences);
    const snapshot = app.settings.snapshot();
    agent = { ...snapshot.settings.agents[0], id: 'pending-requests-fixture', providerId, name: '子代理审批测试',
      toolNames: ['subagents', 'subagent_requests', 'delete_fixture'], approvalMode: 'sensitive', maxIterations: 12 };
    snapshot.settings.agents.push(agent); await app.settings.save({ settings: snapshot.settings, expectedRevision: snapshot.revision });
  });
  afterEach(async () => { await app.close(); await f.cleanup(); });

  async function launchWaitingChild(title: string) {
    const root = await app.createConversation('owner', title);
    let childCalls = 0;
    const previous = generate;
    generate = async input => {
      if (input.conversationId === root.id) {
        if (!input.messages.some(message => message.parts.some(part => part.functionResponse))) return { role: 'model', parts: [
          { functionCall: { id: `launch-${title}`, name: 'subagents', args: { agentName: 'General Worker', prompt: 'delete the fixture', background: true } } }] };
        return answer('parent finished');
      }
      if (input.conversationId !== root.id && !app.subagents.childConversationIds().has(input.conversationId)) return previous(input);
      if (input.messages.some(message => message.parts.some(part => (part.functionResponse as { name?: string } | undefined)?.name === 'delete_fixture'))) return answer('child finished');
      childCalls++;
      return { role: 'model', parts: [{ functionCall: { id: `delete-${title}-${childCalls}`, name: 'delete_fixture', args: { paths: [`${title}.tmp`] } } }] };
    };
    const run = await app.runtime.start({ actorId: 'owner', conversationId: root.id, agentId: agent.id, requestKey: `pending:${title}`,
      message: { role: 'user', parts: [{ text: 'start' }] } });
    await app.runtime.wait(run.id);
    await waitUntil(async () => (await app.subagents.conversationRequests('owner', root.id)).approvals.length === 1);
    return { root, run };
  }

  test('主界面列出后代子代理的审批，并可直接点击允许', async () => {
    const { root } = await launchWaitingChild('ui');
    const pending = await call('subagents.pendingRequests', { conversationId: root.id });
    expect(pending.approvals).toHaveLength(1);
    expect(pending.approvals[0]).toMatchObject({ agentName: 'General Worker', toolName: 'delete_fixture', args: { paths: ['ui.tmp'] } });
    expect(pending.questions).toEqual([]);
    await call('subagents.resolveApproval', { runId: pending.approvals[0].subagentRunId, id: pending.approvals[0].id, accepted: true });
    await waitUntil(() => app.subagents.activeIds().length === 0);
    expect(executions).toBe(1);
    expect((await call('subagents.pendingRequests', { conversationId: root.id })).approvals).toEqual([]);
  });

  test('主代理用工具列出并批准自己派发的子代理请求，不能处理其他对话的请求', async () => {
    const first = await launchWaitingChild('agent');
    const other = await launchWaitingChild('other');
    const listed = await tool().execute({ action: 'list' }, context(first.root.id, first.run.id));
    expect(listed.success).toBe(true);
    const approvals = (listed.data as { approvals: Array<{ requestId: string; toolName: string; args: unknown }> }).approvals;
    expect(approvals).toEqual([expect.objectContaining({ toolName: 'delete_fixture', args: { paths: ['agent.tmp'] } })]);
    const foreign = (await app.subagents.conversationRequests('owner', other.root.id)).approvals[0];
    expect(await tool().execute({ action: 'approve', requestId: foreign.id }, context(first.root.id, first.run.id)))
      .toMatchObject({ success: false, code: 'NOT_FOUND' });
    expect(await tool().execute({ action: 'approve', requestId: approvals[0].requestId }, context(first.root.id, first.run.id)))
      .toMatchObject({ success: true, data: { accepted: true, toolName: 'delete_fixture' } });
    await waitUntil(() => executions === 1);
    expect(await tool().execute({ action: 'reject', requestId: foreign.id }, context(other.root.id, other.run.id)))
      .toMatchObject({ success: true, data: { accepted: false } });
    await waitUntil(() => app.subagents.activeIds().length === 0);
    expect(executions).toBe(1);
  });
  test.each(['recover', 'no_retry', 'resume_exhausted'])('限流接续不重复工具，最终交付保留已完成结果（%s）', async mode => {
    const recover = mode !== 'no_retry';
    let previews = 0, childCalls = 0; let received: any;
    app.tools.register({ declaration: { name: 'preview_fixture', description: 'local preview', parameters: { type: 'object', properties: {} } },
      effects: () => [], execute: async () => { previews++; return { success: true, data: { path: 'preview.html', url: 'http://localhost/preview' } }; } });
    const snapshot = app.settings.snapshot(); snapshot.settings.agents.find(item => item.id === agent.id)!.toolNames.push('preview_fixture');
    await app.settings.save({ settings: snapshot.settings, expectedRevision: snapshot.revision });
    const root = await app.createConversation('owner', '限流接续');
    generate = async input => {
      if (input.conversationId === root.id) {
        const reply = input.messages.flatMap(message => message.parts).find(part => (part.functionResponse as any)?.name === 'subagents')?.functionResponse as any;
        if (!reply) return { role: 'model', parts: [{ functionCall: { id: 'launch-preview', name: 'subagents', args: { agentName: 'General Worker', prompt: 'preview once', background: false } } }] };
        received = reply.response; return answer('parent finished');
      }
      childCalls++;
      if (childCalls === 1) return { role: 'model', parts: [{ functionCall: { id: 'preview-once', name: 'preview_fixture', args: {} } }] };
      if (childCalls === 2) {
        input.onDelta?.([{ text: 'preview details already collected' }]);
        throw Object.assign(new Error('HTTP 429: rate limit'), { modelRetry: {
          kind: 'rate_limit', remainingRetries: recover ? 1 : 0, resumeSafe: true, delayMs: 0 } });
      }
      expect(input.retryCount).toBe(0);
      expect(input.messages.some(message => message.parts.some(part => (part.functionResponse as any)?.name === 'preview_fixture'))).toBe(true);
      if (mode === 'resume_exhausted') throw Object.assign(new Error('HTTP 429: rate limit'), { modelRetry: {
        kind: 'rate_limit', remainingRetries: 0, resumeSafe: true, delayMs: 0 } });
      return answer('preview recovered');
    };
    const run = await app.runtime.start({ actorId: 'owner', conversationId: root.id, agentId: agent.id, requestKey: `rate-limit:${recover}`,
      message: { role: 'user', parts: [{ text: 'preview' }] } });
    expect((await app.runtime.wait(run.id))?.status).toBe('completed'); expect(previews).toBe(1);
    if (mode === 'recover') { expect(childCalls).toBe(3); expect(received.data.response).toContain('preview recovered'); }
    else { expect(childCalls).toBe(recover ? 3 : 2); expect(received.success).toBe(false); expect(received.data.response).toContain('preview.html');
      expect(received.data.response).toContain('continueFromRunId'); expect(received.data.response).toContain('preview details already collected'); }
  });

});
