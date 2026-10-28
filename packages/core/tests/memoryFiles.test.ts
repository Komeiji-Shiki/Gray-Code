import path from 'node:path';
import { mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { ModelInput, PlatformMessage, WorkspaceDefinition } from '@graycode/contracts';
import type { ToolContext } from '@graycode/core';
import { PlatformApplication } from '../../../apps/server/src/application';
import { memoryRoots } from '../../../apps/server/src/memory/files';
import { BOT_CHANNEL_ACCESS, type BotChannelAccess } from '../../../apps/server/src/bots/channelAccess';
import { workspaceDirectoryKey } from '../../../apps/server/src/workspace/identity';
import { FileReadAccess } from '../../../apps/server/src/workspace/readAccess';
import { prepareExternalWrite } from '../../../apps/server/src/workspace/writeAccess';
import { changeNamespace, operationNamespace, type WorkspaceOperation } from '../../../apps/server/src/workspace/changes';
import { PlatformPromptService } from '../../../apps/server/src/prompt/service';
import { upgradeToolNames } from '../../../shared/toolNameUpgrades';
import { fixture } from './fixtures';

describe('文件长期记忆', () => {
  let f: Awaited<ReturnType<typeof fixture>>, app: PlatformApplication, workspace: WorkspaceDefinition;
  let generate: (input: ModelInput) => Promise<PlatformMessage>;
  beforeEach(async () => {
    f = await fixture(); await f.store.close();
    generate = async () => ({ role: 'model', parts: [{ text: '完成。' }] });
    app = await PlatformApplication.open({ dataDirectory: f.data, documentsDirectory: f.root,
      models: { generate: input => generate(input) } });
    workspace = { id: 'project', name: '记忆测试项目', directory: f.source, deviceId: 'local' };
    const draft = app.settings.snapshot();
    draft.settings.accounts.push({ id: 'visitor', displayName: '频道访客', role: 'member',
      effects: ['workspace_read', 'workspace_write'], workspaceIds: ['project'] });
    draft.settings.workspaces.push(workspace);
    await app.settings.save({ settings: draft.settings, expectedRevision: draft.revision });
  });
  afterEach(async () => { jest.restoreAllMocks(); await app.close(); await f.cleanup(); });

  const channel = async (id: string, channelId: string, direct = false, platform: 'discord' | 'onebot' = 'discord') => {
    await app.createConversation('owner', id, undefined, {}, [], { id });
    const value: BotChannelAccess = { version: 1,
      context: { platform, botId: 'fixture-bot', channelId, direct },
      participants: [{ actorId: 'owner', platformUserId: 'owner' }, { actorId: 'visitor', platformUserId: 'visitor' }] };
    await app.storage.putRecord({ namespace: BOT_CHANNEL_ACCESS, id, ownerId: id, value });
  };

  test('根解析统一覆盖主人、伙伴、故事、Bot频道、子代理及总开关', async () => {
    await app.createConversation('owner', '普通对话', undefined, {}, [], { id: 'ordinary' });
    await app.createConversation('owner', '伙伴对话', undefined,
      { platformMode: 'chat', companion: { characterId: 'fixture-character' } }, [], { id: 'companion' });
    await app.createConversation('owner', '角色故事', undefined, { platformMode: 'character' }, [], { id: 'story' });
    await channel('group', '120/中文');
    await channel('qq-group', '123', false, 'onebot');
    await channel('qq-dm', '123', true, 'onebot');
    const base = path.join(f.data, 'memory');
    const global = { label: 'global', directory: path.join(base, 'global') };
    const hash = createHash('sha256').update(workspaceDirectoryKey(f.source)!).digest('hex').slice(0, 12);
    const project = { label: 'project', directory: path.join(base, 'projects', `legacy-${hash}`) };
    const cases = [
      { actor: 'owner', id: 'ordinary', workspace, roots: [global, project] },
      { actor: 'owner', id: 'ordinary', roots: [global] },
      { actor: 'owner', id: 'companion', roots: [global] },
      { actor: 'owner', id: 'story', workspace, roots: [{ label: 'story', directory: path.join(base, 'characters', 'story') }] },
      { actor: 'owner', id: 'group', workspace, roots: [{ label: 'channel', directory: path.join(base, 'bots', 'discord-120___') }] },
      { actor: 'visitor', id: 'group', roots: [{ label: 'channel', directory: path.join(base, 'bots', 'discord-120___') }] },
      { actor: 'visitor', id: 'qq-group', roots: [{ label: 'channel', directory: path.join(base, 'bots', 'qq-123') }] },
      { actor: 'visitor', id: 'qq-dm', roots: [{ label: 'channel', directory: path.join(base, 'bots', 'qq-dm-123') }] },
      { actor: 'visitor', id: 'ordinary', workspace, roots: [] },
    ];
    for (const item of cases) expect(await memoryRoots(app, item.actor, item.id, item.workspace)).toEqual(item.roots);
    jest.spyOn(app.subagents, 'rootConversationId').mockImplementation(id => id === 'child' ? 'group' : id);
    expect(await memoryRoots(app, 'visitor', 'child', workspace)).toEqual(cases[5].roots);
    const draft = await app.product.draft(); await draft.settings.updateMemoryConfig({ enabled: false }); await app.product.save(draft);
    expect(await memoryRoots(app, 'owner', 'ordinary', workspace)).toEqual([]);
    expect(await memoryRoots(app, 'visitor', 'group')).toEqual([]);
  });

  test('频道访客只放行本频道真实路径，主人写全局记忆无需询问', async () => {
    await channel('own-channel', 'own'); await channel('other-channel', 'other');
    const [own] = await memoryRoots(app, 'visitor', 'own-channel');
    const [other] = await memoryRoots(app, 'visitor', 'other-channel');
    const [global] = await memoryRoots(app, 'owner', undefined);
    await Promise.all([own, other, global].map(root => mkdir(root.directory, { recursive: true })));
    await Promise.all([own, other].map(root => writeFile(path.join(root.directory, 'note.md'), '频道记忆')));
    await symlink(other.directory, path.join(own.directory, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    const draft = await app.product.draft();
    await draft.settings.updateToolConfig('read_file', { outsideWorkspaceAccess: 'deny' });
    await draft.settings.updateToolConfig('write_file', { outsideWorkspaceAccess: 'deny' });
    await app.product.save(draft);
    const context = (actorId: string): ToolContext => ({ runId: 'access', actorId, actor: app.actor(actorId)!,
      conversationId: 'own-channel', workspace, signal: new AbortController().signal,
      requestApproval: jest.fn(async () => true), progress() {}, askUser: jest.fn() });
    const visitor = context('visitor');
    const access = new FileReadAccess(app, visitor);
    expect(await access.resolve(path.join(own.directory, 'note.md'))).toBe(await realpath(path.join(own.directory, 'note.md')));
    await prepareExternalWrite(app, visitor, 'write_file', { path: path.join(own.directory, 'new.md') });
    expect(visitor.fileWriteGrants).toEqual([{ path: path.join(await realpath(own.directory), 'new.md'), recursive: false }]);
    await expect(access.resolve(path.join(other.directory, 'note.md'))).rejects.toThrow('工作区外');
    await expect(prepareExternalWrite(app, visitor, 'write_file', { path: path.join(other.directory, 'new.md') })).rejects.toThrow('工作区外');
    await expect(access.resolve(path.join(own.directory, 'escape', 'note.md'))).rejects.toThrow('工作区外');
    await expect(prepareExternalWrite(app, visitor, 'write_file', { path: path.join(own.directory, 'escape', 'new.md') })).rejects.toThrow('工作区外');
    expect(visitor.requestApproval).not.toHaveBeenCalled();
    const owner = context('owner'); owner.conversationId = undefined;
    await prepareExternalWrite(app, owner, 'write_file', { path: path.join(global.directory, 'preference.md') });
    expect(owner.fileWriteGrants).toHaveLength(1); expect(owner.requestApproval).not.toHaveBeenCalled();
  });

  test('会话首次读取的索引冻结，后续编辑不改变系统提示及历史前缀', async () => {
    const conversation = await app.createConversation('owner', '索引快照', undefined, {}, [], { id: 'snapshot' });
    const [global] = await memoryRoots(app, 'owner', conversation.id);
    await mkdir(global.directory, { recursive: true });
    await writeFile(path.join(global.directory, 'MEMORY.md'), '- [偏好](preference.md) — 首次索引内容\n');
    const agent = { ...app.settings.read('agents').agents[0], toolNames: ['read_file', 'write_file'] };
    const prepare = (history: PlatformMessage[]) => new PlatformPromptService(app).prepare({ actor: app.actor('owner')!, agent, conversation, history,
      request: { actorId: 'owner', agentId: agent.id, conversationId: conversation.id, requestKey: 'snapshot',
        message: { role: 'user', parts: [{ text: '继续' }] } } });
    const first = await prepare([]);
    await writeFile(path.join(global.directory, 'MEMORY.md'), '- [偏好](preference.md) — 后续改写内容\n');
    // 快照随首个回合的用户消息保存，进程重启后后续回合仍从历史中取回。
    const turn: PlatformMessage = { id: 'turn-1', role: 'user', parts: [{ text: '继续' }], isUserInput: true,
      ...('messageMetadata' in first ? first.messageMetadata : {}) };
    const second = await prepare([turn]);
    expect(first.systemPrompt).toContain(global.directory);
    expect(second.systemPrompt).toBe(first.systemPrompt);
    expect(second.promptContext?.beforeHistoryMessages).toEqual(first.promptContext?.beforeHistoryMessages);
    expect(JSON.stringify(second.promptContext?.beforeHistoryMessages)).toContain('首次索引内容');
    expect(JSON.stringify(second.promptContext?.beforeHistoryMessages)).not.toContain('后续改写内容');
    expect(JSON.stringify((await prepare([])).promptContext?.beforeHistoryMessages)).toContain('后续改写内容');
  });

  test('无工作区文件工具写读记忆，变更记录、审阅及逆向恢复使用临时根', async () => {
    const conversation = await app.createConversation('owner', '无工作区记忆', undefined, {}, [], { id: 'workspace-free' });
    const [global] = await memoryRoots(app, 'owner', conversation.id);
    const file = path.join(global.directory, 'preference.md'), text = '跨会话保存的偏好。';
    const draft = await app.product.draft();
    await draft.settings.updateApplyDiffConfig({ autoSave: false, autoApplyWithoutDiffView: false });
    await app.product.save(draft);
    let iteration = 0;
    generate = async () => {
      if (++iteration === 1) return { role: 'model', parts: [{ functionCall: {
        id: 'write-memory', name: 'write_file', args: { path: file, content: text },
      } }] };
      if (iteration === 2) return { role: 'model', parts: [{ functionCall: {
        id: 'read-memory', name: 'read_file', args: { files: [{ path: file }] },
      } }] };
      return { role: 'model', parts: [{ text: '文件记忆已保存并读回。' }] };
    };
    const run = await app.runtime.start({ actorId: 'owner', agentId: 'default', conversationId: conversation.id,
      requestKey: 'workspace-free-memory', message: { role: 'user', parts: [{ text: '保存并读取记忆' }] } });
    expect(await app.runtime.wait(run.id)).toMatchObject({ status: 'completed' });
    expect((await app.storage.readRunEvents(run.id)).some(event => event.type === 'diff.review.requested')).toBe(false);
    expect(await readFile(file, 'utf8')).toBe(text);
    expect((await app.storage.getRun(run.id))!.workspaceId).toBeUndefined();
    expect(app.settings.read('workspaces').workspaces.some(item => item.id === 'memory:global')).toBe(false);
    const messages = (await app.storage.readFullHistory(conversation.id)).messages;
    const responses = messages.flatMap(message => message.parts).flatMap(part => part.functionResponse
      ? [part.functionResponse as { name: string; response: Record<string, unknown> }] : []);
    expect(responses).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'write_file', response: expect.objectContaining({ success: true }) }),
      expect.objectContaining({ name: 'read_file', response: expect.objectContaining({ success: true }) }),
    ]));
    expect(JSON.stringify(responses.find(response => response.name === 'read_file'))).toContain(text);
    const changes = await app.storage.readRecordPage(changeNamespace, conversation.id, { limit: 10 });
    expect(changes).toHaveLength(1);
    const operation = changes[0].value as WorkspaceOperation;
    expect(operation.workspace).toMatchObject({ id: 'memory:global', directory: global.directory });
    const diffs = await app.diffs.list('owner', operation.workspace.id);
    expect(diffs).toHaveLength(1); expect(diffs[0].status).toBe('accepted');
    expect(JSON.stringify(await app.diffs.content('owner', diffs[0].id))).toContain(text);
    await expect(app.productUi.call({ actorId: 'owner', clientId: 'memory-file-review' }, 'diff.openPreview', {
      toolId: 'write-memory', id: diffs[0].id, conversationId: conversation.id,
    })).resolves.toEqual({ success: true });
    // 沿用现有中断恢复的逆向事务，确认临时工作区不依赖设置登记。
    await app.storage.putRecord({ namespace: operationNamespace, id: conversation.id, ownerId: conversation.id, value: operation });
    expect(await app.changes.recover()).toEqual({ recovered: [operation.id], conflicts: [] });
    await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('工具目录移除写记忆和工程日志，旧清单名称自然丢弃', () => {
    const removed = ['memory_remember', 'memory_revise', 'memory_remove', 'memory_summarize', 'engineering_log',
      'memory_wake', 'memory_note', 'memory_recall', 'memory_compress', 'memory_zoom', 'memory_forget', 'memory_config'];
    const names = app.tools.names();
    expect(names.filter(name => removed.includes(name))).toEqual([]);
    expect(names).toEqual(expect.arrayContaining(['memory_topics', 'memory_search', 'memory_read']));
    expect(upgradeToolNames(['read_file', ...removed, 'write_file'])).toEqual(['read_file', 'write_file']);
  });
});
