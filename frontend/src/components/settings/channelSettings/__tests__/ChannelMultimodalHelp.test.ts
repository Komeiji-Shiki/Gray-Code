import { mount } from '@vue/test-utils';
import { afterEach, expect, test } from 'vitest';
import ChannelBasicSettings from '../ChannelBasicSettings.vue';
import { setLanguage } from '../../../../i18n';
const originalHost = window.__GRAYCODE_HOST;
afterEach(() => { window.__GRAYCODE_HOST = originalHost; setLanguage('auto'); });
const render = () => mount(ChannelBasicSettings, { props: {
  config: { id: 'fixture', name: 'fixture', type: 'openai', toolMode: 'function_call', enabled: true,
    url: '', apiKey: '', model: '', models: [], options: {}, optionsEnabled: {} } as any,
  showApiKey: false, typeOptions: [], toolModeOptions: [], timeoutDraft: '120000', maxContextTokensDraft: '256000',
}, global: { stubs: { ModelManager: true, CustomSelect: true } } });

test('桌面显示真实的图片能力和设置入口，不提供不生效的旧开关', () => {
  setLanguage('zh-CN'); window.__GRAYCODE_HOST = { kind: 'web' } as typeof originalHost;
  const wrapper = render();
  try {
    const help = wrapper.get('[data-search-anchor="multimodal"]');
    expect(help.text()).toContain('OpenAI Function Calling 也能发送工具图片');
    expect(help.text()).toContain('在“工具”设置中调整');
    expect(help.find('input[type=checkbox]').exists()).toBe(false);
    expect(wrapper.find('.tool-mode-warning').exists()).toBe(false);
  } finally { wrapper.unmount(); }
});

test('扩展宿主保留其仍生效的渠道多模态开关', async () => {
  setLanguage('en'); window.__GRAYCODE_HOST = undefined;
  const wrapper = render();
  try {
    await wrapper.get('[data-search-anchor="multimodal"] input[type=checkbox]').setValue(true);
    expect(wrapper.emitted('update:field')).toContainEqual(['multimodalToolsEnabled', true]);
  } finally { wrapper.unmount(); }
});
