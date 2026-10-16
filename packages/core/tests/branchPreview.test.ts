import { PlatformApplication } from '../../../apps/server/src/application';
import { branchMutation, branchNamespace, branchView, readBranches } from '../../../apps/server/src/conversations/branches';
import type { PlatformMessage } from '@graycode/contracts';
import { fixture } from './fixtures';

test('分支预览投影保留候选、工具归属、写入标记与旧图兼容，完整正文保持原样', async () => {
  const f = await fixture(); await f.store.close();
  const app = await PlatformApplication.open({ dataDirectory: f.data });
  const id = 'preview';
  const text = '预览🐱与完整正文'.repeat(6000);
  const payload = '不会显示的工具参数与结果'.repeat(5000);
  const image = Buffer.alloc(300_000, 37).toString('base64');
  const root: PlatformMessage = { id: 'root', parentId: null, role: 'user', timestamp: 1000,
    parts: [{ text }, { inlineData: { mimeType: 'image/png', data: image } }] };
  const old: PlatformMessage = { id: 'old', parentId: 'root', role: 'model', timestamp: 1001, modelVersion: 'old-model',
    characterTurn: { privateSnapshot: payload }, usageMetadata: { promptTokenCount: 30 },
    parts: [{ text, thoughtSignature: payload }, { functionCall: { id: 'old-call', name: 'workspace_files', args: { action: 'write', payload } } }] };
  const response: PlatformMessage = { id: 'result', parentId: 'old', role: 'user', timestamp: 1002,
    parts: [{ functionResponse: { id: 'old-call', name: 'workspace_files', response: { payload } } }] };
  const current: PlatformMessage = { id: 'current', parentId: 'root', role: 'model', timestamp: 1003, modelVersion: 'new-model',
    parts: [{ text: `新候选${text}` }, { functionCall: { id: 'new-call', name: 'workspace_files', args: { action: 'read', payload } } }] };
  try {
    await app.storage.createConversation({ id, actorId: 'owner', createdAt: 1000, updatedAt: 1000 });
    await app.storage.appendHistory(id, [root, old, response]);
    const original = await app.conversations.read('owner', id);
    const branches = readBranches(original);
    branches.graph.nodes.old.label = '原候选';
    branches.graph.nodes.old.workspaceCheckpointId = 'retained-checkpoint';
    const messages = [root, current];
    await app.storage.commitConversation({ conversationId: id, expectedRevision: original.history.revision,
      messages, records: [branchMutation(original, branches, messages)] });

    for (const legacy of [false, true]) {
      if (legacy) {
        // 早期图会在节点和 groups 中同时保存正文，投影必须仍按主历史重建当前路径。
        await app.storage.putRecord({ namespace: branchNamespace, id, ownerId: id, value: branches });
      }
      const before = await app.conversations.read('owner', id);
      const config = app.product.runtimeSettings().getCheckpointConfig();
      const expected = branchView(readBranches(before), new Set([...config.beforeTools, ...config.afterTools]));
      const { graph } = await app.conversations.graph('owner', id);
      expect(graph).toEqual(expected);
      expect(graph.nodes.old).toMatchObject({ label: '原候选', modelVersion: 'old-model', hasWorkspaceState: true, wroteToWorkspace: true });
      expect(graph.nodes.current).toMatchObject({ modelVersion: 'new-model', wroteToWorkspace: false });
      expect(Object.keys(graph.nodes)).toEqual(expect.arrayContaining(['root', 'old', 'current']));
      expect(graph.nodes.result).toBeUndefined();
      expect(graph.nodes.old.parts).toEqual([{ text: text.slice(0, 180) }, { text: '[tool: workspace_files]' }]);
      expect(graph.nodes.old.contentMetadata).toBeUndefined();
      expect(graph.nodes.old.usageMetadata).toBeUndefined();
      expect(JSON.stringify(graph).length).toBeLessThan(5000);
      expect(await app.conversations.read('owner', id)).toEqual(before);
    }
  } finally { await app.close(); await f.cleanup(); }
});
