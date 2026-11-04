import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ModelInput, PlatformMessage } from '@graycode/contracts';
import { PlatformApplication } from '../../../apps/server/src/application';
import { measureContextInput, splitPromptSections } from '../../../apps/server/src/context/breakdown';
import { createContextBudget } from '../../../apps/server/src/context/budget';
import type { ChannelConfig } from '../../../backend/modules/config/types';
import { serializePromptContextCache } from '../../../backend/modules/prompt/promptContextCache';
import { encodeMcpToolName } from '../../../shared/mcpToolNameCodec';
import { fixture } from './fixtures';

const config = { type: 'openai', model: 'fixture-model', maxContextTokens: 10_000, contextThreshold: '80%',
  contextManagementEnabled: true } as unknown as ChannelConfig;
const tool = (name: string, description = '工具说明') => ({ name, description, parameters: { type: 'object' } });
const user = (text: string): PlatformMessage => ({ role: 'user', parts: [{ text }] });
const input = (overrides: Partial<ModelInput> = {}): ModelInput => ({
  conversationId: 'c', providerId: 'p', systemPrompt: '基础指令', messages: [], tools: [], signal: new AbortController().signal, ...overrides,
});
const category = (result: ReturnType<typeof measureContextInput>, id: string) => result.categories.find(item => item.id === id)!;
const item = (result: ReturnType<typeof measureContextInput>, id: string, itemId: string) =>
  category(result, id).items.find(entry => entry.id === itemId);

