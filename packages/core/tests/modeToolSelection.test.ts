import type { PlatformMessage } from '@graycode/contracts';
import { PlatformApplication } from '../../../apps/server/src/application';
import { ApplicationRouter } from '../../../apps/server/src/transport/router';
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

describe('Code 模式按会话阶段选择文档工具', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let app: PlatformApplication;
  let router: ApplicationRouter;
  let tools: string[] = [];
  const owner = { actorId: 'owner', clientId: 'mode-tools' };
  beforeEach(async () => {
    f = await fixture(); await f.store.close();
    app = await PlatformApplication.open({ dataDirectory: f.data,
      models: { generate: async input => { tools = input.tools.map(tool => tool.name); return { role: 'model', parts: [{ text: 'ok' }] }; } } });
    const draft = app.settings.snapshot();
    draft.settings.workspaces.push({ id: 'project', name: 'Fixture', directory: f.source, deviceId: 'local' });
    await app.settings.save({ settings: draft.settings, expectedRevision: draft.revision });
    router = new ApplicationRouter(app);
  });
  afterEach(async () => { await app.close(); await f.cleanup(); });

  async function send(history: PlatformMessage[]) {
    const conversation = await router.call(owner, 'conversations.create', { title: 'Mode tools', workspaceId: 'project' }) as { id: string };
    if (history.length) await app.storage.appendHistory(conversation.id, history);
    const run = await router.call(owner, 'runs.start', { conversationId: conversation.id, requestKey: 'mode-tools', agentId: 'default', promptModeId: 'code', text: '继续' }) as { id: string };
    expect((await app.runtime.wait(run.id))?.status).toBe('completed');
    return tools;
  }

  test('普通对话不发送文档工作流工具', async () => {
    const sent = await send([]);
    expect(sent).toContain('read_file');
    for (const name of [...SYNC_TOOLS, ...MODE_ONLY_TOOLS]) expect(sent).not.toContain(name);
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
});
