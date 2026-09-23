import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { PlatformApplication } from '../../../apps/server/src/application';
import { ApplicationRouter } from '../../../apps/server/src/transport/router';
import { fixture } from './fixtures';

test('超过存储队列容量的统计分批读取，并且不依赖已移除的当前工作区', async () => {
  const f = await fixture(); await f.store.close();
  const app = await PlatformApplication.open({ dataDirectory: f.data });
  const router = new ApplicationRouter(app); const client = { actorId: 'owner', clientId: 'usage-test' };
  const directory = path.join(f.root, 'project'); await mkdir(directory);
  try {
    const workspace = await router.call(client, 'workspaces.add', { directory, name: '项目' }) as { id: string };
    await router.call(client, 'ui.context.set', { workspaceId: workspace.id, mode: 'chat' });
    for (let index = 0; index < 140; index++) await app.createConversation('owner', `统计样本 ${index}`, undefined, undefined, [
      { id: 'answer', role: 'model', timestamp: Date.now(), modelVersion: 'fixture-model', parts: [{ text: '样本回复' }],
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 5, cachedContentTokenCount: 50 } },
    ]);
    const snapshot = app.settings.snapshot(); snapshot.settings.workspaces = [];
    await app.settings.save({ settings: snapshot.settings, expectedRevision: snapshot.revision });
    const read = jest.spyOn(app.storage, 'readUsageState');
    const metadata = jest.spyOn(app.storage, 'getConversation');
    const revisions = jest.spyOn(app.storage, 'recordRevisions');
    const pages = jest.spyOn(app.storage, 'listUsageConversations');
    const [first, second] = await Promise.all([
      router.call(client, 'ui.request', { type: 'usage.getStats', data: {} }),
      router.call({ actorId: 'owner', clientId: 'usage-other' }, 'ui.request', { type: 'usage.getStats', data: {} }),
    ]) as any[];
    expect(first.totals).toMatchObject({ conversations: 140, modelMessages: 140, skippedConversations: 0, promptTokens: 14000, totalTokens: 17500 });
    expect(second.totals).toEqual(first.totals); expect(first.readErrors).toEqual({});
    expect(read).toHaveBeenCalledTimes(140); expect(pages).toHaveBeenCalledTimes(2);
    expect(metadata).not.toHaveBeenCalled(); expect(revisions).not.toHaveBeenCalled();

    read.mockClear(); pages.mockClear();
    const warm = await app.usage.stats('owner', {});
    expect(warm.totals).toEqual(first.totals);
    expect(read).not.toHaveBeenCalled(); expect(pages).toHaveBeenCalledTimes(2);
    const id = first.byConversation[0].conversationId;
    await app.storage.appendHistory(id, [{ id: 'new-answer', role: 'model', timestamp: Date.now(), parts: [],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 } }]);
    const updated = await app.usage.stats('owner', {});
    expect(updated.totals.totalTokens).toBe(17512); expect(read).toHaveBeenCalledTimes(1);
    read.mockClear();
    const filtered = await app.usage.stats('owner', { startTime: Date.now() + 1000 });
    expect(filtered.totals.totalTokens).toBe(0); expect(read).not.toHaveBeenCalled();

    const childId = first.byConversation[1].conversationId, grandchildId = first.byConversation[2].conversationId;
    for (const [child, parent] of [[childId, id], [grandchildId, childId]]) {
      const value = (await app.storage.getConversation(child))!;
      await app.storage.saveMetadata({ ...value, parentConversationId: parent, custom: { platformSubagentId: child } });
    }
    const grouped = await app.usage.stats('owner', {});
    expect(grouped.totals).toMatchObject({ totalTokens: 17512, conversations: 138 });
    expect(grouped.byConversation.find(item => item.conversationId === id)).toMatchObject({ totalTokens: 387, subagentTokens: 250 });
    expect(read).not.toHaveBeenCalled();
    await app.storage.putRecord({ namespace: 'conversation-usage', id, value: { version: 1, conversationId: id, messages: [
      { id: 'imported-subagent', source: 'subagent', prompt: 7, candidates: 3, thoughts: 0, cacheCreation: 0, cacheRead: 0 },
    ] } });
    expect((await app.usage.stats('owner', {})).totals.totalTokens).toBe(17522);
    expect(read).toHaveBeenCalledTimes(1);
    read.mockClear();
    await app.storage.deleteRecord('conversation-usage', id);
    expect((await app.usage.stats('owner', {})).totals.totalTokens).toBe(17512);
    expect(read).toHaveBeenCalledTimes(1);
  } finally { await app.close(); await f.cleanup(); }
});
