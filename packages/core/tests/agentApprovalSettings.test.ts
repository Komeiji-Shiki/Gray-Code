import { needsApproval } from '../src/runtime/tools';
import { PlatformApplication } from '../../../apps/server/src/application';
import { configuredAgent } from '../../../apps/server/src/settings/agent';
import { SettingsTransfer } from '../../../apps/server/src/settings/transfer';
import { ApplicationRouter } from '../../../apps/server/src/transport/router';
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

test('自动执行设置页按运行时规则显示确认方式，单独设置过的工具可以恢复默认', async () => {
  const f = await fixture(); await f.store.close();
  const app = await PlatformApplication.open({ dataDirectory: f.data });
  const router = new ApplicationRouter(app), owner = { actorId: 'owner', clientId: 'auto-exec-settings' };
  const call = (type: string, data = {}) => router.call(owner, 'ui.request', { type, data }) as Promise<any>;
  const states = async (): Promise<Record<string, { approval: string; approvalConfigured: boolean }>> =>
    Object.fromEntries((await call('tools.getTools')).tools.map((tool: { name: string; approval: string; approvalConfigured: boolean }) =>
      [tool.name, { approval: tool.approval, approvalConfigured: tool.approvalConfigured }]));
  try {
    await call('ui.settings.begin');
    const runtime = configuredAgent(app, app.settings.snapshot().settings.agents[0]).toolApproval ?? {};
    const shown = await states();
    for (const [name, state] of Object.entries(shown)) expect([name, state.approval]).toEqual([name, runtime[name] ?? 'risk']);
    // delete_file 的默认值也写在设置里，但不算单独设置过。
    expect(shown).toMatchObject({ delete_file: { approval: 'ask', approvalConfigured: false }, read_file: { approval: 'risk', approvalConfigured: false },
      subagent_requests: { approval: 'risk', approvalConfigured: false } });
    expect(await call('tools.setToolAutoExec', { toolName: 'subagent_requests', autoExec: true }))
      .toMatchObject({ success: true, approval: 'auto', approvalConfigured: true });
    expect((await states()).subagent_requests).toEqual({ approval: 'auto', approvalConfigured: true });
    expect(await call('tools.resetToolAutoExec', { toolName: 'subagent_requests' })).toMatchObject({ success: true, approval: 'risk', approvalConfigured: false });
    expect((await states()).subagent_requests).toEqual({ approval: 'risk', approvalConfigured: false });
    // 默认配置里的工具恢复为默认值，与重新启动后加载的结果一致。
    expect(await call('tools.setToolAutoExec', { toolName: 'execute_command', autoExec: true })).toMatchObject({ approval: 'auto', approvalConfigured: true });
    expect(await call('tools.resetToolAutoExec', { toolName: 'execute_command' })).toMatchObject({ approval: 'ask', approvalConfigured: false });
  } finally { await app.close(); await f.cleanup(); }
});

test('便携配置替换导入时，另一台机器已恢复默认的工具不会被本机旧设置补回；普通导入仍合并', async () => {
  const f = await fixture(); await f.store.close();
  const app = await PlatformApplication.open({ dataDirectory: f.data });
  const rules = () => configuredAgent(app, app.settings.snapshot().settings.agents[0]).toolApproval ?? {};
  try {
    const transfer = new SettingsTransfer(app);
    const local = await app.product.draft();
    await local.settings.setToolAutoExec('subagent_requests', true);
    await local.settings.setToolAutoExec('run_command', false);
    await app.product.save(local);
    // 便携副本来自另一台机器：那里 subagent_requests 已恢复默认，run_command 仍单独设置为需确认。
    const other = await app.product.draft();
    await other.settings.resetToolAutoExec('subagent_requests');
    const portable = await transfer.export(other);

    const merged = await app.product.draft();
    await transfer.import(merged, portable);
    expect(merged.settings.getToolAutoExecConfig().subagent_requests).toBe(true);

    const replaced = await app.product.draft();
    await transfer.import(replaced, portable, true);
    await app.product.save(replaced);
    expect(rules().subagent_requests).toBeUndefined();
    expect(rules().run_command).toBe('ask');
    expect(rules().delete_file).toBe('ask');
  } finally { await app.close(); await f.cleanup(); }
});
