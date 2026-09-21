import { mount, flushPromises } from '@vue/test-utils';
import { beforeEach, expect, test, vi } from 'vitest';
import ExternalAgentSettings from '../ExternalAgentSettings.vue';
const mocks = vi.hoisted(() => ({ send: vi.fn(), register: vi.fn(), dirty: vi.fn() }));
vi.mock('@/utils/vscode', () => ({ sendToExtension: mocks.send }));
vi.mock('@/platform/settingsDraft', () => ({ useDesktopSettingsDraft: mocks.register, markDesktopSettingsDirty: mocks.dirty }));
beforeEach(() => {
  vi.clearAllMocks(); mocks.send.mockImplementation(async method => method === 'platform.externalAgents.get' ? [{ id:'agent',name:'测试代理',enabled:true,command:'C:\\Program Files\\agent.exe',args:['folder with spaces'] }] : {});
});
test('ACP 环境变量错误指出配置名称，不回显 JSON 中的敏感值', async () => {
  const wrapper = mount(ExternalAgentSettings); await flushPromises();
  await wrapper.find('textarea').setValue('{"TOKEN":"fixture-private-value"');
  await expect(mocks.register.mock.calls[0][0]()).rejects.toThrow('代理“测试代理”的环境变量 JSON 格式不正确');
  expect(wrapper.text()).not.toContain('fixture-private-value');
  expect(mocks.send.mock.calls.some(([method]) => method === 'platform.externalAgents.update')).toBe(false); wrapper.unmount();
});
test('环境变量必须是字符串键值对，合法配置保留含空格的独立参数', async () => {
  const wrapper = mount(ExternalAgentSettings); await flushPromises();
  await wrapper.find('textarea').setValue('{"PORT":3000}');
  await expect(mocks.register.mock.calls[0][0]()).rejects.toThrow('每个值都必须是字符串');
  await wrapper.find('textarea').setValue('{"PORT":"3000"}'); await mocks.register.mock.calls[0][0]();
  expect(mocks.send).toHaveBeenCalledWith('platform.externalAgents.update', { profiles: [expect.objectContaining({command:'C:\\Program Files\\agent.exe',args:['folder with spaces'],env:{PORT:'3000'}})] });
  wrapper.unmount();
});
