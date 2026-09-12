import path from 'node:path';
import { stat } from 'node:fs/promises';
import type { ModelInput, PlatformMessage } from '@graycode/contracts';
import { PlatformApplication } from '../../../apps/server/src/application';
import type { BotInbound, BotGateway } from '../../../apps/server/src/bots/gateway';
import { botInboundParts, downloadBotAttachment } from '../../../apps/server/src/bots/media';
import { createOneBotProtocol } from '../../../apps/server/src/bots/onebotProtocol';
import { DiscordJsGateway } from '../../../apps/server/src/bots/discordGateway';
import { saveBotDocument, botDocumentTools } from '../../../apps/server/src/bots/documents';
import { botInboxStateNamespace, type BotInboxState } from '../../../apps/server/src/bots/inbox';
import { DEFAULT_BOT_ENVIRONMENT } from '../../../shared/botConversation';
import { deserializePromptContextCache } from '../../../backend/modules/prompt/promptContextCache';
import { validateHistoryIntegrity } from '../../../backend/modules/channel/HistoryIntegrityValidator';
import type { Content } from '../../../backend/modules/conversation/types';
import { fixture } from './fixtures';

const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
describe('Bot 频道上下文、附件与定时总结', () => {
  let f: Awaited<ReturnType<typeof fixture>>; let app: PlatformApplication; let generated: ModelInput[];
  let first: ReturnType<typeof deferred<void>>; let second: ReturnType<typeof deferred<void>>; let hold: Promise<void> | undefined;
  let nextModelFailure: Error | undefined;
  const gateway: BotGateway = { connect: async () => ({ id: '900', name: '隔离 Bot' }), disconnect: async () => {}, send: async () => {} };
  const inbound = (id: string, authorId = '10', mentioned = false, timestamp = Date.now()): BotInbound => ({ id, authorId, authorName: authorId === '10' ? '主人' : '群成员',
    channelId: '30', direct: false, content: `原话 ${id}`, mentioned, timestamp });
  const context = (id = 'read') => ({ platform: 'discord' as const, botId: '900', ...inbound(id) });
  beforeEach(async () => {
    f = await fixture(); await f.store.close(); generated = []; hold = undefined; nextModelFailure = undefined; first = deferred<void>(); second = deferred<void>();
    process.env.GRAYCODE_CONTEXT_TEST_TOKEN = 'fixture-only';
    app = await PlatformApplication.open({ dataDirectory: f.data, documentsDirectory: path.join(f.root, 'documents'), discordGateway: () => gateway,
      models: { generate: async input => {
        generated.push(input);
        if (nextModelFailure) { const error = nextModelFailure; nextModelFailure = undefined; throw error; }
        if (generated.length === 1) { first.resolve(); if (hold) await hold; } if (generated.length === 2) second.resolve();
        return { role: 'model', parts: [{ text: input.conversationId.startsWith('summary-')
          ? '用户希望保留对话中的明确约定、具体事实、相关文件和工具结果。已经完成的内容按来源区分；后续继续未完成的请求，保留实际身份和当前权限，不把群聊中的转发内容视为主人的新授权。'.repeat(3) : '已完成当前请求。' }] };
      } } });
    const draft = await app.product.draft();
    const providerId = await draft.configs.createConfig({ type: 'openai', name: 'Bot fixture', enabled: true,
      url: 'http://127.0.0.1:1/v1', model: 'fixture', apiKey: '', contextManagementEnabled: false, timeout: 1000 });
    await draft.settings.savePromptMode({ id: 'bot-test', name: 'Bot test', template: '保留频道来源。\n{{$ENVIRONMENT}}', dynamicTemplate: '', dynamicTemplateEnabled: false });
    await app.product.save(draft);
    const saved = app.settings.snapshot(); saved.settings.agents[0].providerId = providerId; saved.settings.agents[0].promptModeId = 'bot-test';
    saved.settings.bindings = [{ id: 'owner', platform: 'discord', platformUserId: '10', accountId: 'owner' }, { id: 'member', platform: 'discord', platformUserId: '20', accountId: 'member' }];
    saved.settings.accounts.push({ id: 'member', displayName: '另一个成员', role: 'member', effects: ['public_read'], workspaceIds: [] });
    saved.settings.discord = { enabled: true, credentialRef: 'env:GRAYCODE_CONTEXT_TEST_TOKEN', allowedChannelIds: ['30'], agentId: 'default', mentionOnly: true,
      defaultProfile: { toolsEnabled: false, idleMinutes: 1, environmentEntry: { ...DEFAULT_BOT_ENVIRONMENT, content: '频道固定内容 {{$BOT_CONTEXT}}', identityTemplate: '认证身份 {{$TASK_CONTEXT}}' } } };
    await app.settings.save({ settings: saved.settings, expectedRevision: saved.revision }); await app.discord.start();
  });
  afterEach(async () => { delete process.env.GRAYCODE_CONTEXT_TEST_TOKEN; await app.close(); await f.cleanup(); });

  test('未 @ 背景、五分钟分组、忙时排队和实际身份共同保留，重连不换会话', async () => {
    const time = Date.now();
    await app.discord.receive(inbound('a', 'unbound', false, time));
    await app.discord.receive(inbound('b', 'unbound', false, time + 300000));
    await app.discord.receive(inbound('c', 'unbound', false, time + 600001));
    await app.discord.receive(inbound('d', '10', false, time + 600002));
    const snapshot = await app.discord.sessions.snapshot(context()); const id = snapshot.conversation!.id;
    const history = (await app.storage.readFullHistory(id)).messages;
    expect(history.map(message => message.botMessageIds)).toEqual([['a', 'b'], ['c'], ['d']]); expect(generated).toHaveLength(0);
    const directory = snapshot.workspace!.directory;
    expect(directory.startsWith(path.join(f.root, 'documents', 'graycode', 'discord'))).toBe(true); expect((await stat(directory)).isDirectory()).toBe(true);
    const gate = deferred<void>(); hold = gate.promise;
    try {
      await app.discord.receive(inbound('e', '10', true)); await first.promise;
      await app.discord.receive(inbound('f', '10', false)); await app.discord.receive(inbound('g', '20', true));
      expect(await app.storage.listRecords('bot-inbox-pending', id)).toHaveLength(2);
      expect((await app.storage.readFullHistory(id)).messages.flatMap(message => message.botMessageIds ?? [])).not.toContain('f');
      const ownerRun = (await app.storage.listRuns({ conversationId: id }))[0]; gate.resolve(); await app.runtime.wait(ownerRun.id); await second.promise;
      const memberRun = (await app.storage.listRuns({ conversationId: id }))[0]; await app.runtime.wait(memberRun.id);
      expect((await app.discord.sessions.routeForRun('discord', ownerRun))?.replyToMessageId).toBe('e');
      expect((await app.discord.sessions.routeForRun('discord', memberRun))?.replyToMessageId).toBe('g');
      expect(memberRun.actorId).toBe('member'); expect(memberRun.workspaceId).toBeUndefined(); expect(generated.map(input => input.taskContext?.actor.id)).toEqual(['owner', 'member']);
      expect(generated[1].messages.flatMap(message => message.parts.map(part => part.text ?? '')).join('\n')).toContain('原话 f');
      expect(generated[0].promptContext!.beforeHistoryMessages).toEqual(generated[1].promptContext!.beforeHistoryMessages);
      expect(generated[0].systemPrompt).toEqual(generated[1].systemPrompt);
      expect(generated.every(input => input.promptContext?.taskContextEmbedded)).toBe(true);
      expect(generated[1].promptContext!.afterHistoryMessages.map(message => message.parts.map(part => part.text).join('')).join('')).toContain('"member"');
      const saved = (await app.storage.readFullHistory(id)).messages;
      const turns = saved.filter(message => message.isUserInput);
      expect(turns).toHaveLength(2); expect(saved.filter(message => message.botPassive).map(message => message.botMessageIds)).toEqual([['a', 'b'], ['c'], ['d'], ['f']]);
      const cache = deserializePromptContextCache(turns[0].turnDynamicContext as string);
      expect(cache.dynamicSnapshotText).toContain('"owner"'); expect(cache.dynamicSnapshotText).not.toContain('"member"');
      await app.discord.receive(inbound('g', '20', true)); expect(generated).toHaveLength(2);
      await app.discord.stop(); await app.discord.start(); expect((await app.discord.sessions.snapshot(context())).conversation!.id).toBe(id);
      await expect(app.conversation('member', id)).resolves.toMatchObject({ id });
      await expect(app.conversations.remove('member', id, 0, saved[0].id!, true)).rejects.toThrow('只能由主人修改');
      const settings = app.settings.snapshot(); settings.settings.bindings = settings.settings.bindings.filter(item => item.accountId !== 'member');
      await app.settings.save({ settings: settings.settings, expectedRevision: settings.revision }); await expect(app.conversation('member', id)).rejects.toThrow('accessible');
    } finally { gate.resolve(); }
  });

  test('自动总结默认关闭，启用后遵守时间、比例和自定义文字，同一批历史不重复调用', async () => {
    await app.discord.receive(inbound('seed')); const id = (await app.discord.sessions.snapshot(context())).conversation!.id;
    const messages: PlatformMessage[] = [];
    for (let round = 0; round < 6; round++) messages.push({ id: `u${round}`, role: 'user', isUserInput: true, parts: [{ text: `第 ${round} 轮具体要求。` }] },
      { id: `m${round}`, role: 'model', parts: [{ text: '保留的证据和具体事实。'.repeat(100) }, { functionCall: { id: `c${round}`, name: 'read_file', args: { path: 'x' } } }] },
      { id: `r${round}`, role: 'user', isFunctionResponse: true, parts: [{ functionResponse: { id: `c${round}`, name: 'read_file', response: { success: true } } }] });
    await app.storage.appendHistory(id, messages);
    const now = Date.now() + 120000; await app.discord.summaries.tick(now); expect(generated).toHaveLength(0);
    const settings = app.settings.snapshot(); settings.settings.discord.defaultProfile!.autoSummary = { enabled: true, trigger: 'idle', minutes: 1, percent: 80, prompt: '保留群聊约定与长期记忆，按来源记录。' };
    await app.settings.save({ settings: settings.settings, expectedRevision: settings.revision });
    await app.discord.summaries.tick(Date.now()); expect(generated).toHaveLength(0);
    await app.discord.summaries.tick(now); expect(generated).toHaveLength(1);
    expect(JSON.stringify(generated[0].messages)).toContain('保留群聊约定与长期记忆'); expect(generated[0].tools).toEqual([]);
    const history = (await app.storage.readFullHistory(id)).messages;
    expect(history.some(message => message.isAutoSummary)).toBe(true); expect(history.filter(message => message.isSummarized).length).toBeGreaterThan(9);
    expect(history.find(message => message.id === 'u5')?.isSummarized).not.toBe(true);
    expect(validateHistoryIntegrity(generated[0].messages as Content[]).valid).toBe(true); expect(await app.storage.listSnapshots(id)).toHaveLength(1);
    await app.discord.summaries.tick(now + 3600000); expect(generated).toHaveLength(1);
    const summary = history.find(message => message.isSummary)!;
    const originalText = summary.parts.map(part => part.text).join('\n');
    const edited = await app.productUi.call({ actorId: 'owner', clientId: 'summary-edit' }, 'context.editSummary', {
      conversationId: id, summaryMessageId: summary.id, text: '主人手动补充：以后保留群聊中的明确约定。', expectedText: originalText,
    }) as { success: boolean; message: PlatformMessage };
    expect(edited.message.parts).toEqual([{ text: '主人手动补充：以后保留群聊中的明确约定。' }]);
    expect(edited.message.summarizedMessageIds).toEqual(summary.summarizedMessageIds); expect(edited.message.isAutoSummary).toBe(true);
    expect(generated).toHaveLength(1); expect(await app.storage.listSnapshots(id)).toHaveLength(2);
    await expect(app.context.editSummary('owner', id, summary.id!, '过期窗口的修改', originalText)).rejects.toThrow('已被其他操作修改');
    await app.context.restoreSummary('owner', id, summary.id!);
    const restored = (await app.storage.readFullHistory(id)).messages;
    for (const original of messages) expect(restored.find(message => message.id === original.id)?.parts).toEqual(original.parts);
    expect(restored.some(message => message.isSummary || message.isSummarized)).toBe(false);
  });

  test('定时总结失败后，同一批历史按原间隔重试，成功后不重复总结', async () => {
    await app.discord.receive(inbound('retry-summary'));
    const id = (await app.discord.sessions.snapshot(context())).conversation!.id;
    await app.storage.appendHistory(id, Array.from({ length: 12 }, (_, index) => ({ id: `retry-${index}`, role: index % 2 ? 'model' : 'user',
      isUserInput: index % 2 === 0, parts: [{ text: '保留这次对话中的具体事实与约定。'.repeat(100) }] })));
    const settings = app.settings.snapshot(); settings.settings.discord.defaultProfile!.autoSummary = { enabled: true, trigger: 'idle', minutes: 1, percent: 80, prompt: '保留重要事实。' };
    await app.settings.save({ settings: settings.settings, expectedRevision: settings.revision });
    const now = Date.now() + 120000; nextModelFailure = new Error('临时网络错误');
    await app.discord.summaries.tick(now);
    const failed = await app.storage.getRecord(botInboxStateNamespace, id) as BotInboxState;
    expect(failed.summarySequence).toBeUndefined(); expect(failed.summaryError).toContain('临时网络错误'); expect(failed.summaryRetryAt).toBe(now + 60000);
    expect((await app.storage.readFullHistory(id)).messages.some(message => message.isSummary)).toBe(false);
    await app.close();
    app = await PlatformApplication.open({ dataDirectory: f.data, documentsDirectory: path.join(f.root, 'documents'), discordGateway: () => gateway,
      models: { generate: async input => { generated.push(input); return { role: 'model', parts: [{ text:
        '重启后保留对话中已确认的要求、事实和来源，继续未完成的工作，按实际身份使用权限，并保留后续所需的文件和工具结果。'.repeat(5) }] }; } } });
    await app.discord.start();
    await app.discord.summaries.tick(now + 30000); expect(generated).toHaveLength(1);
    await app.discord.summaries.tick(now + 60000); expect(generated).toHaveLength(2);
    const completed = await app.storage.getRecord(botInboxStateNamespace, id) as BotInboxState;
    expect(completed.summarySequence).toBe(completed.sequence); expect(completed.summaryError).toBeUndefined(); expect(completed.summaryRetryAt).toBeUndefined();
    await app.discord.summaries.tick(now + 3600000); expect(generated).toHaveLength(2);
  });

  test('一个频道读取配置失败，其他频道仍能完成上下文总结', async () => {
    const settings = app.settings.snapshot(); settings.settings.discord.allowedChannelIds = ['30', '31'];
    settings.settings.discord.defaultProfile!.autoSummary = { enabled: true, trigger: 'idle', minutes: 1, percent: 80, prompt: '保留重要事实。' };
    await app.settings.save({ settings: settings.settings, expectedRevision: settings.revision });
    for (const channelId of ['30', '31']) {
      await app.discord.receive({ ...inbound(`channel-${channelId}`), channelId });
      const snapshot = await app.discord.sessions.snapshot({ ...context(), channelId });
      await app.storage.appendHistory(snapshot.conversation!.id, Array.from({ length: 12 }, (_, index) => ({ id: `${channelId}-${index}`, role: index % 2 ? 'model' : 'user',
        isUserInput: index % 2 === 0, parts: [{ text: '另一频道的上下文仍然需要正常整理。'.repeat(100) }] })));
    }
    const events: Record<string, unknown>[] = [];
    const unsubscribe = app.subscribe(event => { if (event.type === 'bot.summary.finished') events.push(event); });
    const loader = jest.spyOn(app.discord.sessions, 'load').mockRejectedValueOnce(new Error('单个频道配置暂时无法读取'));
    try {
      await expect(app.discord.summaries.tick(Date.now() + 120000)).resolves.toBeUndefined();
      expect(generated).toHaveLength(1); expect(events.some(event => String(event.error).includes('单个频道'))).toBe(true);
      expect(events.some(event => !event.error)).toBe(true);
    } finally { loader.mockRestore(); unsubscribe(); }
  });

  test('Discord 引用转发消息时保留快照图片和文档，已知正文中的后续引用继续展开', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRzUAAAAASUVORK5CYII=', 'base64');
    const requests: string[] = [];
    const discord = new DiscordJsGateway();
    const forwarded = { content: '转发外层文字', createdTimestamp: 2, author: { id: '55', displayName: '转发者' }, attachments: new Map(),
      reference: { channelId: '42', messageId: 'snapshot' }, messageSnapshots: new Map([['snapshot', { content: '快照里的原始文字', createdTimestamp: 1,
        attachments: new Map([['md', { name: 'notes.md', url: 'https://cdn.discordapp.com/notes' }]]),
        embeds: [{ title: '原始图片', fields: [], image: { url: 'https://example.invalid/cat.png', proxyURL: 'https://media.discordapp.net/embedded-cat' } }] }]]) };
    (discord as any).client = { isReady: () => true, channels: { fetch: async (channelId: string) => ({ isTextBased: () => true,
      messages: { fetch: async (id: string) => { requests.push(`${channelId}:${id}`); return forwarded; } } }) } };
    const hydrated = await discord.hydrate({ ...inbound('quoted'), references: [{ kind: 'reply', id: 'known', content: '已知引用正文',
      references: [{ kind: 'reply', id: 'forwarded', channelId: '41' }] }] });
    const parts = await botInboundParts(hydrated, 'discord', async item => item.url?.includes('embedded-cat') ? png : Buffer.from('# 文档原文\n保留这条约定'),
      (attachment, bytes) => saveBotDocument(app, 'quoted-test', attachment, bytes));
    expect(requests).toEqual(['41:forwarded']); expect(parts.filter(part => part.inlineData)).toHaveLength(1);
    const text = parts.map(part => part.text ?? '').join('\n');
    for (const expected of ['已知引用正文', '转发者', '快照里的原始文字', 'notes.md', 'bot_read_attachment', '原始图片']) expect(text).toContain(expected);
    expect(text).not.toContain('# 文档原文'); expect(text).not.toContain('保留这条约定');
    expect(hydrated.references?.[0].references?.[0].references?.[0].channelId).toBe('42');
  });

  test('大文档仅记录本地描述，工具按字符范围读取并隔离其他会话', async () => {
    const body = '# 大文档\n' + '不应自动注入模型的文档正文。'.repeat(10000);
    const download = jest.spyOn(global, 'fetch').mockResolvedValue(new Response(Buffer.from(body)));
    try {
      await app.discord.receive({ ...inbound('document'), attachments: [{ name: 'large.md', url: 'https://cdn.discordapp.com/large', size: Buffer.byteLength(body) }] });
      const id = (await app.discord.sessions.snapshot(context())).conversation!.id;
      const history = await app.storage.readFullHistory(id);
      expect(JSON.stringify(history.messages)).not.toContain('不应自动注入模型的文档正文');
      expect(JSON.stringify(history.messages)).toContain('large.md'); expect(JSON.stringify(history.messages)).toContain('sizeBytes');
      expect(generated).toHaveLength(0);
      await app.discord.receive(inbound('read-document', '10', true));
      const run = (await app.storage.listRuns({ conversationId: id }))[0]; await app.runtime.wait(run.id);
      expect(JSON.stringify(generated[0].messages)).not.toContain('不应自动注入模型的文档正文');
      expect(generated[0].tools.some(tool => tool.name === 'bot_read_attachment')).toBe(true);
      const tool = botDocumentTools(app)[0];
      const scope = { actorId: 'owner', conversationId: id, runId: run.id, signal: new AbortController().signal, progress: () => {}, askUser: async () => { throw new Error('不应询问'); } };
      const key = (await app.storage.listRecords('bot-documents', id))[0];
      const document = await app.storage.getRecord('bot-documents', key) as { id: string; path: string };
      expect((await stat(document.path)).size).toBe(Buffer.byteLength(body));
      // 目录迁移后保留的旧绝对路径不应阻止读取当前数据目录中的附件。
      await app.storage.putRecord({ namespace: 'bot-documents', id: key, ownerId: id,
        value: { ...document, path: path.join(f.root, 'previous-data', path.relative(app.storage.directory, document.path)) } });
      const firstPart = await tool.execute({ action: 'read', id: document.id, limit: 100 }, scope);
      expect(firstPart).toMatchObject({ text: body.slice(0, 100), nextOffset: 100, truncated: true });
      const nextPart = await tool.execute({ action: 'read', id: document.id, offset: 100, limit: 100 }, scope);
      expect(nextPart.text).toBe(body.slice(100, 200));
      await expect(tool.execute({ action: 'read', id: document.id }, { ...scope, conversationId: 'other' })).rejects.toThrow();
    } finally { download.mockRestore(); }
  });

  test.each(['summary', 'notes'] as const)('Bot 可以选择常规方式 %s，定时检查不会误用时间总结', async method => {
    await app.discord.receive(inbound('seed'));
    const saved = app.settings.snapshot();
    saved.settings.discord.defaultProfile!.autoSummary = { enabled: true, method, trigger: 'idle', minutes: 1, percent: 80, prompt: '' };
    await app.settings.save({ settings: saved.settings, expectedRevision: saved.revision });
    const id = (await app.discord.sessions.snapshot(context())).conversation!.id;
    await app.discord.summaries.tick(Date.now() + 3600000);
    expect(generated).toHaveLength(0);
    expect(app.context.configuration(await app.conversation('owner', id))).toMatchObject({ method, bot: { enabled: true, method } });
  });

  test('Discord 转发快照和 OneBot 引用中的图片、文本附件进入内容，无法读取时保留来源', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRzUAAAAASUVORK5CYII=', 'base64');
    const discord = new DiscordJsGateway();
    const content = (discord as any).messageContent({ content: '转发', createdTimestamp: 1, attachments: new Map(), reference: { channelId: 'elsewhere' },
      messageSnapshots: new Map([['forward', { content: '转发正文', createdTimestamp: 0, attachments: new Map([['image', { name: 'cat.png', url: 'https://cdn.discordapp.com/fixture', contentType: 'image/png' }]]) }]]) });
    const parts = await botInboundParts({ ...inbound('media'), ...content, attachments: [{ name: 'notes.md', url: 'https://cdn.discordapp.com/text' }] }, 'discord', async item => item.name === 'cat.png' ? png : Buffer.from('# 原始文档\n内容'),
      (attachment, bytes) => saveBotDocument(app, 'media-test', attachment, bytes));
    expect(parts.some(part => part.inlineData)).toBe(true); expect(JSON.stringify(parts)).not.toContain('# 原始文档'); expect(JSON.stringify(parts)).toContain('转发正文');
    const protocol = createOneBotProtocol({ enabled: true, endpoint: 'ws://localhost:1', allowedChannelIds: ['group:30'], agentId: 'default', mentionOnly: true });
    const message = protocol.inbound({ post_type: 'message', self_id: 900, user_id: 10, group_id: 30, message_type: 'group', message_id: 1,
      message: [{ type: 'reply', data: { id: 55 } }] }, '900')!;
    const calls: string[] = [];
    const hydrated = await protocol.hydrate(message, async action => { calls.push(action.action);
      return action.action === 'get_msg' ? { sender: { user_id: 99, nickname: '原发言人' }, message: [{ type: 'forward', data: { id: 'fwd' } }] }
        : { messages: [{ sender: { user_id: 88 }, content: [{ type: 'image', data: { url: 'https://gchat.qpic.cn/image', file: 'x' } }] }] };
    });
    const qq = await botInboundParts(hydrated, 'onebot', async () => png);
    expect(calls).toEqual(['get_msg', 'get_forward_msg']); expect(qq.some(part => part.inlineData)).toBe(true); expect(JSON.stringify(qq)).toContain('原发言人');
    const unavailable = await botInboundParts({ ...inbound('bad'), attachments: [{ name: 'lost.txt' }] }, 'discord', async () => { throw new Error('附件失效'); });
    expect(JSON.stringify(unavailable)).toContain('未读取，附件失效');
    await expect(downloadBotAttachment({ name: 'x.txt', url: 'http://127.0.0.1/private' }, 'discord')).rejects.toThrow('平台 CDN');
  });
});
