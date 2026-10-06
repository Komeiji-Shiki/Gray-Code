import { mount, flushPromises, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import AutoExecSettings from '../AutoExecSettings.vue';
import { setLanguage } from '../../../i18n';
const mocks = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('@/utils/vscode', () => ({ sendToExtension: mocks.send }));

type Approval = 'auto' | 'ask' | 'risk';
const tool = (name: string, approval?: Approval, approvalConfigured?: boolean) => ({ name, description: name, enabled: true, category: 'other',
  ...(approval ? { approval, approvalConfigured: approvalConfigured ?? false } : {}) });
// 模拟独立平台：保存和恢复默认的回执带回最新规则；defaults 是恢复默认后的规则。
function respond(tools: unknown[], config: Record<string, boolean>, mcpTools: unknown[] = [], defaults: Record<string, Approval> = {}) {
  mocks.send.mockImplementation(async (method: string, data: { toolName?: string; autoExec?: boolean } = {}) => method === 'tools.getTools' ? { tools }
    : method === 'tools.getMcpTools' ? { tools: mcpTools } : method === 'tools.getAutoExecConfig' ? { config }
      : method === 'tools.setToolAutoExec' ? { success: true, approval: data.autoExec ? 'auto' : 'ask', approvalConfigured: true }
        : method === 'tools.resetToolAutoExec' ? { success: true, approval: defaults[data.toolName!], approvalConfigured: false } : { success: true });
}
const row = (wrapper: VueWrapper, name: string) => wrapper.get(`[data-search-tool="${encodeURIComponent(name)}"]`);
const checked = (wrapper: VueWrapper, name: string) => (row(wrapper, name).get('input[type="checkbox"]').element as HTMLInputElement).checked;
const saved = () => mocks.send.mock.calls.filter(([method]) => method === 'tools.setToolAutoExec').map(([, data]) => data);
beforeEach(() => { setLanguage('zh-CN'); vi.clearAllMocks(); });
afterEach(() => setLanguage('auto'));

test('独立平台按实际规则显示：未单独设置的工具显示按风险确认，勾选后改为自动执行', async () => {
  respond([tool('subagent_requests', 'risk'), tool('run_command', 'risk'), tool('delete_file', 'ask'), tool('computer_action', 'auto')],
    { delete_file: false });
  const wrapper = mount(AutoExecSettings); await flushPromises();
  try {
    const label = row(wrapper, 'subagent_requests').get('.toggle-label');
    expect(label.text()).toBe('按风险确认');
    expect(label.attributes('title')).toContain('删除');
    expect(checked(wrapper, 'subagent_requests')).toBe(false);
    expect(row(wrapper, 'run_command').get('.toggle-label').text()).toBe('按风险确认');
    expect(row(wrapper, 'delete_file').get('.toggle-label').text()).toBe('需确认');
    expect(checked(wrapper, 'computer_action')).toBe(true);
    await row(wrapper, 'subagent_requests').get('input[type="checkbox"]').setValue(true); await flushPromises();
    expect(saved()).toEqual([{ toolName: 'subagent_requests', autoExec: true }]);
    expect(label.text()).toBe('自动执行');
  } finally { wrapper.unmount(); }
});

test('全部需确认同样覆盖按风险确认的工具，已需确认的工具不重复保存', async () => {
  respond([tool('read_file', 'risk'), tool('delete_file', 'ask'), tool('computer_action', 'auto')], {});
  const wrapper = mount(AutoExecSettings); await flushPromises();
  try {
    await wrapper.findAll('.auto-exec-actions .action-btn')[2].trigger('click'); await flushPromises();
    expect(saved()).toEqual([{ toolName: 'read_file', autoExec: false }, { toolName: 'computer_action', autoExec: false }]);
    expect(row(wrapper, 'read_file').get('.toggle-label').text()).toBe('需确认');
  } finally { wrapper.unmount(); }
});

test('平台内置列表已含的 MCP 工具只显示一行，保留服务器信息，切换后状态与规则一致', async () => {
  const builtin = { ...tool('mcp__fs__read', 'auto'), category: 'mcp' };
  const mcp = { name: 'mcp__fs__read', description: 'read', enabled: true, category: 'mcp', serverId: 'fs', serverName: '文件服务' };
  respond([tool('read_file', 'risk'), builtin], {}, [mcp]);
  const wrapper = mount(AutoExecSettings); await flushPromises();
  try {
    expect(wrapper.findAll(`[data-search-tool="${encodeURIComponent('mcp__fs__read')}"]`)).toHaveLength(1);
    expect(row(wrapper, 'mcp__fs__read').get('.mcp-badge').text()).toBe('文件服务');
    await row(wrapper, 'mcp__fs__read').get('input[type="checkbox"]').setValue(false); await flushPromises();
    expect(saved()).toEqual([{ toolName: 'mcp__fs__read', autoExec: false }]);
    expect(row(wrapper, 'mcp__fs__read').get('.toggle-label').text()).toBe('需确认');
    expect(checked(wrapper, 'mcp__fs__read')).toBe(false);
  } finally { wrapper.unmount(); }
});

test('单独设置过的工具可以恢复默认，全部恢复默认只处理单独设置过的工具', async () => {
  respond([tool('subagent_requests', 'auto', true), tool('delete_file', 'ask'), tool('run_command', 'ask', true)], { delete_file: false }, [],
    { subagent_requests: 'risk', run_command: 'risk' });
  const wrapper = mount(AutoExecSettings); await flushPromises();
  const resets = () => mocks.send.mock.calls.filter(([method]) => method === 'tools.resetToolAutoExec').map(([, data]) => data);
  const resetAll = () => wrapper.findAll('.auto-exec-actions .action-btn').find(button => button.text().includes('全部恢复默认'));
  try {
    expect(row(wrapper, 'delete_file').find('.reset-btn').exists()).toBe(false);
    await row(wrapper, 'subagent_requests').get('.reset-btn').trigger('click'); await flushPromises();
    expect(resets()).toEqual([{ toolName: 'subagent_requests' }]);
    expect(row(wrapper, 'subagent_requests').get('.toggle-label').text()).toBe('按风险确认');
    expect(row(wrapper, 'subagent_requests').find('.reset-btn').exists()).toBe(false);
    await resetAll()!.trigger('click'); await flushPromises();
    expect(resets()).toEqual([{ toolName: 'subagent_requests' }, { toolName: 'run_command' }]);
    expect(row(wrapper, 'run_command').get('.toggle-label').text()).toBe('按风险确认');
    expect(resetAll()).toBeUndefined();
  } finally { wrapper.unmount(); }
});

test('旧扩展不提供规则时沿用自动执行配置，未配置的工具自动执行', async () => {
  respond([tool('read_file'), tool('delete_file')], { delete_file: false });
  const wrapper = mount(AutoExecSettings); await flushPromises();
  try {
    expect(row(wrapper, 'read_file').get('.toggle-label').text()).toBe('自动执行');
    expect(checked(wrapper, 'read_file')).toBe(true);
    expect(row(wrapper, 'delete_file').get('.toggle-label').text()).toBe('需确认');
  } finally { wrapper.unmount(); }
});
