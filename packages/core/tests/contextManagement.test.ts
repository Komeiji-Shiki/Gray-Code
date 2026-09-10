import type { ModelInput, PlatformMessage } from '@graycode/contracts';
import { PlatformApplication } from '../../../apps/server/src/application';
import { validateHistoryIntegrity } from '../../../backend/modules/channel/HistoryIntegrityValidator';
import type { Content } from '../../../backend/modules/conversation/types';
import { fixture } from './fixtures';

describe('完整前缀总结与持久笔记换窗口', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let app: PlatformApplication;
  let providerId: string;
  let seen: ModelInput[];
  let generate: (input: ModelInput) => Promise<PlatformMessage>;
  const summaryText = '当前任务是完成原始要求。已经读取所需证据，确认原有约束仍然生效，尚待执行最新用户提出的修改。继续时保留精确文件路径和消息来源，不把历史引用当作新请求。';
  beforeEach(async () => {
    f = await fixture(); await f.store.close(); seen = [];
    generate = async () => ({ role: 'model', parts: [{ text: summaryText }] });
    app = await PlatformApplication.open({ dataDirectory: f.data, models: { generate: async input => { seen.push(input); return generate(input); } } });
    const draft = await app.product.draft();
    providerId = await draft.configs.createConfig({ type: 'openai', name: '本地总结夹具', enabled: true, url: 'http://127.0.0.1:1/v1',
      model: 'fixture', apiKey: '', timeout: 1000, contextManagementEnabled: false, maxContextTokens: 16000, contextThreshold: '20%' });
    await draft.settings.savePromptMode({ id: 'minimal', name: '最小测试', template: 'Preserve the task.', dynamicTemplate: '', dynamicTemplateEnabled: false, toolPolicy: [] });
    await app.product.save(draft);
    await app.storage.createConversation({ id: 'compaction', actorId: 'owner', title: '连续任务', createdAt: Date.now(), updatedAt: Date.now() });
    await app.storage.appendHistory('compaction', [
      { id: 'first', role: 'user', isUserInput: true, parts: [{ text: '原始要求' }] },
      { id: 'evidence', role: 'model', parts: [{ text: '必须可恢复的原始证据。'.repeat(1000) }] },
    ]);
  });
  afterEach(async () => { await app.close(); await f.cleanup(); });
  const start = (key: string) => app.runtime.start({ actorId: 'owner', agentId: 'default', conversationId: 'compaction', providerId, promptModeId: 'minimal',
    requestKey: key, message: { id: key, role: 'user', parts: [{ text: '继续完成最新修改，保留特殊约束。' }] } });

  test('手动总结保留完整前缀，重复总结后可以逐次恢复原上下文', async () => {
    const run = await start('latest'); expect(await app.runtime.wait(run.id)).toMatchObject({ status: 'completed' });
    const normal = seen[0];
    expect((await app.context.summarizeManually('owner', 'compaction', providerId)).success).toBe(true);
    const summary = seen[1];
    expect(summary).toMatchObject({ conversationId: normal.conversationId, providerId: normal.providerId, systemPrompt: normal.systemPrompt,
      tools: normal.tools, promptContext: normal.promptContext, purpose: 'summary' });
    expect(summary.messages.slice(0, normal.messages.length)).toEqual(normal.messages);
    expect(summary.messages.at(-1)?.contextControl).toBe('summary_request');
    const firstBoundary = (await app.storage.readFullHistory('compaction')).messages.find(message => message.isSummary)!;
    expect((await app.storage.readFullHistory('compaction')).messages.filter(message => !message.isSummarized).map(message => message.id)).toEqual(['first', firstBoundary.id]);
    await app.storage.appendHistory('compaction', [{ id: 'later', role: 'user', isUserInput: true, parts: [{ text: '后续修改' }] },
      { id: 'later-answer', role: 'model', parts: [{ text: '后续执行结果' }] }]);
    expect((await app.context.summarizeManually('owner', 'compaction', providerId)).success).toBe(true);
    const history = (await app.storage.readFullHistory('compaction')).messages;
    const secondBoundary = history.at(-1)!;
    expect(history.find(message => message.id === firstBoundary.id)?.isSummarized).toBe(true);
    await app.context.restoreSummary('owner', 'compaction', secondBoundary.id!);
    const restored = (await app.storage.readFullHistory('compaction')).messages;
    expect(restored.find(message => message.id === firstBoundary.id)?.isSummarized).not.toBe(true);
    expect(restored.find(message => message.id === 'evidence')?.isSummarized).toBe(true);
    expect(restored.find(message => message.id === 'later')?.isSummarized).not.toBe(true);
    await app.context.restoreSummary('owner', 'compaction', firstBoundary.id!);
    expect((await app.storage.readFullHistory('compaction')).messages.some(message => message.isSummary || message.isSummarized)).toBe(false);
  });

  test('模型保存笔记并换窗口后，读取原笔记和精确历史消息，继续同一个任务', async () => {
    const draft = await app.product.draft(); await draft.settings.updateSummarizeConfig({ method: 'notes' });
    await draft.configs.updateConfig(providerId, { contextManagementEnabled: true, multimodalToolsEnabled: true, toolMode: 'xml' }); await app.product.save(draft);
    await app.storage.appendHistory('compaction', [{ id: 'image-evidence', role: 'model', parts: [{ inlineData: { mimeType: 'image/png',
      data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRzUAAAAASUVORK5CYII=' } }] }]);
    generate = async () => {
      if (seen.length === 1) return { role: 'model', parts: [
        { functionCall: { id: 'save-note', name: 'context_notes', args: { action: 'write', name: 'checkpoint', text: '目标：继续最新修改。证据消息 ID：evidence。用户要求 ID：latest。' } } },
        { functionCall: { id: 'switch-window', name: 'new_context', args: {} } },
      ] };
      if (seen.length === 2) return { role: 'model', parts: [
        { functionCall: { id: 'read-note', name: 'context_notes', args: { action: 'read', name: 'checkpoint' } } },
        { functionCall: { id: 'read-history', name: 'context_history', args: { action: 'read', messageId: 'evidence', limit: 1200 } } },
        { functionCall: { id: 'read-image', name: 'context_history', args: { action: 'read', messageId: 'image-evidence', includeAttachments: true } } },
      ] };
      return { role: 'model', parts: [{ text: '已经恢复笔记与历史证据，继续处理最新修改。' }] };
    };
    const run = await start('latest'); expect(await app.runtime.wait(run.id)).toMatchObject({ status: 'completed' });
    expect(seen).toHaveLength(3); expect(seen.some(input => input.purpose === 'summary')).toBe(false);
    expect(seen[0].messages.at(-1)?.contextControl).toBe('reminder');
    expect(seen[1].messages).toHaveLength(2);
    expect(seen[1].messages[0].id).toBe('first'); expect(seen[1].messages[1].contextMethod).toBe('notes');
    expect(JSON.stringify(seen[1].messages)).toContain('checkpoint'); expect(JSON.stringify(seen[1].messages)).toContain('latest');
    expect(JSON.stringify(seen[1].messages)).not.toContain('必须可恢复的原始证据');
    expect(JSON.stringify(seen[2].messages)).toContain('必须可恢复的原始证据');
    expect(JSON.stringify(seen[2].messages)).toContain('目标：继续最新修改');
    expect(seen[2].messages.some(message => message.parts.some(part => part.inlineData))).toBe(true);
    expect(seen.every(input => validateHistoryIntegrity(input.messages as Content[]).valid)).toBe(true);
    const keys = await app.storage.listRecords('context-notes', 'compaction'); expect(keys).toHaveLength(1);
    expect(await app.storage.getRecord('context-notes', keys[0])).toMatchObject({ text: expect.stringContaining('evidence') });
    expect((await app.storage.readFullHistory('compaction')).messages.find(message => message.id === 'evidence')?.parts[0].text).toContain('必须可恢复');
    expect((await app.storage.verify()).ok).toBe(true);
  });

  test('手动笔记换窗口不调用模型；旧窗口和笔记在应用重新打开后仍然保留', async () => {
    const draft = await app.product.draft(); await draft.settings.updateSummarizeConfig({ method: 'notes' }); await app.product.save(draft);
    await app.storage.putRecord({ namespace: 'context-notes', id: JSON.stringify(['compaction', 'checkpoint']), ownerId: 'compaction', value: { text: '保留精确证据：evidence', updatedAt: Date.now() } });
    expect((await app.context.summarizeManually('owner', 'compaction', providerId)).success).toBe(true);
    expect(seen).toHaveLength(0);
    await app.close();
    app = await PlatformApplication.open({ dataDirectory: f.data, models: { generate: async () => { throw new Error('此处不能调用模型'); } } });
    const history = (await app.storage.readFullHistory('compaction')).messages;
    expect(history.at(-1)?.contextMethod).toBe('notes'); expect(history.find(message => message.id === 'evidence')?.parts[0].text).toContain('必须可恢复');
    expect(await app.storage.getRecord('context-notes', JSON.stringify(['compaction', 'checkpoint']))).toMatchObject({ text: '保留精确证据：evidence' });
  });
});
