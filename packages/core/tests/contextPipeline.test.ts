import type { ModelInput, PlatformMessage } from '@graycode/contracts';
import { PlatformApplication } from '../../../apps/server/src/application';
import { validateHistoryIntegrity } from '../../../backend/modules/channel/HistoryIntegrityValidator';
import type { Content } from '../../../backend/modules/conversation/types';
import { fixture } from './fixtures';

describe('context evaluation and summaries share the original rules and one history transaction', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let app: PlatformApplication;
  let providerId: string;
  let primary: ModelInput[];
  let summaries: ModelInput[];
  let summaryText: string;
  const detailed = 'The user requested the original work. The files, tool results and decisions above must remain available. Continue with the unfinished request and preserve all explicit constraints.';
  beforeEach(async () => {
    f = await fixture(); await f.store.close(); primary = []; summaries = []; summaryText = detailed;
    app = await PlatformApplication.open({ dataDirectory: f.data, models: { generate: async input => {
      if (input.purpose === 'summary') { summaries.push(input); return { role: 'model', parts: [{ text: summaryText }] }; }
      primary.push(input); return { role: 'model', parts: [{ text: 'Completed after context preparation.' }] };
    } } });
    const draft = await app.product.draft();
    providerId = await draft.configs.createConfig({ type: 'openai', name: 'Context fixture', enabled: true,
      url: 'http://localhost:1234/v1', model: 'fixture', apiKey: '', timeout: 5000, contextManagementEnabled: true,
      maxContextTokens: 8000, contextThreshold: '50%', models: [{ id: 'fixture', name: 'Fixture', contextWindow: 32000 }] });
    await draft.settings.savePromptMode({ id: 'context-test', name: 'Context test', template: 'Preserve user requirements.', dynamicTemplate: '', dynamicTemplateEnabled: false });
    await draft.settings.updateSummarizeConfig({ keepRecentRounds: 1, keepRecentTokens: '50%', maxAutoSummarizeAttemptsPerTurn: 2 });
    await app.product.save(draft);
    const now = Date.now();
    await app.storage.createConversation({ id: 'context', actorId: 'owner', createdAt: now, updatedAt: now });
    const messages: PlatformMessage[] = [];
    for (let round = 0; round < 4; round++) {
      messages.push({ id: `u${round}`, role: 'user', isUserInput: true, parts: [{ text: `Original requirement ${round}` }] },
        { id: `m${round}`, role: 'model', parts: [{ text: `Evidence ${round}: ${'retained original text '.repeat(300)}` },
          { functionCall: { id: `call-${round}`, name: 'workspace_files', args: { action: 'list', path: '.' } } }] },
        { id: `r${round}`, role: 'user', isFunctionResponse: true, parts: [{ functionResponse: { id: `call-${round}`, name: 'workspace_files', response: { success: true, data: { paths: ['source.ts'] } } } }] });
    }
    await app.storage.appendHistory('context', messages.map((message, index) => ({ ...message, timestamp: now + index, parentId: messages[index - 1]?.id ?? null })));
  });
  afterEach(async () => { await app.close(); await f.cleanup(); });

  test('automatic summaries protect original text, pair tool messages and supply reduced model history', async () => {
    const before = await app.storage.readFullHistory('context');
    const run = await app.runtime.start({ actorId: 'owner', agentId: 'default', conversationId: 'context', requestKey: 'managed',
      providerId, promptModeId: 'context-test', message: { id: 'latest-user', role: 'user', parts: [{ text: 'Continue the work.' }] } });
    expect(await app.runtime.wait(run.id)).toMatchObject({ status: 'completed' });
    expect(summaries.length).toBeGreaterThan(0); expect(summaries.length).toBeLessThanOrEqual(2);
    const after = await app.storage.readFullHistory('context');
    for (const original of before.messages) expect(after.messages.find(message => message.id === original.id)?.parts).toEqual(original.parts);
    expect(after.messages.find(message => message.id === 'u0')?.isSummarized).not.toBe(true);
    expect(after.messages.find(message => message.id === 'latest-user')?.isSummarized).toBe(true);
    expect(primary[0].messages.filter(message => !message.contextControl).map(message => message.id)).toEqual(['u0', after.messages.find(message => message.isSummary)!.id]);
    expect(summaries[0].systemPrompt).toBe(primary[0].systemPrompt);
    expect(summaries[0].tools).toEqual(primary[0].tools);
    expect(summaries[0].conversationId).toBe('context');
    expect(summaries[0].messages.at(-1)?.contextControl).toBe('summary_request');
    expect(after.messages.some(message => message.isSummary)).toBe(true);
    expect(primary[0].messages.some(message => message.isSummary)).toBe(true);
    expect(primary[0].messages.length).toBeLessThan(after.messages.length);
    expect(validateHistoryIntegrity(primary[0].messages as Content[]).valid).toBe(true);
    expect((await app.storage.readRunEvents(run.id)).some(event => event.type === 'context.summary.completed')).toBe(true);
    expect((await app.storage.listSnapshots('context')).length).toBe(summaries.length);
    expect((await app.storage.verify()).ok).toBe(true);
  });

  test('bad summaries leave history intact; manual summaries can be restored by stable ID', async () => {
    const before = await app.storage.readFullHistory('context');
    summaryText = 'too short';
    expect(await app.context.summarizeManually('owner', 'context', providerId)).toMatchObject({ success: false });
    expect(await app.storage.readFullHistory('context')).toEqual(before);
    expect(await app.storage.listSnapshots('context')).toEqual([]);
    summaryText = detailed;
    const result = await app.context.summarizeManually('owner', 'context', providerId);
    expect(result).toMatchObject({ success: true });
    if (!result.success || !('summaryContent' in result)) throw new Error('Summary unavailable');
    const id = result.summaryContent.id!;
    const summaryHistory = await app.storage.readFullHistory('context');
    expect(summaryHistory.messages.some(message => message.isSummarized)).toBe(true);
    await app.context.restoreSummary('owner', 'context', id);
    const restored = await app.storage.readFullHistory('context');
    expect(restored.messages.map(message => message.parts)).toEqual(before.messages.map(message => message.parts));
    expect(restored.messages.some(message => message.isSummarized || message.isSummary)).toBe(false);
  });
});
