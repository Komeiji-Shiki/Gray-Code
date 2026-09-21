import { PlatformRuntime, RuntimeToolRegistry } from '@graycode/core';
import type { ApprovalRequest, ApprovalDecision, ModelInput } from '@graycode/contracts';
import { fixture, metadata } from './fixtures';

test('每次权限请求独立确认，选项和旧请求身份不能混用，普通确认保持原行为', async () => {
  const f = await fixture(), registry = new RuntimeToolRegistry();
  const received: ApprovalDecision[] = [], requests: ApprovalRequest[] = [], inputs: ModelInput[] = [];
  const cancelledRequest = new AbortController();
  let wake: (() => void) | undefined;
  registry.register({ declaration: { name: 'external_fixture', description: 'fixture', parameters: { type: 'object' } }, effects: () => ['process_execute'],
    execute: async (_args, context) => {
      const choices = [{ id: 'allow/once==', label: '仅本次允许', kind: 'allow_once' as const },
        { id: 'allow/always==', label: '始终允许这条规则', kind: 'allow_always' as const }, { id: 'reject', label: '拒绝', kind: 'reject_once' as const }];
      received.push(await context.requestPermission!('第一个具体操作', choices));
      received.push(await context.requestPermission!('第二个具体操作', choices));
      await context.requestPermission!('已被上游取消的请求', choices, cancelledRequest.signal);
      return { success: true };
    } });
  const runtime = new PlatformRuntime({ storage: f.store, tools: registry,
    actor: async id => ({ id, displayName: id, role: id === 'owner' ? 'owner' : 'guest', effects: [], workspaceIds: '*' }),
    agent: async () => ({ id: 'a', name: 'a', providerId: 'fixture', systemPrompt: '', toolNames: ['external_fixture'],
      approvalMode: 'sensitive', toolApproval: { external_fixture: 'ask' }, maxIterations: 3 }), workspace: async () => null,
    models: { generate: async input => { inputs.push(input); return input.messages.some(message => message.isFunctionResponse)
      ? { role: 'model', parts: [{ text: 'done' }] } : { role: 'model', parts: [{ functionCall: { id: 'same-tool-call', name: 'external_fixture', args: {} } }] }; } },
  });
  runtime.subscribe(notification => {
    if (notification.type === 'event' && notification.event.type === 'approval.requested') {
      requests.push(notification.event.payload as unknown as ApprovalRequest); wake?.();
    }
  });
  const next = async (count: number) => { while (requests.length < count) await new Promise<void>(resolve => { wake = resolve; }); return requests[count - 1]; };
  try {
    await f.store.createConversation(metadata('choices')); await runtime.initialize();
    const run = await runtime.start({ actorId: 'owner', agentId: 'a', conversationId: 'choices', requestKey: 'one', message: { role: 'user', parts: [{ text: 'start' }] } });
    const initial = await next(1);
    expect(initial.choices).toBeUndefined();
    await runtime.resolveApproval(initial.id, 'owner', true);
    const first = await next(2);
    expect(first.reason).toBe('第一个具体操作');
    await expect(runtime.resolveApproval(first.id, 'guest', true, 'allow/once==')).rejects.toThrow('cannot approve');
    await expect(runtime.resolveApproval(first.id, 'owner', true)).rejects.toThrow('具体选项');
    await runtime.resolveApproval(first.id, 'owner', false, 'allow/once==');
    const second = await next(3);
    expect(second.id).not.toBe(first.id);
    await expect(runtime.resolveApproval(first.id, 'owner', true, 'allow/always==')).rejects.toThrow('expired');
    await expect(runtime.resolveApproval(second.id, 'owner', true, 'missing')).rejects.toThrow('具体选项');
    expect(runtime.pendingApprovals().map(value => value.id)).toEqual([second.id]);
    await runtime.resolveApproval(second.id, 'owner', true, 'reject');
    const third = await next(4);
    cancelledRequest.abort(new Error('upstream cancelled'));
    expect((await runtime.wait(run.id))?.status).toBe('completed');
    expect(runtime.pendingApprovals()).toEqual([]);
    await expect(runtime.resolveApproval(third.id, 'owner', true, 'allow/once==')).rejects.toThrow('expired');
    expect(received).toEqual([{ accepted: true, choiceId: 'allow/once==' }, { accepted: false, choiceId: 'reject' }]);
    expect(inputs[1].messages.find(message => message.role === 'model')?.parts).toEqual([{ functionCall: { id: 'same-tool-call', name: 'external_fixture', args: {} } }]);
    expect(JSON.stringify(inputs[1].messages)).not.toContain('approvalChoices');
  } finally { await runtime.close(); await f.cleanup(); }
});
