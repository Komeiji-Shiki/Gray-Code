import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import type { AgentDefinition, PlatformMessage } from '@graycode/contracts';
import { PlatformApplication } from '../../../apps/server/src/application';
import { ApplicationRouter } from '../../../apps/server/src/transport/router';
import { fixture } from './fixtures';

type Call = { name: string; args: Record<string, unknown> };

describe('按操作审批：受限模式与合并工具', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let app: PlatformApplication;
  let router: ApplicationRouter;
  let call: Call;
  let searchDeclaration: { description: string; parameters: { properties?: Record<string, unknown> } } | undefined;
  let requests = 0;
  const owner = { actorId: 'owner', clientId: 'operation-approval' };
  beforeEach(async () => {
    f = await fixture(); await f.store.close();
    await writeFile(path.join(f.source, 'note.txt'), 'old value');
    app = await PlatformApplication.open({ dataDirectory: f.data,
      models: { generate: async input => {
        searchDeclaration = input.tools.find(tool => tool.name === 'search_in_files') as typeof searchDeclaration;
        return input.messages.some(message => message.role === 'model')
          ? { role: 'model', parts: [{ text: 'done' }] }
          : { role: 'model', parts: [{ functionCall: { id: 'operation', ...call } }] };
      } } });
    const draft = app.settings.snapshot();
    draft.settings.workspaces.push({ id: 'project', name: 'Fixture', directory: f.source, deviceId: 'local' });
    await app.settings.save({ settings: draft.settings, expectedRevision: draft.revision });
    router = new ApplicationRouter(app);
  });
  afterEach(async () => { await app.close(); await f.cleanup(); });

  /** 发起一次只调用一个工具的运行，返回该工具的结果。 */
  async function run(next: Call, options: { promptModeId?: string; agentId?: string } = {}) {
    call = next;
    const conversation = await router.call(owner, 'conversations.create', { title: 'Approval', workspaceId: 'project' }) as { id: string };
    // runs.start 不接收模式参数；桌面经产品聊天入口传递模式，这里直接使用运行器入口。
    const started = await app.runtime.start({ actorId: owner.actorId, conversationId: conversation.id, workspaceId: 'project', requestKey: `approval-${++requests}`,
      agentId: options.agentId ?? 'default', promptModeId: options.promptModeId ?? 'code', message: { role: 'user', parts: [{ text: '执行' }] } });
    expect((await app.runtime.wait(started.id))?.status).toBe('completed');
    const messages: PlatformMessage[] = (await app.storage.readFullHistory(conversation.id)).messages;
    const part = messages.flatMap(message => message.parts).find(item => item.functionResponse);
    return (part!.functionResponse as { response: Record<string, unknown> }).response;
  }

  test('Ask 模式只授予搜索时拒绝 search_in_files 的 replace，搜索照常执行', async () => {
    const replaced = await run({ name: 'search_in_files', args: { mode: 'replace', query: 'old', replace: 'new' } }, { promptModeId: 'ask' });
    expect(replaced).toMatchObject({ success: false, code: 'PERMISSION_DENIED' });
    expect(await readFile(path.join(f.source, 'note.txt'), 'utf8')).toBe('old value');
    const searched = await run({ name: 'search_in_files', args: { mode: 'search', query: 'old' } }, { promptModeId: 'ask' });
    expect(searched).toMatchObject({ success: true });
    // 声明里不再展示替换参数，模型也就不会把替换当作可用操作。
    expect(Object.keys(searchDeclaration!.parameters.properties ?? {})).not.toEqual(expect.arrayContaining(['replace']));
    expect(searchDeclaration!.parameters.properties).not.toHaveProperty('mode');
    expect(searchDeclaration!.parameters.properties).not.toHaveProperty('maxFiles');
    expect(searchDeclaration!.description).not.toContain('替换');
  });

  test('授予写工具的模式仍展示完整的搜索替换声明', async () => {
    await run({ name: 'read_file', args: { path: 'note.txt' } });
    expect(searchDeclaration!.parameters.properties).toHaveProperty('replace');
    expect(searchDeclaration!.parameters.properties).toHaveProperty('mode');
  });

  test('旧清单划定的工程日志操作范围不会被新名称上的自动执行覆盖', async () => {
    const draft = app.settings.snapshot();
    const base = draft.settings.agents[0];
    const limited: AgentDefinition = { ...base, id: 'limited', name: 'Limited', toolNames: ['memory_wake', 'read_file'], toolApproval: { engineering_log: 'auto' } };
    draft.settings.agents.push(limited);
    await app.settings.save({ settings: draft.settings, expectedRevision: draft.revision });
    const noted = await run({ name: 'engineering_log', args: { action: 'note', text: '不应写入' } }, { agentId: 'limited' });
    expect(noted).toMatchObject({ success: false, code: 'PERMISSION_DENIED', error: 'This tool is disabled by its approval rule.' });
  });
});