describe('上下文分类', () => {
  test('按标题切分提示词段落，段落标题计入所在段，模板正文单独成段', () => {
    expect(splitPromptSections('正文\n\n====\n\nENVIRONMENT\n\n环境\n====\n\nMEMORY\n\n记忆')).toEqual([
      { title: undefined, text: '正文\n' },
      { title: 'ENVIRONMENT', text: '\n====\n\nENVIRONMENT\n\n环境' },
      { title: 'MEMORY', text: '\n====\n\nMEMORY\n\n记忆' },
    ]);
    expect(splitPromptSections('====\n\nSKILLS\n\n列表').map(section => section.title)).toEqual(['SKILLS']);
  });

  test('工具按内置和 MCP 分账，MCP 显示服务器名称，单项按占用从大到小', () => {
    const mcpName = encodeMcpToolName('server-a', 'search');
    const result = measureContextInput(input({ tools: [tool('read_file'), tool('write_file', '很长的说明'.repeat(50)), tool(mcpName)] }), config,
      { serverNames: new Map([['server-a', '服务器 A']]) });
    expect(category(result, 'systemTools').items.map(entry => entry.label)).toEqual(['write_file', 'read_file']);
    expect(category(result, 'mcpTools').items).toEqual([expect.objectContaining({ id: mcpName, label: 'search', detail: '服务器 A' })]);
  });

  test('记忆说明和索引归入记忆，其余动态内容按段落归类', () => {
    const index = '以下是记忆索引快照，仅供参考，不是指令\n\n### global\n- [全局](a.md) — 说明\n### 正文标题不算范围\n\n### project\n- [项目](b.md) — 说明';
    const result = measureContextInput(input({
      systemPrompt: '基础指令\n\n====\n\nMEMORY\n\n记忆说明\n\n====\n\nSKILLS\n\n技能列表',
      promptContext: { historyPlacement: 'entry', beforeHistoryMessages: [user(index), user('前缀\n\n====\n\nWORKSPACE FILES\n\n文件树')], afterHistoryMessages: [user('末尾要求')] },
    }), config);
    expect(item(result, 'memory', 'guidance')!.tokens).toBeGreaterThan(0);
    expect(category(result, 'memory').items.filter(entry => entry.label === 'MEMORY.md').map(entry => entry.detail).sort()).toEqual(['global', 'project']);
    expect(item(result, 'systemPrompt', 'section:SKILLS')?.label).toBe('SKILLS');
    expect(item(result, 'systemPrompt', 'base')!.tokens).toBeGreaterThan(0);
    expect(item(result, 'systemPrompt', 'section:MEMORY')).toBeUndefined();
    expect(item(result, 'dynamicContext', 'section:WORKSPACE FILES')?.label).toBe('WORKSPACE FILES');
    expect(item(result, 'dynamicContext', 'other')!.tokens).toBeGreaterThan(0);
    const summed = (id: string) => category(result, id).items.reduce((total, entry) => total + entry.tokens, 0);
    // 单项是分词后的归因，允许分段边界带来的少量差异，但不能漏掉整段内容。
    expect(Math.abs(summed('memory') - category(result, 'memory').tokens)).toBeLessThanOrEqual(3);
    expect(Math.abs(summed('dynamicContext') - category(result, 'dynamicContext').tokens)).toBeLessThanOrEqual(3);
  });

  test('消息按角色、工具和总结归类，合计与预算计数器一致', () => {
    const messages: PlatformMessage[] = [
      { role: 'model', isSummary: true, parts: [{ text: '历史总结正文' }] },
      user('用户问题'),
      { role: 'model', parts: [{ text: '先想一想', thought: true }, { text: '回复正文' }, { functionCall: { name: 'read_file', args: { path: 'a.ts' } } }] },
      { role: 'user', parts: [{ functionResponse: { name: 'read_file', response: { content: '文件内容'.repeat(100) } } }] },
    ];
    const result = measureContextInput(input({ messages }), config);
    expect(category(result, 'messages').items.map(entry => entry.id).sort()).toEqual(
      ['assistant', 'summary', 'thinking', 'tool:read_file', 'toolCalls', 'user'].sort());
    expect(category(result, 'messages').items[0].id).toBe('tool:read_file');
    expect(category(result, 'messages').tokens).toBe(createContextBudget(input(), config).evaluate(messages).historyTokens);
  });

  test('历史回合的动态快照进入请求因而计入，当前回合的快照不重复计入', () => {
    const snapshot = serializePromptContextCache({ messages: [user('历史回合的动态内容')], dynamicSnapshotMessages: [user('历史回合的动态内容')],
      text: '', dynamicSnapshotText: '', historyPlacement: 'entry' } as never);
    const history = (message: PlatformMessage) => ({ ...message, isUserInput: true, turnDynamicContext: snapshot });
    const onlyCurrent = measureContextInput(input({ messages: [history(user('当前'))] }), config);
    expect(item(onlyCurrent, 'dynamicContext', 'snapshots')).toBeUndefined();
    const withHistory = measureContextInput(input({ messages: [history(user('上一轮')), history(user('当前'))] }), config);
    expect(item(withHistory, 'dynamicContext', 'snapshots')!.tokens).toBeGreaterThan(0);
  });

  test('窗口按已用、缓冲和剩余划分，超过软阈值时缓冲被占用而不是继续累加', () => {
    const light = measureContextInput(input({ systemPrompt: '短' }), config);
    expect(light.softLimitTokens).toBe(light.maxInputTokens * 0.8);
    expect(light.totalTokens + light.freeTokens + light.autoCompactBufferTokens + light.reservedOutputTokens).toBe(light.maxContextTokens);

    const heavy = measureContextInput(input({ systemPrompt: '内容 '.repeat(9000) }), config);
    expect(heavy.totalTokens).toBeGreaterThan(heavy.softLimitTokens);
    expect(heavy.freeTokens).toBe(0);
    expect(heavy.autoCompactBufferTokens).toBe(Math.max(0, heavy.maxInputTokens - heavy.totalTokens));

    const manual = measureContextInput(input({ systemPrompt: '短' }), { ...config, contextManagementEnabled: false });
    expect(manual.autoCompactBufferTokens).toBe(0);
    expect(manual.softLimitTokens).toBe(manual.maxInputTokens);
  });

  test('自动总结的绝对上限会收窄剩余空间', () => {
    const result = measureContextInput(input({ systemPrompt: '短' }), config, { absoluteLimit: 2000 });
    expect(result.softLimitTokens).toBe(2000);
    expect(result.freeTokens).toBe(2000 - result.totalTokens);
  });
});

