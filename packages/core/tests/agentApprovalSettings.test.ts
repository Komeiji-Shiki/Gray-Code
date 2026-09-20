import { needsApproval } from '../src/runtime/tools';
import { PlatformApplication } from '../../../apps/server/src/application';
import { configuredAgent } from '../../../apps/server/src/settings/agent';
import { fixture } from './fixtures';

test('操控工具继承自动执行勾选，保留取消勾选、Agent 覆盖和命令动态审批', async () => {
  const f = await fixture(); await f.store.close();
  const app = await PlatformApplication.open({ dataDirectory: f.data });
  try {
    const original = app.settings.snapshot().settings.agents[0];
    const inherited = configuredAgent(app, { ...original, approvalMode: 'all_mutations' });
    expect(needsApproval(inherited, 'computer_action', ['desktop_control'])).toBe(false);
    expect(needsApproval(inherited, 'browser_action', ['private_browser', 'external_send'])).toBe(false);
    expect(inherited.toolApproval?.execute_command).toBe('ask');
    expect(needsApproval(inherited, 'execute_command', ['high_risk'])).toBe(true);
    expect(needsApproval(inherited, 'delete_file', ['data_delete'])).toBe(true);

    const draft = await app.product.draft();
    await draft.settings.setToolAutoExec('computer_action', false);
    await draft.settings.setToolAutoExec('browser_action', false);
    await app.product.save(draft);
    const saved = configuredAgent(app, original);
    expect(needsApproval(saved, 'computer_action', ['desktop_control'])).toBe(true);
    expect(needsApproval(saved, 'browser_action', ['external_send'])).toBe(true);
    const override = configuredAgent(app, { ...original, toolApproval: { computer_action: 'auto', browser_read: 'ask' } });
    expect(needsApproval(override, 'computer_action', ['desktop_control'])).toBe(false);
    expect(needsApproval(override, 'browser_read', ['private_browser'])).toBe(true);
    const custom = configuredAgent(app, { ...original, id: 'custom', toolNames: ['browser_read'] });
    expect(custom.toolNames).toEqual(['browser_read']);
  } finally { await app.close(); await f.cleanup(); }
});
