import type { PlatformMessage } from '@graycode/contracts';
import { PlatformApplication } from '../../../apps/server/src/application';
import { ApplicationRouter } from '../../../apps/server/src/transport/router';
import { DEFAULT_CHAT_MODE_TOOL_NAMES } from '../../../backend/modules/settings/modeToolsPolicy';
import { encodeMcpToolName } from '../../../shared/mcpToolNameCodec';
import { fixture } from './fixtures';

const SYNC_TOOLS = ['update_plan', 'create_progress', 'update_progress', 'record_progress_milestone'];
const MODE_ONLY_TOOLS = ['create_design', 'create_plan', 'create_review', 'finalize_review'];

/** 一次 create_plan 调用及其结果；confirmed 时带上计划卡确认后写入的执行授权。 */
function planTurn(confirmed: boolean): PlatformMessage[] {
  return [
    { id: 'plan-input', role: 'user', isUserInput: true, parts: [{ text: '先做计划' }] },
    { id: 'plan-call', role: 'model', parts: [{ functionCall: { id: 'plan-1', name: 'create_plan', args: { title: '计划' } } }] },
    { id: 'plan-result', role: 'user', isFunctionResponse: true, parts: [{ functionResponse: { id: 'plan-1', name: 'create_plan', response: {
      success: true, planPath: '.graycode/plans/plan.md',
      ...(confirmed ? { continuationApproved: true, continuationIntent: 'implement_now', continuationPrompt: '开始实现' } : {}),
    } } }] },
    { id: 'plan-answer', role: 'model', parts: [{ text: '计划已生成。' }] },
  ];
}

