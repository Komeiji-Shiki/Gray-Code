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
    for (let index = 0; index < 75; index++) await app.createConversation('owner', `统计样本 ${index}`, undefined, undefined, [
      { id: 'answer', role: 'model', timestamp: Date.now(), modelVersion: 'fixture-model', parts: [{ text: '样本回复' }],
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 5, cachedContentTokenCount: 50 } },
    ]);
    const snapshot = app.settings.snapshot(); snapshot.settings.workspaces = [];
    await app.settings.save({ settings: snapshot.settings, expectedRevision: snapshot.revision });
    const [first, second] = await Promise.all([
      router.call(client, 'ui.request', { type: 'usage.getStats', data: {} }),
      router.call({ actorId: 'owner', clientId: 'usage-other' }, 'ui.request', { type: 'usage.getStats', data: {} }),
    ]) as any[];
    expect(first.totals).toMatchObject({ conversations: 75, modelMessages: 75, skippedConversations: 0, promptTokens: 7500, totalTokens: 9375 });
    expect(second.totals).toEqual(first.totals); expect(first.readErrors).toEqual({});
  } finally { await app.close(); await f.cleanup(); }
});
