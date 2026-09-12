import { mount, flushPromises } from '@vue/test-utils';
import { beforeEach, expect, test, vi } from 'vitest';
import PlatformDevelopmentSettings from '../PlatformDevelopmentSettings.vue';

const calls = vi.hoisted(() => ({ send: vi.fn(), register: vi.fn(), dirty: vi.fn() }));
vi.mock('@/utils/vscode', () => ({ sendToExtension: calls.send }));
vi.mock('@/platform/settingsDraft', () => ({ useDesktopSettingsDraft: calls.register, markDesktopSettingsDirty: calls.dirty }));
const initial = () => ({ disabledLanguageServers: ['custom-python'],
  languageServers: [{ id: 'custom-python', name: '项目 Python', languages: ['python'], command: 'python-lsp', args: ['', '--stdio', 'folder with spaces'], settings: { analysis: { mode: 'strict' } } }],
  debugAdapters: [{ id: 'debug', name: '调试器', command: 'debug', args: [], transport: 'stdio' }],
});
beforeEach(() => {
  vi.clearAllMocks();
  Element.prototype.scrollIntoView = vi.fn();
  calls.send.mockImplementation(async (type: string) => {
    if (type === 'platform.development.get') return initial();
    if (type === 'platform.development.list') return [
      { id: 'typescript', name: 'TypeScript / JavaScript', languages: ['typescript', 'javascript'], source: 'bundled', available: true },
      { id: 'gopls', name: 'Go', languages: ['go'], source: 'system', available: false, requirement: '需要 Go 开发环境和 gopls。', documentationUrl: 'https://go.dev/gopls/',
        configurationTemplate: { id: 'gopls', name: 'Go', languages: ['go'], command: 'gopls', args: [] } },
    ];
    return { success: true };
  });
});
const render = () => mount(PlatformDevelopmentSettings, { global: { stubs: { DesktopEditorSettings: true } } });

test('重新检测不会覆盖待保存的开关或程序路径，保存保留空参数和调试器设置', async () => {
  const wrapper = render(); await flushPromises();
  try {
    expect(wrapper.text()).toContain('内置可用'); expect(wrapper.text()).toContain('需要安装');
    await wrapper.get('.service-row input[type=checkbox]').setValue(false);
    await wrapper.get('.custom-fields input[placeholder="程序名称或完整路径"]').setValue('D:/tools/python-lsp');
    await wrapper.findAll('button').find(button => button.text() === '重新检测')!.trigger('click'); await flushPromises();
    expect((wrapper.get('.service-row input[type=checkbox]').element as HTMLInputElement).checked).toBe(false);
    expect((wrapper.get('.custom-fields input[placeholder="程序名称或完整路径"]').element as HTMLInputElement).value).toBe('D:/tools/python-lsp');
    await wrapper.findAll('button').find(button => button.text() === '自定义路径与参数')!.trigger('click');
    await flushPromises(); expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
    await calls.register.mock.calls[0][0]();
    const saved = calls.send.mock.calls.find(call => call[0] === 'platform.development.update')![1].settings;
    expect(saved.disabledLanguageServers).toEqual(expect.arrayContaining(['typescript', 'custom-python']));
    expect(saved.languageServers[0]).toMatchObject({ command: 'D:/tools/python-lsp', args: ['', '--stdio', 'folder with spaces'], settings: { analysis: { mode: 'strict' } } });
    expect(saved.debugAdapters).toEqual(initial().debugAdapters);
    expect(saved.languageServers[1]).toMatchObject({ id: 'gopls', languages: ['go'], command: 'gopls', args: [] });
  } finally { wrapper.unmount(); }
});

test('重命名自定义标识保留停用状态，单独移除服务也会标记待保存', async () => {
  const wrapper = render(); await flushPromises();
  try {
    await wrapper.get('.custom-fields input[placeholder="例如：project-python"]').setValue('project-python');
    expect((wrapper.get('.custom-server input[type=checkbox]').element as HTMLInputElement).checked).toBe(false);
    await calls.register.mock.calls[0][0]();
    expect(calls.send.mock.calls.find(call => call[0] === 'platform.development.update')![1].settings.disabledLanguageServers).toContain('project-python');
    await wrapper.findAll('button').find(button => button.text() === '移除服务')!.trigger('click');
    expect(calls.dirty).toHaveBeenCalledOnce();
    expect(wrapper.find('.custom-server').exists()).toBe(false);
  } finally { wrapper.unmount(); }
});

test('配置读取失败时不能用空表单覆盖已保存设置', async () => {
  calls.send.mockRejectedValue(new Error('连接暂时不可用'));
  const wrapper = render(); await flushPromises();
  try {
    expect(wrapper.get('[role=alert]').text()).toContain('连接暂时不可用');
    expect(calls.register.mock.calls[0][1]()).toBe(false);
  } finally { wrapper.unmount(); }
});
