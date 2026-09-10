import type { ModelInput, PlatformMessage } from '@graycode/contracts';
import { PlatformApplication } from '../../../apps/server/src/application';
import { fixture } from './fixtures';

describe('context read-only status mirrors saved summaries without extra summarize calls', () => {
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
    providerId = await draft.configs.createConfig({ type: 'openai', name: 'Status fixture', enabled: true,
      url: 'http://localhost:1234/v1', model: 'fixture', apiKey: '', timeout: 5000, contextManagementEnabled: true,
      maxContextTokens: 8000, contextThreshold: '50%', models: [{ id: 'fixture', name: 'Fixture', contextWindow: 32000 }] });
    await draft.settings.savePromptMode({ id: 'status-test', name: 'Status test', template: 'Preserve user requirements.', dynamicTemplate: '', dynamicTemplateEnabled: false });
    await draft.settings.updateSummarizeConfig({ keepRecentRounds: 1, keepRecentTokens: '50%', maxAutoSummarizeAttemptsPerTurn: 2 });
    await app.product.save(draft);
    const now = Date.now();
    await app.storage.createConversation({ id: 'status', actorId: 'owner', createdAt: now, updatedAt: now });
    const messages: PlatformMessage[] = [];
    for (let round = 0; round < 4; round++) {
      messages.push({ id: `u${round}`, role: 'user', isUserInput: true, parts: [{ text: `Original requirement ${round}` }] },
        { id: `m${round}`, role: 'model', parts: [{ text: `Evidence ${round}: ${'retained original text '.repeat(300)}` },
          { functionCall: { id: `call-${round}`, name: 'workspace_files', args: { action: 'list', path: '.' } } }] },
        { id: `r${round}`, role: 'user', isFunctionResponse: true, parts: [{ functionResponse: { id: `call-${round}`, name: 'workspace_files', response: { success: true, data: { paths: ['source.ts'] } } } }] });
    }
    await app.storage.appendHistory('status', messages.map((message, index) => ({ ...message, timestamp: now + index, parentId: messages[index - 1]?.id ?? null })));
  });
  afterEach(async () => { await app.close(); await f.cleanup(); });

  test('describe stays consistent across summarize and restore without triggering new summaries', async () => {
    const before = await app.context.describeConversation('owner', 'status', { providerId });
    expect(before.success).toBe(true);
    expect(before.range.summaryCount).toBe(0);
    expect(before.range.lastSummaryIndex).toBe(-1);
    expect(before.tokens.source).toBe('none');
    expect(before.tokens.usedTokens).toBe(0);
    expect(before.tokens.precise).toBe(false);
    expect(before.tokens.localEstimate).toBeGreaterThan(0);
    expect(before.tokens.localEstimateLabel).toBe('estimate');
    expect(before.tokens.maxContextTokens).toBe(8000);
    expect(before.tokens.preciseIsProviderCount).toBe(false);
    expect(before.summaries).toEqual([]);

    const run = await app.runtime.start({ actorId: 'owner', agentId: 'default', conversationId: 'status', requestKey: 'status-managed',
      providerId, promptModeId: 'status-test', message: { id: 'latest-user', role: 'user', parts: [{ text: 'Continue the work.' }] } });
    expect(await app.runtime.wait(run.id)).toMatchObject({ status: 'completed' });
    expect(summaries.length).toBeGreaterThan(0);
    const summarizeCalls = summaries.length;
    const snapshots = await app.storage.listSnapshots('status');
    expect(snapshots.length).toBe(summarizeCalls);

    const after = await app.context.describeConversation('owner', 'status', { providerId });
    expect(after.range.summaryCount).toBeGreaterThan(0);
    expect(after.range.lastSummaryIndex).toBeGreaterThanOrEqual(0);
    expect(after.range.summarizedCount).toBeGreaterThan(0);
    // 临时裁剪与已保存总结分别上报：fallbackActive 为布尔值，总结列表非空即为已保存总结。
    expect(typeof after.range.fallbackActive).toBe('boolean');
    if (after.range.fallbackActive) expect(after.range.trimStartIndex).toEqual(expect.any(Number));
    expect(after.summaries).toHaveLength(after.range.summaryCount);
    const first = after.summaries[0];
    expect(first.summaryTokenStats).toMatchObject({ sourceTokenCount: expect.any(Number), summaryTokenCount: expect.any(Number) });
    expect(first.summaryTokenStats!.estimatedTokensSaved).toBeGreaterThanOrEqual(0);
    expect(first.summarizedMessageIds?.length).toBeGreaterThan(0);
    // 合成历史没有 usageMetadata 时，总结也没有 contextTokenCountBefore/estimatedAfter，
    // 前端同样显示 0（见 computed.ts：无助手用量直接返回 0），此处与前端保持一致。
    if (typeof first.summaryTokenStats?.estimatedContextTokenCountAfter === 'number') {
      expect(after.tokens.source).toBe('summary-estimate');
      expect(after.tokens.usedTokens).toBe(first.summaryTokenStats.estimatedContextTokenCountAfter);
    } else {
      expect(after.tokens.source).toBe('none');
      expect(after.tokens.usedTokens).toBe(0);
    }
    expect(after.tokens.precise).toBe(false);

    const again = await app.context.describeConversation('owner', 'status', { providerId });
    expect(again).toEqual(after);
    expect(summaries).toHaveLength(summarizeCalls);
    expect(await app.storage.listSnapshots('status')).toHaveLength(snapshots.length);

    const detail = await app.context.getSummaryDetail('owner', 'status', first.id!);
    expect(detail.success).toBe(true);
    expect(detail.summary.summaryTokenStats).toEqual(first.summaryTokenStats);
    expect(detail.summary.summarizedMessageIds).toEqual(first.summarizedMessageIds);
    await expect(app.context.getSummaryDetail('owner', 'status', 'missing')).rejects.toThrow('已变化');

    const historyBeforeRestore = await app.storage.readFullHistory('status');
    for (const entry of [...after.summaries].reverse()) {
      const current = await app.storage.readFullHistory('status');
      if (!current.messages.some(message => message.id === entry.id && message.isSummary)) continue;
      await app.context.restoreSummary('owner', 'status', entry.id!);
    }
    const restored = await app.context.describeConversation('owner', 'status', { providerId });
    expect(restored.range.summaryCount).toBe(0);
    expect(restored.range.summarizedCount).toBe(0);
    expect(restored.range.lastSummaryIndex).toBe(-1);
    expect(restored.summaries).toEqual([]);
    const historyAfterRestore = await app.storage.readFullHistory('status');
    expect(historyAfterRestore.messages.some(message => message.isSummary || message.isSummarized)).toBe(false);
    expect(historyAfterRestore.messages.length).toBeLessThan(historyBeforeRestore.messages.length);
  });

  test('describe without a provider still reports local estimates and rejects unknown conversations', async () => {
    const bare = await app.context.describeConversation('owner', 'status');
    expect(bare.tokens.maxContextTokens).toBeUndefined();
    expect(bare.tokens.tokenUsagePercent).toBeUndefined();
    expect(bare.tokens.localEstimate).toBeGreaterThan(0);
    expect(bare.tokens.precise).toBe(false);
    await expect(app.context.describeConversation('owner', 'missing')).rejects.toThrow();
  });
});
