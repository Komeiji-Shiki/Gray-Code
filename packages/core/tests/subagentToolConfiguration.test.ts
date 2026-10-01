import { readFile, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { AgentDefinition, ModelInput, RunRecord, WorkspaceDefinition } from '@graycode/contracts';
import type { ToolContext } from '@graycode/core';
import { PlatformApplication } from '../../../apps/server/src/application';
import { ProviderModelAdapter } from '../../../apps/server/src/model/adapter';
import { createSubagentRecord } from '../../../apps/server/src/subagents/profile';
import { subagentSettingsHandlers } from '../../../apps/server/src/subagents/settingsUi';
import type { SubagentLaunchContext } from '../../../apps/server/src/subagents/types';
import type { SubAgentToolsConfig } from '../../../backend/modules/settings/types/subAgentsTypes';
import { encodeMcpToolName } from '../../../shared/mcpToolNameCodec';
import { fixture } from './fixtures';

const FILE_TOOLS = ['workspace_files', 'read_file', 'list_files', 'find_files', 'search_in_files', 'search_files',
  'write_file', 'apply_diff', 'insert_code', 'delete_code', 'create_directory', 'delete_file'];
const MCP_TOOL = encodeMcpToolName('fixture', 'read_file');
const OTHER_MCP_TOOL = encodeMcpToolName('other', 'read_file');

describe('子代理设置保存到模型请求的工具范围', () => {
  let f: Awaited<ReturnType<typeof fixture>>, app: PlatformApplication, agent: AgentDefinition, workspace: WorkspaceDefinition;
  let seen: ModelInput[], parent: RunRecord, server: Server, requests: any[];
  let childCalls: Array<{ name: string; args: Record<string, unknown> }>;
  const registerFixtures = () => {
    for (const name of [MCP_TOOL, OTHER_MCP_TOOL, 'mcp_probe']) if (!app.tools.names().includes(name)) app.tools.register({
      declaration: { name, description: '隔离名称夹具', parameters: { type: 'object', properties: {} } },
      effects: () => ['public_read'], execute: async () => ({ success: true }),
    });
  };
  const context = (): ToolContext => ({ actorId: parent.actorId, runId: parent.id, conversationId: parent.conversationId,
    agent: { ...agent, toolNames: seen.find(input => input.conversationId === parent.conversationId)!.tools.map(tool => tool.name) },
    workspace, modelSelection: { providerId: agent.providerId }, signal: new AbortController().signal,
    toolCallId: 'configured-child', askUser: async () => { throw new Error('unused'); }, progress: () => {} });
  const saveTools = async (tools: SubAgentToolsConfig) => {
    const draft = await app.product.draft();
    await subagentSettingsHandlers(draft, app)['subagents.update']({ type: 'editor', updates: { tools } });
    await app.product.save(draft);
    registerFixtures();
    expect(app.product.runtimeSettings().getSubAgent('editor')!.tools).toEqual(tools);
  };
  const dispatch = async (agentName = '并行修改者') => {
    // 配置保存会刷新 MCP 发现；只恢复本测试的内存夹具，不连接真实服务。
    registerFixtures();
    const result = await app.subagents.dispatch({ agentName, prompt: '验证工具配置' }, context());
    expect(result).toMatchObject({ success: true, error: undefined });
    return (await app.subagents.get(parent.actorId, String((result.data as { runId: string }).runId)))!;
  };
  const childInputs = (conversationId: string) => seen.filter(input => input.conversationId === conversationId);
  const names = (input: ModelInput) => input.tools.map(tool => tool.name);

  beforeEach(async () => {
    f = await fixture(); await f.store.close(); seen = []; childCalls = []; requests = [];
    server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      const call = childCalls.shift();
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ model: 'fixture', choices: [{ finish_reason: call ? 'tool_calls' : 'stop', message: {
        role: 'assistant', content: call ? null : '完成', ...(call ? { tool_calls: [{ id: `call-${requests.length}`,
          type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] } : {}),
      } }] }));
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    app = await PlatformApplication.open({ dataDirectory: f.data, models: { generate: async input => {
      seen.push(input);
      // 正式适配器发出真实 HTTP 请求，只有回答由本机隔离端点控制。
      const adapter = new ProviderModelAdapter({ profile: async id => app.settings.find('providers', id) ?? null,
        credential: async () => '', channel: id => app.product.channel(id) });
      return adapter.generate(input);
    } } });
    registerFixtures();
    const draft = await app.product.draft();
    const providerId = await draft.configs.createConfig({ name: '工具配置夹具', type: 'openai', model: 'fixture', enabled: true,
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, apiKey: '', timeout: 3000 });
    await draft.configs.updateConfig(providerId, { preferStream: false, options: { stream: false } });
    await draft.settings.updateSummarizeConfig({ method: 'summary' });
    workspace = { id: 'tool-config-workspace', name: '隔离工作区', deviceId: 'local', directory: f.source };
    draft.app.workspaces.push(workspace);
    agent = { ...draft.app.agents[0], id: 'tool-config-parent', name: '工具范围测试', providerId,
      toolNames: [...FILE_TOOLS, 'subagents', 'execute_command', 'get_symbols', 'goto_definition', 'find_references', MCP_TOOL, OTHER_MCP_TOOL, 'mcp_probe'],
      toolApproval: { workspace_files: 'auto' }, maxIterations: 8 };
    draft.app.agents.push(agent);
    await subagentSettingsHandlers(draft, app)['subagents.create']({ type: 'editor', name: '并行修改者', enabled: true,
      channel: { channelId: providerId }, tools: { mode: 'all' }, systemPrompt: '只处理分配的任务。' });
    await app.product.save(draft);
    registerFixtures();
    await app.storage.createConversation({ id: 'tool-config-root', actorId: 'owner', title: '工具配置', workspaceId: workspace.id,
      createdAt: 1, updatedAt: 1 });
    parent = await app.runtime.start({ actorId: 'owner', agentId: agent.id, conversationId: 'tool-config-root', workspaceId: workspace.id,
      requestKey: 'tool-config-parent', message: { role: 'user', parts: [{ text: '验证子代理工具范围' }] } });
    expect((await app.runtime.wait(parent.id))!.status).toBe('completed');
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    try { await app.close(); }
    finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await f.cleanup(); }
  });

  test('设置页具名白名单保留所有勾选文件工具，读取/写入及请求前缀均正常', async () => {
    await saveTools({ mode: 'whitelist', whitelist: [...FILE_TOOLS] });
    await writeFile(path.join(f.source, 'source.txt'), '文件读取证据', 'utf8');
    childCalls = [{ name: 'workspace_files', args: { action: 'read', path: 'source.txt' } },
      { name: 'workspace_files', args: { action: 'write', path: 'created.txt', content: '子代理写入证据', expectedHash: null } }];
    const child = await dispatch();
    expect(child.profile.toolNames).toEqual([...FILE_TOOLS].sort());
    const inputs = childInputs(child.conversationId);
    expect(inputs).toHaveLength(3);
    const expected = [...FILE_TOOLS, 'context_status'].sort();
    for (const input of inputs) expect(names(input)).toEqual(expected);
    expect(await readFile(path.join(f.source, 'created.txt'), 'utf8')).toBe('子代理写入证据');
    expect(JSON.stringify(inputs[1].messages)).toContain('文件读取证据');
    for (let iteration = 1; iteration <= 3; iteration++) {
      const saved = await app.storage.getRecord('model-requests', `${child.coreRunIds[0]}:${iteration}`) as any;
      expect(saved.body).toEqual(requests[iteration]);
      expect(saved.body.tools.map((tool: any) => tool.function.name)).toEqual(expected);
      expect(saved.prefix.tools).toEqual(inputs[0].tools);
    }
  });

  test.each([
    { mode: 'whitelist', list: ['read_file', 'goto_definition'] },
    { mode: 'whitelist', whitelist: ['read_file', 'goto_definition'], list: ['write_file'] },
  ] as SubAgentToolsConfig[])('旧 list 兼容，具名白名单优先且工具 ID 不改名：%j', async tools => {
    await saveTools(tools);
    const child = await dispatch();
    expect(child.profile.toolNames).toEqual(['goto_definition', 'read_file']);
    expect(names(childInputs(child.conversationId)[0])).toEqual(['context_status', 'goto_definition', 'read_file']);
  });

  test.each([
    { mode: 'whitelist', whitelist: [], list: ['read_file'] },
    { mode: 'whitelist', list: [] },
    { mode: 'whitelist' },
  ] as SubAgentToolsConfig[])('空白名单不回退为继承全部或旧非空列表：%j', async tools => {
    await saveTools(tools);
    const child = await dispatch();
    expect(child.profile.toolNames).toEqual([]);
    // 上下文管理基础工具保持既有行为，不代表拥有文件权限。
    expect(names(childInputs(child.conversationId)[0])).toEqual(['context_status']);
  });

  test.each([
    { mode: 'blacklist', blacklist: ['workspace_files', 'write_file'] },
    { mode: 'blacklist', list: ['workspace_files', 'write_file'] },
  ] as SubAgentToolsConfig[])('具名和旧黑名单都排除配置项：%j', async tools => {
    await saveTools(tools);
    const child = await dispatch();
    expect(child.profile.toolNames).not.toContain('workspace_files');
    expect(child.profile.toolNames).not.toContain('write_file');
    expect(child.profile.toolNames).toContain('read_file');
    expect(names(childInputs(child.conversationId)[0])).not.toContain('workspace_files');
  });

  test('显式空黑名单优先于遗留 list，仍与父范围和全局关闭取交集', async () => {
    await saveTools({ mode: 'blacklist', blacklist: [], list: ['read_file'] });
    const draft = await app.product.draft(); await draft.settings.setToolEnabled('write_file', false); await app.product.save(draft);
    const child = await dispatch();
    expect(child.profile.toolNames).toContain('read_file');
    expect(child.profile.toolNames).not.toContain('write_file');
    expect(child.profile.toolNames).not.toContain('run_command');
  });

  test('General Worker 继承捕获的父工具集合，不继承另一个代理的白名单、不补全集', async () => {
    await saveTools({ mode: 'whitelist', whitelist: [] });
    const draft = await app.product.draft(); await draft.settings.setToolEnabled('write_file', false); await app.product.save(draft);
    const general = await dispatch('General Worker');
    expect(general.profile.toolNames).toEqual(context().agent!.toolNames.filter(name => name !== 'write_file'));
    expect(general.profile.toolNames).toContain('workspace_files');
    expect(general.profile.toolNames).not.toContain('run_command');
    const emptyParent = { ...context(), agent: { ...agent, toolNames: [] } } as SubagentLaunchContext;
    expect(createSubagentRecord(app, { agentName: 'General Worker' }, emptyParent, 1).profile.toolNames).toEqual([]);
    expect(createSubagentRecord(app, { agentName: 'General Worker' }, context() as SubagentLaunchContext, 2).profile.toolNames).not.toContain('subagents');
  });

  test('工具名称精确匹配：内置旧名和编码 MCP 名均可用，不把 namespace 或另一服务的同名工具当授权', async () => {
    await saveTools({ mode: 'whitelist', whitelist: ['goto_definition', MCP_TOOL, 'default.read_file', 'run_command'] });
    const child = await dispatch();
    expect(child.profile.toolNames).toEqual(['goto_definition', MCP_TOOL]);
    expect(names(childInputs(child.conversationId)[0])).not.toContain(OTHER_MCP_TOOL);
    expect(names(childInputs(child.conversationId)[0])).not.toContain('read_file');
  });

  test.each(['builtin', 'mcp'] as const)('工具分类使用正式 MCP 编码而非宽前缀：%s', async mode => {
    await saveTools({ mode });
    const child = await dispatch();
    if (mode === 'mcp') expect(child.profile.toolNames).toEqual([MCP_TOOL, OTHER_MCP_TOOL]);
    else {
      expect(child.profile.toolNames).toContain('mcp_probe');
      expect(child.profile.toolNames).not.toContain(MCP_TOOL);
    }
  });

  test('选择了工具仍不能绕过账号授权，未声明工具也不能执行', async () => {
    const snapshot = app.settings.snapshot();
    snapshot.settings.accounts.push({ id: 'reader', role: 'member', displayName: '只读成员', effects: ['workspace_read'], workspaceIds: [workspace.id] });
    await app.settings.save({ settings: snapshot.settings, expectedRevision: snapshot.revision });
    registerFixtures();
    const conversation = (await app.storage.getConversation(parent.conversationId))!;
    await app.storage.saveMetadata({ ...conversation, actorId: 'reader' });
    parent = await app.runtime.start({ actorId: 'reader', agentId: agent.id, conversationId: parent.conversationId, workspaceId: workspace.id,
      requestKey: 'reader-parent', message: { role: 'user', parts: [{ text: '只读验证' }] } });
    await app.runtime.wait(parent.id);
    await saveTools({ mode: 'whitelist', whitelist: ['workspace_files'] });
    childCalls = [{ name: 'workspace_files', args: { action: 'write', path: 'denied.txt', content: '不可写', expectedHash: null } },
      { name: 'write_file', args: { path: 'undeclared.txt', content: '不可写' } }];
    const child = await dispatch();
    const history = (await app.storage.readFullHistory(child.conversationId)).messages;
    const outcomes = history.flatMap(message => message.parts).flatMap(part => part.functionResponse ? [(part.functionResponse as { response: unknown }).response] : []);
    expect(child.profile.toolNames).toEqual(['workspace_files']);
    expect(outcomes).toMatchObject([
      { success: false, code: 'PERMISSION_DENIED' },
      { success: false, code: 'UNKNOWN_TOOL' },
    ]);
    await expect(readFile(path.join(f.source, 'denied.txt'))).rejects.toHaveProperty('code', 'ENOENT');
    await expect(readFile(path.join(f.source, 'undeclared.txt'))).rejects.toHaveProperty('code', 'ENOENT');
  });
});
