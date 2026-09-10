import { PlatformRuntime, RuntimeToolRegistry, createAskUserTool } from '@graycode/core';
import type { ModelInput } from '@graycode/contracts';
import { fixture, metadata } from './fixtures';

describe('optional questions alongside tool work', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let runtime: PlatformRuntime;
  let workDone: boolean;
  let modelInputs: ModelInput[];
  beforeEach(async () => { f = await fixture(); workDone = false; modelInputs = []; });
  afterEach(async () => { await runtime.close(); await f.cleanup(); });

  async function start(timeoutMs: number) {
    const tools = new RuntimeToolRegistry(); tools.register(createAskUserTool());
    tools.register({ declaration: { name: 'independent_work', description: 'work', parameters: { type: 'object' } },
      effects: () => ['workspace_write'], execute: async () => { workDone = true; return { success: true }; } });
    runtime = new PlatformRuntime({ storage: f.store, tools, questionTimeoutMs: timeoutMs,
      actor: async id => ({ id, displayName: id, role: id === 'owner' ? 'owner' : 'guest', effects: [], workspaceIds: [] }),
      agent: async () => ({ id: 'agent', name: 'agent', providerId: 'fixture', systemPrompt: 'stable',
        toolNames: ['ask_user', 'independent_work'], approvalMode: 'sensitive', maxIterations: 5 }), workspace: async () => null,
      models: { generate: async input => {
        modelInputs.push(input);
        if (!input.messages.some(message => message.role === 'model')) return { role: 'model', parts: [
          { functionCall: { id: 'question-call', name: 'ask_user', args: { questions: [{ title: 'Preferred color?', options: ['blue', 'red'] }] } } },
          { functionCall: { id: 'work-call', name: 'independent_work', args: {} } },
        ] };
        return { role: 'model', parts: [{ text: input.messages.some(message => message.userFeedback) ? 'Decision completed' : 'Independent work completed' }] };
      } },
    });
    await f.store.createConversation({ ...metadata('questions'), actorId: 'owner' });
    let ready!: (questionId: string) => void;
    const questionReady = new Promise<string>(resolve => { ready = resolve; });
    runtime.subscribe(notification => {
      if (notification.type === 'event' && notification.event.type === 'question.asked') ready(String(notification.event.payload.id));
    });
    const run = await runtime.start({ actorId: 'owner', agentId: 'agent', conversationId: 'questions', requestKey: 'questions',
      message: { role: 'user', parts: [{ text: 'Work while waiting for my preference.' }] } });
    return { run, questionReady };
  }

  test('accepts free text and delivers it only after every result in the current tool batch', async () => {
    const { run, questionReady } = await start(10_000);
    const id = await questionReady;
    await expect(runtime.answerQuestion(id, 'guest', ['green'])).rejects.toThrow('cannot answer');
    await runtime.answerQuestion(id, 'owner', ['green instead']);
    expect((await runtime.wait(run.id))?.status).toBe('completed');
    expect(workDone).toBe(true);
    const history = (await f.store.readFullHistory('questions')).messages;
    const feedbackIndex = history.findIndex(message => message.userFeedback);
    const lastToolIndex = history.findIndex(message => (message.parts[0].functionResponse as { id?: string } | undefined)?.id === 'work-call');
    expect(feedbackIndex).toBeGreaterThan(lastToolIndex);
    expect(history[feedbackIndex].parts[0].text).toContain('green instead');
    expect(modelInputs.at(-1)?.messages.some(message => message.userFeedback)).toBe(true);
    expect(runtime.pendingQuestions()).toEqual([]);
  });

  test('continues independent work and returns a timeout notice without turning silence into approval', async () => {
    const { run } = await start(60);
    expect((await runtime.wait(run.id))?.status).toBe('completed');
    expect(workDone).toBe(true);
    const feedback = (await f.store.readFullHistory('questions')).messages.find(message => message.userFeedback)!;
    expect(feedback.userFeedback).toMatchObject({ timedOut: true });
    expect(feedback.parts[0].text).toContain('not approval');
    expect(feedback.actorId).toBeUndefined();
    expect(modelInputs.at(-1)?.messages.some(message => message.userFeedback)).toBe(true);
  });
});