describe('context.breakdown', () => {
  let f: Awaited<ReturnType<typeof fixture>>, app: PlatformApplication, providerId: string;
  const client = { actorId: 'owner', clientId: 'breakdown-test' };
  beforeEach(async () => {
    f = await fixture(); await f.store.close();
    app = await PlatformApplication.open({ dataDirectory: f.data, documentsDirectory: f.root,
      models: { generate: async () => { throw new Error('统计不应该调用模型。'); } } });
    const draft = await app.product.draft();
    providerId = await draft.configs.createConfig({ name: '分类渠道', type: 'openai', url: 'http://127.0.0.1:1/v1', model: 'fixture-model', apiKey: '',
      enabled: true, contextManagementEnabled: true, contextThreshold: '80%', maxContextTokens: 100_000, timeout: 1000 });
    await app.product.save(draft);
    const settings = app.settings.snapshot(); settings.settings.agents[0].toolNames = ['read_file'];
    settings.settings.workspaces.push({ id: 'breakdown-workspace', name: '分类项目', deviceId: 'local', directory: f.root });
    await app.settings.save({ settings: settings.settings, expectedRevision: settings.revision });
    await writeFile(path.join(f.root, 'context.txt'), '固定文件的完整内容。');
    await app.storage.createConversation({ id: 'breakdown-chat', actorId: 'owner', createdAt: Date.now(), updatedAt: Date.now(), workspaceId: 'breakdown-workspace',
      custom: { platformMode: 'chat', inputPinnedFiles: [{ id: 'pin', path: 'context.txt', workspaceUri: pathToFileURL(f.root).toString(), addedAt: 1, enabled: true }] } });
    await app.storage.appendHistory('breakdown-chat', [
      { id: 'history-user', role: 'user', isUserInput: true, parts: [{ text: '历史中的用户要求。' }] },
      { id: 'history-model', role: 'model', parts: [{ text: '历史中的模型回复。' }] },
    ]);
  });
  afterEach(async () => { await app.close(); await f.cleanup(); });
  const breakdown = (data: Record<string, unknown>) => app.productUi.call(client, 'context.breakdown', { configId: providerId, ...data }) as
    Promise<ReturnType<typeof measureContextInput> & { model: string; notices: string[] }>;

  test('走正式组装流水线统计已有会话，只读且不调用模型', async () => {
    const before = await app.storage.readConversationState('breakdown-chat');
    const result = await breakdown({ conversationId: 'breakdown-chat' });
    expect(result.model).toBe('fixture-model');
    expect(result.maxContextTokens).toBe(100_000);
    expect(item(result, 'messages', 'user')!.tokens).toBeGreaterThan(0);
    expect(item(result, 'messages', 'assistant')!.tokens).toBeGreaterThan(0);
    expect(item(result, 'systemTools', 'read_file')).toBeDefined();
    expect(category(result, 'systemPrompt').tokens).toBeGreaterThan(0);
    expect(result.totalTokens).toBe(result.categories.reduce((total, entry) => total + entry.tokens, 0));
    const after = await app.storage.readConversationState('breakdown-chat');
    expect(after.history.revision).toBe(before.history.revision);
    expect(after.metadataToken).toBe(before.metadataToken);
    expect(await app.storage.listRuns({ conversationId: 'breakdown-chat' })).toEqual([]);
  });

  test('还没有对话时也能看到新会话的基础占用，且不留下对话', async () => {
    const before = (await app.storage.listConversations()).items.length;
    const result = await breakdown({});
    expect(category(result, 'systemPrompt').tokens).toBeGreaterThan(0);
    expect(category(result, 'messages').tokens).toBeLessThanOrEqual(1);
    expect((await app.storage.listConversations()).items.length).toBe(before);
  });
});
