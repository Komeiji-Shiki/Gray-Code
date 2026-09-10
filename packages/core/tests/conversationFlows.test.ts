import { PlatformApplication } from '../../../apps/server/src/application';
import { ApplicationRouter } from '../../../apps/server/src/transport/router';
import type { ModelInput } from '@graycode/contracts';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fixture } from './fixtures';

describe('original UI history operations on the independent core', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let app: PlatformApplication;
  let router: ApplicationRouter;
  let channelId: string;
  let calls: ModelInput[];
  let toolExecutions: number;
  const client = { actorId: 'owner', clientId: 'history-ui' };
  const call = (type: string, data = {}) => router.call(client, 'ui.request', { type, data }) as Promise<any>;
  const history = () => app.storage.readFullHistory('conversation');
  async function run(type: string, data: Record<string, unknown>) {
    const result = await call(type, { configId: channelId, conversationId: 'conversation', ...data });
    expect(await app.runtime.wait(result.runId)).toMatchObject({ status: 'completed' });
    return result;
  }
  beforeEach(async () => {
    calls = []; toolExecutions = 0; f = await fixture(); await f.store.close();
    app = await PlatformApplication.open({ dataDirectory: f.data, models: { generate: async input => {
      calls.push(input);
      return input.messages.some(message => message.parts.some(part => part.functionResponse))
        ? { role: 'model', parts: [{ text: `answer-${calls.length}` }], modelVersion: 'fixture' }
        : { role: 'model', parts: [{ functionCall: { id: 'file-list', name: 'workspace_files', args: { action: 'list', path: '.' } } }] };
    } } });
    app.subscribe(event => { if (event.type === 'event' && (event.event as any).type === 'tool.started') toolExecutions++; });
    router = new ApplicationRouter(app);
    const snapshot = app.settings.snapshot();
    snapshot.settings.workspaces.push({ id: 'workspace', name: 'Fixture', directory: f.source, deviceId: 'local' });
    await app.settings.save({ settings: snapshot.settings, expectedRevision: snapshot.revision });
    await call('ui.settings.begin'); channelId = await call('config.createConfig', { name: 'Fixture', type: 'openai' });
    await call('config.updateConfig', { configId: channelId, updates: { model: 'fixture' } });
    await call('ui.settings.save'); await call('ui.settings.end');
    await call('ui.context.set', { workspaceId: 'workspace', mode: 'code' });
    await call('conversation.createConversation', { conversationId: 'conversation' });
  });
  afterEach(async () => { await app.close(); await f.cleanup(); });

  test('reroll preserves the original branch and tool identities, and continuation never replays previous tools', async () => {
    await run('chatStream', { streamId: 'first', messageId: 'user-one', message: 'List files' });
    const first = await history();
    const oldReply = first.messages.at(-1)!;
    await app.checkpoints.create('owner', 'conversation', { messageId: oldReply.id });
    const retried = await run('chat.rerollStream', { streamId: 'reroll', assistantNodeId: oldReply.id });
    const second = await history(); const newReply = second.messages.at(-1)!;
    expect(await call('chat.rerollStream', { configId: channelId, conversationId: 'conversation', streamId: 'reroll', assistantNodeId: oldReply.id })).toMatchObject({ runId: retried.runId });
    const models = app.models;
    await app.close(); app = await PlatformApplication.open({ dataDirectory: f.data, models }); router = new ApplicationRouter(app);
    expect(newReply.id).not.toBe(oldReply.id); expect(toolExecutions).toBe(1);
    const graph = (await call('conversation.getBranchGraph', { conversationId: 'conversation' })).graph;
    expect(graph.nodes[newReply.id!].kind).toBe('reroll'); expect(graph.nodes[oldReply.id!]).toBeDefined();
    await call('conversation.switchBranchCandidate', { conversationId: 'conversation', nodeId: oldReply.id, mode: 'chat-only' });
    expect((await history()).messages.map(message => message.parts)).toEqual(first.messages.map(message => message.parts));
    expect((await history()).messages[2].id).toBe(first.messages[2].id);
    expect((await history()).messages[0].turnDynamicContext).toBe(first.messages[0].turnDynamicContext);
    await call('conversation.switchBranchCandidate', { conversationId: 'conversation', nodeId: newReply.id, mode: 'chat-only' });
    await run('retryStream', { streamId: 'continue' });
    expect(toolExecutions).toBe(1);
    expect((await history()).messages.filter(message => message.isUserInput)).toHaveLength(1);
    expect(calls.at(-1)?.promptContext).toEqual(calls[0].promptContext);
    await expect(call('conversation.switchBranchCandidate', { conversationId: 'conversation', nodeId: oldReply.id, mode: 'chat-and-workspace' })).resolves.toMatchObject({ success: true });
    const failures: any[] = [];
    app.subscribe(event => { if (event.type === 'ui.message' && (event.message as any)?.data?.type === 'error') failures.push(event.message); });
    jest.spyOn(app.models, 'generate').mockRejectedValueOnce(new Error('fixture upstream disconnected'));
    const failed = await call('retryStream', { configId: channelId, conversationId: 'conversation', streamId: 'failed-continuation' });
    expect((await app.runtime.wait(failed.runId))?.status).toBe('failed');
    expect(failures.at(-1)?.data.error).toMatchObject({ code: 'API_ERROR', message: 'fixture upstream disconnected' });
    await run('retryStream', { streamId: 'recover-continuation' });
    expect(toolExecutions).toBe(1);
  });

  test('editing a user candidate keeps the previous subtree, supports root edits and restores a transactional snapshot', async () => {
    await run('chatStream', { streamId: 'first-edit', messageId: 'root', message: 'First' });
    await run('chatStream', { streamId: 'second-edit', messageId: 'follow-up', message: 'Old question' });
    const original = await history();
    await run('chat.editBranchStream', { streamId: 'edit', userNodeId: 'follow-up', newText: 'Edited question', attachments: [] });
    const edited = await history();
    expect(edited.messages.at(-2)?.parts[0].text).toBe('Edited question');
    expect(edited.messages.at(-2)?.id).not.toBe('follow-up');
    await call('conversation.switchBranchCandidate', { conversationId: 'conversation', nodeId: 'follow-up', mode: 'chat-only' });
    expect((await history()).messages.map(message => message.parts)).toEqual(original.messages.map(message => message.parts));
    await run('chat.editBranchStream', { streamId: 'root-edit', userNodeId: 'root', newText: 'New root question', attachments: [] });
    expect((await history()).messages[0]).toMatchObject({ id: 'root', parts: [{ text: 'New root question' }] });
    const rootGraph = (await call('conversation.getBranchGraph', { conversationId: 'conversation' })).graph;
    expect(rootGraph.nodes.root.kind).not.toBe('edit');
    expect(rootGraph.nodes[rootGraph.nodes.root.activeChildId].kind).toBe('reroll');
    expect(rootGraph.nodes[original.messages[1].id!]).toBeDefined();
    const beforeRemove = await history();
    const result = await call('deleteSingleMessage', { conversationId: 'conversation', targetIndex: 1, messageId: beforeRemove.messages[1].id });
    expect((await history()).messages.some(message => message.isFunctionResponse)).toBe(false);
    const current = await history();
    await app.conversations.restoreSnapshot('owner', 'conversation', result.snapshotId, current.revision);
    expect((await history()).messages.map(message => message.parts)).toEqual(beforeRemove.messages.map(message => message.parts));
    expect((await app.storage.verify()).ok).toBe(true);
  });

  test('stale delete cannot cancel active work, while an explicit valid delete waits for cancellation', async () => {
    await run('chatStream', { streamId: 'first-delete', messageId: 'initial', message: 'First' });
    let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
    jest.spyOn(app.models, 'generate').mockImplementationOnce(input => new Promise((_resolve, reject) => {
      entered(); input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true });
    }));
    const running = await call('chatStream', { conversationId: 'conversation', configId: channelId, streamId: 'waiting', messageId: 'pending', message: 'Wait' });
    await started;
    await expect(call('deleteMessage', { conversationId: 'conversation', targetIndex: 0, messageId: 'wrong' })).rejects.toThrow('MESSAGE_CHANGED');
    expect((await app.storage.getRun(running.runId))?.status).toBe('running');
    const page = await history();
    await call('deleteMessage', { conversationId: 'conversation', targetIndex: page.messages.length - 1, messageId: 'pending' });
    expect((await app.storage.getRun(running.runId))?.status).toBe('cancelled');
    expect((await history()).messages.some(message => message.id === 'pending')).toBe(false);
  });

  test('分支对应存档可恢复文件，未确认、过期确认和恢复失败都保留草稿及历史', async () => {
    await fs.writeFile(path.join(f.source, 'branch.txt'), '原分支文件');
    await run('chatStream', { streamId: 'workspace-first', message: 'First' });
    const original = await history(); const oldReply = original.messages.at(-1)!;
    const checkpoint = await app.checkpoints.create('owner', 'conversation', { messageId: oldReply.id });
    await run('chat.rerollStream', { streamId: 'workspace-reroll', assistantNodeId: oldReply.id });
    const before = await history();
    const graph = (await call('conversation.getBranchGraph', { conversationId: 'conversation' })).graph;
    expect(graph.nodes[oldReply.id!]).toMatchObject({ hasWorkspaceState: true, workspaceCheckpointId: checkpoint.id });
    expect((await app.checkpoints.summaries('owner', 'conversation')).checkpoints.some(item => item.id === checkpoint.id)).toBe(false);
    await fs.writeFile(path.join(f.source, 'branch.txt'), '新分支文件');
    const workspace = app.workspace('owner', 'workspace', ['workspace_write']);
    const document = await app.files.openDocument(workspace, 'branch.txt', 'editor');
    const draft = await app.files.updateDocument(workspace, 'branch.txt', 'editor', '尚未保存的草稿', document.version);
    const options = { conversationId: 'conversation', nodeId: oldReply.id, mode: 'chat-and-workspace' };
    expect(await call('conversation.switchBranchCandidate', options)).toMatchObject({ success: false, dirtyFiles: ['branch.txt'] });
    expect(await history()).toEqual(before);
    expect(await call('conversation.switchBranchCandidate', { ...options, confirmedDiscardDirty: true, confirmedDirtyFiles: ['wrong.txt'] }))
      .toMatchObject({ success: false, error: 'STALE_DIRTY_CONFIRMATION' });
    const failure = jest.spyOn(app.changes, 'perform').mockRejectedValueOnce(new Error('恢复前中断'));
    await expect(call('conversation.switchBranchCandidate', { ...options, confirmedDiscardDirty: true, confirmedDirtyFiles: ['branch.txt'] })).rejects.toThrow('恢复前中断');
    failure.mockRestore();
    expect(app.files.clientDocuments('editor', 'workspace')).toEqual([draft]);
    expect(await fs.readFile(path.join(f.source, 'branch.txt'), 'utf8')).toBe('新分支文件');
    expect(await history()).toEqual(before);
    const resets: any[] = [];
    app.subscribe(event => { if (event.type === 'document.reset') resets.push(event); });
    expect(await call('conversation.switchBranchCandidate', { ...options, confirmedDiscardDirty: true, confirmedDirtyFiles: ['branch.txt'] })).toMatchObject({ success: true });
    expect(await fs.readFile(path.join(f.source, 'branch.txt'), 'utf8')).toBe('原分支文件');
    expect((await history()).messages.map(item => item.id)).toEqual(original.messages.map(item => item.id));
    expect(app.files.clientDocuments('editor', 'workspace')[0]).toMatchObject({ text: '原分支文件', dirty: false, version: draft.version + 1 });
    expect(resets[0]).toMatchObject({ clientId: 'editor', previousText: '尚未保存的草稿', document: { text: '原分支文件' } });
  });

  test('软删除整棵候选、恢复与彻底删除保持其他候选及工具配对', async () => {
    await run('chatStream', { streamId: 'purge-first', message: 'First' });
    const oldReply = (await history()).messages.at(-1)!;
    await run('chatStream', { streamId: 'purge-follow', messageId: 'follow-up', message: 'Follow' });
    await run('chat.rerollStream', { streamId: 'purge-reroll', assistantNodeId: oldReply.id });
    const current = await history();
    const target = { conversationId: 'conversation', nodeId: oldReply.id };
    await expect(call('conversation.purgeBranchCandidate', target)).rejects.toThrow('先软删除');
    await call('conversation.renameBranchCandidate', { ...target, label: '原来的回答' });
    await call('conversation.deleteBranchCandidate', target);
    expect((await call('conversation.getBranchGraph', target)).graph.nodes['follow-up'].deleted).toBe(true);
    await call('conversation.restoreBranchCandidate', target);
    expect((await call('conversation.getBranchGraph', target)).graph.nodes['follow-up'].deleted).not.toBe(true);
    await call('conversation.deleteBranchCandidate', target);
    expect(await call('conversation.purgeBranchCandidate', target)).toMatchObject({ success: true, purged: true, prunedNodeCount: 3 });
    expect(await call('conversation.purgeBranchCandidate', target)).toMatchObject({ success: true, purged: false });
    expect((await call('conversation.getBranchGraph', target)).graph.nodes[oldReply.id!]).toBeUndefined();
    expect((await history()).messages).toEqual(current.messages);
  });

  test('原地编辑保留附件身份与图片处理方式，更新角色显示并清空旧计数', async () => {
    const attachment = { id: 'note-one', name: '笔记.txt', mimeType: 'text/plain', data: Buffer.from('附件原字节').toString('base64') };
    await run('chatStream', { streamId: 'metadata-send', messageId: 'metadata-user', message: '原文', attachments: [attachment], deepSeekVisionTileSplit: false });
    const state = await app.conversations.read('owner', 'conversation');
    expect(state.history.messages[0]).toMatchObject({ deepSeekVisionTileSplit: false, parts: [{ inlineData: attachment }, { text: '原文' }] });
    state.history.messages[0].tokenCountByChannel = { stale: 900 };
    state.history.messages[0].characterTurn = { macros: { char: '灰魂' }, rules: [] };
    state.history.messages[0].characterOriginalParts = [{ text: '旧原文' }];
    state.history.messages[0].characterDisplayParts = [{ text: '旧显示' }];
    await app.storage.commitConversation({ conversationId: 'conversation', expectedRevision: state.history.revision, messages: state.history.messages });
    const callsBefore = calls.length;
    const result = await call('chat.editBranchStream', { conversationId: 'conversation', streamId: 'metadata-keep', userNodeId: 'metadata-user', newText: '你好 {{char}}', mode: 'keep' });
    expect(result.userContent).toMatchObject({ tokenCountByChannel: {}, deepSeekVisionTileSplit: false,
      parts: [{ inlineData: attachment }, { text: '你好 灰魂' }], characterDisplayParts: [{ inlineData: attachment }, { text: '你好 灰魂' }] });
    expect(result.userContent.characterOriginalParts).toEqual([{ inlineData: attachment }, { text: '你好 {{char}}' }]);
    expect((await history()).messages.slice(1)).toEqual(state.history.messages.slice(1));
    expect(calls.length).toBe(callsBefore);
    await call('chat.editBranchStream', { conversationId: 'conversation', streamId: 'remove-attachment', userNodeId: 'metadata-user', newText: '只保留文字', attachments: [], mode: 'keep', deepSeekVisionTileSplit: true });
    expect((await history()).messages[0]).toMatchObject({ parts: [{ text: '只保留文字' }], deepSeekVisionTileSplit: true });
  });

  test('超过检查点数量时清理不会等待创建自身持有的文件锁', async () => {
    await call('ui.settings.begin');
    await call('checkpoint.updateConfig', { config: { maxCheckpoints: 1 } });
    await call('ui.settings.save'); await call('ui.settings.end');
    await app.checkpoints.create('owner', 'conversation');
    await app.checkpoints.create('owner', 'conversation');
    expect(await app.checkpoints.list('owner', 'conversation')).toHaveLength(1);
  });
});
