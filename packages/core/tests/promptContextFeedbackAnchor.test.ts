import type { ModelInput, PlatformMessage } from '@graycode/contracts';
import { PlatformApplication } from '../../../apps/server/src/application';
import { ApplicationRouter } from '../../../apps/server/src/transport/router';
import { activeContextHistory } from '../../../apps/server/src/context/compaction';
import { fixture } from './fixtures';

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const call = (id: string, name: string, args: Record<string, unknown> = {}) => ({ functionCall: { id, name, args } });
const answer = (): PlatformMessage => ({ role: 'model', parts: [{ text: 'Completed without losing user instructions.' }] });
function expectPrefix(previous: any, next: any) {
  const { input: before, ...beforeRest } = previous, { input: after, ...afterRest } = next;
  expect(afterRest).toEqual(beforeRest);
  expect(JSON.stringify(after.slice(0, before.length))).toBe(JSON.stringify(before));
  expect(JSON.stringify(next)).not.toMatch(/"userFeedback"|"isUserInput"|"turnDynamicContext"|"source"/);
}

// Real UI delivery, QuestionBroker/drainFeedback, prompt capture and notes-window projection.
// Only model generation is local; preview runs the production Responses adapter/formatter.
describe.each(['entries', 'legacy'] as const)('%s prompt capture through live feedback and context recovery', assembly => {
  let f: Awaited<ReturnType<typeof fixture>>, app: PlatformApplication, providerId: string, router: ApplicationRouter;
  let generated: ModelInput[], requests: any[];
  const gates: Array<ReturnType<typeof deferred>> = [];
  const gate = () => { const value = deferred(); gates.push(value); return value; };
  let generate: (input: ModelInput) => Promise<PlatformMessage>;
  const client = { actorId: 'owner', clientId: 'prompt-anchor-test' };
  beforeEach(async () => {
    f = await fixture(); await f.store.close(); generated = []; requests = [];
    app = await PlatformApplication.open({ dataDirectory: f.data, models: { generate: async input => {
      generated.push(input); requests.push((await app.modelAdapter.preview(input)).body); return generate(input);
    } } });
    router = new ApplicationRouter(app);
    const draft = await app.product.draft();
    providerId = await draft.configs.createConfig({ name: 'Local Responses fixture', type: 'openai-responses', enabled: true,
      url: 'http://127.0.0.1:1/v1', apiKey: '', model: 'fixture', timeout: 1000, contextManagementEnabled: false });
    await draft.settings.updateSummarizeConfig({ method: 'notes' });
    await draft.settings.savePromptMode({ id: 'anchor-mode', name: 'Anchor regression', template: 'Stable system instructions',
      promptAssemblyMode: assembly, dynamicTemplateEnabled: true, dynamicTemplate: '{{$TODO_LIST}}\nStatic run suffix',
      ...(assembly === 'entries' ? { promptEntries: [
        { id: 'system', name: 'System', role: 'system', type: 'prompt', enabled: true, order: 0, content: 'Stable system instructions' },
        { id: 'prefix', name: 'Prefix', role: 'user', type: 'prompt', enabled: true, order: 1, content: 'Static prefix' },
        { id: 'history', name: 'History', role: 'user', type: 'chat_history', enabled: true, order: 2, content: '' },
        { id: 'todo', name: 'Todo', role: 'user', type: 'prompt', enabled: true, order: 3, content: '{{$TODO_LIST}}' },
        { id: 'suffix', name: 'Suffix', role: 'user', type: 'prompt', enabled: true, order: 4, content: 'Static run suffix' },
      ] as const } : {}) });
    await app.product.save(draft);
    await app.storage.createConversation({ id: 'anchor-chat', actorId: 'owner', createdAt: Date.now(), updatedAt: Date.now(),
      custom: { todoList: [{ id: 'todo', content: 'Initial captured TODO', status: 'pending' }] } });
  });
  afterEach(async () => { gates.splice(0).forEach(value => value.resolve()); await app.close(); await f.cleanup(); });
  const start = (id: string) => app.runtime.start({ actorId: 'owner', agentId: 'default', conversationId: 'anchor-chat', providerId,
    promptModeId: 'anchor-mode', requestKey: id, message: { id, role: 'user', parts: [{ text: id }] } });
  const interrupt = (id: string, text: string) => router.call(client, 'ui.request', { type: 'chat.sendInterruptMessage',
    data: { conversationId: 'anchor-chat', messageId: id, text } });

  test('keeps full request prefixes within a run, across notes recovery, and starts a distinct ordinary turn', async () => {
    const secondModel = gate(), releaseSecond = gate(), releaseQuestionWork = gate(), notesModel = gate(), releaseNotes = gate();
    const questionReady = gate(); let questionId = '';
    app.runtime.subscribe(notification => {
      if (notification.type === 'event' && notification.event.type === 'question.asked') {
        questionId = String(notification.event.payload.id); questionReady.resolve();
      }
    });
    app.tools.register({ declaration: { name: 'anchor_work', description: 'Local tool fixture', parameters: { type: 'object', properties: {} } },
      effects: () => [], execute: async (_args, context) => {
        if (context.toolCallId === 'question-work') await releaseQuestionWork.promise;
        return { success: true, text: 'Stable tool result' };
      } });
    const settings = app.settings.snapshot();
    settings.settings.agents[0].toolNames = ['ask_user', 'anchor_work'];
    settings.settings.agents[0].maxIterations = 12;
    await app.settings.save({ settings: settings.settings, expectedRevision: settings.revision });
    generate = async () => {
      switch (generated.length) {
        case 1: return { role: 'model', parts: [call('first-work', 'anchor_work')] };
        case 2:
          secondModel.resolve(); await releaseSecond.promise;
          return { role: 'model', parts: [call('question', 'ask_user', { questions: [{ title: 'Preferred color?', options: ['blue', 'green'] }] }), call('question-work', 'anchor_work')] };
        case 3: return { role: 'model', parts: [
          call('save', 'context_notes', { action: 'write', name: 'checkpoint', text: 'Preserve interruption and green answer. Original message: original-task.' }),
          call('switch', 'new_context')
        ] };
        case 4:
          notesModel.resolve(); await releaseNotes.promise;
          return { role: 'model', parts: [call('recover', 'context_history', { action: 'read', messageId: 'original-task' })] };
        default: return answer();
      }
    };
    const run = await start('original-task');
    await secondModel.promise;
    expect(await interrupt('interrupt-before-notes', 'Keep the latest user constraint.')).toMatchObject({ success: true });
    releaseSecond.resolve();
    await questionReady.promise; await app.runtime.answerQuestion(questionId, 'owner', ['green instead']); releaseQuestionWork.resolve();
    await notesModel.promise;
    // Isolated fixture: clear only the UI throttle timestamp, without changing message/feedback metadata.
    await app.storage.putRecord({ namespace: 'user-interrupt-rate', id: 'anchor-chat', ownerId: 'anchor-chat', value: { timestamp: 0 } });
    expect(await interrupt('interrupt-after-notes', 'Keep this post-window instruction too.')).toMatchObject({ success: true });
    releaseNotes.resolve();
    expect(await app.runtime.wait(run.id)).toMatchObject({ status: 'completed' });
    expect(generated).toHaveLength(5);
    expectPrefix(requests[0], requests[1]); expectPrefix(requests[1], requests[2]);
    expectPrefix(requests[3], requests[4]);
    for (const body of requests) expect(JSON.stringify(body.input).split('Initial captured TODO')).toHaveLength(2);
    for (const input of generated) expect(input.promptContext).toEqual(generated[0].promptContext);
    expect(JSON.stringify(requests[2])).toContain('Keep the latest user constraint.');
    expect(JSON.stringify(requests[2])).toContain('green instead');
    expect(JSON.stringify(requests[4])).toContain('Keep this post-window instruction too.');
    const full = (await app.storage.readFullHistory('anchor-chat')).messages;
    const feedback = full.filter(message => message.userFeedback);
    expect(feedback).toHaveLength(3);
    for (const message of feedback) {
      expect(message).toMatchObject({ role: 'user', isUserInput: true });
      expect(message.turnDynamicContext).toBeUndefined();
    }
    const boundary = full.find(message => message.contextMethod === 'notes')!;
    expect(boundary).toBeDefined();
    expect(generated[3].messages.map(message => message.id)).toEqual(['original-task', feedback[1].id, boundary.id]);
    expect(JSON.stringify(generated[3].messages)).toContain('green instead');
    // Restore the real notes boundary, then rebuild from the storage projection: no synthetic prompt anchor is persisted.
    await app.context.restoreSummary('owner', 'anchor-chat', boundary.id!);
    const config = (await app.product.channel(providerId))!;
    const restored = (await app.storage.readFullHistory('anchor-chat')).messages;
    const restoredBody = (await app.modelAdapter.preview({ ...generated[2], messages: activeContextHistory(restored, config) })).body;
    expectPrefix(requests[2], restoredBody);
    const feedbackContent = (messages: PlatformMessage[]) => messages.filter(message => message.userFeedback)
      .map(({ id, role, isUserInput, userFeedback, source, parts }) => ({ id, role, isUserInput, userFeedback, source, parts }));
    expect(feedbackContent(restored)).toEqual(feedbackContent(feedback));
    const state = await app.storage.readConversationState('anchor-chat');
    await app.storage.commitConversation({ conversationId: 'anchor-chat', expectedRevision: state.history.revision, expectedMetadataToken: state.metadataToken,
      metadata: { ...state.metadata, custom: { ...state.metadata.custom as object, todoList: [{ id: 'todo', content: 'NEW RUN TODO', status: 'pending' }] } } });
    const nextRun = await start('ordinary-next-turn'); expect(await app.runtime.wait(nextRun.id)).toMatchObject({ status: 'completed' });
    expect(generated.at(-1)?.promptContext).not.toEqual(generated[0].promptContext);
    const next = JSON.stringify(requests.at(-1).input);
    expect(next.indexOf('Keep this post-window instruction too.')).toBeLessThan(next.indexOf('NEW RUN TODO'));
    expect(next.indexOf('NEW RUN TODO')).toBeLessThan(next.indexOf('ordinary-next-turn'));
    expect((await app.storage.verify()).ok).toBe(true);
  });
});
