import type { ModelInput, PlatformMessage } from '@graycode/contracts';
import { PlatformApplication } from '../../../apps/server/src/application';
import { validateHistoryIntegrity } from '../../../backend/modules/channel/HistoryIntegrityValidator';
import type { Content } from '../../../backend/modules/conversation/types';
import { fixture } from './fixtures';
import { contextTurnState } from '../../../apps/server/src/context/decision';

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
      if (input.purpose === 'summary') { summaries.push(input); return { role: 'model', completionStatus: 'complete', parts: [{ text: summaryText }] }; }
      primary.push(input); return { role: 'model', parts: [{ text: 'Completed after context preparation.' }] };
    } } });
    const draft = await app.product.draft();
    providerId = await draft.configs.createConfig({ type: 'openai', name: 'Context fixture', enabled: true,
      url: 'http://localhost:1234/v1', model: 'fixture', apiKey: '', timeout: 5000, contextManagementEnabled: true,
      maxContextTokens: 8000, contextThreshold: '50%', models: [{ id: 'fixture', name: 'Fixture', contextWindow: 32000 }] });
    // 本夹具只验证历史与摘要；完整默认工具目录本身就超过这里刻意缩小的输入预算。
    await draft.settings.savePromptMode({ id: 'context-test', name: 'Context test', template: 'Preserve user requirements.',
      dynamicTemplate: '', dynamicTemplateEnabled: false, toolPolicy: [] });
    await draft.settings.updateSummarizeConfig({ keepRecentRounds: 1, keepRecentTokens: '50%', maxAutoSummarizeAttemptsPerTurn: 2 });
    await app.product.save(draft);
    const now = Date.now();
    await app.storage.createConversation({ id: 'context', actorId: 'owner', createdAt: now, updatedAt: now });
    const messages: PlatformMessage[] = [];
    for (let round = 0; round < 4; round++) {
      messages.push({ id: `u${round}`, role: 'user', isUserInput: true, promptModeId: 'context-test', parts: [{ text: `Original requirement ${round}` }] },
        { id: `m${round}`, role: 'model', parts: [{ text: `Evidence ${round}: ${'retained original text '.repeat(300)}` },
          { functionCall: { id: `call-${round}`, name: 'workspace_files', args: { action: 'list', path: '.' } } }] },
        { id: `r${round}`, role: 'user', isFunctionResponse: true, parts: [{ functionResponse: { id: `call-${round}`, name: 'workspace_files', response: { success: true, data: { paths: ['source.ts'] } } } }] });
    }
    await app.storage.appendHistory('context', messages.map((message, index) => ({ ...message, timestamp: now + index, parentId: messages[index - 1]?.id ?? null })));
  });
  afterEach(async () => { await app.close(); await f.cleanup(); });

  test.each(['first', 'all'] as const)('automatic summaries retain %s user originals, pair tool messages and supply reduced model history', async userMessageRetention => {
    const draft = await app.product.draft(); await draft.settings.updateSummarizeConfig({ userMessageRetention }); await app.product.save(draft);
    const before = await app.storage.readFullHistory('context');
    const run = await app.runtime.start({ actorId: 'owner', agentId: 'default', conversationId: 'context', requestKey: 'managed',
      providerId, promptModeId: 'context-test', message: { id: 'latest-user', role: 'user', parts: [{ text: 'Continue the work.' }] } });
    const completed = await app.runtime.wait(run.id);
    expect({ status: completed?.status, error: completed?.error }).toEqual({ status: 'completed', error: undefined });
    expect(summaries.length).toBeGreaterThan(0); expect(summaries.length).toBeLessThanOrEqual(2);
    const after = await app.storage.readFullHistory('context');
    for (const original of before.messages) expect(after.messages.find(message => message.id === original.id)?.parts).toEqual(original.parts);
    expect(after.messages.find(message => message.id === 'u0')?.isSummarized).not.toBe(true);
    expect(after.messages.find(message => message.id === 'latest-user')?.isSummarized).not.toBe(true);
    const retained = userMessageRetention === 'all' ? ['u0', 'u1', 'u2', 'u3', 'latest-user'] : ['u0', 'latest-user'];
    expect(primary[0].messages.filter(message => !message.contextControl).map(message => message.id)).toEqual([...retained, after.messages.find(message => message.isSummary)!.id]);
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
    expect({ success: result.success, error: 'error' in result ? result.error : undefined }).toEqual({ success: true, error: undefined });
    if (!result.success || !('summaryContent' in result)) throw new Error('Summary unavailable');
    const id = result.summaryContent.id!;
    const summaryHistory = await app.storage.readFullHistory('context');
    expect(summaryHistory.messages.some(message => message.isSummarized)).toBe(true);
    await app.context.restoreSummary('owner', 'context', id);
    const restored = await app.storage.readFullHistory('context');
    expect(restored.messages.map(message => message.parts)).toEqual(before.messages.map(message => message.parts));
    expect(restored.messages.some(message => message.isSummarized || message.isSummary)).toBe(false);
  });

  test('all 原文已经占满软阈值时，连续新用户回合的少量模型内容不重复调用总结', async () => {
    const draft = await app.product.draft();
    await draft.settings.updateSummarizeConfig({ userMessageRetention: 'all' });
    await app.product.save(draft);
    const state = await app.storage.readFullHistory('context');
    await app.storage.commitConversation({ conversationId: 'context', expectedRevision: state.revision,
      messageUpdates: state.messages.flatMap((message, index) => message.role === 'model' ? [{ index,
        message: { ...message, parts: message.parts.map(part => typeof part.text === 'string' ? { text: 'small result' } : part) } }] : []) });
    await app.storage.appendHistory('context', [{ id: 'large-preserved-input', role: 'user', isUserInput: true, promptModeId: 'context-test',
      parts: [{ text: 'irreducible constraint '.repeat(1700) }] }]);
    for (const id of ['continue-one', 'continue-two']) {
      const run = await app.runtime.start({ actorId: 'owner', agentId: 'default', conversationId: 'context', requestKey: id,
        providerId, promptModeId: 'context-test', message: { id, role: 'user', parts: [{ text: 'Continue briefly.' }] } });
      const completed = await app.runtime.wait(run.id);
      expect({ status: completed?.status, error: completed?.error }).toEqual({ status: 'completed', error: undefined });
    }
    expect(primary).toHaveLength(2);
    expect(summaries).toEqual([]);
    expect(await app.storage.listSnapshots('context')).toEqual([]);
    expect(primary[1].messages.find(message => message.id === 'large-preserved-input')?.parts)
      .toEqual([{ text: 'irreducible constraint '.repeat(1700) }]);
  });

  test('新用户回合只重置尝试额度，摘要边界或模型预算改变才丢弃压缩进度', () => {
    const basis = { providerId: 'provider', modelId: 'model', boundaryId: 'summary', retention: 'all' as const,
      fixedTokens: 1000, maxInputTokens: 10000, softLimitTokens: 8000 };
    const previous = { turnId: 'old-turn', summaryAttempts: 2, summaryBlocked: true, fallback: true, fallbackStartId: 'cut',
      lastSummaryInputTokens: 8100, lastSummarySavedTokens: 500, lastSummaryCoveredCount: 12, summaryBasis: basis };
    expect(contextTurnState(previous, 'new-turn', basis)).toEqual({ turnId: 'new-turn', summaryAttempts: 0, summaryBasis: basis,
      lastSummaryInputTokens: 8100, lastSummarySavedTokens: 500, lastSummaryCoveredCount: 12 });
    expect(contextTurnState(previous, 'new-turn', { ...basis, boundaryId: 'restored-summary' }).lastSummarySavedTokens).toBeUndefined();
    expect(contextTurnState(previous, 'new-turn', { ...basis, modelId: 'other-model' }).lastSummaryCoveredCount).toBeUndefined();
  });
});
