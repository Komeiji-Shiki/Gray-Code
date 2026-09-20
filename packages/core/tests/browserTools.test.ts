import type { ModelInput } from '@graycode/contracts';
import { PlatformApplication } from '../../../apps/server/src/application';
import { ApplicationRouter } from '../../../apps/server/src/transport/router';
import type { BrowserHost } from '../../../apps/server/src/browser/port';
import { browserTools } from '../../../apps/server/src/browser/tools';
import { initialSettings } from '../../../apps/server/src/settings/service';
import { fixture } from './fixtures';

test('浏览器声明不随身份或宿主变化，拒绝与审批在访问私人页面之前执行', async () => {
  const f = await fixture();
  const previous = initialSettings(['ask_user']); previous.toolCatalogVersion = 10;
  await f.store.commitRecords([{ namespace: 'platform-settings', id: 'main', value: previous, expectedRevision: null }]); await f.store.close();
  const inputs: ModelInput[] = []; const executed: string[] = []; const finished: string[] = [];
  const host: BrowserHost = {
    tool: async (_name, _args, context) => { executed.push(context.actorId); return { success: true, data: { title: 'private page' } }; },
    call: async () => 'private page', finishRun: id => { finished.push(id); }, close: () => {},
  };
  const app = await PlatformApplication.open({ dataDirectory: f.data, browser: () => host, models: { generate: async input => {
    inputs.push(input);
    if (input.messages.some(message => message.parts.some(part => part.functionResponse))) return { role: 'model', parts: [{ text: '完成' }] };
    const mutation = input.messages.some(message => message.parts.some(part => typeof part.text === 'string' && part.text.includes('提交表单')));
    return { role: 'model', parts: [{ functionCall: { id: 'browser-call', name: mutation ? 'browser_action' : 'browser_tabs', args: mutation ? { action: 'click', tabId: 'known-tab', ref: 'observed-ref', url: 'https://example.test/form' } : { action: 'list' } } }] };
  } } });
  try {
    const legacy = await app.product.draft();
    await legacy.settings.setToolAutoExec('execute_command', true);
    await app.product.save(legacy);
    expect(app.settings.snapshot().settings.agents[0].toolNames).toEqual(['ask_user', ...browserTools().map(tool => tool.declaration.name)]);
    const current = app.settings.snapshot(); current.settings.accounts.push({ id: 'guest', displayName: '普通成员', role: 'guest', effects: [], workspaceIds: [] });
    await app.settings.save({ settings: current.settings, expectedRevision: current.revision });
    const approvals: any[] = [];
    app.subscribe(notification => {
      const event = notification.event as any;
      if (notification.type === 'event' && event?.type === 'approval.requested') { approvals.push(event.payload); void app.runtime.resolveApproval(event.payload.id, 'owner', false); }
    });
    for (const [actorId, text] of [['owner', '查看页面'], ['guest', '查看页面'], ['owner', '提交表单'], ['owner', '确认提交表单']]) {
      if (text === '确认提交表单') {
        const draft = await app.product.draft(); await draft.settings.setToolAutoExec('browser_action', false); await app.product.save(draft);
      }
      const conversation = await app.createConversation(actorId, text);
      const run = await app.runtime.start({ requestKey: conversation.id, conversationId: conversation.id, actorId, agentId: 'default', message: { role: 'user', parts: [{ text }] } });
      expect((await app.runtime.wait(run.id))?.status).toBe('completed');
      const history = await app.storage.readHistory(conversation.id);
      const response = history.messages.flatMap(message => message.parts).find(part => part.functionResponse)?.functionResponse as any;
      expect(response.id).toBe('browser-call');
      expect(response.response.success).toBe(actorId === 'owner' && text !== '确认提交表单');
      if (actorId === 'guest' || text === '确认提交表单') expect(response.response.code).toBe('PERMISSION_DENIED');
      expect(finished).toContain(run.id);
    }
    expect(executed).toEqual(['owner', 'owner']); expect(approvals).toHaveLength(1);
    expect(approvals[0].args).toEqual({ action: 'click', tabId: 'known-tab', ref: 'observed-ref', url: 'https://example.test/form' });
    expect(inputs[0].tools).toEqual(inputs[2].tools);
    expect(browserTools().map(tool => tool.declaration)).toEqual(browserTools(host).map(tool => tool.declaration));
    expect(await browserTools()[0].execute({ action: 'list' }, {} as any)).toMatchObject({ success: false, code: 'BROWSER_UNAVAILABLE' });
    await expect(new ApplicationRouter(app).call({ actorId: 'guest', clientId: 'untrusted' }, 'browser.state')).rejects.toThrow('Owner');
  } finally { await app.close(); await f.cleanup(); }
});
