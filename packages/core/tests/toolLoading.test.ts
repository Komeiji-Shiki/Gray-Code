import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ModelInput, PlatformMessage, RunRecord, ToolDeclaration } from '@graycode/contracts';
import { RuntimeToolRegistry, TOOL_SEARCH_NAME, type RuntimeTool } from '@graycode/core';
import { PlatformApplication } from '../../../apps/server/src/application';
import { measureContextInput } from '../../../apps/server/src/context/breakdown';
import { defaultToolLoading, resolveToolLoading, searchDeferredTools } from '../../../apps/server/src/settings/toolLoading';
import type { ChannelConfig } from '../../../backend/modules/config/types';
import { fixture } from './fixtures';

const tool = (name: string, description = `${name} 的完整说明`): RuntimeTool => ({
  declaration: { name, description, parameters: { type: 'object', properties: { path: { type: 'string', description: '目标路径' } },
    required: ['path'], additionalProperties: false } },
  effects: () => [],
  execute: async args => ({ success: true, data: { received: args } }),
});

describe('目录捕获', () => {
  const registry = () => {
    const tools = new RuntimeToolRegistry();
    for (const name of ['read_file', 'office_create', 'mcp__a__search', TOOL_SEARCH_NAME]) tools.register(tool(name));
    return tools;
  };

  test('按需工具只发固定占位，校验和完整声明仍来自真实工具', () => {
    const catalog = registry().catalog(['read_file', 'office_create', TOOL_SEARCH_NAME], undefined, new Set(['office_create']));
    const stub = catalog.declarations.find(item => item.name === 'office_create')!;
    expect(stub.description).not.toContain('完整说明');
    expect(stub.parameters).toEqual({ type: 'object', properties: {}, additionalProperties: true });
    expect(catalog.declarations.find(item => item.name === 'read_file')!.description).toContain('完整说明');
    expect(catalog.deferred?.get('office_create')?.description).toContain('完整说明');
    const entry = catalog.entries.get('office_create')!;
    expect(entry.validate({ path: 'a.docx' })).toBe(true);
    expect(entry.validate({})).toBe(false);
  });

  test('占位内容只取决于名称：换一批按需工具不影响其他工具的占位字节', () => {
    const tools = registry();
    const first = tools.catalog(['read_file', 'office_create'], undefined, new Set(['office_create']));
    const second = tools.catalog(['read_file', 'office_create', 'mcp__a__search'], undefined, new Set(['office_create', 'mcp__a__search']));
    const pick = (declarations: ToolDeclaration[]) => JSON.stringify(declarations.find(item => item.name === 'office_create'));
    expect(pick(second.declarations)).toBe(pick(first.declarations));
  });

  test('加载方式变化时目录版本变化，相同配置复用同一份声明对象', () => {
    const tools = registry();
    const plain = tools.catalog(['read_file', 'office_create']);
    const deferred = tools.catalog(['read_file', 'office_create'], undefined, new Set(['office_create']));
    expect(deferred.version).not.toBe(plain.version);
    expect(plain.deferred).toBeUndefined();
    expect(tools.catalog(['read_file', 'office_create'], undefined, new Set(['office_create'])).declarations).toBe(deferred.declarations);
  });
});

