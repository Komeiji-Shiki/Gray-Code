import { mount, flushPromises } from '@vue/test-utils';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import PlatformIntegrationSettings from '../PlatformIntegrationSettings.vue';
const calls = vi.hoisted(() => ({ send: vi.fn(), register: vi.fn() }));
vi.mock('@/utils/vscode', () => ({ sendToExtension: calls.send }));
vi.mock('@/platform/settingsDraft', () => ({ useDesktopSettingsDraft: calls.register }));
const fixture = () => ({ version: 1, providers: [], agents: [], appearance: {}, discord: {}, bindings: [],
  workspaces: [{ id: 'project', name: '普通项目', directory: '/workspace/project' }, { id: 'workspace-bot_existing', name: '旧 Bot 目录', directory: '/workspace/bot' }],
  accounts: [{ id: 'owner', displayName: '主人', role: 'owner', effects: [], workspaceIds: '*' },
    { id: 'visitor', displayName: '群聊访客', role: 'guest', effects: ['public_read'], workspaceIds: [], mcpTools: [] }],
});
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  vi.clearAllMocks(); calls.send.mockImplementation(async (type: string) => {
    if (type === 'platform.settings.get') return fixture();
    if (type === 'tools.getMcpTools') return { tools: [{ name: 'mcp__web__search', description: '搜索网页', serverName: '网络' }, { name: 'mcp__web__other', description: '其他工具', serverName: '网络' }] };
    return { success: true };
  });
});
const saved = () => calls.send.mock.calls.filter(call => call[0] === 'platform.settings.update').at(-1)?.[1].settings;
describe('默认访客及可视化多选权限', () => {
  test('只有主人账号时也能直接自定义默认权限，并在原位置选择 MCP', async () => {
    calls.send.mockImplementationOnce(async () => ({ ...fixture(), accounts: fixture().accounts.slice(0, 1) }));
    const wrapper = mount(PlatformIntegrationSettings, { props: { section: 'accounts' }, attachTo: document.body }); await flushPromises();
    try {
      const select = wrapper.get('[aria-label="未绑定用户默认权限"]');
      expect(select.findAll('option').map(option => option.text())).toEqual(['不允许主动对话', '自定义默认权限…']);
      expect(saved()).toBeUndefined();
      await select.setValue('$custom'); await flushPromises();
      const accountId = saved().botGuestAccountId;
      expect(accountId).toMatch(/^account_/);
      expect(saved().accounts).toHaveLength(2);
      expect(saved().accounts[1]).toMatchObject({ id: accountId, role: 'guest', botWorkspaceAccess: true, workspaceIds: [], effects: ['public_read'], mcpTools: [] });
      const editor = wrapper.get('#bot-default-permissions');
      expect(editor.get('details').attributes()).toHaveProperty('open');
      expect(wrapper.findAll('.permission-account-fields')).toHaveLength(1);
      await editor.get('[aria-label="允许的 MCP 工具"]').trigger('click'); await flushPromises();
      [...document.querySelectorAll<HTMLButtonElement>('.multiselect-options [role=option]')]
        .find(item => item.querySelector('strong')?.textContent === 'search')!.click(); await flushPromises();
      expect(saved().accounts[1].mcpTools).toEqual(['mcp__web__search']);
      document.querySelector<HTMLButtonElement>('.multiselect-footer button')!.click(); await flushPromises();
      await editor.get('select').setValue('member'); await flushPromises();
      expect(saved().accounts[1].role).toBe('member');
      expect(wrapper.find('[role="alert"]').exists()).toBe(false);
      await select.setValue(''); await flushPromises();
      expect(saved().botGuestAccountId).toBeUndefined();
      expect(saved().accounts[1].mcpTools).toEqual(['mcp__web__search']);
      expect(wrapper.find('#bot-default-permissions').exists()).toBe(false);
      await select.setValue(accountId); await flushPromises();
      expect(saved().accounts).toHaveLength(2);
      expect(wrapper.get('#bot-default-permissions [aria-label="允许的 MCP 工具"]').text()).toContain('search');
    } finally { wrapper.unmount(); }
  });
  test('默认工作区对应当前机器人，选择其他目录及单个 MCP 不会改动相邻权限', async () => {
    const wrapper = mount(PlatformIntegrationSettings, { props: { section: 'accounts' }, attachTo: document.body }); await flushPromises();
    try {
      await wrapper.get('[aria-label="未绑定用户默认权限"]').setValue('visitor'); await flushPromises(); expect(saved().botGuestAccountId).toBe('visitor');
      expect(wrapper.get('[aria-label="允许的工作区"]').text()).toContain('当前机器人专用工作区');
      await wrapper.get('[aria-label="允许的 MCP 工具"]').trigger('click'); await flushPromises();
      const option = [...document.querySelectorAll<HTMLButtonElement>('.multiselect-options [role=option]')].find(item => item.textContent?.includes('search'))!;
      option.click(); await flushPromises(); expect(saved().accounts[1].mcpTools).toEqual(['mcp__web__search']);
      const updates = calls.send.mock.calls.filter(call => call[0] === 'platform.settings.update').length;
      const search = document.querySelector<HTMLInputElement>('.multiselect-search input')!; search.value = 'other'; search.dispatchEvent(new Event('input', { bubbles: true })); search.dispatchEvent(new Event('change', { bubbles: true })); await flushPromises();
      expect(calls.send.mock.calls.filter(call => call[0] === 'platform.settings.update')).toHaveLength(updates);
      document.querySelector<HTMLButtonElement>('.multiselect-footer button')!.click(); await flushPromises();
      await wrapper.get('[aria-label="允许的工作区"]').trigger('click'); await flushPromises();
      expect(document.querySelector('.multiselect-options')!.textContent).not.toContain('旧 Bot 目录');
      [...document.querySelectorAll<HTMLButtonElement>('.multiselect-options [role=option]')].find(item => item.querySelector('strong')?.textContent === '普通项目')!.click(); await flushPromises();
      expect(saved().accounts[1]).toMatchObject({ workspaceIds: ['project'], botWorkspaceAccess: true, mcpTools: ['mcp__web__search'] });
    } finally { wrapper.unmount(); }
  });
  test('指定用户可以单独拉黑，新增规则不默认授予主人权限', async () => {
    const wrapper = mount(PlatformIntegrationSettings, { props: { section: 'accounts' } }); await flushPromises();
    try {
      await wrapper.findAll('button').find(button => button.text() === '添加用户规则')!.trigger('click');
      const rule = wrapper.get('.bot-user-rule'); await rule.get('input:not([type=checkbox])').setValue('1234567890');
      await rule.get('input[type=checkbox]').setValue(true); await flushPromises();
      expect(saved().bindings[0]).toMatchObject({ platformUserId: '1234567890', accountId: '', blocked: true });
      expect(saved().botGuestAccountId).toBeUndefined();
    } finally { wrapper.unmount(); }
  });
});
