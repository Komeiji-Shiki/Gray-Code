import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import WorkspaceFeatureLinks from '../../components/settings/panel/WorkspaceFeatureLinks.vue';
import { setLanguage } from '../../i18n';
import type { HostTransport } from '../../utils/hostTransport';
import { WORKSPACE_PANEL_MESSAGE, readWorkspacePanelMessage } from '../../../../shared/workspacePanelNavigation';
import { settingsSearchIndex } from '../../components/settings/panel/settingsSearchIndex';
const originalHost = window.__GRAYCODE_HOST;
const openPanel = vi.fn();
beforeEach(() => { setLanguage('zh-CN'); openPanel.mockReset(); window.__GRAYCODE_HOST = { openWorkspacePanel: openPanel } as unknown as HostTransport; });
afterEach(() => { window.__GRAYCODE_HOST = originalHost; setLanguage('auto'); });

test('长期记忆入口说明预算位置，直接导航而不提交当前表单', async () => {
  const wrapper = mount(WorkspaceFeatureLinks, { props: { area: 'memory' } });
  try {
    expect(wrapper.text()).toContain('Token 预算'); expect(wrapper.text()).toContain('日志式记忆');
    await wrapper.get('button').trigger('click'); expect(openPanel).toHaveBeenCalledWith('memory');
  } finally { wrapper.unmount(); }
});
test('外观页提供桌宠与屏幕感知的独立入口', async () => {
  const wrapper = mount(WorkspaceFeatureLinks, { props: { area: 'companions' } });
  try {
    const buttons = wrapper.findAll('button'); expect(buttons).toHaveLength(2);
    await buttons[0].trigger('click'); await buttons[1].trigger('click');
    expect(openPanel.mock.calls).toEqual([['pets'], ['screenSense']]);
  } finally { wrapper.unmount(); }
});
test('旧扩展不显示没有宿主支持的跳转按钮，搜索索引也不添加这些入口', () => {
  window.__GRAYCODE_HOST = undefined;
  const wrapper = mount(WorkspaceFeatureLinks, { props: { area: 'memory' } });
  try { expect(wrapper.find('section').exists()).toBe(false); }
  finally { wrapper.unmount(); }
  expect(settingsSearchIndex(false).some(item => item.key === 'memory-library')).toBe(false);
  expect(settingsSearchIndex(true).find(item => item.key === 'memory-library')?.keywords).toContain('向量');
  expect(settingsSearchIndex(true).find(item => item.key === 'companion-features')?.keywords).toContain('Live2D');
});
test('仅接受当前聊天页面、相同来源和明确的面板名称', () => {
  const source = {}, other = {}, origin = 'graycode://app';
  const event = { source, origin, data: { type: WORKSPACE_PANEL_MESSAGE, panel: 'memory' } };
  expect(readWorkspacePanelMessage(event, source, origin)).toBe('memory');
  expect(readWorkspacePanelMessage({ ...event, source: other }, source, origin)).toBeUndefined();
  expect(readWorkspacePanelMessage({ ...event, origin: 'https://external.example' }, source, origin)).toBeUndefined();
  expect(readWorkspacePanelMessage({ ...event, data: { ...event.data, panel: 'settings.delete' } }, source, origin)).toBeUndefined();
  expect(readWorkspacePanelMessage({ ...event, data: null }, source, origin)).toBeUndefined();
  expect(readWorkspacePanelMessage({ ...event, source: null }, null, origin)).toBeUndefined();
});