describe('平台模式按配置与会话阶段选择工具', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let app: PlatformApplication;
  let router: ApplicationRouter;
  let tools: string[] = [];
  const owner = { actorId: 'owner', clientId: 'mode-tools' };
  const mcpTool = encodeMcpToolName('mode-tools', 'read_external');
  beforeEach(async () => {
    f = await fixture(); await f.store.close();
    app = await PlatformApplication.open({ dataDirectory: f.data,
      secretCodec: {
        encrypt: async value => Buffer.from(value, 'utf8'),
        decrypt: async value => Buffer.from(value).toString('utf8'),
      },
      models: { generate: async input => { tools = input.tools.map(tool => tool.name); return { role: 'model', parts: [{ text: 'ok' }] }; } } });
    app.tools.register({ declaration: { name: mcpTool, description: '模式工具范围验证', parameters: { type: 'object', properties: {} } },
      effects: () => [], execute: async () => ({ success: true }) });
    const draft = app.settings.snapshot();
    draft.settings.workspaces.push({ id: 'project', name: 'Fixture', directory: f.source, deviceId: 'local' });
    await app.settings.save({ settings: draft.settings, expectedRevision: draft.revision });
    // 网页搜索与抓取只在配置凭据后进入工具目录。
    const product = await app.product.draft();
    await product.settings.updateWebSearchConfig({ apiKey: 'sk-test' });
    await app.product.save(product);
    router = new ApplicationRouter(app);
  });
  afterEach(async () => { await app.close(); await f.cleanup(); });

  async function send(history: PlatformMessage[], promptModeId = 'code', custom: { platformMode?: 'chat' | 'code' | 'character' } = { platformMode: 'code' }) {
    const conversation = await app.createConversation(owner.actorId, 'Mode tools', 'project', custom);
    if (history.length) await app.storage.appendHistory(conversation.id, history);
    const run = await router.call(owner, 'runs.start', { conversationId: conversation.id, requestKey: 'mode-tools', agentId: 'default', promptModeId, text: '继续' }) as { id: string };
    expect((await app.runtime.wait(run.id))?.status).toBe('completed');
    return tools;
  }

  test('开发模式未执行计划时不发送文档工作流工具', async () => {
    const sent = await send([]);
    expect(sent).toContain('read_file');
    for (const name of [...SYNC_TOOLS, ...MODE_ONLY_TOOLS]) expect(sent).not.toContain(name);
  });

  test('runs.start 传入的模式决定工具集', async () => {
    const sent = await send([], 'ask');
    expect(sent).toContain('read_file');
    expect(sent).not.toContain('write_file');
  });

  test('计划尚未确认时不因 planPath 提前开放同步工具', async () => {
    const sent = await send(planTurn(false));
    for (const name of SYNC_TOOLS) expect(sent).not.toContain(name);
  });

  test('确认执行计划后保留计划与进度同步工具，其余文档工具仍属于各自模式', async () => {
    const sent = await send(planTurn(true));
    for (const name of SYNC_TOOLS) expect(sent).toContain(name);
    for (const name of MODE_ONLY_TOOLS) expect(sent).not.toContain(name);
  });

  test('默认对话使用完整的 22 项内置清单，保留 MCP 并追加上下文工具', async () => {
    const sent = await send([], 'code', { platformMode: 'chat' });
    expect(DEFAULT_CHAT_MODE_TOOL_NAMES).toHaveLength(22);
    for (const name of ['read_file', 'write_file', 'ask_user', 'memory_search', 'web_search', 'web_fetch', mcpTool, 'context_status', 'context_history']) {
      expect(sent).toContain(name);
    }
    for (const name of ['execute_command', 'search_in_files', 'subagents', ...SYNC_TOOLS, ...MODE_ONLY_TOOLS]) {
      expect(sent).not.toContain(name);
    }
    expect(sent.every(name => name === mcpTool || name.startsWith('context_')
      || (DEFAULT_CHAT_MODE_TOOL_NAMES as readonly string[]).includes(name))).toBe(true);
  });

  test('对话模式的显式空数组不回退默认工具，环境工具继续追加', async () => {
    const draft = app.settings.snapshot();
    draft.settings.modeProfiles = { chat: { toolNames: [] } };
    await app.settings.save({ settings: draft.settings, expectedRevision: draft.revision });
    const sent = await send([], 'code', { platformMode: 'chat' });
    expect(sent).toContain('context_status');
    expect(sent).toContain('context_history');
    expect(sent.filter(name => !name.startsWith('context_'))).toEqual([]);
  });

  test.each(['code', 'character'] as const)('%s 模式未自选工具时保持原 Agent 工具范围', async platformMode => {
    const sent = await send([], 'code', { platformMode });
    for (const name of ['read_file', 'write_file', 'execute_command', 'search_in_files', 'subagents', mcpTool]) {
      expect(sent).toContain(name);
    }
  });

  test('未标记平台模式的旧会话不套用默认对话清单', async () => {
    const draft = app.settings.snapshot();
    draft.settings.modeProfiles = { chat: { toolNames: [] } };
    await app.settings.save({ settings: draft.settings, expectedRevision: draft.revision });
    const sent = await send([], 'code', {});
    for (const name of ['read_file', 'write_file', 'execute_command', 'search_in_files', 'subagents', mcpTool]) {
      expect(sent).toContain(name);
    }
  });

  test('项目自动任务新建开发对话并使用开发模式预设', async () => {
    const draft = await app.product.draft();
    const providerId = await draft.configs.createConfig({ name: '模式验证', type: 'openai', url: 'http://127.0.0.1:1/v1',
      model: 'fixture-model', apiKey: '', enabled: true, timeout: 1000 });
    draft.app.modeProfiles = { chat: { promptModeId: 'ask' }, code: { promptModeId: 'code' } };
    await app.product.save(draft);
    const task = await app.automations.create(owner.actorId, { kind: 'goal', name: '项目自动任务', objective: '处理项目任务',
      workspaceId: 'project', agentId: 'default', providerId });
    const conversation = await app.storage.getConversation(task.conversationId);
    expect(conversation).toMatchObject({ workspaceId: 'project', custom: { platformMode: 'code' } });
    expect(task.configuration.promptModeId).toBe('code');
  });
});
