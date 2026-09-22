import { mount, flushPromises } from '@vue/test-utils';
import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import ToolsSettings from '../ToolsSettings.vue';
import { setLanguage } from '../../../i18n';
const mocks = vi.hoisted(() => ({ send: vi.fn(), register: vi.fn() }));
vi.mock('@/utils/vscode', () => ({ sendToExtension: mocks.send }));
vi.mock('@/platform/settingsDraft', () => ({ useDesktopSettingsDraft: mocks.register }));
beforeEach(() => {
  setLanguage('zh-CN'); vi.clearAllMocks();
  mocks.send.mockImplementation(async method => method === 'tools.getMaxToolIterations' ? { maxIterations: 200 }
    : method === 'tools.getTools' ? { tools: [] } : method === 'dependencies.list' ? { dependencies: [] } : {});
});
afterEach(() => setLanguage('auto'));
test('0 和小数显示原因，阻止保存或离开且保留原输入', async () => {
  const wrapper = mount(ToolsSettings); await flushPromises();
  try {
    const input = wrapper.get('input[type="number"]');
    for (const invalid of ['0', '1.5', '-2', '1e3']) {
      await input.setValue(invalid); await flushPromises();
      expect(input.attributes('aria-invalid')).toBe('true');
      expect(wrapper.get('[role="alert"]').text()).toContain('正整数');
      await expect(mocks.register.mock.calls[0][0]()).rejects.toThrow('0 和小数无效');
      expect((input.element as HTMLInputElement).value).toBe(invalid);
    }
    expect(mocks.send.mock.calls.some(([method]) => method === 'tools.updateMaxToolIterations')).toBe(false);
    await input.setValue('-1'); await flushPromises();
    expect(input.attributes('aria-invalid')).toBe('false');
    await expect(mocks.register.mock.calls[0][0]()).resolves.toBeUndefined();
    expect(mocks.send).toHaveBeenCalledWith('tools.updateMaxToolIterations', { maxIterations: -1 });
  } finally { wrapper.unmount(); }
});
test('清空后统一保存仍保留原值，正整数沿现有路径暂存', async () => {
  const wrapper = mount(ToolsSettings); await flushPromises();
  try {
    const input = wrapper.get('input[type="number"]'); await input.setValue('');
    await mocks.register.mock.calls[0][0](); await flushPromises();
    expect((input.element as HTMLInputElement).value).toBe('200');
    expect(mocks.send.mock.calls.some(([method]) => method === 'tools.updateMaxToolIterations')).toBe(false);
    await input.setValue('5'); await flushPromises();
    expect(mocks.send).toHaveBeenCalledWith('tools.updateMaxToolIterations', { maxIterations: 5 });
  } finally { wrapper.unmount(); }
});