describe('加载方式解析', () => {
  const preferences = (enabled = true, configured: Record<string, 'resident' | 'deferred'> = {}) => ({
    isToolEnabled: (name: string) => name !== TOOL_SEARCH_NAME || enabled,
    getToolLoading: () => configured,
  });

  test('默认策略：MCP 与低频大工具按需，核心读写和命令常驻', () => {
    for (const name of ['mcp__a__b', 'browser_action', 'computer_observe', 'office_create', 'find_references']) expect(defaultToolLoading(name)).toBe('deferred');
    for (const name of ['read_file', 'write_file', 'apply_diff', 'execute_command', 'search_in_files', 'create_plan', 'context_notes']) expect(defaultToolLoading(name)).toBe('resident');
  });

  test('有按需工具才追加工具搜索，单独设置优先于默认策略', () => {
    expect(resolveToolLoading(preferences(), ['read_file'])).toEqual({ names: ['read_file'] });
    const resolved = resolveToolLoading(preferences(true, { office_create: 'resident', read_file: 'deferred' }), ['read_file', 'office_create', 'crop_image']);
    expect(resolved.names).toEqual(['read_file', 'office_create', 'crop_image', TOOL_SEARCH_NAME]);
    expect([...resolved.deferred!]).toEqual(['read_file', 'crop_image']);
  });

  test('关闭工具搜索或关闭渠道开关时全部发送完整定义', () => {
    expect(resolveToolLoading(preferences(false), ['office_create'])).toEqual({ names: ['office_create'] });
    expect(resolveToolLoading(preferences(), ['office_create'], { toolDeferredLoading: false })).toEqual({ names: ['office_create'] });
    expect(resolveToolLoading(preferences(), ['office_create'], { toolDeferredLoading: true }).deferred?.has('office_create')).toBe(true);
  });

  test('开启严格工具的渠道发送完整定义，关闭时不受影响', () => {
    expect(resolveToolLoading(preferences(), ['office_create'], { strictToolsEnabled: true })).toEqual({ names: ['office_create'] });
    expect(resolveToolLoading(preferences(), ['office_create'], { strictToolsEnabled: false }).deferred?.has('office_create')).toBe(true);
  });

  test('子代理继承的清单已含工具搜索时不重复，也不会把它自己算成按需', () => {
    const resolved = resolveToolLoading(preferences(), [TOOL_SEARCH_NAME, 'office_create']);
    expect(resolved.names).toEqual(['office_create', TOOL_SEARCH_NAME]);
    expect(resolved.deferred?.has(TOOL_SEARCH_NAME)).toBe(false);
    expect(resolveToolLoading(preferences(), [TOOL_SEARCH_NAME, 'read_file'])).toEqual({ names: ['read_file'] });
  });
});

describe('工具搜索', () => {
  const declaration = (name: string, description: string): ToolDeclaration => ({ name, description, parameters: { type: 'object', properties: {} } });
  const deferred = new Map(['office_create', 'office_edit', 'crop_image'].map(name => [name, declaration(name, name === 'crop_image' ? '裁剪图片 region' : `处理 ${name} 文档`)]));

  test('select 按名称精确返回并按请求顺序排列，范围外的名称单独说明', () => {
    const result = searchDeferredTools(deferred, 'select:office_edit, crop_image,read_file');
    expect(result.tools.map(item => item.name)).toEqual(['office_edit', 'crop_image']);
    expect(result.unavailable).toEqual(['read_file']);
    expect(result.tools[0].parameters).toEqual({ type: 'object', properties: {} });
  });

  test('关键词命中名称优先于说明，同分按名称排序并受数量限制', () => {
    expect(searchDeferredTools(deferred, 'office').tools.map(item => item.name)).toEqual(['office_create', 'office_edit']);
    expect(searchDeferredTools(deferred, 'office', 1).tools.map(item => item.name)).toEqual(['office_create']);
    expect(searchDeferredTools(deferred, 'region crop').tools[0].name).toBe('crop_image');
    expect(searchDeferredTools(deferred, '裁剪').tools.map(item => item.name)).toEqual(['crop_image']);
    expect(searchDeferredTools(deferred, '没有这个工具').tools).toEqual([]);
  });

  test('本次运行没有按需工具时不报错', () => {
    expect(searchDeferredTools(undefined, 'select:office_edit')).toEqual({ tools: [], unavailable: ['office_edit'] });
  });
});

