import { PlatformRuntime, RuntimeToolRegistry, PlatformStorage } from '@graycode/core';
import type { ActorIdentity, AgentDefinition, ModelInput, RunRecord } from '@graycode/contracts';
import { fixture, metadata } from './fixtures';

describe('independent task execution and identity boundaries', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let runtime: PlatformRuntime;
  let registry: RuntimeToolRegistry;
  let calls: ModelInput[];
  let executions: string[];
  const actors: Record<string, ActorIdentity> = {
    owner: { id: 'owner', displayName: 'Owner', role: 'owner', effects: [], workspaceIds: '*' },
    guest: { id: 'guest', displayName: 'Owner', role: 'guest', effects: ['public_read'], workspaceIds: [] },
  };
  const agent: AgentDefinition = { id: 'agent', name: 'Agent', providerId: 'fixture', systemPrompt: 'Stable instructions',
    approvalMode: 'sensitive', maxIterations: 4, toolNames: ['public_search', 'local_command', 'delete_file'] };
  beforeEach(async () => {
    f = await fixture(); registry = new RuntimeToolRegistry(); calls = []; executions = [];
    for (const [name, effects] of [['public_search', ['public_read']], ['local_command', ['process_execute']], ['delete_file', ['data_delete']]] as const) {
      registry.register({ declaration: { name, description: name, parameters: { type: 'object', properties: {} } },
        effects: () => [...effects], execute: async () => { executions.push(name); return { success: true }; } });
    }
    runtime = new PlatformRuntime({ storage: f.store, tools: registry,
      actor: async id => actors[id] ?? null, agent: async () => agent, workspace: async () => null,
      models: { generate: async input => {
        calls.push(input);
        return input.messages.some(message => message.role === 'model')
          ? { role: 'model', parts: [{ text: 'Done' }] }
          : { role: 'model', parts: input.messages[0].parts[0].text === 'delete'
            ? [{ functionCall: { id: 'delete-call', name: 'delete_file', args: {} } }]
            : [{ functionCall: { id: 'public-call', name: 'public_search', args: {} } }, { functionCall: { id: 'local-call', name: 'local_command', args: {} } }] };
      } },
    });
    await runtime.initialize();
  });
  afterEach(async () => { await runtime.close(); await f.cleanup(); });

  async function start(actorId: string, conversationId: string, text = 'work', requestKey = conversationId) {
    await f.store.createConversation({ ...metadata(conversationId), actorId });
    return runtime.start({ actorId, conversationId, requestKey, agentId: agent.id, message: { role: 'user', parts: [{ text }] } });
  }

  test('keeps identical declarations while denying guest private operations with paired tool results', async () => {
    const guest = await start('guest', 'guest-task');
    expect((await runtime.wait(guest.id))?.status).toBe('completed');
    expect(executions).toEqual(['public_search']);
    const history = (await f.store.readFullHistory('guest-task')).messages;
    expect(history[3].parts[0]).toMatchObject({ functionResponse: { id: 'local-call', response: { success: false, code: 'PERMISSION_DENIED' } } });
    expect((history[1].parts[1].functionCall as Record<string, unknown>).rejected).toBeUndefined();
    const guestTools = JSON.stringify(calls[0].tools);
    const owner = await start('owner', 'owner-task');
    expect((await runtime.wait(owner.id))?.status).toBe('completed');
    expect(executions).toEqual(['public_search', 'public_search', 'local_command']);
    expect(JSON.stringify(calls[2].tools)).toBe(guestTools);
    const events = await f.store.readRunEvents(guest.id);
    expect(events.map(event => event.sequence)).toEqual(events.map((_, i) => i + 1));
    expect(events.at(-1)?.type).toBe('run.completed');
    await f.store.collectGarbage();
    expect((await f.store.verify()).ok).toBe(true);
  });

  test('allows only qualified approval and blocks another member from cancelling an owner run', async () => {
    let approvalReady!: (id: string) => void;
    const ready = new Promise<string>(resolve => { approvalReady = resolve; });
    runtime.subscribe(notification => { if (notification.type === 'event' && notification.event.type === 'approval.requested') approvalReady(String(notification.event.payload.id)); });
    const run = await start('owner', 'approval', 'delete');
    const approvalId = await ready;
    expect(executions).toEqual([]);
    await expect(runtime.cancel(run.id, 'guest')).rejects.toThrow('cannot cancel');
    await expect(runtime.resolveApproval(approvalId, 'guest', true)).rejects.toThrow('cannot approve');
    await runtime.resolveApproval(approvalId, 'owner', false);
    expect((await runtime.wait(run.id))?.status).toBe('completed');
    expect(executions).toEqual([]);
    expect((await f.store.readFullHistory('approval')).messages[2].parts[0]).toMatchObject({ functionResponse: { id: 'delete-call', response: { code: 'PERMISSION_DENIED' } } });
  });

  test('repeated delivery returns the existing run without appending input or executing again', async () => {
    const first = await start('owner', 'duplicate');
    await runtime.wait(first.id);
    const again = await runtime.start({ actorId: 'owner', conversationId: 'duplicate', requestKey: 'duplicate', agentId: 'agent', message: { role: 'user', parts: [{ text: 'work' }] } });
    expect(again.id).toBe(first.id);
    expect(executions).toEqual(['public_search', 'local_command']);
    expect((await f.store.readFullHistory('duplicate')).messages).toHaveLength(5);
  });

  test('startup settles an interrupted tool call and never replays its side effect', async () => {
    await f.store.createConversation({ ...metadata('crash'), actorId: 'owner' });
    const run: RunRecord = { id: 'crashed-run', requestKey: 'crashed-request', actorId: 'owner', agentId: 'agent',
      conversationId: 'crash', status: 'queued', createdAt: 1, updatedAt: 1, iteration: 0, catalogVersion: 'old' };
    await f.store.createRun(run, { role: 'user', parts: [{ text: 'work' }] });
    await f.store.appendRunEvent({ runId: run.id, type: 'run.started', payload: {}, update: { status: 'running' } });
    await f.store.appendHistory('crash', [{ role: 'model', runId: run.id, parts: [{ functionCall: { id: 'unknown-effect', name: 'local_command', args: {} } }] }]);
    await runtime.initialize();
    expect((await f.store.getRun(run.id))?.status).toBe('interrupted');
    expect((await f.store.readFullHistory('crash')).messages[2].parts[0]).toMatchObject({ functionResponse: { id: 'unknown-effect', response: { code: 'INTERRUPTED' } } });
    expect(executions).toEqual([]);
    await f.store.close();
    f.store = await PlatformStorage.open(f.data);
    expect((await f.store.getRun(run.id))?.status).toBe('interrupted');
  });
});
