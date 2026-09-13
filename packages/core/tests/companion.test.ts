import { randomUUID } from 'node:crypto';
import type { CompanionConfiguration, CompanionTurn, ModelInput, PlatformMessage } from '@graycode/contracts';
import { PlatformApplication } from '../../../apps/server/src/application';
import { ApplicationRouter } from '../../../apps/server/src/transport/router';
import { fixture } from './fixtures';

describe('陪伴配置与真实记忆', () => {
  let f: Awaited<ReturnType<typeof fixture>>, app: PlatformApplication, router: ApplicationRouter, providerId: string, seen: ModelInput[];
  let generate: (input: ModelInput) => Promise<PlatformMessage>;
  const client = { actorId: 'owner', clientId: 'companion-test' };
  const config: CompanionConfiguration = { enabled: true, name: '青禾', userName: '主人', tone: '自然轻松地交流，讨论项目时保持具体。' };
  const open = async () => {
    app = await PlatformApplication.open({ dataDirectory: f.data, documentsDirectory: f.root, models: { generate: async input => { seen.push(input); return generate(input); } } });
    router = new ApplicationRouter(app);
  };
  const save = async (id?: string, configuration = config, saveAsDefault = false) => {
    const value = await router.call(client, 'companion.get', { conversationId: id }) as any;
    return await router.call(client, 'companion.save', { conversationId: id, configuration, metadataToken: value.metadataToken,
      defaultsRevision: value.defaultsRevision, saveAsDefault }) as { conversationId: string };
  };
  const run = async (id: string, text: string) => {
    const record = await app.runtime.start({ actorId: 'owner', agentId: 'default', providerId, conversationId: id, requestKey: randomUUID(), message: { role: 'user', parts: [{ text }] } });
    expect((await app.runtime.wait(record.id))?.status).toBe('completed'); return record;
  };
  beforeEach(async () => {
    f = await fixture(); await f.store.close(); seen = []; generate = async () => ({ role: 'model', parts: [{ text: '收到。' }] }); await open();
    const draft = await app.product.draft(); providerId = await draft.configs.createConfig({ name: '陪伴测试', type: 'openai', url: 'http://127.0.0.1:1/v1', model: 'fixture', apiKey: '', enabled: true, contextManagementEnabled: false, timeout: 1000 }); await app.product.save(draft);
  });
  afterEach(async () => { await app.close(); await f.cleanup(); });

  test('当前对话保存与默认配置保持账号归属，重启后仅新建普通对话继承', async () => {
    const original = await app.createConversation('owner', '原有项目', undefined, { platformMode: 'chat' });
    await app.storage.appendHistory(original.id, [{ role: 'user', id: 'existing-message', parts: [{ text: '已有对话内容' }] }]);
    const stale = await router.call(client, 'companion.get', { conversationId: original.id }) as any;
    expect((await save(original.id, config, true)).conversationId).toBe(original.id);
    expect((await app.storage.readFullHistory(original.id)).messages).toHaveLength(1);
    await expect(router.call(client, 'companion.save', { conversationId: original.id, configuration: config, metadataToken: stale.metadataToken })).rejects.toThrow();
    await app.close(); await open();
    const next = await app.createConversation('owner', '新的普通对话', undefined, { platformMode: 'chat' }, [], { automaticWorkspace: true });
    expect((next.custom as any).companion.configuration.name).toBe('青禾');
    await run(next.id, '请记住下次继续我们的话题。');
    const nextAccess = await app.longMemory.access('owner', { conversationId: next.id });
    expect(seen.at(-1)?.messages.filter(message => message.memoryContext).flatMap(message => message.parts.map(part => part.text)).join('')).toContain(nextAccess.scopes.find(scope => scope.kind === 'personal')!.id);
    const code = await app.createConversation('owner', '代码', undefined, { platformMode: 'code' }, [], { automaticWorkspace: true });
    expect((code.custom as any).companion).toBeUndefined();
    const accounts = app.settings.snapshot(); accounts.settings.accounts.push({ id: 'member', displayName: '隔离账号', role: 'member', effects: [], workspaceIds: [] });
    await app.settings.save({ settings: accounts.settings, expectedRevision: accounts.revision });
    const other = await app.createConversation('member', '其他账号', undefined, { platformMode: 'chat' });
    await expect(router.call(client, 'companion.get', { conversationId: other.id })).rejects.toThrow('当前账号');
    await expect(router.call({ actorId: 'member', clientId: 'member' }, 'companion.save', { conversationId: other.id, configuration: config })).rejects.toThrow();
    const defaults = await app.companion.defaults('owner'); await router.call(client, 'companion.defaults.clear', { defaultsRevision: defaults.revision });
    expect((await app.companion.forNewConversation('owner', { platformMode: 'chat' }))?.companion).toBeUndefined();
    expect((await app.conversation('owner', next.id)).custom).toHaveProperty('companion');
  });

  test('实际请求包含角色语气与真实记忆，不加载角色剧情，旧回合保留配置快照', async () => {
    const card = await app.characters.import({ name: '青禾.json', data: Buffer.from(JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', data: { name: '卡片名', personality: '温柔而有条理', description: '虚构身份：月宫来客', scenario: '月宫生活三百年', first_mes: '虚构开场白', system_prompt: 'PRIVATE_CARD_SYSTEM' } })).toString('base64') });
    const current = await save(undefined, { ...config, characterId: card.id });
    const access = await app.longMemory.access('owner', { conversationId: current.conversationId }); const scope = access.scopes.find(value => value.kind === 'personal')!;
    expect(scope.realm).toBe('real');
    await app.longMemory.remember(access, { scopeId: scope.id, kind: 'preference', text: '我喜欢用薄荷茶放松。', topic: ['个人', '饮品'] });
    await run(current.conversationId, '还记得我喜欢喝什么茶吗？');
    const input = JSON.stringify(seen.at(-1));
    expect(input).toContain('温柔而有条理'); expect(input).toContain('薄荷茶'); expect(input).toContain('青禾');
    expect(input).not.toContain('月宫生活三百年'); expect(input).not.toContain('PRIVATE_CARD_SYSTEM'); expect(input).not.toContain('虚构开场白');
    const source = (await app.storage.readFullHistory(current.conversationId)).messages.find(message => message.isUserInput)!;
    const turn = source.companionTurn as CompanionTurn; expect(turn.resource?.id).toBe(card.id); expect(source.characterTurn).toBeUndefined();
    await save(current.conversationId, { ...config, name: '新名字' });
    const conversation = await app.conversation('owner', current.conversationId);
    expect((await app.companion.capture('owner', conversation, source))?.identity.name).toBe('青禾');
    expect(await app.companion.capture('member', conversation, source)).toBeUndefined();
    expect((await app.companion.capture('owner', conversation))?.identity.name).toBe('新名字');
  });

  test('自然记忆工具可跨陪伴对话记录、纠正与删除约定', async () => {
    const first = await save(undefined, config, true);
    const access = await app.longMemory.access('owner', { conversationId: first.conversationId }); const scope = access.scopes.find(value => value.kind === 'personal')!;
    let iteration = 0; generate = async () => ++iteration === 1 ? { role: 'model', parts: [{ functionCall: { id: 'remember', name: 'memory_remember', args: { scopeId: scope.id, text: '下次继续聊银杏项目的画面设置。', kind: 'event', topic: ['约定', '银杏项目'], quote: '下次继续聊银杏项目的画面设置。' } } }] } : { role: 'model', parts: [{ text: '已记住。' }] };
    await run(first.conversationId, '请记住：下次继续聊银杏项目的画面设置。');
    const saved = (await app.longMemory.search(access, { text: '银杏项目' })).hits[0].record;
    const second = await app.createConversation('owner', '继续陪伴话题', undefined, { platformMode: 'chat' }, [], { automaticWorkspace: true });
    generate = async () => ({ role: 'model', parts: [{ text: '继续。' }] }); await run(second.id, '上次说要继续聊银杏项目的什么？');
    expect(JSON.stringify(seen.at(-1))).toContain('画面设置');
    const nextAccess = await app.longMemory.access('owner', { conversationId: second.id });
    const revised = await app.longMemory.revise(nextAccess, { scopeId: scope.id, id: saved.id, expectedVersion: saved.version, text: '改为讨论银杏项目的快捷键。' });
    await run(second.id, '银杏项目最新的约定是什么？'); expect(JSON.stringify(seen.at(-1))).toContain('快捷键');
    const current = revised.records[0]; await app.longMemory.remove(nextAccess, { scopeId: scope.id, id: current.id, expectedVersion: current.version, action: 'delete' });
    await run(second.id, '请确认，忘记的银杏项目约定不要复述。'); expect(JSON.stringify(seen.at(-1))).not.toContain('改为讨论银杏项目的快捷键');
  });

  test('角色对话切回普通对话后，旧剧情和该回合工具结果不能进入真实记忆', async () => {
    const story = await app.createConversation('owner', '剧情', undefined, { platformMode: 'character' }, [
      { id: 'story-user', role: 'user', actorId: 'owner', isUserInput: true, characterMode: true, parts: [{ text: '我的家在月宫。' }] },
      { id: 'story-tool', role: 'user', parts: [{ functionResponse: { id: 'story-tool-call', name: 'scene_lookup', response: { city: '月宫' } } }] },
    ]);
    await router.call(client, 'ui.request', { type: 'ui.mode.select', data: { mode: 'chat', conversationId: story.id } });
    const access = await app.longMemory.access('owner', { conversationId: story.id }); const scope = access.scopes.find(value => value.kind === 'personal')!;
    const context = { actorId: 'owner', conversationId: story.id, runId: 'origin-check', signal: new AbortController().signal } as any;
    for (const sourceMessageId of ['story-user', 'story-tool']) await expect(app.longMemory.remember(access, { scopeId: scope.id, text: '用户住在月宫。', sourceMessageId }, context)).rejects.toThrow('角色剧情');
    const real = (await app.longMemory.remember(access, { scopeId: scope.id, text: '这是管理页明确保存的真实记录。' })).records[0];
    await expect(app.longMemory.revise(access, { scopeId: scope.id, id: real.id, expectedVersion: real.version, text: '用户住在月宫。', sourceMessageId: 'story-user' }, context)).rejects.toThrow('角色剧情');
    const policy = await app.longMemory.policies.get('owner'); await app.longMemory.policies.save('owner', { ...policy.value, providerId, model: 'fixture' }, policy.revision);
    expect(await app.longMemory.background.enqueueConversation('owner', story.id, scope.id)).toBeNull(); expect(seen).toHaveLength(0);
  });
});
