import { mount, flushPromises } from '@vue/test-utils';
import { beforeEach, expect, test, vi } from 'vitest';
import ClawdSettings from '../ClawdSettings.vue';
import PlatformAppearanceSettings from '../PlatformAppearanceSettings.vue';

const calls = vi.hoisted(() => ({ send: vi.fn(), register: vi.fn(), dirty: vi.fn(), draft: { dirty: false } }));
vi.mock('@/utils/vscode', () => ({ sendToExtension: calls.send }));
vi.mock('@/platform/settingsDraft', () => ({ useDesktopSettingsDraft: calls.register, markDesktopSettingsDirty: calls.dirty, desktopSettingsDraft: calls.draft }));
vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
beforeEach(() => {
  vi.clearAllMocks(); calls.draft.dirty = false;
  calls.send.mockImplementation(async method => {
    if (method === 'platform.settings.get') return { appearance: { theme: 'dark' }, clawd: { enabled: true, agentId: 'custom-graycode-0123456789ab' } };
    if (method === 'platform.clawd.status') return { state: 'waiting' };
    if (method === 'platform.clawd.check') return { state: 'connected', port: 23334 };
    if (method === 'ui.settings.status') return { dirty: false };
    return { success: true };
  });
});

test('只在编辑后合入最新设置草稿，保留其他页的设置', async () => {
  const wrapper = mount(ClawdSettings); await flushPromises();
  await calls.register.mock.calls[0][0]();
  expect(calls.send.mock.calls.some(([method]) => method === 'platform.settings.update')).toBe(false);
  await wrapper.get('#clawd-agent-id').setValue(' custom-graycode-abcdef012345 ');
  await calls.register.mock.calls[0][0]();
  expect(calls.send).toHaveBeenCalledWith('platform.settings.update', { settings: { appearance: { theme: 'dark' }, clawd: { enabled: true, agentId: 'custom-graycode-abcdef012345' } } });
  expect(calls.dirty).toHaveBeenCalled(); wrapper.unmount();
});

test('未保存时提示保存全部，检查只使用已经生效的设置', async () => {
  const wrapper = mount(ClawdSettings); await flushPromises();
  calls.draft.dirty = true; await wrapper.get('button').trigger('click'); await flushPromises();
  expect(wrapper.get('[role="alert"]').text()).toContain('saveFirst');
  expect(calls.send.mock.calls.some(([method]) => method === 'platform.clawd.check')).toBe(false);
  calls.draft.dirty = false; await wrapper.get('button').trigger('click'); await flushPromises();
  expect(wrapper.get('[role="status"]').text()).toContain('status_connected'); wrapper.unmount();
});

test('检查失败后可以继续修改配置并重试', async () => {
  const wrapper = mount(ClawdSettings); await flushPromises();
  calls.send.mockImplementationOnce(async () => ({ dirty: false })).mockImplementationOnce(async () => { throw new Error('connection failed'); });
  await wrapper.get('button').trigger('click'); await flushPromises();
  expect(wrapper.get('[role="alert"]').text()).toBe('connection failed');
  expect(wrapper.get('button').attributes('disabled')).toBeUndefined();
  await wrapper.get('input[type="checkbox"]').setValue(false);
  expect(wrapper.find('[role="alert"]').exists()).toBe(false); wrapper.unmount();
});

test('同页外观保存不会用旧快照覆盖刚写入的 Clawd 配置', async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  let clawd: { enabled: boolean; agentId: string } | undefined;
  calls.send.mockImplementation(async method => {
    if (method === 'desktop.fonts') return [];
    if (method === 'platform.settings.get') return { appearance: { theme: 'dark', colors: {}, uiFont: 'inherit', textFont: 'inherit', codeFont: 'monospace', fontSize: 14, codeFontSize: 13, lineHeight: 1.6 }, clawd };
    return { success: true };
  });
  const wrapper = mount(PlatformAppearanceSettings, { global: { stubs: { BackgroundGallery: true, MarkdownRenderer: true } } });
  try {
    await flushPromises(); clawd = { enabled: true, agentId: 'custom-graycode-0123456789ab' };
    await wrapper.get('select[aria-label="外观主题"]').setValue('light'); await flushPromises();
    expect(calls.send).toHaveBeenCalledWith('platform.settings.update', { settings: expect.objectContaining({ clawd,
      appearance: expect.objectContaining({ theme: 'light' }) }) });
  } finally { wrapper.unmount(); vi.unstubAllGlobals(); }
});
