import type { PlatformApplication } from '../../../apps/server/src/application';
import type { BotGateway, BotReply } from '../../../apps/server/src/bots/gateway';
import { BotOutbox } from '../../../apps/server/src/bots/outbox';
import { BotStreams, botFinalReplies, botMessageText } from '../../../apps/server/src/bots/streaming';
import { botStatsFooter, botTotalStats } from '../../../apps/server/src/bots/messageStats';
import { botRunMessages, botRunReply } from '../../../apps/server/src/bots/rounds';
import { BotSessions, type BotRoute } from '../../../apps/server/src/bots/sessions';
import { discordProfile } from '../../../apps/server/src/bots/config';
import { inlineBotArguments, splitBotText } from '../../../apps/server/src/bots/text';
import { fixture, metadata } from './fixtures';
import { cleanBotPresentationReferences, stripDiscordPresentation } from '../../../apps/server/src/bots/presentation';
import { DiscordJsGateway } from '../../../apps/server/src/bots/discordGateway';

describe('Bot 回复合并与发送恢复', () => {
  let f: Awaited<ReturnType<typeof fixture>>; let app: PlatformApplication; let outbox: BotOutbox;
  let sent: BotReply[]; let edits: Array<{ id: string; reply: BotReply }>; let connected: boolean; let admitted: boolean; let fail: boolean;
  let gateway: BotGateway;
  const route: BotRoute = { platform: 'discord', botId: '900', channelId: '30', actorId: 'owner', conversationId: 'conversation', platformUserId: '10', direct: false,
    output: { streaming: true, updateIntervalMs: 1000, showThoughts: false, showToolStatus: true, longReplies: 'split' } };
  beforeEach(async () => {
    f = await fixture(); app = { storage: f.store } as PlatformApplication; sent = []; edits = []; connected = true; admitted = true; fail = false;
    gateway = { connect: async () => ({ id: '900', name: '测试 Bot' }), disconnect: async () => {}, send: async () => {},
      sendReply: async (_channelId, reply) => { sent.push(reply); if (fail) throw new Error('模拟回执丢失'); return { id: String(sent.length) }; },
      editReply: async (_channelId, id, reply) => { edits.push({ id, reply }); },
    };
    outbox = new BotOutbox(app, 'discord', () => connected ? { gateway, botId: '900' } : undefined, async () => admitted);
  });
  afterEach(async () => { await outbox.close(); await f.cleanup(); });

  test('本 Bot 输出被引用或转发时清理展示统计，保留代码块与其他人的原文', async () => {
    const rendered = '**已进行思考 1.2 秒**\n\n实际正文\n\n-# 第 1 轮 · TTFT 0.10s · 耗时 2.00s · TPS 10.0';
    await outbox.put('rendered', route, [{ content: rendered }]);
    const incoming = { id: 'quote', authorId: '10', channelId: '30', content: '引用', mentioned: true, direct: false,
      references: [{ kind: 'forward' as const, id: '1', channelId: '30', content: rendered },
        { kind: 'reply' as const, id: 'older', authorId: '900', content: rendered },
        { kind: 'reply' as const, id: 'human', authorId: '10', content: rendered }] };
    const cleaned = await cleanBotPresentationReferences(app, incoming, '900');
    expect(cleaned.references?.map(reference => reference.content)).toEqual(['实际正文', '实际正文', rendered]);
    expect(incoming.references[0].content).toBe(rendered);
    const code = '```md\n' + rendered + '\n```';
    expect(stripDiscordPresentation(code)).toBe(code);
  });

  test('流式分段收缩只删除自己保存的多余回执，不留下旧正文', async () => {
    const deleted: string[] = [];
    gateway.deleteReply = async (_channelId, messageId) => { deleted.push(messageId); };
    await outbox.put('resize', route, [{ content: '第一段' }, { content: '临时第二段' }, { content: '临时第三段' }], false);
    await outbox.put('resize', route, [{ content: '整理后的完整正文' }]);
    expect(deleted).toEqual(['3', '2']); expect(edits).toContainEqual({ id: '1', reply: { content: '整理后的完整正文' } });
    expect(await outbox.list()).toEqual([]);
  });

  test('已知回执在同一条消息上完成输出，断线和重复终结不会产生重复回复', async () => {
    await outbox.put('first', route, [{ content: '正在写…' }], false);
    connected = false; await outbox.put('first', route, [{ content: '完整回复' }]); expect(edits).toHaveLength(0);
    connected = true; await outbox.flush();
    expect(sent).toHaveLength(1); expect(edits).toEqual([{ id: '1', reply: { content: '完整回复' } }]);
    expect(await outbox.list()).toEqual([]);
    await outbox.put('first', route, [{ content: '重复结束事件' }]); expect(sent).toHaveLength(1); expect(edits).toHaveLength(1);
  });

  test('回执丢失不会自动重发，明确确认后才可重试；合并期间新来的消息不会遗留', async () => {
    fail = true; await outbox.put('uncertain', route, [{ content: '重要回复' }]);
    expect((await outbox.list())[0].phase).toBe('unknown'); await outbox.flush(); expect(sent).toHaveLength(1);
    await expect(outbox.retry('uncertain')).rejects.toThrow('重试可能重复');
    fail = false; await outbox.retry('uncertain', true); expect(sent).toHaveLength(2); expect(await outbox.list()).toEqual([]);
    let release!: () => void; const hold = new Promise<void>(resolve => { release = resolve; });
    let notifyStarted!: () => void; const started = new Promise<void>(resolve => { notifyStarted = resolve; });
    gateway.sendReply = async (_id, reply) => { sent.push(reply); if (reply.content === 'first-in-flight') { notifyStarted(); await hold; } return { id: String(sent.length) }; };
    const first = outbox.put('concurrent-first', route, [{ content: 'first-in-flight' }]); await started;
    const second = outbox.put('concurrent-second', route, [{ content: 'second-in-flight' }]); release(); await Promise.all([first, second]);
    expect(sent.slice(-2).map(item => item.content)).toEqual(['first-in-flight', 'second-in-flight']); expect(await outbox.list()).toEqual([]);
  });

  test('逐 token 输入合成一帧并在结束时替换为全文；撤销权限后不会留下待重发的半成品', async () => {
    // 使用真实数据库与投递队列，仅将任务查询和计时入口替换为当前测试的确定输入。
    jest.spyOn(f.store, 'getRun').mockResolvedValue({ id: 'stream', conversationId: 'conversation' } as any);
    const sessions = { routeForRun: async () => route, admitted: async () => admitted } as unknown as BotSessions;
    const streams = new BotStreams(app, 'discord', sessions, outbox);
    const timers: Array<() => void> = [];
    const timer = jest.spyOn(global, 'setTimeout').mockImplementation(((callback: () => void) => { timers.push(callback); return { unref() {} } as any; }) as typeof setTimeout);
    try {
      streams.started('stream'); for (const word of ['第一段', '，', '第二段']) streams.delta('stream', [{ text: word }, { text: '私有思考', thought: true }]);
      await new Promise<void>(resolve => setImmediate(resolve)); expect(timers).toHaveLength(1); expect(sent).toHaveLength(0);
      timers[0](); await streams.finish('stream', route, '第一段，第二段。完整结束');
      expect(sent).toHaveLength(1); expect(sent[0].content).toContain('第一段，第二段'); expect(sent[0].content).not.toContain('私有思考');
      expect(edits.at(-1)?.reply.content).toBe('第一段，第二段。完整结束'); expect(await outbox.list()).toEqual([]);
      streams.started('revoked'); await new Promise<void>(resolve => setImmediate(resolve));
      connected = false; timers.at(-1)!(); await new Promise<void>(resolve => setImmediate(resolve)); admitted = false;
      await streams.discard('revoked'); connected = true; admitted = true; await outbox.flush();
      expect(sent).toHaveLength(1); expect(await outbox.list()).toEqual([]);
    } finally { timer.mockRestore(); await streams.close(); }
  });

  test('输出继承保留上层字段，长回复的分段保持代码围栏与 Unicode 完整', () => {
    const profile = discordProfile({ enabled: true, agentId: 'default', allowedChannelIds: ['30'], mentionOnly: true,
      defaultProfile: { providerId: 'first', modelId: 'first-model', output: { streaming: true, showToolStatus: true } },
      channels: { '30': { profile: { providerId: 'second', output: { showThoughts: true } } } } }, { direct: false, channelId: '30' });
    expect(profile.output).toEqual({ streaming: true, showToolStatus: true, showThoughts: true }); expect(profile.modelId).toBeUndefined();
    const text = '开始\n```ts\n' + 'const 猫 = "😺";\n'.repeat(220) + '```\n结束';
    const parts = splitBotText(text); expect(parts.length).toBeGreaterThan(1);
    expect(parts.every(part => part.length <= 1900 && (part.match(/```/g)?.length ?? 0) % 2 === 0)).toBe(true);
    expect(parts.join('').match(/const 猫 = "😺";/g)).toHaveLength(220);
    expect(parts.join('').includes('结束')).toBe(true);
  });

  test('思考结束时编辑原消息收起内容，最后保留耗时与统计', async () => {
    jest.spyOn(f.store, 'getRun').mockResolvedValue({ id: 'thinking', conversationId: 'conversation' } as any);
    const thoughtRoute: BotRoute = { ...route, output: { ...route.output!, showThoughts: true } };
    const sessions = { routeForRun: async () => thoughtRoute, admitted: async () => true } as unknown as BotSessions;
    const streams = new BotStreams(app, 'discord', sessions, outbox);
    const timers: Array<() => void> = [];
    const timer = jest.spyOn(global, 'setTimeout').mockImplementation(((callback: () => void) => { timers.push(callback); return { unref() {} }; }) as any);
    let now = 1000; const clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
    let firstSent!: () => void; const first = new Promise<void>(resolve => firstSent = resolve);
    let bodyEdited!: () => void; const body = new Promise<void>(resolve => bodyEdited = resolve);
    gateway.sendReply = async (_channel, reply) => { sent.push(reply); firstSent(); return { id: 'thinking-message' }; };
    gateway.editReply = async (_channel, id, reply) => { edits.push({ id, reply }); bodyEdited(); };
    try {
      streams.started('thinking'); streams.delta('thinking', [{ text: '只在进行中显示的思考', thought: true }]);
      await new Promise<void>(resolve => setImmediate(resolve)); timers.shift()!(); await first; await outbox.flush();
      expect(sent[0].content).toContain('只在进行中显示的思考');
      now = 3500; streams.delta('thinking', [{ text: '正式回答' }]);
      await new Promise<void>(resolve => setImmediate(resolve)); timers.shift()!(); await body; await outbox.flush();
      expect(edits.at(-1)).toMatchObject({ id: 'thinking-message', reply: { content: expect.stringContaining('已进行思考 2.5 秒') } });
      expect(edits.at(-1)?.reply.content).not.toContain('只在进行中显示的思考');
      const message = { role: 'model', parts: [{ text: '只在进行中显示的思考', thought: true }, { text: '正式回答' }],
        thinkingDuration: 2500, ttft: 500, responseDuration: 3500, chunkCount: 3, usageMetadata: { candidatesTokenCount: 150, thoughtsTokenCount: 100 } };
      streams.saved('thinking', message);
      await streams.finish('thinking', thoughtRoute, botMessageText(message, thoughtRoute), botStatsFooter(message));
      expect(sent).toHaveLength(1);
      expect(edits.at(-1)?.reply.content).toBe('**已进行思考 2.5 秒**\n\n正式回答\n\n-# TTFT 0.50s · 耗时 3.50s · TPS 50.0 · 输出 150');
    } finally { timer.mockRestore(); clock.mockRestore(); await streams.close(); }
  });

  test('非流式只显示思考耗时，分段和附件都在末尾保留统计且不推测缺失值', () => {
    const finalRoute: BotRoute = { ...route, output: { ...route.output!, streaming: false, showThoughts: true } };
    const message = { role: 'model', parts: [{ thought: true, text: '完整思考不应发送' }, { text: '最终正文' }],
      thinkingDuration: 1200, ttft: 500, responseDuration: 2500, chunkCount: 3,
      usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 100, thoughtsTokenCount: 80, cachedContentTokenCount: 12 } };
    expect(botMessageText(message, finalRoute)).toBe('**已进行思考 1.2 秒**\n\n最终正文');
    const footer = botStatsFooter(message);
    expect(footer).toBe('-# TTFT 0.50s · 耗时 2.50s · TPS 50.0 · 输入 200 · 输出 100 · 缓存 12');
    const long = '```ts\n' + 'const 猫 = "😺";\n'.repeat(220);
    const replies = botFinalReplies(long, finalRoute, footer);
    expect(replies.every(reply => reply.content!.length <= 1900)).toBe(true);
    expect(replies.filter(reply => reply.content!.includes('-# TTFT'))).toHaveLength(1);
    expect(replies.at(-1)?.content).toMatch(/```\n\n-# TTFT/);
    const file = botFinalReplies(long, { ...finalRoute, output: { ...finalRoute.output!, longReplies: 'file' } }, footer)[0];
    expect(file.content?.endsWith(footer)).toBe(true);
    expect(Buffer.from(file.files![0].data).toString().endsWith(footer)).toBe(true);
    const missing = { role: 'model', parts: [{ thought: true, text: '思考' }, { text: '回答' }] };
    expect(botMessageText(missing, finalRoute)).toBe('**思考完成**\n\n回答');
    expect(botStatsFooter(missing)).toBe('-# TTFT — · 耗时 — · TPS —');
    expect(botMessageText(message, { ...finalRoute, output: { ...finalRoute.output!, showThoughts: false } })).toBe('最终正文');
  });

  test('跨历史分页读取全部模型轮次，忽略其他任务与工具结果，合计不重复添加缓存和思考', async () => {
    const rounds = Array.from({ length: 110 }, (_, index) => ({ id: `round-${index}`, role: 'model', runId: 'many-rounds', timestamp: 2000 + index,
      parts: [{ thought: true, text: '进行中的思考' }, ...(index < 109 ? [{ functionCall: { name: 'read_file', args: {} } }] : [{ text: '```ts\nconst answer = 42;' }])],
      thinkingDuration: 1200, responseDuration: 2100, ttft: 100, chunkCount: 3,
      usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 40, thoughtsTokenCount: 20, totalTokenCount: 240, cacheReadTokenCount: 100, cachedContentTokenCount: 100 } }));
    await f.store.initializeConversation(metadata('many'), [{ role: 'model', parts: [], runId: 'previous', timestamp: 900 },
      { role: 'user', parts: [], runId: 'many-rounds', isUserInput: true, timestamp: 1000 },
      ...rounds.flatMap(message => [message, { role: 'user', parts: [], runId: 'many-rounds', isFunctionResponse: true, timestamp: message.timestamp,
        usageMetadata: { promptTokenCount: 999999, candidatesTokenCount: 999999 } }])]);
    const read = jest.spyOn(f.store, 'readHistory');
    const messages = await botRunMessages(app, { id: 'many-rounds', conversationId: 'many', createdAt: 1000 } as any);
    expect(messages.map(message => message.id)).toEqual(rounds.map(message => message.id)); expect(read).toHaveBeenCalledTimes(3);
    const reply = botRunReply(messages, { ...route, output: { ...route.output!, showThoughts: true } });
    expect(reply.text.match(/第 \d+ 轮/g)).toHaveLength(110); expect(reply.text).toContain('调用「read_file」');
    expect(reply.text).toContain('const answer = 42;\n```\n\n-# 第 110 轮'); expect(reply.text).not.toContain('进行中的思考');
    expect(reply.footer).toContain('共 110 轮 · 合计 26400 token · 输入 22000 · 输出 4400 · 缓存 11000');
    expect(reply.footer).toContain('TPS 20.0'); expect(reply.footer).not.toContain('统计不完整');
    const hidden = botRunReply([rounds[0]], { ...route, output: { ...route.output!, showThoughts: false, showToolStatus: false } });
    expect(hidden.text).not.toContain('read_file'); expect(hidden.text).not.toContain('已进行思考');
    const partial = botTotalStats([rounds[0], { role: 'model', parts: [] }]);
    expect(partial).toContain('合计 ≥ 240 token'); expect(partial).toContain('统计不完整'); expect(partial).toContain('TPS —');
  });

  test('发送队列固定原消息引用，排队期间其他用户的更新不会替换目标', async () => {
    connected = false;
    await outbox.put('reply-origin', { ...route, replyToMessageId: 'original-message' }, [{ content: '正在处理' }], false);
    await outbox.put('reply-origin', { ...route, platformUserId: 'other-user', replyToMessageId: 'other-message' }, [{ content: '最终内容' }]);
    connected = true; await outbox.flush();
    expect(sent).toEqual([{ content: '最终内容', replyToMessageId: 'original-message' }]);
    const payloads: any[] = [];
    const discord = new DiscordJsGateway();
    (discord as any).client = { isReady: () => true, channels: { fetch: async () => ({ isSendable: () => true, send: async (payload: any) => { payloads.push(payload); return { id: 'receipt' }; } }) } };
    await discord.sendReply('channel', sent[0], 'nonce');
    expect(payloads[0]).toMatchObject({ content: '最终内容', reply: { messageReference: 'original-message', failIfNotExists: false },
      allowedMentions: { parse: [], repliedUser: false }, nonce: 'nonce', enforceNonce: true });
  });

  test('思考与工具统计紧凑显示，参数使用行内代码，单轮不重复总计', () => {
    const outputRoute: BotRoute = { ...route, output: { ...route.output!, showThoughts: true } };
    const messages = [
      { role: 'model', thinkingDuration: 300, parts: [{ text: '内部思考', thought: true }, { functionCall: { name: 'read_file', args: { path: 'README.md', start_line: 10 } } }] },
      { role: 'model', parts: [{ text: '第一段。\n\n第二段。' }] },
    ];
    const reply = botRunReply(messages, outputRoute);
    const rendered = botFinalReplies(reply.text, outputRoute, reply.footer)[0].content!;
    expect(rendered).toContain('**已进行思考 0.3 秒**\n-# 第 1 轮 · 调用「read_file」 `{"path":"README.md","start_line":10}`');
    expect(rendered).toContain('第一段。\n\n第二段。\n\n-# 第 2 轮');
    expect(rendered).toMatch(/-# 第 2 轮[^\n]+\n-# 共 2 轮/);
    const single = botRunReply([messages[1]], outputRoute);
    expect(single.footer).toBeUndefined();
    expect(botFinalReplies(single.text, outputRoute, single.footer)[0].content).toMatch(/第一段。\n\n第二段。\n\n-# 第 1 轮/);
    expect(single.text).not.toContain('共 1 轮');
  });

  test('参数摘要保持简短，参数中的反引号不会结束行内代码', () => {
    const args = { path: 'src/`draft`.ts', password: 'private-value' };
    expect(inlineBotArguments(args)).toBe('``{"path":"src/`draft`.ts","password":"[隐藏]"}``');
    expect(args.password).toBe('private-value');
    expect(inlineBotArguments({ content: '文字'.repeat(300) }).length).toBeLessThan(170);
    expect(inlineBotArguments({})).toBe('');
  });

  test('下一轮开始仍保留前一轮工具与用量，工具返回不会被当成新一轮', async () => {
    jest.spyOn(f.store, 'getRun').mockResolvedValue({ id: 'round-stream', conversationId: 'conversation' } as any);
    const sessions = { routeForRun: async () => route, admitted: async () => true } as unknown as BotSessions;
    const streams = new BotStreams(app, 'discord', sessions, outbox);
    const timers: Array<() => void> = [];
    const timer = jest.spyOn(global, 'setTimeout').mockImplementation(((callback: () => void) => { timers.push(callback); return { unref() {} }; }) as any);
    try {
      streams.started('round-stream');
      const firstMessage = { id: 'first-model', role: 'model', parts: [{ thought: true, text: '原始思考' }, { text: '工具调用之前的完整输出' }, { functionCall: { name: 'read_file', args: { path: 'README.md' } } }],
        thinkingDuration: 1200,
        usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 30, cacheReadTokenCount: 50 } };
      const original = structuredClone(firstMessage);
      streams.saved('round-stream', firstMessage);
      streams.saved('round-stream', { role: 'user', parts: [{ text: '工具响应不应出现在消息里' }] });
      streams.started('round-stream'); streams.delta('round-stream', [{ text: '第二轮正文' }]);
      await new Promise<void>(resolve => setImmediate(resolve)); timers.shift()!();
      await streams.finish('round-stream', route, '最终回复');
      expect(sent[0].content).toContain('第 1 轮 · 调用「read_file」'); expect(sent[0].content).toContain('输入 120');
      expect(sent[0].content).toContain('`{"path":"README.md"}`');
      expect(sent[0].content).toContain('缓存 50'); expect(sent[0].content).toContain('第二轮正文');
      expect(sent[0].content).toContain('工具调用之前的完整输出');
      expect(sent[0].content!.indexOf('工具调用之前的完整输出')).toBeLessThan(sent[0].content!.indexOf('第 1 轮'));
      expect(firstMessage).toEqual(original);
      expect(sent[0].content).not.toContain('第 2 轮'); expect(sent[0].content).not.toContain('工具响应不应');
    } finally { timer.mockRestore(); await streams.close(); }
  });
});