describe('网线上的请求', () => {
  test('经真实格式器和 HTTP 发送时，加载工具前后 tools 字节不变，旧消息是新消息的前缀', async () => {
    const f = await fixture(); await f.store.close();
    const bodies: Record<string, any>[] = [];
    const calls = [
      { name: TOOL_SEARCH_NAME, arguments: JSON.stringify({ query: 'select:mcp__fixture__lookup' }) },
      { name: 'mcp__fixture__lookup', arguments: JSON.stringify({ path: 'a.txt' }) },
    ];
    const server = createServer((request, response) => {
      let raw = '';
      request.on('data', chunk => { raw += chunk; });
      request.on('end', () => {
        const body = JSON.parse(raw);
        bodies.push(body);
        const call = calls[bodies.length - 1];
        const message = call
          ? { role: 'assistant', content: null, tool_calls: [{ id: `call-${bodies.length}`, type: 'function', function: call }] }
          : { role: 'assistant', content: '完成。' };
        const usage = { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 };
        if (body.stream) {
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          const delta = call ? { ...message, tool_calls: [{ index: 0, ...message.tool_calls![0] }] } : message;
          response.write(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
          response.write(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }], usage })}\n\n`);
          response.end('data: [DONE]\n\n');
        } else {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ id: 'c', object: 'chat.completion',
            choices: [{ index: 0, message, finish_reason: call ? 'tool_calls' : 'stop' }], usage }));
        }
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const app = await PlatformApplication.open({ dataDirectory: f.data, documentsDirectory: f.root });
    try {
      const draft = await app.product.draft();
      const providerId = await draft.configs.createConfig({ name: '模拟接口', type: 'openai',
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, model: 'fixture-model', apiKey: '',
        enabled: true, contextManagementEnabled: false, timeout: 10000 });
      await app.product.save(draft);
      app.tools.register(tool('mcp__fixture__lookup', 'Find a record by its path.'));
      const settings = app.settings.snapshot();
      settings.settings.agents[0].toolNames = ['read_file', 'mcp__fixture__lookup'];
      await app.settings.save({ settings: settings.settings, expectedRevision: settings.revision });
      await app.storage.createConversation({ id: 'wire-chat', actorId: 'owner', createdAt: Date.now(), updatedAt: Date.now(), custom: { platformMode: 'chat' } });
      const started = await app.productUi.call({ actorId: 'owner', clientId: 'wire-test' }, 'chatStream',
        { conversationId: 'wire-chat', configId: providerId, message: '查一下记录', streamId: 'wire' }) as { runId: string };
      const run = await app.runtime.wait(started.runId);
      expect(run?.error).toBeUndefined();
      expect(run?.status).toBe('completed');
      expect(bodies).toHaveLength(3);

      const tools = bodies.map(body => JSON.stringify(body.tools));
      expect(tools[1]).toBe(tools[0]);
      expect(tools[2]).toBe(tools[0]);
      const stub = bodies[0].tools.find((item: any) => item.function.name === 'mcp__fixture__lookup').function;
      expect(stub.description).not.toContain('Find a record');
      expect(stub.parameters).toEqual({ type: 'object', properties: {}, additionalProperties: true });

      const prefix = (index: number, length: number) => JSON.stringify(bodies[index].messages.slice(0, length));
      expect(prefix(1, bodies[0].messages.length)).toBe(prefix(0, bodies[0].messages.length));
      expect(prefix(2, bodies[1].messages.length)).toBe(prefix(1, bodies[1].messages.length));
      const appended = JSON.stringify(bodies[1].messages.slice(bodies[0].messages.length));
      expect(appended).toContain('Find a record by its path.');
      expect(JSON.stringify(bodies[2].messages.slice(bodies[1].messages.length))).toContain('a.txt');
    } finally {
      await app.close();
      await new Promise(resolve => server.close(resolve));
      await f.cleanup();
    }
  });
});

describe('真实运行', () => {
  let f: Awaited<ReturnType<typeof fixture>>, app: PlatformApplication, providerId: string;
  let requests: ModelInput[];
  let replies: PlatformMessage[];
  const client = { actorId: 'owner', clientId: 'tool-loading-test' };
  const responses = (input: ModelInput) => input.messages.flatMap(message => message.parts.flatMap(part =>
    (part as { functionResponse?: { name: string; response: Record<string, any> } }).functionResponse ?? []));
  beforeEach(async () => {
    f = await fixture(); await f.store.close(); requests = []; replies = [];
    app = await PlatformApplication.open({ dataDirectory: f.data, documentsDirectory: f.root,
      models: { generate: async input => {
        requests.push(input);
        return replies.shift() ?? { role: 'model', parts: [{ text: '完成。' }] };
      } } });
    const draft = await app.product.draft();
    providerId = await draft.configs.createConfig({ name: '按需渠道', type: 'openai', url: 'http://127.0.0.1:1/v1', model: 'fixture-model', apiKey: '',
      enabled: true, contextManagementEnabled: false, timeout: 1000 });
    await app.product.save(draft);
    app.tools.register(tool('mcp__fixture__lookup', 'Find a record by its path.'));
    const settings = app.settings.snapshot();
    settings.settings.agents[0].toolNames = ['read_file', 'mcp__fixture__lookup'];
    await app.settings.save({ settings: settings.settings, expectedRevision: settings.revision });
    await app.storage.createConversation({ id: 'loading-chat', actorId: 'owner', createdAt: Date.now(), updatedAt: Date.now(), custom: { platformMode: 'chat' } });
  });
  afterEach(async () => { await app.close(); await f.cleanup(); });
  const call = (id: string, name: string, args: Record<string, unknown>): PlatformMessage =>
    ({ role: 'model', parts: [{ functionCall: { id, name, args } }] });
  const send = async () => {
    const started = await app.productUi.call(client, 'chatStream', { conversationId: 'loading-chat', configId: providerId, message: '查一下记录', streamId: 'loading' }) as { runId: string };
    return app.runtime.wait(started.runId) as Promise<RunRecord>;
  };

  test('加载工具前后 tools 字节不变，历史只追加，定义随工具结果进入消息', async () => {
    replies = [call('search', TOOL_SEARCH_NAME, { query: 'select:mcp__fixture__lookup' }), call('use', 'mcp__fixture__lookup', { path: 'a.txt' })];
    const run = await send();
    expect(run.status).toBe('completed');
    expect(requests).toHaveLength(3);

    const [first, second, third] = requests;
    expect(JSON.stringify(second.tools)).toBe(JSON.stringify(first.tools));
    expect(JSON.stringify(third.tools)).toBe(JSON.stringify(first.tools));
    expect(second.systemPrompt).toBe(first.systemPrompt);
    expect(third.systemPrompt).toBe(first.systemPrompt);
    const prefix = (input: ModelInput, count: number) => JSON.stringify(input.messages.slice(0, count));
    expect(prefix(second, first.messages.length)).toBe(prefix(first, first.messages.length));
    expect(prefix(third, second.messages.length)).toBe(prefix(second, second.messages.length));

    const stub = first.tools.find(item => item.name === 'mcp__fixture__lookup')!;
    expect(stub.parameters).toEqual({ type: 'object', properties: {}, additionalProperties: true });
    expect(first.tools.some(item => item.name === TOOL_SEARCH_NAME)).toBe(true);
    expect(first.tools.find(item => item.name === 'read_file')!.description.length).toBeGreaterThan(stub.description.length);

    const [loaded] = responses(second);
    expect(loaded.response.data.tools[0]).toMatchObject({ name: 'mcp__fixture__lookup', description: 'Find a record by its path.' });
    expect(loaded.response.data.tools[0].parameters.required).toEqual(['path']);
    const used = responses(third).at(-1)!;
    expect(used.name).toBe('mcp__fixture__lookup');
    expect(used.response.data.received).toEqual({ path: 'a.txt' });
  });

  test('没加载就用错参数调用时，校验失败结果附上完整定义，不执行工具', async () => {
    replies = [call('blind', 'mcp__fixture__lookup', {})];
    await send();
    const failed = responses(requests[1])[0];
    expect(failed.response.success).toBe(false);
    expect(failed.response.code).toBe('INVALID_ARGUMENTS');
    expect(failed.response.definition.parameters.required).toEqual(['path']);
  });

  test('关闭工具搜索后发送完整定义，请求里没有占位也没有搜索工具', async () => {
    const draft = await app.product.draft();
    await draft.settings.setToolEnabled(TOOL_SEARCH_NAME, false);
    await app.product.save(draft);
    await send();
    expect(requests[0].tools.some(item => item.name === TOOL_SEARCH_NAME)).toBe(false);
    expect(requests[0].tools.find(item => item.name === 'mcp__fixture__lookup')?.description).toBe('Find a record by its path.');
  });

  test('渠道关闭按需加载只影响这个渠道，设置随渠道保存', async () => {
    const draft = await app.product.draft();
    await draft.configs.updateConfig(providerId, { toolDeferredLoading: false } as Partial<ChannelConfig>);
    await app.product.save(draft);
    expect((await app.product.channel(providerId))?.toolDeferredLoading).toBe(false);
    await send();
    expect(requests[0].tools.find(item => item.name === 'mcp__fixture__lookup')?.description).toBe('Find a record by its path.');
  });

  test('单独设置保存后下一次请求生效，重启应用仍然保留', async () => {
    const draft = await app.product.draft();
    await draft.settings.setToolLoading('mcp__fixture__lookup', 'resident');
    await app.product.save(draft);
    await send();
    expect(requests[0].tools.find(item => item.name === 'mcp__fixture__lookup')?.description).toBe('Find a record by its path.');

    await app.close();
    app = await PlatformApplication.open({ dataDirectory: f.data, documentsDirectory: f.root });
    expect(app.product.runtimeSettings().getToolLoading()).toEqual({ mcp__fixture__lookup: 'resident' });
  });

  test('工具页列出加载方式，切换后列表随之变化，无效的值被拒绝', async () => {
    const list = async () => (await app.productUi.call(client, 'tools.getTools', {}) as { tools: { name: string; loading?: string }[] }).tools;
    const before = await list();
    expect(before.find(item => item.name === 'read_file')?.loading).toBe('resident');
    expect(before.find(item => item.name === 'mcp__fixture__lookup')?.loading).toBe('deferred');
    expect(before.find(item => item.name === TOOL_SEARCH_NAME)?.loading).toBeUndefined();

    await app.productUi.call(client, 'tools.setToolLoading', { toolName: 'mcp__fixture__lookup', mode: 'resident' });
    await expect(app.productUi.call(client, 'tools.setToolLoading', { toolName: 'read_file', mode: 'later' })).rejects.toThrow('工具加载方式无效');
    expect((await list()).find(item => item.name === 'mcp__fixture__lookup')?.loading).toBe('resident');
  });

  test('每种协议的请求都能带上占位，再次组装时 tools 字段不变', async () => {
    const base = requests;
    for (const type of ['openai', 'openai-responses', 'anthropic', 'gemini', 'gemini-interactions']) {
      const draft = await app.product.draft();
      const id = await draft.configs.createConfig({ name: type, type, url: 'http://127.0.0.1:1/v1', model: 'fixture-model', apiKey: '', enabled: true,
        contextManagementEnabled: false, timeout: 1000 } as never);
      await app.product.save(draft);
      const preview = async (message: string) => (await app.productUi.call(client, 'prompt.preview',
        { conversationId: 'loading-chat', configId: id, message }) as { body: Record<string, unknown> }).body;
      const first = JSON.stringify((await preview('第一次')).tools);
      expect(first).toContain('mcp__fixture__lookup');
      expect(first).toContain('additionalProperties');
      expect(first).not.toContain('Find a record by its path.');
      expect(JSON.stringify((await preview('第二次')).tools)).toBe(first);
    }
    expect(base).toHaveLength(0);
  });

  test('严格工具渠道能组装请求：Chat 与 Responses 都发送完整定义，没有占位和搜索工具', async () => {
    for (const type of ['openai', 'openai-responses']) {
      const draft = await app.product.draft();
      const id = await draft.configs.createConfig({ name: `${type} strict`, type, url: 'http://127.0.0.1:1/v1', model: 'fixture-model', apiKey: '', enabled: true,
        contextManagementEnabled: false, timeout: 1000, strictToolsEnabled: true } as never);
      await app.product.save(draft);
      const { body } = await app.productUi.call(client, 'prompt.preview',
        { conversationId: 'loading-chat', configId: id, message: '严格模式' }) as { body: Record<string, unknown> };
      const tools = JSON.stringify(body.tools);
      expect(tools).toContain('Find a record by its path.');
      expect(tools).not.toContain(TOOL_SEARCH_NAME);
    }
  });

  test('上下文面板分开统计占位和没有发送的完整定义', async () => {
    const result = await app.productUi.call(client, 'context.breakdown', { conversationId: 'loading-chat', configId: providerId }) as ReturnType<typeof measureContextInput>;
    const mcp = result.categories.find(category => category.id === 'mcpTools')!;
    expect(mcp.items.map(item => item.id)).toEqual(['stubs']);
    const unsent = result.deferredCategories.find(category => category.id === 'mcpToolsDeferred')!;
    expect(unsent.items[0]).toMatchObject({ id: 'mcp__fixture__lookup', label: 'lookup' });
    expect(unsent.tokens).toBeGreaterThan(0);
    expect(result.totalTokens).toBe(result.categories.reduce((total, category) => total + category.tokens, 0));
  });
});
