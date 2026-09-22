import { mount, flushPromises } from '@vue/test-utils';
import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import ContextSettings from '../ContextSettings.vue';
import { setLanguage } from '../../../i18n';
const mocks = vi.hoisted(() => ({ send: vi.fn(), register: vi.fn() }));
vi.mock('@/utils/vscode', () => ({ sendToExtension: mocks.send }));
vi.mock('@/platform/settingsDraft', () => ({ useDesktopSettingsDraft: mocks.register }));
beforeEach(() => {
  setLanguage('zh-CN'); vi.clearAllMocks();
  mocks.send.mockImplementation(async method => method === 'getContextAwarenessConfig' ? {
    includeWorkspaceFiles: true, maxFileDepth: 2, includeOpenTabs: true, maxOpenTabs: 20, includeActiveEditor: true, ignorePatterns: [],
    diagnostics: { enabled: true, includeSeverities: ['error','warning'], workspaceOnly: true, openFilesOnly: false, maxDiagnosticsPerFile: 10, maxFiles: 20 },
  } : method === 'getOpenTabs' ? { tabs: [] } : method === 'getActiveEditor' ? { path: null } : {});
});
afterEach(() => setLanguage('auto'));
test('说明每个数值的范围影响，小数保留在输入框并阻止分类离开', async () => {
  const wrapper = mount(ContextSettings, { global: { stubs: { CustomCheckbox: true } } }); await flushPromises();
  try {
    expect(wrapper.text()).toContain('0 只列根目录条目');
    expect(wrapper.text()).toContain('不包含正文');
    const input = wrapper.get('[aria-label="最大深度"]'); await input.setValue('2.5');
    expect(input.attributes('aria-invalid')).toBe('true');
    expect(mocks.send.mock.calls.some(([method]) => method === 'updateContextAwarenessConfig')).toBe(false);
    await expect(mocks.register.mock.calls[0][0]()).rejects.toThrow('非负整数');
    await input.setValue('-1'); await flushPromises();
    expect(input.attributes('aria-invalid')).toBe('false');
    expect(mocks.send).toHaveBeenCalledWith('updateContextAwarenessConfig', { config: expect.objectContaining({ maxFileDepth: -1 }) });
    await wrapper.get('[aria-label="最大数量"]').setValue('0'); await flushPromises();
    expect(mocks.send).toHaveBeenCalledWith('updateContextAwarenessConfig', { config: expect.objectContaining({ maxOpenTabs: 0 }) });
  } finally { wrapper.unmount(); }
});
